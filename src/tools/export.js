const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle } = require('docx');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TMP_DIR = '/tmp';

// === Helpers de filesystem ===

/**
 * Verifica que el directorio temporal exista y sea escribible.
 * Puede fallar si /tmp no existe (entorno mal configurado) o si el proceso
 * no tiene permisos de escritura (container con filesystem read-only).
 * @throws {Error} Si /tmp no está disponible para escritura
 */
function verificarTmpDisponible() {
  try {
    fs.accessSync(TMP_DIR, fs.constants.W_OK);
  } catch {
    throw new Error(`No se puede escribir en ${TMP_DIR}. Verificá que el directorio exista y tenga permisos de escritura.`);
  }
}

/**
 * Escribe un buffer a disco con manejo de errores descriptivo.
 * Puede fallar por: disco lleno, permisos insuficientes, path inválido,
 * o filesystem read-only (ej: container sin volumen montado en /tmp).
 * @param {string} filePath - Ruta completa del archivo a crear
 * @param {Buffer} buffer - Contenido a escribir
 * @param {string} tipo - Tipo de archivo para el mensaje de error (ej: "Word", "Excel")
 */
function escribirArchivo(filePath, buffer, tipo) {
  try {
    fs.writeFileSync(filePath, buffer);
  } catch (err) {
    const nombre = path.basename(filePath);
    throw new Error(`No se pudo crear el archivo ${tipo} "${nombre}": ${err.message}`);
  }
}

// === Generación de documentos ===

/**
 * Genera un archivo Word (.docx) a partir de contenido markdown-like.
 * @param {string} content - Contenido en texto/markdown a convertir
 * @param {string} filename - Nombre base del archivo (sin extensión)
 * @returns {string} Ruta al archivo generado
 */
async function generateWord(content, filename) {
  verificarTmpDisponible();

  const safeName = `${filename.replace(/[^a-zA-Z0-9_-]/g, '_')}_${crypto.randomBytes(4).toString('hex')}`;
  const filePath = path.join(TMP_DIR, `${safeName}.docx`);

  const children = parseContentToParagraphs(content);

  const doc = new Document({
    sections: [{
      properties: {},
      children,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  escribirArchivo(filePath, buffer, 'Word');

  console.log(`[export] Word generado: ${filePath} (${buffer.length} bytes)`);
  return filePath;
}

/**
 * Genera un archivo Excel (.xlsx) a partir de datos tabulares.
 * @param {Array<{sheetName?: string, headers: string[], rows: string[][]}>} data - Datos a exportar
 * @param {string} filename - Nombre base del archivo (sin extensión)
 * @returns {string} Ruta al archivo generado
 */
async function generateExcel(data, filename) {
  verificarTmpDisponible();

  const safeName = `${filename.replace(/[^a-zA-Z0-9_-]/g, '_')}_${crypto.randomBytes(4).toString('hex')}`;
  const filePath = path.join(TMP_DIR, `${safeName}.xlsx`);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Moltbot KarIA';
  workbook.created = new Date();

  const sheets = Array.isArray(data) && data.length > 0 && data[0].headers ? data : [data];

  for (const sheet of sheets) {
    const sheetName = sheet.sheetName || 'Datos';
    const ws = workbook.addWorksheet(sheetName);

    if (sheet.headers && sheet.headers.length > 0) {
      const headerRow = ws.addRow(sheet.headers);
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
      headerRow.alignment = { horizontal: 'center' };
    }

    if (sheet.rows) {
      for (const row of sheet.rows) {
        ws.addRow(row);
      }
    }

    // Auto-ajustar ancho de columnas
    ws.columns.forEach((col) => {
      let maxLen = 10;
      col.eachCell({ includeEmpty: false }, (cell) => {
        const len = String(cell.value || '').length;
        if (len > maxLen) maxLen = len;
      });
      col.width = Math.min(maxLen + 2, 50);
    });
  }

  // ExcelJS escribe el archivo directamente con writeFile (async).
  // Puede fallar por disco lleno, permisos insuficientes, o path inválido.
  try {
    await workbook.xlsx.writeFile(filePath);
  } catch (err) {
    const nombre = path.basename(filePath);
    throw new Error(`No se pudo crear el archivo Excel "${nombre}": ${err.message}`);
  }

  console.log(`[export] Excel generado: ${filePath}`);
  return filePath;
}

/**
 * Parsea contenido de texto en párrafos de docx.
 */
function parseContentToParagraphs(content) {
  const lines = content.split('\n');
  const paragraphs = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('# ')) {
      paragraphs.push(new Paragraph({
        text: trimmed.slice(2),
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 200 },
      }));
    } else if (trimmed.startsWith('## ')) {
      paragraphs.push(new Paragraph({
        text: trimmed.slice(3),
        heading: HeadingLevel.HEADING_2,
        spacing: { after: 150 },
      }));
    } else if (trimmed.startsWith('### ')) {
      paragraphs.push(new Paragraph({
        text: trimmed.slice(4),
        heading: HeadingLevel.HEADING_3,
        spacing: { after: 100 },
      }));
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      paragraphs.push(new Paragraph({
        children: parseInlineFormatting(trimmed.slice(2)),
        bullet: { level: 0 },
      }));
    } else if (trimmed === '') {
      paragraphs.push(new Paragraph({ text: '' }));
    } else {
      paragraphs.push(new Paragraph({
        children: parseInlineFormatting(trimmed),
        spacing: { after: 100 },
      }));
    }
  }

  return paragraphs;
}

/**
 * Parsea formato inline (bold con **texto**) en TextRuns.
 */
function parseInlineFormatting(text) {
  const runs = [];
  const regex = /\*\*(.*?)\*\*/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push(new TextRun(text.slice(lastIndex, match.index)));
    }
    runs.push(new TextRun({ text: match[1], bold: true }));
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    runs.push(new TextRun(text.slice(lastIndex)));
  }

  return runs.length > 0 ? runs : [new TextRun(text)];
}

module.exports = { generateWord, generateExcel };
