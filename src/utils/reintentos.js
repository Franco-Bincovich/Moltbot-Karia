/**
 * Lógica de reintentos con backoff exponencial para operaciones que pueden
 * fallar de forma transitoria (errores de red, timeouts, rate limits).
 *
 * Solo reintenta errores transitorios. Los errores de lógica (credenciales
 * inválidas, archivo no encontrado, validación) se propagan inmediatamente.
 */

// === Detección de errores transitorios ===

/**
 * Determina si un error es transitorio y merece un reintento.
 * Retorna true para errores de red, timeouts y rate limits.
 * Retorna false para errores de lógica que no se resolverían reintentando.
 * @param {Error} err
 * @returns {boolean}
 */
function esErrorTransitorio(err) {
  const mensaje = (err.message || '').toLowerCase();
  const codigo = err.code || '';

  // Errores de red y conexión
  if (codigo === 'ECONNRESET' || codigo === 'ECONNREFUSED' || codigo === 'ETIMEDOUT' || codigo === 'ENOTFOUND') return true;

  // Timeouts (AbortError de fetch, timeout de googleapis)
  if (err.name === 'AbortError') return true;
  if (mensaje.includes('timeout')) return true;
  if (mensaje.includes('socket hang up')) return true;

  // Rate limits (HTTP 429) y errores de servidor (5xx)
  if (err.status === 429 || err.status >= 500) return true;
  if (mensaje.includes('rate limit') || mensaje.includes('too many requests')) return true;
  if (mensaje.includes('internal server error') || mensaje.includes('service unavailable')) return true;

  // Error genérico de red de googleapis
  if (mensaje.includes('network error') || mensaje.includes('fetch failed')) return true;

  return false;
}

// === Función principal ===

/**
 * Ejecuta una función asíncrona con reintentos automáticos en caso de errores transitorios.
 * Usa backoff exponencial: cada reintento espera más que el anterior.
 *
 * @param {Function} fn - Función asíncrona a ejecutar (sin argumentos; usar closure si necesita parámetros)
 * @param {object} opciones - Configuración de reintentos
 * @param {number} opciones.intentos - Cantidad máxima de ejecuciones (default 3: 1 original + 2 reintentos)
 * @param {number} opciones.esperaMs - Tiempo base de espera entre reintentos en ms (default 1000)
 * @param {number} opciones.factor - Multiplicador de espera entre reintentos (default 2 = backoff exponencial)
 * @param {Function} opciones.onReintento - Callback opcional invocado antes de cada reintento: (error, intentoActual, esperaMs) => void
 * @returns {Promise<*>} Resultado de la función ejecutada
 * @throws {Error} El último error si se agotan todos los intentos
 */
async function conReintentos(fn, opciones = {}) {
  const {
    intentos = 3,
    esperaMs = 1000,
    factor = 2,
    onReintento = null,
  } = opciones;

  let ultimoError;

  for (let intento = 1; intento <= intentos; intento++) {
    try {
      return await fn();
    } catch (err) {
      ultimoError = err;

      // Si no es un error transitorio, propagar inmediatamente sin reintentar
      if (!esErrorTransitorio(err)) {
        throw err;
      }

      // Si se agotaron los intentos, propagar el error
      if (intento >= intentos) {
        throw err;
      }

      // Calcular espera con backoff exponencial: esperaMs * factor^(intento-1)
      const esperaActual = Math.round(esperaMs * Math.pow(factor, intento - 1));

      // Notificar el reintento si hay callback configurado
      if (onReintento) {
        onReintento(err, intento, esperaActual);
      }

      // Esperar antes del próximo intento
      await new Promise((r) => setTimeout(r, esperaActual));
    }
  }

  // Fallback (no debería llegar acá, pero por seguridad)
  throw ultimoError;
}

module.exports = { conReintentos, esErrorTransitorio };
