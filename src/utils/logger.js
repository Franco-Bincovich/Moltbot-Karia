/**
 * Logger centralizado con formato estandarizado para todo el proyecto.
 *
 * Formato de cada línea:
 *   [YYYY-MM-DDTHH:MM:SS.sssZ] [NIVEL] [módulo] mensaje
 *
 * Ejemplo:
 *   [2026-03-19T14:30:00.123Z] [INFO] [auth] Login exitoso: user@email.com
 *
 * Niveles disponibles (de menor a mayor severidad):
 *
 *   INFO  — Operaciones normales: inicio de servidor, request recibido, operación completada.
 *           Usar para confirmar que las cosas funcionan como se espera.
 *
 *   WARN  — Situaciones inesperadas pero no fatales: archivo no encontrado, reintento de API,
 *           configuración faltante que tiene fallback. El servidor sigue funcionando.
 *
 *   ERROR — Fallos que afectan al usuario: error de Supabase, API externa caída, operación
 *           que no se pudo completar. El servidor sigue corriendo pero algo salió mal.
 *
 *   FATAL — El proceso va a terminar: uncaughtException, error irrecuperable.
 *           Se usa justo antes de process.exit(1).
 */

// === Funciones de logging ===

/** Operaciones normales y confirmaciones. */
function logInfo(modulo, mensaje) {
  console.log(`[${new Date().toISOString()}] [INFO] [${modulo}] ${mensaje}`);
}

/** Situaciones inesperadas pero no fatales. */
function logWarn(modulo, mensaje) {
  console.warn(`[${new Date().toISOString()}] [WARN] [${modulo}] ${mensaje}`);
}

/** Fallos que afectan al usuario o a una operación. */
function logError(modulo, mensaje) {
  console.error(`[${new Date().toISOString()}] [ERROR] [${modulo}] ${mensaje}`);
}

/** El proceso va a terminar de forma irrecuperable. */
function logFatal(modulo, mensaje) {
  console.error(`[${new Date().toISOString()}] [FATAL] [${modulo}] ${mensaje}`);
}

module.exports = { logInfo, logWarn, logError, logFatal };
