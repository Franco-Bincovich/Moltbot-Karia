const xlsx = require('xlsx');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

const MAX_CONTEXT_CHARS = 20000;
const MAX_ROWS = 150;

const ANALYSIS_SYSTEM_PROMPT = `Sos un consultor de datos especializado en análisis de planillas de trabajo.
Analizás datos de Excel (horas, costos laborales, proyectos, clientes) y entregás conclusiones claras y accionables.

COMPORTAMIENTO:
- Si el usuario no especificó qué analizar, preguntá qué aspecto le interesa explorar.
- Si sí especificó, respondé directamente con el análisis.
- Destacá siempre los números más relevantes (máximos, mínimos, totales, promedios).
- Hacé recomendaciones cuando los datos lo justifiquen.
- Usá tablas markdown para mostrar rankings o comparativas.
- Respondé en español, tono profesional pero directo.`;

// Columnas relevantes por tipo de análisis
const COLUMNS_BY_TYPE = {
  horas: ['nombre', 'fecha', 'mes', 'año', 'ano', 'horas trabajadas', 'horas', 'cliente', 'proyecto'],
  costos: ['nombre', 'mes', 'año', 'ano', 'horas trabajadas', 'horas', 'sueldo hora', 'sueldo', 'costo laboral', 'costo'],
  comparativa: ['nombre', 'mes', 'horas trabajadas', 'horas', 'sueldo hora', 'sueldo'],
};

/**
 * Convierte un buffer de Excel a texto estructurado (una tabla por hoja).
 * Limita a MAX_ROWS filas por hoja para no exceder el contexto.
 * Trunca el resultado total a MAX_CONTEXT_CHARS.
 */
function parseExcelBuffer(buffer) {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const parts = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (rows.length === 0) continue;

    const limited = rows.slice(0, MAX_ROWS);
    const totalRows = rows.length;
    const truncated = totalRows > MAX_ROWS ? ` (mostrando primeras ${MAX_ROWS} de ${totalRows} filas)` : '';

    const table = limited.map((row) => row.map(String).join('\t')).join('\n');
    parts.push(`### Hoja: "${sheetName}"${truncated}\n\`\`\`\n${table}\n\`\`\``);
  }

  let result = parts.length > 0 ? parts.join('\n\n') : 'El archivo Excel no contiene datos.';

  // Truncar si excede el límite
  if (result.length > MAX_CONTEXT_CHARS) {
    result = result.slice(0, MAX_CONTEXT_CHARS) + '\n\n[... datos truncados por límite de contexto]';
  }

  return result;
}

/**
 * Filtra las columnas de los datos del Excel según el tipo de análisis.
 * Solo mantiene las columnas relevantes para reducir tokens enviados a Claude.
 */
function filterColumnsByType(excelData, analysisType) {
  const allowedColumns = COLUMNS_BY_TYPE[analysisType];
  if (!allowedColumns) return excelData;

  // Parsear el texto del excel para filtrar columnas
  const sections = excelData.split('### Hoja:');
  const filtered = [];

  for (const section of sections) {
    if (!section.trim()) continue;

    const codeBlockMatch = section.match(/```\n([\s\S]*?)```/);
    if (!codeBlockMatch) {
      filtered.push('### Hoja:' + section);
      continue;
    }

    const headerLine = section.split('```\n')[0];
    const tableText = codeBlockMatch[1];
    const rows = tableText.split('\n').filter((r) => r.trim());

    if (rows.length === 0) {
      filtered.push('### Hoja:' + section);
      continue;
    }

    // Primera fila = headers
    const headers = rows[0].split('\t');
    const keepIndices = [];

    for (let i = 0; i < headers.length; i++) {
      const h = headers[i].toLowerCase().trim();
      if (allowedColumns.some((col) => h.includes(col))) {
        keepIndices.push(i);
      }
    }

    // Si no matcheó ninguna columna, devolver todo (mejor que nada)
    if (keepIndices.length === 0) {
      filtered.push('### Hoja:' + section);
      continue;
    }

    const filteredRows = rows.map((row) => {
      const cells = row.split('\t');
      return keepIndices.map((i) => cells[i] || '').join('\t');
    });

    filtered.push(`### Hoja:${headerLine}\`\`\`\n${filteredRows.join('\n')}\n\`\`\``);
  }

  let result = filtered.join('\n\n');

  if (result.length > MAX_CONTEXT_CHARS) {
    result = result.slice(0, MAX_CONTEXT_CHARS) + '\n\n[... datos truncados por límite de contexto]';
  }

  return result;
}

/**
 * Analiza datos de Excel usando Claude con un prompt especializado en datos.
 * @param {string} excelData - Texto con los datos del Excel (output de parseExcelBuffer)
 * @param {string} question - Qué analizar
 * @param {string} analysisType - Tipo de análisis: horas | costos | comparativa | resumen | otro
 */
async function analyzeExcel(excelData, question, analysisType) {
  // Filtrar columnas según tipo de análisis para reducir contexto
  const filteredData = filterColumnsByType(excelData, analysisType);

  const typeHint = analysisType && analysisType !== 'otro'
    ? `Tipo de análisis solicitado: ${analysisType}.`
    : '';

  const userMessage = `${typeHint}\n\nDatos del archivo Excel:\n\n${filteredData}\n\n---\n\nPregunta o pedido: ${question}`.trim();

  console.log(`[excel] Analizando Excel. Tipo: ${analysisType} | Pregunta: "${question}"`);
  console.log(`[excel] Tamaño de datos original: ${excelData.length} chars | Filtrado: ${filteredData.length} chars`);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: ANALYSIS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

module.exports = { parseExcelBuffer, analyzeExcel };
