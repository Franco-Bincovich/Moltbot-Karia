/**
 * Reglas de validación y sanitización para cada endpoint de la API.
 *
 * Se usa express-validator. Cada exportación es un array de validadores
 * listo para pasarse directamente como middleware en la ruta correspondiente.
 *
 * Después de estas reglas se debe encadenar manejarErroresValidacion para
 * que los errores acumulados corten el request antes de llegar al handler.
 */

const { body } = require('express-validator');

// ─── POST /api/login ─────────────────────────────────────────────────────────

/**
 * Valida las credenciales de login.
 * Se sanitiza el email para evitar espacios accidentales.
 * Se limita la longitud para prevenir ataques de payload grande.
 */
const validarLogin = [
  body('email')
    // El email debe tener formato válido para poder buscarlo en la base de datos
    .isEmail().withMessage('El email no tiene un formato válido.')
    // Normaliza el email: minúsculas y sin espacios extra
    .normalizeEmail()
    // Límite de longitud para evitar strings excesivamente largos
    .isLength({ max: 100 }).withMessage('El email no puede superar los 100 caracteres.'),

  body('password')
    // La contraseña no puede estar vacía: sin ella no se puede autenticar
    .notEmpty().withMessage('La contraseña no puede estar vacía.')
    // Límite de longitud para prevenir inputs abusivos antes de hashear
    .isLength({ max: 100 }).withMessage('La contraseña no puede superar los 100 caracteres.')
    // trim() elimina espacios al inicio/fin que podrían causar fallos silenciosos
    .trim(),
];

// ─── POST /api/sessions ──────────────────────────────────────────────────────

/**
 * Valida la creación de una sesión nueva.
 * El firstMessage se usa para generar el nombre con IA, por lo que
 * se limita para no mandar prompts gigantes a Claude Haiku.
 */
const validarCrearSesion = [
  body('firstMessage')
    // Debe ser un string no vacío para poder generar el nombre de la sesión
    .isString().withMessage('firstMessage debe ser un texto.')
    .notEmpty().withMessage('firstMessage no puede estar vacío.')
    // 500 caracteres es suficiente para que Haiku genere un buen nombre
    .isLength({ max: 500 }).withMessage('firstMessage no puede superar los 500 caracteres.')
    .trim(),
];

// ─── POST /api/chat ───────────────────────────────────────────────────────────

/**
 * Valida el mensaje y los metadatos del chat.
 * El mensaje puede estar vacío si se adjunta un archivo (hasFile),
 * pero si viene texto se sanitiza y limita.
 */
const validarChat = [
  body('message')
    // Es opcional (puede venir vacío si hay archivo adjunto), pero si está presente
    // debe ser string para evitar que lleguen objetos o arrays al agente
    .optional()
    .isString().withMessage('El mensaje debe ser texto.')
    // 5000 caracteres limita el tamaño del prompt enviado al agente
    .isLength({ max: 5000 }).withMessage('El mensaje no puede superar los 5000 caracteres.')
    .trim(),

  body('sesion_id')
    // Si se envía, debe ser un UUID válido — evita inyecciones o IDs malformados
    .optional({ nullable: true, checkFalsy: true })
    .isUUID().withMessage('sesion_id debe ser un UUID válido.'),

  body('history')
    // El historial es opcional. Cuando viene de FormData (con archivo adjunto) llega
    // como string JSON; cuando viene del body JSON llega como array. Se acepta ambos.
    .optional()
    .custom((valor) => {
      if (Array.isArray(valor)) return true;
      if (typeof valor === 'string') {
        try { JSON.parse(valor); return true; } catch { /* cae al throw */ }
      }
      throw new Error('history debe ser un array o un JSON array serializado.');
    }),
];

// ─── Exportaciones ────────────────────────────────────────────────────────────

module.exports = { validarLogin, validarCrearSesion, validarChat };
