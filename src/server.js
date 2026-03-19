require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { handleChat } = require('./agent');
const { parseExcelBuffer } = require('./tools/excel');
const mammoth = require('mammoth');

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic();

// Cliente de Supabase con service key para bypasear RLS en operaciones del servidor
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

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

// === Autenticación ===

/**
 * Middleware que valida el JWT en el header Authorization.
 * Si el token es inválido o expiró, retorna 401.
 * Si es válido, adjunta el payload decodificado en req.user.
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // formato: "Bearer <token>"

  if (!token) return res.status(401).json({ error: 'Token requerido.' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado.' });
  }
}

/**
 * POST /api/login — Autentica al usuario contra la tabla "usuarios" en Supabase.
 * Valida el password con MD5 y retorna un JWT firmado con los datos del usuario.
 */
app.post('/api/login', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase no configurado.' });

  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y password requeridos.' });

  // Hashear password con MD5 para comparar contra la tabla
  const passwordHash = crypto.createHash('md5').update(password).digest('hex');

  const { data: usuario, error } = await supabase
    .from('usuarios')
    .select('id, email, nombre, rol, password_hash')
    .eq('email', email)
    .single();

  if (error || !usuario || usuario.password_hash !== passwordHash) {
    return res.status(401).json({ error: 'Credenciales inválidas.' });
  }

  // Generar JWT con datos del usuario, expira en 8 horas
  const token = jwt.sign(
    { usuario_id: usuario.id, email: usuario.email, nombre: usuario.nombre, rol: usuario.rol },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );

  console.log(`[auth] Login exitoso: ${usuario.email} (rol: ${usuario.rol})`);
  res.json({ token, usuario: { nombre: usuario.nombre, email: usuario.email, rol: usuario.rol } });
});

// === Sesiones ===

/**
 * Genera un nombre de 2-4 palabras en español para una sesión,
 * basado en el primer mensaje del usuario. Usa Claude Haiku por velocidad.
 */
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

/** POST /api/sessions — Crea una sesión nueva con nombre generado por IA. */
app.post('/api/sessions', authenticateToken, async (req, res) => {
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

/** GET /api/sessions — Lista las últimas 50 sesiones ordenadas por fecha. */
app.get('/api/sessions', authenticateToken, async (req, res) => {
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

/** GET /api/sessions/:id/messages — Carga los mensajes de una sesión, excluye rol "system". */
app.get('/api/sessions/:id/messages', authenticateToken, async (req, res) => {
  if (!supabase) return res.json([]);

  const { data, error } = await supabase
    .from('conversaciones')
    .select('rol, contenido, created_at')
    .eq('sesion_id', req.params.id)
    .neq('rol', 'system')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[sessions] Error cargando mensajes:', error.message);
    return res.status(500).json({ error: error.message });
  }

  res.json(data || []);
});

// === Descargas ===

/** GET /download/:filename — Sirve archivos generados desde /tmp (Word, Excel, PDF). */
app.get('/download/:filename', (req, res) => {
  const filePath = path.join('/tmp', req.params.filename);
  if (!require('fs').existsSync(filePath)) {
    return res.status(404).json({ error: 'Archivo no encontrado.' });
  }
  res.download(filePath);
});

// === Chat ===

/**
 * POST /api/chat — Endpoint principal del agente.
 * Acepta mensaje de texto y/o archivo adjunto (Excel/Word).
 * Parsea el archivo, llama al agente con el rol del usuario y guarda en Supabase.
 */
app.post('/api/chat', authenticateToken, upload.single('file'), async (req, res) => {
  const ts = new Date().toISOString();
  const { usuario_id, rol } = req.user;

  const message = req.body.message || '';
  const history = req.body.history
    ? (typeof req.body.history === 'string' ? JSON.parse(req.body.history) : req.body.history)
    : [];
  const sesionId = req.body.sesion_id || null;

  const hasFile = !!req.file;
  const hasMessage = message.trim().length > 0;

  if (!hasMessage && !hasFile) {
    return res.status(400).json({ error: 'El mensaje o un archivo son requeridos.' });
  }

  console.log(`[${ts}] Mensaje: "${message}" | Archivo: ${hasFile ? req.file.originalname : 'ninguno'} | Sesión: ${sesionId} | Rol: ${rol}`);

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
    // Pasar usuario_id y rol al agente para tool-filtering por rol
    const reply = await handleChat(message, history, excelContext, usuario_id, wordContext, rol);

    // Guardar mensajes en Supabase si hay sesión activa
    if (supabase && sesionId) {
      const now = new Date().toISOString();
      const userContent = message || (hasFile ? `[Archivo: ${req.file.originalname}]` : '');
      const { error: insertError } = await supabase.from('conversaciones').insert([
        { sesion_id: sesionId, rol: 'user', contenido: userContent, created_at: now },
        { sesion_id: sesionId, rol: 'assistant', contenido: reply, created_at: now },
      ]);
      if (insertError) {
        console.error(`[db] Error guardando conversación en sesión ${sesionId}:`, insertError.message);
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
  console.log(`[${new Date().toISOString()}] JWT_SECRET: ${process.env.JWT_SECRET ? 'OK' : 'NO CONFIGURADO'}`);
});
