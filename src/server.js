require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const { handleChat } = require('./agent');
const { parseExcelBuffer } = require('./tools/excel');
const mammoth = require('mammoth');

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
    ];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(xlsx|xls|docx|doc)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos Excel (.xlsx, .xls) o Word (.doc, .docx)'));
    }
  },
});

// Log de cada request entrante
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Endpoint de descarga de archivos exportados
app.get('/download/:filename', (req, res) => {
  const filePath = path.join('/tmp', req.params.filename);
  if (!require('fs').existsSync(filePath)) {
    return res.status(404).json({ error: 'Archivo no encontrado.' });
  }
  res.download(filePath);
});

app.post('/api/chat', upload.single('file'), async (req, res) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] /api/chat recibido`);

  const message = req.body.message || '';
  const history = req.body.history
    ? (typeof req.body.history === 'string' ? JSON.parse(req.body.history) : req.body.history)
    : [];

  const hasFile = !!req.file;
  const hasMessage = message.trim().length > 0;

  if (!hasMessage && !hasFile) {
    return res.status(400).json({ error: 'El mensaje o un archivo son requeridos.' });
  }

  console.log(`[${ts}] Mensaje: "${message}" | Archivo: ${hasFile ? req.file.originalname : 'ninguno'} | Historial: ${history.length} turnos`);

  let excelContext = null;
  let wordContext = null;

  if (hasFile) {
    const isExcel = req.file.originalname.match(/\.(xlsx|xls)$/i);
    const isWord = req.file.originalname.match(/\.(docx|doc)$/i);

    if (isExcel) {
      try {
        console.log(`[${ts}] Parseando Excel: ${req.file.originalname} (${req.file.size} bytes)`);
        excelContext = parseExcelBuffer(req.file.buffer);
        console.log(`[${ts}] Excel parseado: ${excelContext.length} caracteres`);
      } catch (err) {
        console.error(`[${ts}] Error al parsear Excel:`, err.message);
        return res.status(400).json({ error: `No se pudo leer el archivo Excel: ${err.message}` });
      }
    } else if (isWord) {
      try {
        console.log(`[${ts}] Parseando Word: ${req.file.originalname} (${req.file.size} bytes)`);
        const result = await mammoth.extractRawText({ buffer: req.file.buffer });
        wordContext = result.value;
        console.log(`[${ts}] Word parseado: ${wordContext.length} caracteres`);
      } catch (err) {
        console.error(`[${ts}] Error al parsear Word:`, err.message);
        return res.status(400).json({ error: `No se pudo leer el archivo Word: ${err.message}` });
      }
    }
  }

  try {
    console.log(`[${ts}] Llamando a handleChat...`);
    const reply = await handleChat(message, history, excelContext, null, wordContext);
    console.log(`[${new Date().toISOString()}] handleChat completado. Respuesta (primeros 200 chars): ${String(reply).slice(0, 200)}`);

    const result = { reply };
    if (excelContext) result.excelContext = excelContext;
    if (wordContext) result.wordContext = wordContext;

    res.json(result);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error en /api/chat:`, err.message);
    console.error(err.stack);
    res.status(500).json({ error: 'Error interno del agente.' });
  }
});

app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Karia Agent corriendo en http://localhost:${PORT}`);
  console.log(`[${new Date().toISOString()}] ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'OK' : 'NO CONFIGURADA'}`);
});
