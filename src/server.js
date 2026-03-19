require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { handleChat } = require('./agent');
const { parseExcelBuffer } = require('./tools/excel');
const mammoth = require('mammoth');

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic();

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

console.log('[server] SUPABASE_SERVICE_KEY (primeros 20 chars):', process.env.SUPABASE_SERVICE_KEY?.slice(0, 20) ?? 'NO CONFIGURADA');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
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

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// === Sessions ===

// Generate a 2-4 word session name using Claude
async function generateSessionName(firstMessage) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      messages: [{
        role: 'user',
        content: `Generá un nombre de 2 a 4 palabras en español para una conversación que empieza con: "${firstMessage.slice(0, 200)}". Respondé SOLO el nombre, sin puntuación ni comillas.`,
      }],
    });
    return response.content[0]?.text?.trim() || firstMessage.slice(0, 30);
  } catch (err) {
    console.error('[sessions] Error generando nombre:', err.message);
    return firstMessage.slice(0, 30);
  }
}

// Create a new session
app.post('/api/sessions', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase no configurado.' });

  const { firstMessage } = req.body;
  if (!firstMessage) return res.status(400).json({ error: 'firstMessage requerido.' });

  const nombre = await generateSessionName(firstMessage);
  console.log(`[sessions] Creando sesión: "${nombre}"`);

  const { data, error } = await supabase
    .from('sesiones')
    .insert({ nombre, iniciada_at: new Date().toISOString() })
    .select('id, nombre')
    .single();

  if (error) {
    console.error('[sessions] Error creando sesión:', error.message);
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

// List sessions (most recent first)
app.get('/api/sessions', async (req, res) => {
  if (!supabase) return res.json([]);

  const { data, error } = await supabase
    .from('sesiones')
    .select('id, nombre, iniciada_at')
    .order('iniciada_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('[sessions] Error listando sesiones:', error.message);
    return res.status(500).json({ error: error.message });
  }

  res.json(data || []);
});

// Load messages for a session
app.get('/api/sessions/:id/messages', async (req, res) => {
  if (!supabase) return res.json([]);

  const { data, error } = await supabase
    .from('conversaciones')
    .select('rol, contenido, created_at')
    .eq('sesion_id', req.params.id)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[sessions] Error cargando mensajes:', error.message);
    return res.status(500).json({ error: error.message });
  }

  res.json(data || []);
});

// === Downloads ===
app.get('/download/:filename', (req, res) => {
  const filePath = path.join('/tmp', req.params.filename);
  if (!require('fs').existsSync(filePath)) {
    return res.status(404).json({ error: 'Archivo no encontrado.' });
  }
  res.download(filePath);
});

// === Chat ===
app.post('/api/chat', upload.single('file'), async (req, res) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] /api/chat recibido`);

  const message = req.body.message || '';
  const history = req.body.history
    ? (typeof req.body.history === 'string' ? JSON.parse(req.body.history) : req.body.history)
    : [];
  const sesionId = req.body.sesion_id
    ? (typeof req.body.sesion_id === 'string' ? parseInt(req.body.sesion_id, 10) : req.body.sesion_id)
    : null;

  const hasFile = !!req.file;
  const hasMessage = message.trim().length > 0;

  if (!hasMessage && !hasFile) {
    return res.status(400).json({ error: 'El mensaje o un archivo son requeridos.' });
  }

  console.log(`[${ts}] Mensaje: "${message}" | Archivo: ${hasFile ? req.file.originalname : 'ninguno'} | Sesión: ${sesionId} | Historial: ${history.length} turnos`);

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
    console.log(`[${new Date().toISOString()}] handleChat completado. Primeros 200 chars: ${String(reply).slice(0, 200)}`);

    // Save messages to Supabase if sesion_id provided
    if (supabase && sesionId) {
      const now = new Date().toISOString();
      const userContent = message || (hasFile ? `[Archivo: ${req.file.originalname}]` : '');
      try {
        await supabase.from('conversaciones').insert([
          { sesion_id: sesionId, rol: 'user', contenido: userContent, created_at: now },
          { sesion_id: sesionId, rol: 'assistant', contenido: reply, created_at: now },
        ]);
      } catch (dbErr) {
        console.error('[db] Error guardando conversación:', dbErr.message);
      }
    }

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
  console.log(`[${new Date().toISOString()}] Supabase: ${supabase ? 'OK' : 'NO CONFIGURADO'}`);
  console.log(`[${new Date().toISOString()}] ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'OK' : 'NO CONFIGURADA'}`);
});
