require('dotenv').config();

// === Validación de variables de entorno críticas ===
//
// JWT_SECRET se usa para firmar y verificar todos los tokens JWT de autenticación.
// Si es undefined, jsonwebtoken firma con string vacío — cualquiera podría generar
// tokens válidos sin conocer un secret. Si es muy corto (ej: "123"), es vulnerable
// a fuerza bruta (un atacante prueba secrets hasta encontrar el correcto).
// 32 caracteres (256 bits) es el mínimo recomendado para HMAC-SHA256 (algoritmo
// por defecto de jsonwebtoken) y hace inviable un ataque por fuerza bruta.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error(`[${new Date().toISOString()}] [FATAL] [server] JWT_SECRET no configurado o demasiado corto (mínimo 32 caracteres).`);
  console.error(`[${new Date().toISOString()}] [FATAL] [server] Sin un secret seguro, cualquier persona podría generar tokens de autenticación válidos.`);
  console.error(`[${new Date().toISOString()}] [FATAL] [server] Generá uno con: node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`);
  process.exit(1);
}

const express = require('express');
// Protección de headers HTTP (XSS, clickjacking, MIME sniffing, etc.)
const helmet = require('helmet');
// Limitación de requests por IP para prevenir abuso y fuerza bruta
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
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
// Limpieza periódica de archivos temporales generados por el agente en /tmp
const { limpiarArchivosTmp } = require('./utils/limpiarTmp');
// Logger centralizado con formato estandarizado [timestamp] [NIVEL] [módulo] mensaje
const { logInfo, logWarn, logError, logFatal } = require('./utils/logger');
// Middlewares de validación y sanitización de inputs
const { validarLogin, validarCrearSesion, validarChat, validarResetPassword } = require('./middlewares/validaciones');
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
  logError('supabase', `Error en ${operacion}: ${error.message} (código: ${error.code || 'N/A'})`);
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

// Content Security Policy (CSP):
// Indica al browser qué recursos puede cargar y desde dónde. Previene XSS
// bloqueando la ejecución de scripts, estilos y conexiones no autorizadas.
// Estaba deshabilitado (contentSecurityPolicy: false) porque el frontend usa
// inline styles y Google Fonts. Ahora está configurado con directives específicas
// que permiten esos casos sin abrir la puerta a inyecciones.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      // Por defecto, solo permitir recursos del propio servidor
      defaultSrc: ["'self'"],
      // Scripts: solo archivos .js del servidor (public/app.js)
      scriptSrc: ["'self'"],
      // Estilos: servidor + Google Fonts CSS + inline styles del frontend
      // 'unsafe-inline' es necesario porque el frontend usa style="" en SVGs y elementos dinámicos
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      // Fuentes: servidor + archivos .woff2 de Google Fonts
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      // Imágenes: servidor + data: URIs (para SVGs inline en el chat)
      imgSrc: ["'self'", "data:"],
      // Conexiones fetch/XHR: solo al propio servidor (API calls del frontend)
      connectSrc: ["'self'"],
    },
  },
}));

app.use((req, res, next) => {
  logInfo('http', `${req.method} ${req.url}`);
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

// Límite para descargas de archivos: 20 descargas cada 15 minutos por IP.
// Previene DoS por descargas masivas y enumeración de archivos en /tmp
// (un atacante podría probar nombres de archivo para descubrir archivos de otros usuarios).
const downloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas descargas. Esperá unos minutos antes de continuar.' },
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
 * Flujo: email → buscar en Supabase → bcrypt.compare(password, hash) → JWT
 *
 * Historial de la autenticación:
 *   v1: passwords almacenados como MD5 directo (inseguro, sin salt)
 *   v2: bcrypt(md5(password)) — migración parcial que mantenía compatibilidad
 *   v3 (actual): bcrypt(password) puro — elimina el paso MD5 intermedio
 *   Se eliminó MD5 porque reducía la entropía a 128 bits y podía causar
 *   colisiones teóricas (dos passwords distintos generando el mismo MD5).
 *   La migración a bcrypt puro requiere que los usuarios restablezcan su password
 *   (ver scripts/migrarBcryptPuro.js).
 *
 * Middlewares: loginLimiter (10 intentos/15min) → validarLogin → manejarErroresValidacion
 */
app.post('/api/login', loginLimiter, validarLogin, manejarErroresValidacion, async (req, res) => {
  if (supabaseNoDisponible(res)) return;

  const { email, password } = req.body;

  try {
    const { data: usuario, error } = await supabase
      .from('usuarios')
      .select('id, email, nombre, rol, password_hash, needs_password_reset')
      .eq('email', email)
      .single();

    // Error de Supabase distinto a "no encontrado" → fallo real de DB
    if (error && error.code !== 'PGRST116') {
      handleSupabaseError(error, 'buscar usuario');
    }

    if (!usuario) {
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    // Si el usuario fue marcado para resetear password (migración de MD5+bcrypt a bcrypt puro),
    // no puede loguearse hasta que restablezca su contraseña.
    if (usuario.needs_password_reset) {
      return res.status(403).json({ error: 'Tu contraseña necesita ser restablecida. Contactá al administrador.' });
    }

    // Comparar password directamente con el hash bcrypt almacenado.
    // bcrypt.compare hashea el input con el mismo salt del hash almacenado y compara.
    const passwordValido = await bcrypt.compare(password, usuario.password_hash);
    if (!passwordValido) {
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    // Generar JWT con datos del usuario, expira en 8 horas
    const token = jwt.sign(
      { usuario_id: usuario.id, email: usuario.email, nombre: usuario.nombre, rol: usuario.rol },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    logInfo('auth', `Login exitoso: ${usuario.email} (rol: ${usuario.rol})`);
    res.json({ token, usuario: { nombre: usuario.nombre, email: usuario.email, rol: usuario.rol } });
  } catch (err) {
    logError('auth', `Error en login: ${err.message}`);
    res.status(500).json({ error: 'Error al iniciar sesión. Intentá de nuevo.' });
  }
});

/**
 * POST /api/reset-password — Restablece la contraseña de un usuario marcado para reset.
 * Recibe: { email: string, password: string (min 8 chars) }
 * Devuelve: { message: string } con confirmación de éxito
 * Errores: 400 validación, 403 si el usuario no requiere reset, 404 si no existe
 *
 * No requiere JWT porque el usuario no puede loguearse mientras tiene
 * needs_password_reset: true. Se protege con loginLimiter (10 intentos/15min)
 * para prevenir fuerza bruta contra emails.
 *
 * La nueva password se hashea con bcrypt puro (12 rounds, sin paso MD5).
 * 12 rounds es el estándar actual — cada round duplica el tiempo de cómputo,
 * haciendo inviable un ataque de fuerza bruta contra el hash.
 */
app.post('/api/reset-password', loginLimiter, validarResetPassword, manejarErroresValidacion, async (req, res) => {
  if (supabaseNoDisponible(res)) return;

  const { email, password } = req.body;

  try {
    // Buscar el usuario por email
    const { data: usuario, error } = await supabase
      .from('usuarios')
      .select('id, email, needs_password_reset')
      .eq('email', email)
      .single();

    if (error && error.code !== 'PGRST116') {
      handleSupabaseError(error, 'buscar usuario para reset');
    }

    if (!usuario) {
      return res.status(404).json({ error: 'No se encontró un usuario con ese email.' });
    }

    // Solo permitir reset si el usuario fue marcado por la migración.
    // Esto evita que cualquiera cambie la password de otro usuario sin autorización.
    if (!usuario.needs_password_reset) {
      return res.status(403).json({ error: 'Este usuario no tiene un restablecimiento de contraseña pendiente.' });
    }

    // Hashear con bcrypt puro (12 rounds, sin MD5 intermedio)
    const nuevoHash = await bcrypt.hash(password, 12);

    // Actualizar password y limpiar el flag de reset
    const { error: updateError } = await supabase
      .from('usuarios')
      .update({ password_hash: nuevoHash, needs_password_reset: false })
      .eq('id', usuario.id);

    if (updateError) {
      handleSupabaseError(updateError, 'actualizar contraseña');
    }

    logInfo('auth', `Password restablecida: ${usuario.email}`);
    res.json({ message: 'Contraseña restablecida correctamente. Ya podés iniciar sesión.' });
  } catch (err) {
    logError('auth', `Error en reset-password: ${err.message}`);
    res.status(500).json({ error: 'Error al restablecer la contraseña. Intentá de nuevo.' });
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
    logError('sessions', `Error generando nombre: ${err.message}`);
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
    logInfo('sessions', `Creando sesión: "${nombre}"`);

    const { data, error } = await supabase
      .from('sesiones')
      .insert({ nombre, usuario_id: req.user.usuario_id, iniciada_at: new Date().toISOString() })
      .select('id, nombre')
      .single();

    if (error) handleSupabaseError(error, 'crear sesión');

    res.json(data);
  } catch (err) {
    logError('sessions', `Error creando sesión: ${err.message}`);
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
    logError('sessions', `Error listando sesiones: ${err.message}`);
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
    logError('sessions', `Error cargando mensajes: ${err.message}`);
    res.status(500).json({ error: 'No se pudieron cargar los mensajes de esta sesión.' });
  }
});

// === Descargas ===

/**
 * GET /download/:filename — Sirve archivos generados desde /tmp (Word, Excel, PDF).
 *
 * Requiere autenticación para evitar que usuarios no logueados o atacantes
 * descarguen archivos adivinando el nombre. Aunque los filenames incluyen
 * 128 bits de entropía (imposible de enumerar por fuerza bruta), la auth
 * agrega una segunda capa de protección contra links compartidos sin permiso.
 *
 * Prevención de path traversal:
 *   Sin sanitización, un atacante podría pedir /download/../../etc/passwd
 *   y path.join('/tmp', '../../etc/passwd') resolvería a /etc/passwd,
 *   permitiendo leer cualquier archivo del servidor.
 *   Se usa path.basename() para extraer solo el nombre del archivo,
 *   descartando cualquier directorio o secuencia "../".
 */
app.get('/download/:filename', downloadLimiter, authenticateToken, (req, res) => {
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

  // Servir el archivo y eliminarlo de /tmp después de que se transmita completo.
  // El archivo ya fue descargado por el usuario, no se necesita más en el servidor.
  // Si la eliminación falla (ej: permisos), solo logueamos — la limpieza periódica
  // lo atrapará después.
  res.download(filePath, () => {
    try {
      require('fs').unlinkSync(filePath);
      logInfo('download', `Archivo eliminado después de descarga: ${safeName}`);
    } catch (err) {
      logWarn('download', `No se pudo eliminar ${safeName} después de descarga: ${err.message}`);
    }
  });
});

// === Health check y estado del servidor ===

/**
 * GET /health — Health check público para Docker y load balancers.
 * Devuelve: { status: "ok", timestamp }
 *
 * Público intencionalmente (sin authenticateToken) porque Docker ejecuta
 * este endpoint cada 30 segundos desde dentro del container, donde no hay
 * un JWT disponible. Solo confirma que el servidor responde — no expone
 * métricas ni datos internos.
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * GET /api/status — Métricas internas del servidor para administradores.
 * Devuelve: { cola, supabase, uptime, version }
 *
 * Requiere autenticación porque expone información interna del servidor
 * (estado de la cola, uptime, versión) que un atacante podría usar para
 * planificar un ataque (ej: esperar a que la cola esté llena, identificar
 * la versión para buscar CVEs).
 */
app.get('/api/status', authenticateToken, (req, res) => {
  const estadoCola = obtenerEstadoCola();
  const pkg = require('../package.json');

  res.json({
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
    supabase: supabase ? 'conectado' : 'desconectado',
    uptime: Math.floor(process.uptime()),
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

  logInfo('chat', `Mensaje: "${message}" | Archivo: ${hasFile ? req.file.originalname : 'ninguno'} | Sesión: ${sesionId} | Rol: ${rol}`);

  let excelContext = null;
  let wordContext = null;

  if (hasFile) {
    const isExcel = req.file.originalname.match(/\.(xlsx|xls)$/i);
    const isWord = req.file.originalname.match(/\.(docx|doc)$/i);

    if (isExcel) {
      try {
        logInfo('chat', `Parseando Excel: ${req.file.originalname} (${req.file.size} bytes)`);
        excelContext = parseExcelBuffer(req.file.buffer);
        logInfo('chat', `Excel parseado: ${excelContext.length} caracteres`);
      } catch (err) {
        logError('chat', `Error al parsear Excel: ${err.message}`);
        return res.status(400).json({ error: `No se pudo leer el archivo Excel: ${err.message}` });
      }
    } else if (isWord) {
      try {
        logInfo('chat', `Parseando Word: ${req.file.originalname} (${req.file.size} bytes)`);
        const result = await mammoth.extractRawText({ buffer: req.file.buffer });
        wordContext = result.value;
        logInfo('chat', `Word parseado: ${wordContext.length} caracteres`);
      } catch (err) {
        logError('chat', `Error al parsear Word: ${err.message}`);
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
        logError('supabase', `Error guardando conversación en sesión ${sesionId}: ${insertError.message} (código: ${insertError.code || 'N/A'})`);
      }
    }

    const result = { reply };
    if (excelContext) result.excelContext = excelContext;
    if (wordContext) result.wordContext = wordContext;

    res.json(result);
  } catch (err) {
    logError('chat', `Error en /api/chat: ${err.message}`);
    logError('chat', err.stack);
    res.status(500).json({ error: 'Error interno del agente. Intentá de nuevo.' });
  }
});

// === Inicio del servidor ===

const server = app.listen(PORT, () => {
  logInfo('server', `Karia Agent corriendo en http://localhost:${PORT}`);
  logInfo('server', `Supabase: ${supabase ? 'OK' : 'NO CONFIGURADO'}`);
  logInfo('server', `ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'OK' : 'NO CONFIGURADA'}`);
  logInfo('server', `JWT_SECRET: ${process.env.JWT_SECRET ? 'OK' : 'NO CONFIGURADO'}`);

  // Limpieza de archivos temporales huérfanos en /tmp.
  // Se ejecuta al arrancar (para limpiar archivos de ejecuciones anteriores)
  // y cada 30 minutos para evitar acumulación durante uso continuo.
  // Solo elimina .pdf, .docx y .xlsx con más de 2 horas de antigüedad.
  limpiarArchivosTmp();
  setInterval(limpiarArchivosTmp, 30 * 60 * 1000);
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
process.on('unhandledRejection', (reason) => {
  logError('process', `Promesa rechazada sin capturar: ${reason}`);
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
  logFatal('process', `Error no capturado — el servidor se va a reiniciar: ${err.message}`);
  logFatal('process', err.stack);
  process.exit(1);
});

/**
 * SIGTERM: señal que envía Docker (docker stop), Kubernetes, o el process manager
 * para pedir un cierre ordenado. Cerramos el servidor HTTP para que deje de aceptar
 * conexiones nuevas y esperamos a que las existentes terminen antes de salir.
 */
process.on('SIGTERM', () => {
  logInfo('process', 'SIGTERM recibido — cerrando servidor...');
  server.close(() => {
    logInfo('process', 'Servidor cerrado correctamente.');
    process.exit(0);
  });
});

/**
 * SIGINT: señal que envía Ctrl+C en la terminal durante desarrollo.
 * Mismo comportamiento que SIGTERM: cierre ordenado.
 */
process.on('SIGINT', () => {
  logInfo('process', 'SIGINT recibido (Ctrl+C) — cerrando servidor...');
  server.close(() => {
    logInfo('process', 'Servidor cerrado correctamente.');
    process.exit(0);
  });
});
