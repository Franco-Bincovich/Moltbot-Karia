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
const { handleChat } = require('./agent');
// Cliente Supabase singleton — configuración centralizada en src/config/supabase.js
const { supabase } = require('./config/supabase');
// Cola de requests para /api/chat — limita concurrencia para no colapsar APIs externas
const { middlewareCola, obtenerEstadoCola } = require('./config/cola');
const { parseExcelBuffer } = require('./tools/excel');
const mammoth = require('mammoth');
// Middlewares de validación y sanitización de inputs
const { validarLogin, validarCrearSesion, validarChat } = require('./middlewares/validaciones');
const { manejarErroresValidacion } = require('./middlewares/manejarErroresValidacion');

// === Inicialización ===

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic();

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
//
// Orden de ejecución para cada request:
//   1. helmet         → Agrega headers de seguridad HTTP a todas las respuestas
//   2. logger         → Loguea método y URL de cada request entrante
//   3. express.json   → Parsea body JSON (para requests que no son multipart)
//   4. express.static → Sirve el frontend desde public/ (HTML, CSS, JS)
//   5. apiLimiter     → Rate limit global en /api/ (100 req / 15 min por IP)
//
// Luego, cada ruta tiene middlewares específicos en su cadena:
//   - loginLimiter / chatLimiter → Rate limits específicos
//   - authenticateToken          → Verifica JWT en Authorization header
//   - upload.single('file')      → Parsea multipart con multer (solo en /api/chat)
//   - validarX + manejarErrores  → Validación de inputs con express-validator

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
 * POST /api/login
 * Recibe: { email: string, password: string }
 * Devuelve: { token: string (JWT 8h), usuario: { nombre, email, rol } }
 * Errores: 401 credenciales inválidas, 500 error de DB
 *
 * Flujo: email → buscar en Supabase → md5(password) → bcrypt.compare → JWT
 * El hash en DB es bcrypt(md5(contraseña)) por migración histórica de MD5 a bcrypt.
 * Middlewares: loginLimiter (10 intentos/15min) → validarLogin → manejarErroresValidacion
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

/**
 * POST /api/sessions
 * Recibe: { firstMessage: string } — primer mensaje de la conversación
 * Devuelve: { id: uuid, nombre: string } — sesión creada en Supabase
 *
 * El nombre se genera automáticamente con Claude Haiku (2-4 palabras en español).
 * Middlewares: authenticateToken → validarCrearSesion → manejarErroresValidacion
 */
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

/**
 * GET /api/sessions
 * Devuelve: Array<{ id, nombre, iniciada_at }> — últimas 50 sesiones del usuario
 * Middlewares: authenticateToken
 */
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

/**
 * GET /api/sessions/:id/messages
 * Devuelve: Array<{ rol, contenido, created_at }> — mensajes de la sesión (sin "system")
 * Errores: 403 si la sesión no pertenece al usuario del JWT
 *
 * Primero verifica ownership de la sesión para evitar que un usuario
 * lea mensajes de otro usuario adivinando UUIDs.
 * Middlewares: authenticateToken
 */
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

/**
 * GET /download/:filename — Sirve archivos generados desde /tmp (Word, Excel, PDF).
 *
 * Prevención de path traversal:
 *   Sin sanitización, un atacante podría pedir /download/../../etc/passwd
 *   y path.join('/tmp', '../../etc/passwd') resolvería a /etc/passwd,
 *   permitiendo leer cualquier archivo del servidor.
 *   Se usa path.basename() para extraer solo el nombre del archivo,
 *   descartando cualquier directorio o secuencia "../".
 */
app.get('/download/:filename', (req, res) => {
  // Sanitizar: extraer solo el nombre del archivo, sin directorios ni "../"
  const safeName = path.basename(req.params.filename);

  // Si el nombre sanitizado difiere del original, el request es sospechoso
  if (safeName !== req.params.filename) {
    return res.status(400).json({ error: 'Nombre de archivo no válido.' });
  }

  const filePath = path.join('/tmp', safeName);

  // Verificación extra: confirmar que el path resuelto está dentro de /tmp
  if (!filePath.startsWith('/tmp/')) {
    return res.status(400).json({ error: 'Nombre de archivo no válido.' });
  }

  if (!require('fs').existsSync(filePath)) {
    return res.status(404).json({ error: 'Archivo no encontrado.' });
  }

  res.download(filePath);
});

// === Estado del servidor ===

/**
 * GET /api/status — Estado actual del servidor para monitoreo.
 * Devuelve: { cola, supabase, uptime, version }
 * No requiere autenticación para facilitar health checks externos.
 */
app.get('/api/status', (req, res) => {
  const estadoCola = obtenerEstadoCola();
  const pkg = require('../package.json');

  res.json({
    // Estado de la cola de requests del chat
    cola: {
      activos: estadoCola.activos,
      enCola: estadoCola.enCola,
      capacidad: {
        maxConcurrentes: estadoCola.maxConcurrentes,
        maxEnCola: estadoCola.maxEnCola,
      },
      totalProcesados: estadoCola.totalProcesados,
      totalRechazados: estadoCola.totalRechazados,
    },
    // Conexión a Supabase
    supabase: supabase ? 'conectado' : 'desconectado',
    // Tiempo que lleva corriendo el servidor (en segundos)
    uptime: Math.floor(process.uptime()),
    // Versión del proyecto desde package.json
    version: pkg.version,
  });
});

// === Chat ===

/**
 * POST /api/chat — Endpoint principal del agente.
 * Recibe: { message: string, history: Array, sesion_id?: uuid } + archivo opcional (multipart)
 * Devuelve: { reply: string, excelContext?: string, wordContext?: string }
 *
 * Flujo:
 *   1. Parsear archivo adjunto si existe (Excel → parseExcelBuffer, Word → mammoth)
 *   2. Llamar a handleChat con mensaje + historial + contexto de archivos + rol del usuario
 *   3. Guardar mensajes (user + assistant) en Supabase si hay sesión activa (no crítico)
 *   4. Retornar respuesta del agente + contextos de archivos para el frontend
 *
 * Middlewares (en orden): chatLimiter (30 msg/15min) → authenticateToken → multer →
 *   validarChat → manejarErroresValidacion → middlewareCola (max 10 simultáneos, 100 en espera)
 *
 * multer debe ejecutarse ANTES de validarChat porque necesita parsear el
 * multipart/form-data para que express-validator pueda leer los campos de texto.
 * La cola se aplica DESPUÉS de la validación para no encolar requests inválidos.
 */
app.post('/api/chat', chatLimiter, authenticateToken, upload.single('file'), validarChat, manejarErroresValidacion, middlewareCola(), async (req, res) => {
  const ts = new Date().toISOString();
  const { usuario_id, rol } = req.user;

  const message = req.body.message || '';

  // El historial puede llegar como array (JSON body) o como string serializado (multipart/form-data).
  // Si viene como string, necesitamos parsearlo. Un JSON malformado desde el cliente
  // (ej: historial corrupto en sessionStorage) crashearía el request sin este try-catch.
  let history = [];
  if (req.body.history) {
    if (typeof req.body.history === 'string') {
      try {
        history = JSON.parse(req.body.history);
      } catch {
        return res.status(400).json({ error: 'El campo history contiene JSON con formato incorrecto.' });
      }
    } else {
      history = req.body.history;
    }
  }

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

const server = app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Karia Agent corriendo en http://localhost:${PORT}`);
  console.log(`[${new Date().toISOString()}] Supabase: ${supabase ? 'OK' : 'NO CONFIGURADO'}`);
  console.log(`[${new Date().toISOString()}] ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'OK' : 'NO CONFIGURADA'}`);
  console.log(`[${new Date().toISOString()}] JWT_SECRET: ${process.env.JWT_SECRET ? 'OK' : 'NO CONFIGURADO'}`);
});

// === Handlers de proceso ===
//
// Estos handlers capturan errores y señales a nivel de proceso para evitar
// que el servidor muera silenciosamente sin dejar rastro de qué pasó.
// Sin ellos, un error async no capturado mata el proceso sin log,
// y un SIGTERM de Docker lo corta sin cerrar conexiones.

/**
 * Promesas rechazadas sin .catch().
 * Ejemplo: una función async que falla dentro de un setTimeout o un event listener
 * donde no hay try-catch. Sin este handler, Node.js loguea un warning pero el error
 * se pierde. No matamos el proceso porque el servidor puede seguir funcionando —
 * solo logueamos para investigar después.
 */
process.on('unhandledRejection', (reason, promise) => {
  console.error(`[${new Date().toISOString()}] [error] Promesa rechazada sin capturar:`);
  console.error(reason);
});

/**
 * Errores síncronos no capturados por ningún try-catch.
 * Ejemplo: un TypeError en un callback de event listener o un error en código
 * que no está dentro de una función async. Después de este error el proceso
 * puede estar en estado inconsistente (memoria corrupta, conexiones abiertas),
 * por eso es necesario hacer exit(1) para que el process manager (PM2, Docker)
 * lo reinicie limpio.
 */
process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] [fatal] Error no capturado — el servidor se va a reiniciar:`);
  console.error(err);
  process.exit(1);
});

/**
 * SIGTERM: señal que envía Docker (docker stop), Kubernetes, o el process manager
 * para pedir un cierre ordenado. Cerramos el servidor HTTP para que deje de aceptar
 * conexiones nuevas y esperamos a que las existentes terminen antes de salir.
 */
process.on('SIGTERM', () => {
  console.log(`[${new Date().toISOString()}] [info] SIGTERM recibido — cerrando servidor...`);
  server.close(() => {
    console.log(`[${new Date().toISOString()}] [info] Servidor cerrado correctamente.`);
    process.exit(0);
  });
});

/**
 * SIGINT: señal que envía Ctrl+C en la terminal durante desarrollo.
 * Mismo comportamiento que SIGTERM: cierre ordenado.
 */
process.on('SIGINT', () => {
  console.log(`[${new Date().toISOString()}] [info] SIGINT recibido (Ctrl+C) — cerrando servidor...`);
  server.close(() => {
    console.log(`[${new Date().toISOString()}] [info] Servidor cerrado correctamente.`);
    process.exit(0);
  });
});
