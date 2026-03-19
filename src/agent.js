const Anthropic = require('@anthropic-ai/sdk');
const { searchCompetitors } = require('./tools/search');
const { generatePresentation } = require('./tools/gamma');
const { analyzeExcel } = require('./tools/excel');
const { generateWord, generateExcel: generateExcelFile } = require('./tools/export');
const { getEvents, createEvent, getTodayEvents, deleteEvent } = require('./tools/google/calendar');
const { getUnreadEmails, sendEmail, searchEmails } = require('./tools/google/gmail');
// getFile no se usa actualmente — solo listFiles y uploadFile tienen tool asociada
const { listFiles, uploadFile } = require('./tools/google/drive');
const { buscarContactosGmail } = require('./tools/google/contactos_gmail');

const client = new Anthropic();

// === Timeouts ===

// 60 segundos para cada llamada a la API de Claude (incluye tool-use loop)
const TIMEOUT_CLAUDE_MS = 60_000;

// === System prompt ===
//
// El system prompt es una función (no una constante) porque inyecta la fecha actual
// de Argentina en cada invocación. Esto permite que Claude interprete correctamente
// referencias temporales como "mañana", "el lunes", etc.
//
// Estructura del prompt:
//   1. FECHAS — Fecha actual + mañana en ISO, con regla de confirmación antes de crear eventos
//   2. IDENTIDAD — Nombre del agente, idioma, tono
//   3. REGLAS DE COMPORTAMIENTO — Concisión, manejo de insultos, no inventar datos
//   4. RESULTADOS DE HERRAMIENTAS — Siempre mostrar datos literales, nunca filtrar
//   5. CAPACIDADES — Lista de 8 herramientas con reglas específicas para cada una
//   6. REGLAS CRÍTICAS — Contactos antes de emails, exportación solo si se pide explícitamente
//
// Cada sección existe para resolver un problema real observado en producción:
//   - FECHAS: el agente creaba eventos en fecha incorrecta con "mañana"
//   - CONCISIÓN: respondía con párrafos innecesarios
//   - RESULTADOS: decía "no encontré" cuando la herramienta sí devolvió datos
//   - CONTACTOS: enviaba emails sin buscar el contacto primero
//   - EXPORTACIÓN: generaba documentos sin que el usuario los pidiera

/**
 * Genera el system prompt con la fecha actual de Argentina inyectada dinámicamente.
 * Se ejecuta en cada mensaje para que la fecha siempre sea correcta.
 * @returns {string} System prompt completo para Claude
 */
function getSystemPrompt() {
  const now = new Date();
  const hoyFormateado = now.toLocaleDateString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const mananaDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const hoyISO = now.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  const mananaISO = mananaDate.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });

  return `Hoy es ${hoyFormateado} (${hoyISO}). Mañana es ${mananaISO}.

REGLA CRÍTICA — FECHAS:
- "hoy" = ${hoyISO}
- "mañana" = ${mananaISO}
- Para cualquier referencia temporal ("esta semana", "el lunes", "el viernes"), calculá la fecha YYYY-MM-DD correcta a partir de hoy ${hoyISO}.
- SIEMPRE confirmá la fecha con el usuario antes de crear un evento de calendario. Ejemplo: "Perfecto, voy a crear el evento para el ${mananaISO} (mañana). ¿Confirmo?"

Sos Moltbot KarIA, un agente inteligente desarrollado por KarIA.

REGLAS:
- Siempre respondés en español.
- Tono profesional y directo.
- No realizás compras ni accedés a sitios con login.
- Si el usuario menciona un producto (aunque sea en términos generales como "lavarropas Samsung 9kg"), buscás directamente sin pedir más detalles.
- Si el usuario usa lenguaje ofensivo o insultos, no los valides ni te disculpes. Respondé con calma, mantené un tono profesional y redirigí la conversación a la tarea.

REGLA CRÍTICA — CONCISIÓN:
- Respondé SOLO lo que el usuario preguntó. No agregues información extra no solicitada.
- Sé directo y conciso: máximo 3-4 párrafos o una tabla cuando corresponda.
- No agregues recomendaciones, sugerencias ni consejos a menos que el usuario los pida explícitamente.
- No repitas información que ya diste en mensajes anteriores de la conversación.

REGLA CRÍTICA SOBRE RESULTADOS DE HERRAMIENTAS:
Cuando una herramienta devuelve datos, SIEMPRE mostrá esos datos al usuario de forma completa y literal.
Nunca digas "no encontré información" ni "no pude obtener resultados" si la herramienta devolvió contenido.
Los datos que devuelven las herramientas son la fuente de verdad — no los filtrés, no los resumás en vacío, no los descartés aunque parezcan incompletos.
Si la tabla tiene filas con "Sin datos" para algunas tiendas, mostrá igual toda la tabla.

CAPACIDADES:
1. **Presentaciones**: Podés generar presentaciones usando Gamma.
   REGLA CRÍTICA PARA PRESENTACIONES:
   - Antes de usar "generate_presentation", SIEMPRE preguntá al usuario qué estilo prefiere, ofreciendo estas 3 opciones:
     1. Formal / Ejecutivo (para directores o clientes)
     2. Moderno / Impactante (colorida y visual)
     3. Minimalista / Limpia (simple y elegante)
   - Si el tema de la presentación NO quedó claro del contexto de la conversación, preguntá también: "¿Sobre qué querés la presentación?"
   - Si el tema YA quedó claro (porque se habló en la conversación), no preguntes el tema, solo el estilo.
   - RECIÉN después de que el usuario confirme el estilo (y el tema si hizo falta), generá la presentación.
   - El contenido de la presentación debe basarse EXCLUSIVAMENTE en lo que se habló en la conversación (resúmenes, análisis, datos discutidos), NO en todos los datos crudos del Excel completo.
   - Incluí la preferencia de estilo en el campo "details" de la herramienta.
   - Cuando la presentación se genere exitosamente, preguntá al usuario si quiere recibirla por mail. Si dice que sí, usá search_contacts para encontrar el destinatario si lo menciona por nombre, luego enviá el mail con el PDF adjunto usando el nombre de archivo que aparece en "[PDF guardado localmente: nombre.pdf]". Si dice que no, no la envíes.
2. **Búsqueda de precios**: Podés buscar precios, stock y promociones de electrodomésticos en tiendas de Córdoba Argentina usando la herramienta "search_competitors". Devolvé siempre la tabla completa que devuelve la herramienta. SIEMPRE citá la fuente URL de cada resultado. Cuando busques precios en comercios, solo devolvé resultados de tiendas que existan y estén operativas hoy. Si al buscar un comercio el sitio no carga, está caído, o los resultados indican que la empresa cerró o ya no opera, no lo incluyas en la respuesta. Nunca inventes ni asumas que una tienda sigue operando.
3. **Análisis de Excel**: Si el usuario adjuntó un archivo Excel, actuás como consultor de datos. Si el usuario no especificó qué analizar, preguntale qué aspecto le interesa (horas por persona, costos, rankings, etc.). Si especificó una pregunta, usá la herramienta "analyze_excel" directamente.
4. **Exportar a Word/Excel**: Podés generar archivos .docx y .xlsx para descargar.
5. **Google Calendar**: Podés ver eventos, crear reuniones y consultar la agenda de la cuenta moltbotkaria@gmail.com.
6. **Gmail**: Podés leer emails no leídos, buscar emails y enviar emails desde moltbotkaria@gmail.com.
7. **Google Drive**: Podés listar archivos, leer documentos y guardar archivos en el Drive de moltbotkaria@gmail.com.
8. **Contactos**: Podés buscar y agregar contactos del usuario.

REGLA CRÍTICA — CONTACTOS Y EMAILS:
- SIEMPRE usá "search_contacts" antes de "send_email" cuando el usuario mencione a alguien por nombre sin dar el email explícito.
- Si search_contacts devuelve unique:true → usá ese email directamente sin preguntar.
- Si search_contacts devuelve unique:false → listá los contactos encontrados y preguntá a cuál quiere enviarle.
- Si search_contacts devuelve found:false → pedí el email al usuario directamente.

REGLA CRÍTICA — EXPORTACIÓN DE DOCUMENTOS:
- NUNCA generes un documento Word o Excel por tu cuenta. Solo hacelo si el usuario lo pide EXPLÍCITAMENTE con palabras como "exportar", "descargar", "generar documento", "pasame en Word", "pasame en Excel", "haceme un archivo", etc.
- Cuando el usuario SÍ pide un documento, PRIMERO preguntá qué quiere que contenga antes de generarlo. Ejemplo: "¿Qué información querés que incluya en el documento? ¿Solo los datos de X o un resumen general?"
- Solo DESPUÉS de que el usuario confirme el contenido, generá el archivo y compartí el link de descarga.
- Si el usuario ya especificó exactamente qué quiere en el documento en el mismo mensaje donde lo pide, no hace falta preguntar de nuevo — generalo directamente.

Cuando necesites usar una herramienta, invocala. No simules resultados.`;
}

// === Definición de herramientas ===
//
// Cada tool se define en formato Anthropic Tool Use: { name, description, input_schema }.
// Claude decide cuándo invocar cada tool basándose en la description y las reglas del system prompt.
//
// Herramientas disponibles:
//   - search_competitors  → Búsqueda web de precios (usa Claude Haiku + web_search en search.js)
//   - generate_presentation → Crea presentación en Gamma (usa Gamma API en gamma.js)
//   - analyze_excel       → Analiza datos de Excel adjunto (usa Claude Sonnet en excel.js)
//   - export_to_word      → Genera .docx descargable (usa librería docx en export.js)
//   - export_to_excel     → Genera .xlsx descargable (usa exceljs en export.js)
//   - get_calendar_events → Lee eventos de Google Calendar
//   - create_calendar_event → Crea evento con soporte para Meet e invitados
//   - delete_calendar_event → Elimina evento por ID
//   - get_emails          → Lee o busca emails en Gmail
//   - send_email          → Envía email con soporte para adjuntos desde /tmp
//   - search_drive        → Lista archivos en Google Drive
//   - save_to_drive       → Sube archivo a Google Drive
//   - search_contacts     → Busca contactos en Google People API

const TOOLS = [
  // Búsqueda de precios: recibe {query}. Devuelve tabla markdown con Tienda | Precio | Link.
  // El query debe incluir el nombre de la tienda si el usuario la mencionó.
  {
    name: 'search_competitors',
    description:
      'Busca precios, stock y promociones de un electrodoméstico en tiendas de Córdoba Argentina usando búsqueda web. Devuelve una tabla comparativa con URLs de fuente. Usá esta herramienta siempre que el usuario mencione un electrodoméstico, aunque no especifique el modelo exacto. IMPORTANTE: si el usuario menciona una tienda específica (ej: "en Frávega", "en Naldo"), DEBÉS incluir el nombre de la tienda dentro del query.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Nombre del producto a buscar. Si el usuario mencionó una tienda específica, INCLUIRLA en el query. Ejemplos: "lavarropas Samsung 9kg" (búsqueda libre), "lavarropas Samsung 9kg Frávega" (tienda específica), "heladera no frost Naldo Cetrogar" (varias tiendas).',
        },
      },
      required: ['query'],
    },
  },
  // Presentaciones: recibe {topic, details}. Devuelve link al PDF de Gamma.
  // El agente debe preguntar estilo antes de invocar.
  {
    name: 'generate_presentation',
    description:
      'Genera una presentación en Gamma. SOLO usá esta herramienta DESPUÉS de haber preguntado al usuario el estilo preferido y haber confirmado el tema. El contenido debe basarse en lo conversado, no en datos crudos del Excel completo.',
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Tema o título de la presentación, basado en lo conversado con el usuario.',
        },
        details: {
          type: 'string',
          description: 'Contenido y puntos clave a cubrir (basados en la conversación, no datos crudos del Excel). DEBE incluir al inicio el estilo elegido por el usuario: "Estilo: Formal/Ejecutivo" o "Estilo: Moderno/Impactante" o "Estilo: Minimalista/Limpia". Luego los puntos de contenido.',
        },
      },
      required: ['topic', 'details'],
    },
  },
  // Análisis de Excel: recibe {question, analysisType, personFilter?}.
  // Requiere que el usuario haya adjuntado un Excel previamente (excelContext).
  {
    name: 'analyze_excel',
    description:
      'Analiza los datos del archivo Excel adjunto por el usuario. Usá esta herramienta cuando el usuario haya subido un Excel y haya especificado qué quiere analizar (horas, costos, rankings, comparativas, etc.). Si el usuario pregunta por una persona específica, incluí su nombre en personFilter para optimizar el análisis.',
    input_schema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'Pregunta o análisis específico a realizar sobre los datos del Excel.',
        },
        analysisType: {
          type: 'string',
          enum: ['horas', 'costos', 'comparativa', 'resumen', 'otro'],
          description: 'Tipo de análisis a realizar.',
        },
        personFilter: {
          type: 'string',
          description: 'Nombre de la persona a filtrar. Si el usuario pregunta por alguien específico (ej: "las horas de Constanza", "el costo de Juan"), incluí el nombre acá para filtrar solo sus datos. Dejá vacío para análisis general.',
        },
      },
      required: ['question', 'analysisType'],
    },
  },
  // Exportación: generan archivos en /tmp y devuelven link /download/{filename}.
  // Solo se usan cuando el usuario pide explícitamente exportar.
  {
    name: 'export_to_word',
    description:
      'Genera un archivo Word (.docx) y devuelve un link de descarga. SOLO usá esta herramienta cuando el usuario pidió EXPLÍCITAMENTE exportar a Word/documento Y ya confirmó qué contenido incluir.',
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Contenido a incluir en el documento Word. Puede incluir markdown básico (# títulos, **bold**, listas con -).',
        },
        filename: {
          type: 'string',
          description: 'Nombre descriptivo para el archivo (sin extensión). Ej: "informe_ventas", "analisis_costos".',
        },
      },
      required: ['content', 'filename'],
    },
  },
  {
    name: 'export_to_excel',
    description:
      'Genera un archivo Excel (.xlsx) con datos tabulares y devuelve un link de descarga. SOLO usá esta herramienta cuando el usuario pidió EXPLÍCITAMENTE exportar a planilla/Excel Y ya confirmó qué datos incluir.',
    input_schema: {
      type: 'object',
      properties: {
        headers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Nombres de las columnas. Ej: ["Producto", "Precio", "Stock"].',
        },
        rows: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: 'Filas de datos. Cada fila es un array de strings. Ej: [["Lavarropas", "$500.000", "Sí"]].',
        },
        filename: {
          type: 'string',
          description: 'Nombre descriptivo para el archivo (sin extensión). Ej: "comparativa_precios".',
        },
        sheetName: {
          type: 'string',
          description: 'Nombre de la hoja del Excel. Por defecto "Datos".',
        },
      },
      required: ['headers', 'rows', 'filename'],
    },
  },
  // Google Calendar: lectura, creación y eliminación de eventos.
  // Usa timezone America/Argentina/Buenos_Aires para evitar desfasajes de 3 horas.
  {
    name: 'get_calendar_events',
    description:
      'Obtiene eventos del Google Calendar de moltbotkaria@gmail.com. Podés consultar los próximos días o solo los eventos de hoy.',
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Cantidad de días a consultar (default 7). Usá 0 para ver solo eventos de hoy.',
        },
      },
      required: [],
    },
  },
  {
    name: 'create_calendar_event',
    description:
      'Crea un evento en el Google Calendar de moltbotkaria@gmail.com. Soporta invitados y Google Meet.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Título del evento.' },
        date: { type: 'string', description: 'Fecha del evento en formato YYYY-MM-DD.' },
        time: { type: 'string', description: 'Hora de inicio en formato HH:MM (24h). Ej: "14:30".' },
        duration: { type: 'number', description: 'Duración en minutos (default 60).' },
        description: { type: 'string', description: 'Descripción opcional del evento.' },
        attendees: {
          type: 'string',
          description: 'Emails de invitados separados por coma. Ej: "hernan@gmail.com, ana@empresa.com".',
        },
        withMeet: {
          type: 'boolean',
          description: 'Si true, crea un link de Google Meet. Usá true cuando el usuario pida "con Meet", "con videollamada", etc.',
        },
      },
      required: ['title', 'date', 'time'],
    },
  },
  {
    name: 'delete_calendar_event',
    description:
      'Elimina un evento del Google Calendar de moltbotkaria@gmail.com. ANTES de eliminar, SIEMPRE: 1) Usá get_calendar_events para buscar el evento y obtener su ID. 2) Confirmá con el usuario qué evento exacto quiere eliminar. 3) Recién después de la confirmación, eliminalo.',
    input_schema: {
      type: 'object',
      properties: {
        eventId: {
          type: 'string',
          description: 'ID del evento a eliminar. Obtené este ID usando get_calendar_events primero.',
        },
      },
      required: ['eventId'],
    },
  },
  // Gmail: lectura, búsqueda y envío de emails.
  // El envío soporta adjuntos desde /tmp (PDFs de Gamma, Word, Excel generados).
  {
    name: 'get_emails',
    description: 'Obtiene los últimos emails no leídos de la cuenta moltbotkaria@gmail.com.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Cantidad máxima de emails a traer (default 10).' },
        query: {
          type: 'string',
          description: 'Término de búsqueda opcional (compatible con operadores de Gmail como from:, subject:, etc.).',
        },
      },
      required: [],
    },
  },
  {
    name: 'send_email',
    description:
      'Envía un email desde moltbotkaria@gmail.com. Soporta adjuntar archivos previamente generados (PDF de Gamma, Word, Excel).',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Dirección de email del destinatario.' },
        subject: { type: 'string', description: 'Asunto del email.' },
        body: { type: 'string', description: 'Cuerpo del email en texto plano.' },
        attachments: {
          type: 'string',
          description: 'Nombres de archivos en /tmp para adjuntar, separados por coma. Usá el nombre exacto que aparece en "[PDF guardado localmente: nombre.pdf]".',
        },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  // Google Drive: listado y subida de archivos.
  {
    name: 'search_drive',
    description: 'Busca y lista archivos en el Google Drive de moltbotkaria@gmail.com.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Término de búsqueda para filtrar archivos por nombre. Dejá vacío para listar los más recientes.',
        },
      },
      required: [],
    },
  },
  {
    name: 'save_to_drive',
    description: 'Guarda un archivo de texto en el Google Drive de moltbotkaria@gmail.com.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre del archivo con extensión. Ej: "informe.txt".' },
        content: { type: 'string', description: 'Contenido del archivo.' },
        mimeType: {
          type: 'string',
          description: 'Tipo MIME del archivo. Default: "text/plain". Otros: "text/csv", "application/json".',
        },
      },
      required: ['name', 'content'],
    },
  },
  // Contactos: búsqueda en Google People API. Se debe invocar antes de send_email
  // cuando el usuario menciona un nombre sin email explícito.
  {
    name: 'search_contacts',
    description:
      'Busca contactos del usuario por nombre. SIEMPRE usá esta herramienta antes de send_email cuando el usuario menciona a alguien por nombre sin dar el email.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Nombre o parte del nombre del contacto a buscar. Ej: "Hernán", "Juan Pérez".',
        },
      },
      required: ['query'],
    },
  },
  // TODO: add_contact — pendiente de implementación vía Gmail People API
  // (People API actualmente no soporta creación de contactos con OAuth2 estándar;
  //  se evaluará usar la API de Directory o Google Contacts v3 en una próxima iteración)
];

// === Ejecución de herramientas ===
//
// executeTool es el dispatcher central: recibe un tool_use block de Claude
// y lo rutea a la función correspondiente. Cada case del switch:
//   1. Extrae y transforma los parámetros del input de Claude
//   2. Llama a la función del módulo correspondiente
//   3. Retorna el resultado como string (Claude lo recibe como tool_result)
//
// Si una herramienta falla, el error se captura en handleChat y se envía
// a Claude como tool_result con el mensaje de error, para que pueda
// informar al usuario de forma natural.

/**
 * Ejecuta una herramienta por nombre y retorna el resultado como string.
 * @param {object} block - Tool use block de Claude: { name, input, id }
 * @param {string|null} excelContext - Datos del Excel adjunto (null si no hay)
 * @param {string|null} usuarioId - ID del usuario autenticado (null si no hay sesión)
 * @returns {Promise<string>} Resultado de la herramienta en texto plano o markdown
 */
async function executeTool(block, excelContext, usuarioId) {
  const { name, input } = block;

  switch (name) {
    // Búsqueda de precios → search.js (Claude Haiku + web_search)
    // Se trunca a 2000 chars para evitar rate limit de tokens en el agente principal
    case 'search_competitors': {
      const MAX_CHARS = 2000;
      let resultado = await searchCompetitors(input.query);
      if (resultado.length > MAX_CHARS) {
        resultado = resultado.slice(0, MAX_CHARS) + '\n\n[Resultados truncados por límite de tamaño]';
      }
      return resultado;
    }

    // Presentación → gamma.js (Gamma API: creación + polling + descarga PDF a /tmp)
    case 'generate_presentation':
      return await generatePresentation(input.topic, input.details);

    // Análisis de Excel → excel.js (pasa los datos del Excel a Claude Sonnet para análisis)
    case 'analyze_excel':
      if (!excelContext) return 'No hay ningún archivo Excel adjunto en esta conversación.';
      return await analyzeExcel(excelContext, input.question, input.analysisType, input.personFilter || null);

    // Exportación a Word → export.js (genera .docx en /tmp, retorna link de descarga)
    case 'export_to_word': {
      const filePath = await generateWord(input.content, input.filename);
      return `Archivo Word generado. Link de descarga: /download/${require('path').basename(filePath)}`;
    }

    // Exportación a Excel → export.js (genera .xlsx en /tmp, retorna link de descarga)
    case 'export_to_excel': {
      const filePath = await generateExcelFile(
        { headers: input.headers, rows: input.rows, sheetName: input.sheetName || 'Datos' },
        input.filename
      );
      return `Archivo Excel generado. Link de descarga: /download/${require('path').basename(filePath)}`;
    }

    // Calendar → calendar.js. days=0 devuelve solo hoy, otro valor devuelve los próximos N días
    case 'get_calendar_events':
      return input.days === 0 ? await getTodayEvents() : await getEvents(input.days || 7);

    // Creación de evento: parsea attendees (string CSV → array) y delega a createEvent
    case 'create_calendar_event': {
      const invitados = input.attendees
        ? input.attendees.split(',').map((e) => e.trim()).filter(Boolean)
        : [];
      return await createEvent(
        input.title, input.date, input.time,
        input.duration || 60, input.description || '',
        invitados, input.withMeet || false
      );
    }

    case 'delete_calendar_event':
      return await deleteEvent(input.eventId);

    case 'get_emails':
      return input.query
        ? await searchEmails(input.query)
        : await getUnreadEmails(input.limit || 10);

    // Envío de email: parsea attachments (string CSV → array de filenames en /tmp)
    case 'send_email': {
      const adjuntos = input.attachments
        ? input.attachments.split(',').map((f) => f.trim()).filter(Boolean)
        : [];
      return await sendEmail(input.to, input.subject, input.body, adjuntos);
    }

    case 'search_drive':
      return await listFiles(input.query || '');

    case 'save_to_drive':
      return await uploadFile(input.name, input.content, input.mimeType || 'text/plain');

    case 'search_contacts':
      // La búsqueda de contactos usa exclusivamente Google People API (Gmail).
      // Supabase no se consulta para esta herramienta.
      return JSON.stringify(await buscarContactosGmail(input.query));

    // add_contact: pendiente de implementación vía Gmail People API

    default:
      console.warn(`[agent] Herramienta desconocida: ${name}`);
      return `Herramienta desconocida: ${name}`;
  }
}

// === Helpers de historial y contexto ===

/**
 * Busca en el historial el contenido de un archivo adjunto (Excel o Word).
 * Los archivos se almacenan como mensajes del asistente con prefijos especiales.
 * @param {Array} history - Historial de mensajes
 * @param {string} prefix - Prefijo a buscar: '[EXCEL_DATA]\n' o '[WORD_DATA]\n'
 * @returns {string|null} Contenido del archivo, o null si no está en el historial
 */
function extraerContextoDeHistorial(history, prefix) {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.startsWith(prefix)) {
      return msg.content.slice(prefix.length);
    }
  }
  return null;
}

/**
 * Prepara el historial de mensajes para enviar a Claude:
 * - Elimina los marcadores de archivos ([EXCEL_DATA], [WORD_DATA])
 * - Limita a los últimos 6 mensajes para evitar superar el rate limit de tokens
 * - Garantiza que el primer mensaje del array sea siempre del usuario
 */
function prepararHistorial(history) {
  const MAX_MENSAJES = 6;

  const sinMarcadores = history.filter(
    (m) => !(
      m.role === 'assistant' &&
      typeof m.content === 'string' &&
      (m.content.startsWith('[EXCEL_DATA]\n') || m.content.startsWith('[WORD_DATA]\n'))
    )
  );

  const recientes = sinMarcadores.slice(-MAX_MENSAJES);
  const primerUsuarioIdx = recientes.findIndex((m) => m.role === 'user');
  const normalizado = primerUsuarioIdx > 0 ? recientes.slice(primerUsuarioIdx) : recientes;

  return normalizado.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Construye el mensaje del usuario inyectando el contenido de archivos adjuntos.
 * Si hay Excel y/o Word adjuntos, los incluye antes del mensaje del usuario.
 */
function construirMensajeUsuario(mensajeUsuario, excelContext, wordContext) {
  const textoUsuario = mensajeUsuario.trim() || '(El usuario subió el archivo sin agregar un mensaje)';

  if (excelContext && wordContext) {
    return `El usuario adjuntó un archivo Excel con los siguientes datos:\n\n${excelContext}\n\nTambién adjuntó un archivo Word con el siguiente contenido:\n\n${wordContext}\n\n---\n\nMensaje del usuario: ${textoUsuario}`;
  }
  if (excelContext) {
    return `El usuario adjuntó un archivo Excel con los siguientes datos:\n\n${excelContext}\n\n---\n\nMensaje del usuario: ${textoUsuario}`;
  }
  if (wordContext) {
    return `El usuario adjuntó un archivo Word con el siguiente contenido:\n\n${wordContext}\n\n---\n\nMensaje del usuario: ${textoUsuario}`;
  }
  return mensajeUsuario;
}

// === Filtrado de herramientas por rol ===

/** Herramientas disponibles para el rol "document_analyst": solo análisis de documentos. */
const TOOLS_DOCUMENT_ANALYST = ['analyze_excel', 'export_to_word', 'export_to_excel'];

/**
 * Retorna el subconjunto de herramientas permitidas según el rol del usuario.
 * - admin: acceso completo a todas las herramientas
 * - document_analyst: solo herramientas de análisis y exportación de documentos
 */
function getToolsParaRol(rol) {
  if (rol === 'document_analyst') {
    return TOOLS.filter((t) => TOOLS_DOCUMENT_ANALYST.includes(t.name));
  }
  return TOOLS;
}

/**
 * Retorna un system prompt ajustado al rol del usuario.
 * Para document_analyst, restringe el contexto a análisis de documentos.
 */
function getSystemPromptParaRol(rol) {
  const base = getSystemPrompt();
  if (rol === 'document_analyst') {
    return `${base}\n\nROL ACTIVO: document_analyst. Solo podés interactuar sobre documentos adjuntos (Excel y Word). No tenés acceso a búsqueda de precios, calendario, email, Drive ni contactos. Si el usuario pide algo fuera del análisis de documentos, explicale amablemente que tu rol está limitado al análisis de archivos.`;
  }
  return base;
}

// === Handler principal ===
//
// Flujo completo de handleChat:
//   1. Recuperar contexto de archivos adjuntos (Excel/Word) del historial si no viene directo
//   2. Filtrar tools y system prompt según el rol del usuario (admin vs document_analyst)
//   3. Preparar historial: limpiar marcadores de archivos, limitar a 6 mensajes, inyectar contexto
//   4. Llamar a Claude con el historial preparado
//   5. Si Claude responde con tool_use → ejecutar las herramientas → enviar resultados → repetir
//   6. Cuando Claude responde con texto final (stop_reason !== 'tool_use') → retornar al usuario
//
// El loop de tool-use puede ejecutar múltiples herramientas en secuencia.
// Ejemplo: el usuario pide "mandale a Hernán el PDF de la presentación"
//   → Claude llama a search_contacts("Hernán")
//   → recibe el email
//   → Claude llama a send_email(email, asunto, body, ["presentacion.pdf"])
//   → recibe confirmación
//   → Claude genera la respuesta final al usuario

/**
 * Procesa un mensaje del usuario y retorna la respuesta del agente.
 * Maneja el loop de tool-use: Claude puede invocar múltiples herramientas
 * antes de generar la respuesta final.
 *
 * @param {string} userMessage - Mensaje del usuario
 * @param {Array} history - Historial de la conversación [{role, content}]
 * @param {string|null} excelContext - Contenido del Excel adjunto (o null)
 * @param {string|null} usuarioId - ID del usuario autenticado (null si no hay login)
 * @param {string|null} wordContext - Contenido del Word adjunto (o null)
 * @param {string} userRol - Rol del usuario: "admin" | "document_analyst"
 * @returns {string} Respuesta del agente en texto
 */
async function handleChat(userMessage, history, excelContext = null, usuarioId = null, wordContext = null, userRol = 'admin') {
  // Recuperar contexto de archivos del historial si no viene como parámetro directo
  excelContext = excelContext || extraerContextoDeHistorial(history, '[EXCEL_DATA]\n');
  wordContext = wordContext || extraerContextoDeHistorial(history, '[WORD_DATA]\n');

  // Determinar herramientas y system prompt según el rol del usuario
  const toolsActivas = getToolsParaRol(userRol);
  const systemPrompt = getSystemPromptParaRol(userRol);

  // Preparar mensajes: limpiar marcadores y limitar por tokens
  const messages = prepararHistorial(history);
  messages.push({ role: 'user', content: construirMensajeUsuario(userMessage, excelContext, wordContext) });

  console.log(`[agent] Contexto: ${messages.length} turnos | Excel: ${!!excelContext} | Word: ${!!wordContext} | Rol: ${userRol} | Tools: ${toolsActivas.length}`);

  // Primera llamada a Claude (timeout 60s)
  let response;
  try {
    response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      tools: toolsActivas,
      messages,
    }, { timeout: TIMEOUT_CLAUDE_MS });
  } catch (err) {
    if (err.name === 'APIConnectionTimeoutError' || err.message?.includes('timeout')) {
      throw new Error('El agente tardó demasiado en responder. Por favor intentá de nuevo.');
    }
    throw err;
  }

  // Loop de tool-use: continuar mientras Claude quiera ejecutar herramientas
  while (response.stop_reason === 'tool_use') {
    messages.push({ role: 'assistant', content: response.content });

    // Ejecutar todas las herramientas solicitadas en este turno
    const resultadosTools = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      console.log(`[agent] Ejecutando herramienta: ${block.name}`);
      let resultado;
      try {
        resultado = await executeTool(block, excelContext, usuarioId);
      } catch (err) {
        console.error(`[agent] Error en ${block.name}:`, err.message);
        resultado = `Error al ejecutar ${block.name}: ${err.message}`;
      }

      resultadosTools.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: String(resultado ?? 'Sin respuesta de la herramienta.'),
      });
    }

    messages.push({ role: 'user', content: resultadosTools });

    // Nueva llamada a Claude con los resultados de las herramientas (timeout 60s)
    try {
      response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        tools: toolsActivas,
        messages,
      }, { timeout: TIMEOUT_CLAUDE_MS });
    } catch (err) {
      if (err.name === 'APIConnectionTimeoutError' || err.message?.includes('timeout')) {
        throw new Error('El agente tardó demasiado en responder. Por favor intentá de nuevo.');
      }
      throw err;
    }
  }

  // Extraer y retornar el texto de la respuesta final
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

module.exports = { handleChat };
