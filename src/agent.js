const Anthropic = require('@anthropic-ai/sdk');
const { searchCompetitors } = require('./tools/search');
const { generatePresentation } = require('./tools/gamma');
const { analyzeExcel } = require('./tools/excel');
const { generateWord, generateExcel: generateExcelFile } = require('./tools/export');

const client = new Anthropic();

const SYSTEM_PROMPT = `Sos Moltbot KarIA, un agente inteligente desarrollado por KarIA.

REGLAS:
- Siempre respondés en español.
- Tono profesional y directo.
- No realizás compras ni accedés a sitios con login.
- Si el usuario menciona un producto (aunque sea en términos generales como "lavarropas Samsung 9kg"), buscás directamente sin pedir más detalles.

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
1. **Presentaciones**: Podés generar presentaciones usando Gamma. Cuando el usuario pida una presentación, usá la herramienta "generate_presentation".
2. **Búsqueda de precios**: Podés buscar precios, stock y promociones de electrodomésticos en tiendas de Córdoba Argentina usando la herramienta "search_competitors". Devolvé siempre la tabla completa que devuelve la herramienta. SIEMPRE citá la fuente URL de cada resultado.
3. **Análisis de Excel**: Si el usuario adjuntó un archivo Excel, actuás como consultor de datos. Si el usuario no especificó qué analizar, preguntale qué aspecto le interesa (horas por persona, costos, rankings, etc.). Si especificó una pregunta, usá la herramienta "analyze_excel" directamente.
4. **Exportar a Word/Excel**: Podés generar archivos .docx y .xlsx para descargar.

REGLA CRÍTICA — EXPORTACIÓN DE DOCUMENTOS:
- NUNCA generes un documento Word o Excel por tu cuenta. Solo hacelo si el usuario lo pide EXPLÍCITAMENTE con palabras como "exportar", "descargar", "generar documento", "pasame en Word", "pasame en Excel", "haceme un archivo", etc.
- Cuando el usuario SÍ pide un documento, PRIMERO preguntá qué quiere que contenga antes de generarlo. Ejemplo: "¿Qué información querés que incluya en el documento? ¿Solo los datos de X o un resumen general?"
- Solo DESPUÉS de que el usuario confirme el contenido, generá el archivo y compartí el link de descarga.
- Si el usuario ya especificó exactamente qué quiere en el documento en el mismo mensaje donde lo pide, no hace falta preguntar de nuevo — generalo directamente.

Cuando necesites usar una herramienta, invocala. No simules resultados.`;

const TOOLS = [
  {
    name: 'search_competitors',
    description:
      'Busca precios, stock y promociones de un electrodoméstico en tiendas de Córdoba Argentina usando búsqueda web. Devuelve una tabla comparativa con URLs de fuente. Usá esta herramienta siempre que el usuario mencione un electrodoméstico, aunque no especifique el modelo exacto.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Nombre del producto a buscar, puede ser genérico o con modelo. Ejemplos: "lavarropas Samsung 9kg", "heladera no frost 400 litros", "aire acondicionado Midea 3000 frigorías"',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'generate_presentation',
    description:
      'Genera una presentación en Gamma sobre un tema dado y devuelve el link.',
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Tema o título de la presentación.',
        },
        details: {
          type: 'string',
          description: 'Detalles adicionales o puntos a cubrir en la presentación.',
        },
      },
      required: ['topic'],
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
];

async function handleChat(userMessage, history, excelContext = null) {
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

  // Filtrar los mensajes [EXCEL_DATA] del historial para no enviarlos a Claude
  const messages = history
    .filter((m) => !(m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith('[EXCEL_DATA]\n')))
    .map((m) => ({ role: m.role, content: m.content }));

  // Si hay Excel, inyectarlo en el mensaje del usuario
  let fullMessage;
  if (excelContext) {
    const userText = userMessage.trim() || '(El usuario subió el archivo sin agregar un mensaje)';
    fullMessage = `El usuario adjuntó un archivo Excel con los siguientes datos:\n\n${excelContext}\n\n---\n\nMensaje del usuario: ${userText}`;
  } else {
    fullMessage = userMessage;
  }

  messages.push({ role: 'user', content: fullMessage });

  console.log(`[agent] Enviando a Claude. Turnos en contexto: ${messages.length} | Excel adjunto: ${!!excelContext}`);

  let response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
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
          result = await searchCompetitors(block.input.query);
          console.log(`[agent] search_competitors completado. Resultado (primeros 300 chars): ${String(result).slice(0, 300)}`);
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
      system: SYSTEM_PROMPT,
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
