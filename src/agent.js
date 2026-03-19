const Anthropic = require('@anthropic-ai/sdk');
const { searchCompetitors } = require('./tools/search');
const { generatePresentation } = require('./tools/gamma');
const { analyzeExcel } = require('./tools/excel');
const { generateWord, generateExcel: generateExcelFile } = require('./tools/export');
const { getEvents, createEvent, getTodayEvents, deleteEvent } = require('./tools/google/calendar');
const { getUnreadEmails, sendEmail, searchEmails } = require('./tools/google/gmail');
const { listFiles, getFile, uploadFile } = require('./tools/google/drive');
const { searchContacts, addContact } = require('./tools/contacts');

const client = new Anthropic();

function getSystemPrompt() {
  const now = new Date();
  const today = now.toLocaleDateString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  // Calculate tomorrow's date for explicit reference
  const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const todayISO = now.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }); // YYYY-MM-DD
  const tomorrowISO = tomorrowDate.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  return `Hoy es ${today} (${todayISO}). Mañana es ${tomorrowISO}.

REGLA CRÍTICA — FECHAS:
- "hoy" = ${todayISO}
- "mañana" = ${tomorrowISO}
- Para cualquier referencia temporal ("esta semana", "el lunes", "el viernes"), calculá la fecha YYYY-MM-DD correcta a partir de hoy ${todayISO}.
- SIEMPRE confirmá la fecha con el usuario antes de crear un evento de calendario. Ejemplo: "Perfecto, voy a crear el evento para el ${tomorrowISO} (mañana). ¿Confirmo?"

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
- Si search_contacts devuelve found:false → pedí el email al usuario. Una vez que lo dé, ofrecé guardarlo con add_contact.
- Si el usuario dice "guardá a X con mail Y" o similar → usá add_contact directamente.

REGLA CRÍTICA — EXPORTACIÓN DE DOCUMENTOS:
- NUNCA generes un documento Word o Excel por tu cuenta. Solo hacelo si el usuario lo pide EXPLÍCITAMENTE con palabras como "exportar", "descargar", "generar documento", "pasame en Word", "pasame en Excel", "haceme un archivo", etc.
- Cuando el usuario SÍ pide un documento, PRIMERO preguntá qué quiere que contenga antes de generarlo. Ejemplo: "¿Qué información querés que incluya en el documento? ¿Solo los datos de X o un resumen general?"
- Solo DESPUÉS de que el usuario confirme el contenido, generá el archivo y compartí el link de descarga.
- Si el usuario ya especificó exactamente qué quiere en el documento en el mismo mensaje donde lo pide, no hace falta preguntar de nuevo — generalo directamente.

Cuando necesites usar una herramienta, invocala. No simules resultados.`;
}

const TOOLS = [
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
        title: {
          type: 'string',
          description: 'Título del evento.',
        },
        date: {
          type: 'string',
          description: 'Fecha del evento en formato YYYY-MM-DD.',
        },
        time: {
          type: 'string',
          description: 'Hora de inicio en formato HH:MM (24h). Ej: "14:30".',
        },
        duration: {
          type: 'number',
          description: 'Duración en minutos (default 60).',
        },
        description: {
          type: 'string',
          description: 'Descripción opcional del evento.',
        },
        attendees: {
          type: 'string',
          description: 'Emails de invitados separados por coma. Ej: "hernan@gmail.com, ana@empresa.com". Si el usuario menciona a alguien con su email, agregalo acá.',
        },
        withMeet: {
          type: 'boolean',
          description: 'Si true, crea un link de Google Meet para el evento. Usá true cuando el usuario pida "con Meet", "con videollamada", "con link de reunión", etc.',
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
  {
    name: 'get_emails',
    description:
      'Obtiene los últimos emails no leídos de la cuenta moltbotkaria@gmail.com.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Cantidad máxima de emails a traer (default 10).',
        },
        query: {
          type: 'string',
          description: 'Término de búsqueda opcional para filtrar emails (compatible con operadores de Gmail como from:, subject:, etc.).',
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
        to: {
          type: 'string',
          description: 'Dirección de email del destinatario.',
        },
        subject: {
          type: 'string',
          description: 'Asunto del email.',
        },
        body: {
          type: 'string',
          description: 'Cuerpo del email en texto plano.',
        },
        attachments: {
          type: 'string',
          description: 'Nombres de archivos en /tmp para adjuntar, separados por coma. Ej: "presentacion_ventas_1234.pdf". Usá el nombre exacto que aparece en "[PDF guardado localmente: nombre.pdf]" o el nombre de archivos Word/Excel generados.',
        },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'search_drive',
    description:
      'Busca y lista archivos en el Google Drive de moltbotkaria@gmail.com.',
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
    description:
      'Guarda un archivo de texto en el Google Drive de moltbotkaria@gmail.com.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Nombre del archivo con extensión. Ej: "informe.txt", "datos.csv".',
        },
        content: {
          type: 'string',
          description: 'Contenido del archivo.',
        },
        mimeType: {
          type: 'string',
          description: 'Tipo MIME del archivo. Default: "text/plain". Otros: "text/csv", "application/json".',
        },
      },
      required: ['name', 'content'],
    },
  },
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
  {
    name: 'add_contact',
    description:
      'Agrega un contacto nuevo a la lista del usuario. Usá esta herramienta cuando el usuario pida guardar un contacto o cuando ofreciste guardarlo y el usuario aceptó.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: {
          type: 'string',
          description: 'Nombre completo del contacto.',
        },
        email: {
          type: 'string',
          description: 'Email del contacto.',
        },
      },
      required: ['nombre', 'email'],
    },
  },
];

async function handleChat(userMessage, history, excelContext = null, usuarioId = null, wordContext = null) {
  // Si no hay excelContext directo, buscarlo en el historial
  if (!excelContext) {
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith('[EXCEL_DATA]\n')) {
        excelContext = m.content.slice('[EXCEL_DATA]\n'.length);
        break;
      }
    }
  }

  // Si no hay wordContext directo, buscarlo en el historial
  if (!wordContext) {
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith('[WORD_DATA]\n')) {
        wordContext = m.content.slice('[WORD_DATA]\n'.length);
        break;
      }
    }
  }

  // Filtrar los mensajes de datos de archivos del historial y limitar a los últimos 6 mensajes
  // para evitar superar el rate limit de tokens (429)
  const MAX_HISTORY_MESSAGES = 6;
  const filtered = history
    .filter((m) => !(m.role === 'assistant' && typeof m.content === 'string' && (m.content.startsWith('[EXCEL_DATA]\n') || m.content.startsWith('[WORD_DATA]\n'))));
  const trimmed = filtered.slice(-MAX_HISTORY_MESSAGES);
  // Ensure first message is from 'user' (Claude API requires alternating roles starting with user)
  const firstUserIdx = trimmed.findIndex((m) => m.role === 'user');
  const messages = (firstUserIdx > 0 ? trimmed.slice(firstUserIdx) : trimmed)
    .map((m) => ({ role: m.role, content: m.content }));

  // Si hay archivo adjunto, inyectar su contenido en el mensaje del usuario
  let fullMessage;
  const userText = userMessage.trim() || '(El usuario subió el archivo sin agregar un mensaje)';
  if (excelContext && wordContext) {
    fullMessage = `El usuario adjuntó un archivo Excel con los siguientes datos:\n\n${excelContext}\n\nTambién adjuntó un archivo Word con el siguiente contenido:\n\n${wordContext}\n\n---\n\nMensaje del usuario: ${userText}`;
  } else if (excelContext) {
    fullMessage = `El usuario adjuntó un archivo Excel con los siguientes datos:\n\n${excelContext}\n\n---\n\nMensaje del usuario: ${userText}`;
  } else if (wordContext) {
    fullMessage = `El usuario adjuntó un archivo Word con el siguiente contenido:\n\n${wordContext}\n\n---\n\nMensaje del usuario: ${userText}`;
  } else {
    fullMessage = userMessage;
  }

  messages.push({ role: 'user', content: fullMessage });

  console.log(`[agent] Enviando a Claude. Turnos en contexto: ${messages.length} | Excel: ${!!excelContext} | Word: ${!!wordContext}`);

  let response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: getSystemPrompt(),
    tools: TOOLS,
    messages,
  });

  console.log(`[agent] Claude respondió. stop_reason: ${response.stop_reason}`);

  // Tool-use loop
  while (response.stop_reason === 'tool_use') {
    const assistantContent = response.content;
    messages.push({ role: 'assistant', content: assistantContent });

    const toolResults = [];

    for (const block of assistantContent) {
      if (block.type !== 'tool_use') continue;

      console.log(`[agent] Tool invocada: ${block.name} | Input: ${JSON.stringify(block.input)}`);

      let result;
      try {
        if (block.name === 'search_competitors') {
          let rawResult = await searchCompetitors(block.input.query);
          // Truncar resultados de búsqueda a 2000 chars para evitar rate limit 429
          const MAX_SEARCH_CHARS = 2000;
          if (rawResult.length > MAX_SEARCH_CHARS) {
            rawResult = rawResult.slice(0, MAX_SEARCH_CHARS) + '\n\n[Resultados truncados por límite de tamaño]';
          }
          result = rawResult;
          console.log(`[agent] search_competitors completado. Resultado (${result.length} chars, primeros 300): ${String(result).slice(0, 300)}`);
        } else if (block.name === 'generate_presentation') {
          result = await generatePresentation(block.input.topic, block.input.details);
          console.log(`[agent] generate_presentation completado.`);
        } else if (block.name === 'analyze_excel') {
          if (!excelContext) {
            result = 'No hay ningún archivo Excel adjunto en esta conversación.';
          } else {
            result = await analyzeExcel(excelContext, block.input.question, block.input.analysisType, block.input.personFilter || null);
            console.log(`[agent] analyze_excel completado. Resultado (primeros 300 chars): ${String(result).slice(0, 300)}`);
          }
        } else if (block.name === 'export_to_word') {
          const filePath = await generateWord(block.input.content, block.input.filename);
          const fileName = require('path').basename(filePath);
          result = `Archivo Word generado. Link de descarga: /download/${fileName}`;
          console.log(`[agent] export_to_word completado: ${filePath}`);
        } else if (block.name === 'export_to_excel') {
          const data = {
            headers: block.input.headers,
            rows: block.input.rows,
            sheetName: block.input.sheetName || 'Datos',
          };
          const filePath = await generateExcelFile(data, block.input.filename);
          const fileName = require('path').basename(filePath);
          result = `Archivo Excel generado. Link de descarga: /download/${fileName}`;
          console.log(`[agent] export_to_excel completado: ${filePath}`);
        } else if (block.name === 'get_calendar_events') {
          const days = block.input.days;
          result = days === 0 ? await getTodayEvents() : await getEvents(days || 7);
          console.log(`[agent] get_calendar_events completado.`);
        } else if (block.name === 'create_calendar_event') {
          const attendeesList = block.input.attendees
            ? block.input.attendees.split(',').map((e) => e.trim()).filter(Boolean)
            : [];
          result = await createEvent(
            block.input.title,
            block.input.date,
            block.input.time,
            block.input.duration || 60,
            block.input.description || '',
            attendeesList,
            block.input.withMeet || false
          );
          console.log(`[agent] create_calendar_event completado.`);
        } else if (block.name === 'delete_calendar_event') {
          result = await deleteEvent(block.input.eventId);
          console.log(`[agent] delete_calendar_event completado.`);
        } else if (block.name === 'get_emails') {
          if (block.input.query) {
            result = await searchEmails(block.input.query);
          } else {
            result = await getUnreadEmails(block.input.limit || 10);
          }
          console.log(`[agent] get_emails completado.`);
        } else if (block.name === 'send_email') {
          const attachmentList = block.input.attachments
            ? block.input.attachments.split(',').map((f) => f.trim()).filter(Boolean)
            : [];
          result = await sendEmail(block.input.to, block.input.subject, block.input.body, attachmentList);
          console.log(`[agent] send_email completado. Adjuntos: ${attachmentList.length}`);
        } else if (block.name === 'search_drive') {
          result = await listFiles(block.input.query || '');
          console.log(`[agent] search_drive completado.`);
        } else if (block.name === 'save_to_drive') {
          result = await uploadFile(block.input.name, block.input.content, block.input.mimeType || 'text/plain');
          console.log(`[agent] save_to_drive completado.`);
        } else if (block.name === 'search_contacts') {
          if (!usuarioId) {
            result = 'No hay sesión de usuario activa. El usuario debe iniciar sesión.';
          } else {
            const contactResult = await searchContacts(block.input.query, usuarioId);
            result = JSON.stringify(contactResult);
            console.log(`[agent] search_contacts completado: ${result}`);
          }
        } else if (block.name === 'add_contact') {
          if (!usuarioId) {
            result = 'No hay sesión de usuario activa. El usuario debe iniciar sesión.';
          } else {
            const addResult = await addContact(block.input.nombre, block.input.email, usuarioId);
            result = JSON.stringify(addResult);
            console.log(`[agent] add_contact completado: ${result}`);
          }
        } else {
          result = `Herramienta desconocida: ${block.name}`;
          console.warn(`[agent] Tool desconocida: ${block.name}`);
        }
      } catch (err) {
        console.error(`[agent] Error ejecutando ${block.name}:`, err.message);
        console.error(err.stack);
        result = `Error al ejecutar ${block.name}: ${err.message}`;
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: String(result ?? 'Sin respuesta de la herramienta.'),
      });
    }

    messages.push({ role: 'user', content: toolResults });

    console.log(`[agent] Enviando resultados de tools a Claude...`);
    response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: getSystemPrompt(),
      tools: TOOLS,
      messages,
    });
    console.log(`[agent] Claude respondió. stop_reason: ${response.stop_reason}`);
  }

  // Extraer texto de la respuesta final
  const textBlocks = response.content.filter((b) => b.type === 'text');
  return textBlocks.map((b) => b.text).join('\n');
}

module.exports = { handleChat };
