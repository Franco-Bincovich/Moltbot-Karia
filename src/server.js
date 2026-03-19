require('dotenv').config();
const express = require('express');
// Protección de headers HTTP (XSS, clickjacking, MIME sniffing, etc.)
const helmet = require('helmet');
// Limitación de requests por IP para prevenir abuso y fuerza bruta
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { handleChat } = require('./agent');
const { parseExcelBuffer } = require('./tools/excel');
const mammoth = require('mammoth');
// Middlewares de validación y sanitización de inputs
const { validarLogin, validarCrearSesion, validarChat } = require('./middlewares/validaciones');
const { manejarErroresValidacion } = require('./middlewares/manejarErroresValidacion');

// === Inicialización ===

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic();

// Cliente de Supabase con service key para bypasear RLS en operaciones del servidor
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

// === Helpers ===

/**
 * Maneja errores de operaciones Supabase de forma centralizada.
 * Loguea el error con contexto y lanza una excepción descriptiva en español.
 * @param {object} error - Objeto de error de Supabase
 * @param {string} operacion - Descripción de la operación que falló (ej: "crear sesión")
 * @throws {Error} Error descriptivo con el nombre de la operación
 */
function handleSupabaseError(error, operacion) {
  console.error(`[supabase] Error en ${operacion}: ${error.message} (código: ${error.code || 'N/A'})`);
  throw new Error(`Error al ${operacion}. Intentá de nuevo.`);
}

/**
 * Valida que Supabase esté configurado antes de operar.
 * Si no está configurado, responde 500 directamente.
 * @param {object} res - Response de Express
 * @returns {boolean} true si Supabase NO está disponible (ya respondió al cliente)
 */
function supabaseNoDisponible(res) {
  if (!supabase) {
    res.status(500).json({ error: 'Base de datos no configurada. Contactá al administrador.' });
    return true;
  }
  return false;
}

// === Configuración de Multer ===

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

// === Middlewares globales ===

// Headers de seguridad HTTP (X-Content-Type-Options, X-Frame-Options, HSTS, etc.)
// CSP deshabilitado para no interferir con el frontend actual (inline scripts/styles)
app.use(helmet({ contentSecurityPolicy: false }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// === Rate Limiting ===

// Protección contra fuerza bruta en login: 10 intentos cada 15 minutos por IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de login. Intentá de nuevo en 15 minutos.' },
});

// Límite general para endpoints de la API: 100 requests cada 15 minutos por IP
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intentá de nuevo en unos minutos.' },
});

// Límite específico para el chat: 30 mensajes cada 15 minutos por IP
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados mensajes enviados. Esperá unos minutos antes de continuar.' },
});

// Aplicar límite general a todos los endpoints /api/ excepto login (tiene su propio limiter)
app.use('/api/', apiLimiter);

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
 * Compara password con bcrypt(md5(contraseña)) y retorna un JWT firmado.
 */
app.post('/api/login', loginLimiter, validarLogin, manejarErroresValidacion, async (req, res) => {
  if (supabaseNoDisponible(res)) return;

  const { email, password } = req.body;

  try {
    const { data: usuario, error } = await supabase
      .from('usuarios')
      .select('id, email, nombre, rol, password_hash')
      .eq('email', email)
      .single();

    // Error de Supabase distinto a "no encontrado" → fallo real de DB
    if (error && error.code !== 'PGRST116') {
      handleSupabaseError(error, 'buscar usuario');
    }

    if (!usuario) {
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    // Comparar password con hash bcrypt almacenado.
    // El hash en DB es bcrypt(md5(contraseña)), así que primero hasheamos
    // el input con MD5 y luego comparamos contra el bcrypt almacenado.
    const md5Input = crypto.createHash('md5').update(password).digest('hex');
    const passwordValido = await bcrypt.compare(md5Input, usuario.password_hash);
    if (!passwordValido) {
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
  } catch (err) {
    console.error('[auth] Error en login:', err.message);
    res.status(500).json({ error: 'Error al iniciar sesión. Intentá de nuevo.' });
  }
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
app.post('/api/sessions', authenticateToken, validarCrearSesion, manejarErroresValidacion, async (req, res) => {
  if (supabaseNoDisponible(res)) return;

  const { firstMessage } = req.body;

  try {
    const nombre = await generateSessionName(firstMessage);
    console.log(`[sessions] Creando sesión: "${nombre}"`);

    const { data, error } = await supabase
      .from('sesiones')
      .insert({ nombre, usuario_id: req.user.usuario_id, iniciada_at: new Date().toISOString() })
      .select('id, nombre')
      .single();

    if (error) handleSupabaseError(error, 'crear sesión');

    res.json(data);
  } catch (err) {
    console.error('[sessions] Error creando sesión:', err.message);
    res.status(500).json({ error: 'No se pudo crear la sesión. Intentá de nuevo.' });
  }
});

/** GET /api/sessions — Lista las últimas 50 sesiones del usuario autenticado. */
app.get('/api/sessions', authenticateToken, async (req, res) => {
  if (supabaseNoDisponible(res)) return;

  try {
    const { data, error } = await supabase
      .from('sesiones')
      .select('id, nombre, iniciada_at')
      .eq('usuario_id', req.user.usuario_id)
      .order('iniciada_at', { ascending: false })
      .limit(50);

    if (error) handleSupabaseError(error, 'listar sesiones');

    res.json(data || []);
  } catch (err) {
    console.error('[sessions] Error listando sesiones:', err.message);
    res.status(500).json({ error: 'No se pudieron cargar las sesiones.' });
  }
});

/** GET /api/sessions/:id/messages — Carga los mensajes de una sesión, excluye rol "system".
 *  Valida que la sesión pertenezca al usuario autenticado antes de devolver los mensajes. */
app.get('/api/sessions/:id/messages', authenticateToken, async (req, res) => {
  if (supabaseNoDisponible(res)) return;

  try {
    // Verificar que la sesión pertenece al usuario del JWT
    const { data: sesion, error: sesionError } = await supabase
      .from('sesiones')
      .select('id')
      .eq('id', req.params.id)
      .eq('usuario_id', req.user.usuario_id)
      .single();

    if (sesionError || !sesion) {
      return res.status(403).json({ error: 'Acceso denegado a esta sesión.' });
    }

    const { data, error } = await supabase
      .from('conversaciones')
      .select('rol, contenido, created_at')
      .eq('sesion_id', req.params.id)
      .neq('rol', 'system')
      .order('created_at', { ascending: true });

    if (error) handleSupabaseError(error, 'cargar mensajes de sesión');

    res.json(data || []);
  } catch (err) {
    console.error('[sessions] Error cargando mensajes:', err.message);
    res.status(500).json({ error: 'No se pudieron cargar los mensajes de esta sesión.' });
  }
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
 *
 * Orden de middlewares: multer debe ejecutarse antes de validarChat porque
 * necesita parsear el multipart/form-data para que express-validator pueda
 * leer los campos de texto del body.
 */
app.post('/api/chat', chatLimiter, authenticateToken, upload.single('file'), validarChat, manejarErroresValidacion, async (req, res) => {
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

    // Guardar mensajes en Supabase (operación no crítica: si falla, el usuario igual recibe la respuesta)
    if (supabase && sesionId) {
      const now = new Date().toISOString();
      const userContent = message || (hasFile ? `[Archivo: ${req.file.originalname}]` : '');
      const { error: insertError } = await supabase.from('conversaciones').insert([
        { sesion_id: sesionId, rol: 'user', contenido: userContent, created_at: now },
        { sesion_id: sesionId, rol: 'assistant', contenido: reply, created_at: now },
      ]);
      if (insertError) {
        // No crítico: logueamos pero no interrumpimos la respuesta al usuario
        console.error(`[supabase] Error guardando conversación en sesión ${sesionId}: ${insertError.message} (código: ${insertError.code || 'N/A'})`);
      }
    }

    const result = { reply };
    if (excelContext) result.excelContext = excelContext;
    if (wordContext) result.wordContext = wordContext;

    res.json(result);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error en /api/chat:`, err.message);
    console.error(err.stack);
    res.status(500).json({ error: 'Error interno del agente. Intentá de nuevo.' });
  }
});

// === Inicio del servidor ===

app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Karia Agent corriendo en http://localhost:${PORT}`);
  console.log(`[${new Date().toISOString()}] Supabase: ${supabase ? 'OK' : 'NO CONFIGURADO'}`);
  console.log(`[${new Date().toISOString()}] ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'OK' : 'NO CONFIGURADA'}`);
  console.log(`[${new Date().toISOString()}] JWT_SECRET: ${process.env.JWT_SECRET ? 'OK' : 'NO CONFIGURADO'}`);
});
