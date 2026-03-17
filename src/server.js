require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const { handleChat } = require('./agent');
const { parseExcelBuffer } = require('./tools/excel');

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(xlsx|xls)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos Excel (.xlsx, .xls)'));
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

  // Con multipart el body viene como strings; con JSON viene parseado
  const message = req.body.message || '';
  const history = req.body.history
    ? (typeof req.body.history === 'string' ? JSON.parse(req.body.history) : req.body.history)
    : [];

  const hasFile = !!req.file;
  const hasMessage = message.trim().length > 0;

  if (!hasMessage && !hasFile) {
    return res.status(400).json({ error: 'El mensaje o un archivo Excel son requeridos.' });
  }

  console.log(`[${ts}] Mensaje: "${message}" | Archivo: ${hasFile ? req.file.originalname : 'ninguno'} | Historial: ${history.length} turnos`);

  let excelContext = null;
  if (hasFile) {
    try {
      console.log(`[${ts}] Parseando Excel: ${req.file.originalname} (${req.file.size} bytes)`);
      excelContext = parseExcelBuffer(req.file.buffer);
      console.log(`[${ts}] Excel parseado: ${excelContext.length} caracteres`);
    } catch (err) {
      console.error(`[${ts}] Error al parsear Excel:`, err.message);
      return res.status(400).json({ error: `No se pudo leer el archivo Excel: ${err.message}` });
    }
  }

  try {
    console.log(`[${ts}] Llamando a handleChat...`);
    const reply = await handleChat(message, history, excelContext);
    console.log(`[${new Date().toISOString()}] handleChat completado. Respuesta (primeros 200 chars): ${String(reply).slice(0, 200)}`);
    const result = { reply };
    if (excelContext) result.excelContext = excelContext;
    res.json(result);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error en /api/chat:`, err.message);
    console.error(err.stack);
    res.status(500).json({ error: 'Error interno del agente.' });
  }
});

app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Moltbot KarIA corriendo en http://localhost:${PORT}`);
  console.log(`[${new Date().toISOString()}] PERPLEXITY_API_KEY: ${process.env.PERPLEXITY_API_KEY ? 'OK' : 'NO CONFIGURADA'}`);
  console.log(`[${new Date().toISOString()}] ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'OK' : 'NO CONFIGURADA'}`);
});
