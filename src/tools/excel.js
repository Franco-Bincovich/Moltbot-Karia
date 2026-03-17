const xlsx = require('xlsx');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

const ANALYSIS_SYSTEM_PROMPT = `Sos un consultor de datos especializado en análisis de planillas de trabajo.
Analizás datos de Excel (horas, costos laborales, proyectos, clientes) y entregás conclusiones claras y accionables.

COMPORTAMIENTO:
- Si el usuario no especificó qué analizar, preguntá qué aspecto le interesa explorar.
- Si sí especificó, respondé directamente con el análisis.
- Destacá siempre los números más relevantes (máximos, mínimos, totales, promedios).
- Hacé recomendaciones cuando los datos lo justifiquen.
- Usá tablas markdown para mostrar rankings o comparativas.
- Respondé en español, tono profesional pero directo.`;

/**
 * Convierte un buffer de Excel a texto estructurado (una tabla por hoja).
 * Limita a 300 filas por hoja para no exceder el contexto.
 */
function parseExcelBuffer(buffer) {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const parts = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (rows.length === 0) continue;

    const limited = rows.slice(0, 300);
    const totalRows = rows.length;
    const truncated = totalRows > 300 ? ` (mostrando primeras 300 de ${totalRows} filas)` : '';

    const table = limited.map((row) => row.map(String).join('\t')).join('\n');
    parts.push(`### Hoja: "${sheetName}"${truncated}\n\`\`\`\n${table}\n\`\`\``);
  }

  return parts.length > 0 ? parts.join('\n\n') : 'El archivo Excel no contiene datos.';
}

/**
 * Analiza datos de Excel usando Claude con un prompt especializado en datos.
 * @param {string} excelData - Texto con los datos del Excel (output de parseExcelBuffer)
 * @param {string} question - Qué analizar
 * @param {string} analysisType - Tipo de análisis: horas | costos | comparativa | resumen | otro
 */
async function analyzeExcel(excelData, question, analysisType) {
  const typeHint = analysisType && analysisType !== 'otro'
    ? `Tipo de análisis solicitado: ${analysisType}.`
    : '';

  const userMessage = `${typeHint}\n\nDatos del archivo Excel:\n\n${excelData}\n\n---\n\nPregunta o pedido: ${question}`.trim();

  console.log(`[excel] Analizando Excel. Tipo: ${analysisType} | Pregunta: "${question}"`);
  console.log(`[excel] Tamaño de datos: ${excelData.length} caracteres`);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: ANALYSIS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

module.exports = { parseExcelBuffer, analyzeExcel };
