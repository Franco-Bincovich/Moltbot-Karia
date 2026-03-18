require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { handleChat } = require('./agent');
const { parseExcelBuffer } = require('./tools/excel');

// Supabase client
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;

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

// Login endpoint
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña son requeridos.' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Supabase no configurado. Verificar SUPABASE_URL y SUPABASE_ANON_KEY en .env.' });
  }

  try {
    const passwordHash = crypto.createHash('md5').update(password).digest('hex');

    const { data, error } = await supabase
      .from('usuarios')
      .select('id, nombre, email')
      .eq('email', email.toLowerCase().trim())
      .eq('password', passwordHash)
      .single();

    if (error || !data) {
      console.log(`[auth] Login fallido para: ${email}`);
      return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
    }

    console.log(`[auth] Login exitoso: ${data.nombre} (${data.email})`);
    res.json({ usuario_id: data.id, nombre: data.nombre, email: data.email });
  } catch (err) {
    console.error('[auth] Error en login:', err.message);
    res.status(500).json({ error: 'Error interno al verificar credenciales.' });
  }
});

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
  const usuarioId = req.body.usuario_id
    ? (typeof req.body.usuario_id === 'string' ? parseInt(req.body.usuario_id, 10) : req.body.usuario_id)
    : null;

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
    const reply = await handleChat(message, history, excelContext, usuarioId);
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
  console.log(`[${new Date().toISOString()}] Búsqueda web: Claude web_search (nativa)`);
  console.log(`[${new Date().toISOString()}] ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'OK' : 'NO CONFIGURADA'}`);
});
