const xlsx = require('xlsx');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

const MAX_CONTEXT_CHARS = 20000;

const ANALYSIS_SYSTEM_PROMPT = `Sos un consultor de datos especializado en análisis de planillas de trabajo.
Analizás datos de Excel (horas, costos laborales, proyectos, clientes) y entregás conclusiones claras y accionables.

COMPORTAMIENTO:
- Si el usuario no especificó qué analizar, preguntá qué aspecto le interesa explorar.
- Si sí especificó, respondé directamente con el análisis.
- Destacá siempre los números más relevantes (máximos, mínimos, totales, promedios).
- Hacé recomendaciones cuando los datos lo justifiquen.
- Usá tablas markdown para mostrar rankings o comparativas.
- Respondé en español, tono profesional pero directo.`;

// Columnas esenciales a mantener (match parcial, case-insensitive)
const ESSENTIAL_COLUMNS = [
  'nombre', 'mes', 'año', 'ano', 'fecha',
  'horas trabajadas', 'horas',
  'sueldo hora', 'sueldo',
  'costo laboral', 'costo',
  'cliente', 'proyecto',
];

// Columnas a eliminar explícitamente (match parcial, case-insensitive)
const EXCLUDED_COLUMNS = [
  'concatenada', 'revisar cliente', 'revisar fecha', 'revisar tarea',
  'revisar horas', 'revisar total', 'modalidad trabajo', 'modalidad',
  'mail', 'cuit', 'semana del año', 'semana del ano',
];

/**
 * Determina si una columna debe mantenerse.
 * Mantiene si está en ESSENTIAL_COLUMNS o si no está en EXCLUDED_COLUMNS.
 */
function shouldKeepColumn(headerName) {
  const h = headerName.toLowerCase().trim();
  if (!h) return false;

  // Si está explícitamente excluida, eliminar
  if (EXCLUDED_COLUMNS.some((exc) => h.includes(exc))) return false;

  // Si matchea con una esencial, mantener
  if (ESSENTIAL_COLUMNS.some((ess) => h.includes(ess))) return true;

  // Columnas no reconocidas: eliminar para reducir contexto
  return false;
}

/**
 * Convierte un buffer de Excel a texto estructurado.
 * Lee TODAS las filas pero solo mantiene columnas esenciales.
 * Trunca el resultado total a MAX_CONTEXT_CHARS como seguridad.
 */
function parseExcelBuffer(buffer) {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const parts = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (rows.length === 0) continue;

    // Identificar qué columnas mantener basándose en los headers (fila 0)
    const headers = rows[0];
    const keepIndices = [];
    for (let i = 0; i < headers.length; i++) {
      if (shouldKeepColumn(String(headers[i]))) {
        keepIndices.push(i);
      }
    }

    // Si no se detectaron columnas esenciales, mantener todas (fallback)
    const indices = keepIndices.length > 0 ? keepIndices : headers.map((_, i) => i);

    // Filtrar columnas de todas las filas
    const filteredRows = rows.map((row) =>
      indices.map((i) => String(row[i] || '')).join('\t')
    );

    const totalRows = rows.length - 1; // sin contar header
    const colsKept = indices.length;
    const colsTotal = headers.length;
    const colInfo = colsKept < colsTotal ? ` (${colsKept} de ${colsTotal} columnas)` : '';

    const table = filteredRows.join('\n');
    parts.push(`### Hoja: "${sheetName}" — ${totalRows} filas${colInfo}\n\`\`\`\n${table}\n\`\`\``);
  }

  let result = parts.length > 0 ? parts.join('\n\n') : 'El archivo Excel no contiene datos.';

  if (result.length > MAX_CONTEXT_CHARS) {
    result = result.slice(0, MAX_CONTEXT_CHARS) + '\n\n[... datos truncados por límite de contexto]';
  }

  return result;
}

/**
 * Filtra las filas del excelData para incluir solo las de una persona específica.
 * Busca en la columna "nombre" (la primera columna después del filtrado).
 */
function filterByPerson(excelData, personName) {
  if (!personName) return excelData;

  const searchName = personName.toLowerCase().trim();
  const sections = excelData.split('### Hoja:');
  const filtered = [];

  for (const section of sections) {
    if (!section.trim()) continue;

    const codeBlockMatch = section.match(/```\n([\s\S]*?)```/);
    if (!codeBlockMatch) {
      filtered.push('### Hoja:' + section);
      continue;
    }

    const headerPart = section.split('```\n')[0];
    const tableText = codeBlockMatch[1];
    const rows = tableText.split('\n').filter((r) => r.trim());

    if (rows.length === 0) {
      filtered.push('### Hoja:' + section);
      continue;
    }

    const headerRow = rows[0];
    const headers = headerRow.split('\t').map((h) => h.toLowerCase().trim());

    // Buscar índice de la columna "nombre"
    const nameIdx = headers.findIndex((h) => h.includes('nombre'));

    if (nameIdx === -1) {
      // No hay columna nombre, devolver todo
      filtered.push('### Hoja:' + section);
      continue;
    }

    // Filtrar: mantener header + filas que matcheen el nombre
    const matchedRows = [headerRow];
    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i].split('\t');
      const cellName = (cells[nameIdx] || '').toLowerCase().trim();
      if (cellName.includes(searchName) || searchName.includes(cellName)) {
        matchedRows.push(rows[i]);
      }
    }

    const matchCount = matchedRows.length - 1;
    filtered.push(`### Hoja:${headerPart}(filtrado: ${matchCount} filas de "${personName}")\n\`\`\`\n${matchedRows.join('\n')}\n\`\`\``);
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
 * @param {string|null} personFilter - Nombre de persona para filtrar filas (opcional)
 */
async function analyzeExcel(excelData, question, analysisType, personFilter = null) {
  // Filtrar por persona si se especificó
  const filteredData = filterByPerson(excelData, personFilter);

  const typeHint = analysisType && analysisType !== 'otro'
    ? `Tipo de análisis solicitado: ${analysisType}.`
    : '';

  const userMessage = `${typeHint}\n\nDatos del archivo Excel:\n\n${filteredData}\n\n---\n\nPregunta o pedido: ${question}`.trim();

  console.log(`[excel] Analizando Excel. Tipo: ${analysisType} | Persona: ${personFilter || 'todas'} | Pregunta: "${question}"`);
  console.log(`[excel] Tamaño de datos original: ${excelData.length} chars | Enviado: ${filteredData.length} chars`);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: ANALYSIS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

module.exports = { parseExcelBuffer, analyzeExcel };
