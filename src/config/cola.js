/**
 * Cola de requests con concurrencia limitada para endpoints pesados.
 *
 * Problema que resuelve:
 *   POST /api/chat puede tardar 10-60 segundos por request (llama a Claude,
 *   Google APIs, Gamma, etc.). Con 500 usuarios simultáneos, el servidor
 *   lanzaría 500 llamadas a Claude en paralelo, superando rate limits y
 *   agotando memoria. La cola limita cuántos requests se procesan a la vez
 *   y encola el resto con un timeout.
 *
 * Funcionamiento:
 *   - Máximo 10 requests procesándose simultáneamente (concurrencia)
 *   - Máximo 100 requests esperando en la cola
 *   - Si la cola está llena → 503 inmediato
 *   - Si un request espera más de 30 segundos en cola → 503 por timeout
 *   - Cuando un request activo termina, el siguiente en cola se despacha
 *
 * No usa dependencias externas — implementado con arrays y Promises nativas.
 */

const { logInfo } = require('../utils/logger');

// === Configuración ===

/** Máximo de requests procesándose al mismo tiempo */
const MAX_CONCURRENTES = 10;

/** Máximo de requests esperando en la cola (los que exceden reciben 503) */
const MAX_EN_COLA = 100;

/** Tiempo máximo que un request puede esperar en la cola antes de recibir 503 (ms) */
const TIMEOUT_COLA_MS = 30_000;

/** Intervalo en ms para loguear el estado de la cola (solo cuando hay actividad) */
const LOG_INTERVALO_MS = 10_000;

/**
 * Máximo de requests encolados o activos por usuario individual.
 * Previene que un solo usuario autenticado llene toda la cola, dejando sin servicio
 * al resto. El rate limit por IP (chatLimiter) no es suficiente porque:
 *   - Múltiples usuarios pueden compartir la misma IP (VPN, red corporativa)
 *   - Un atacante puede usar múltiples IPs con el mismo JWT
 * Limitar por usuario_id garantiza fairness independientemente de la IP.
 */
const MAX_POR_USUARIO = 5;

// === Estado interno ===

/** Cantidad de requests procesándose actualmente */
let activos = 0;

/** Cola de requests esperando: cada elemento es { resolve, reject, timer, usuarioId } */
const cola = [];

/** Conteo de requests activos + encolados por usuario_id para limitar fairness */
const requestsPorUsuario = new Map();

/** Timestamp del último log para evitar loguear en cada request */
let ultimoLog = 0;

/** Contador total de requests procesados desde que arrancó el servidor */
let totalProcesados = 0;

/** Contador total de requests rechazados por cola llena */
let totalRechazados = 0;

// === Función principal ===

/**
 * Middleware de Express que encola el request si hay demasiada concurrencia.
 *
 * Flujo:
 *   1. Si hay slot disponible (activos < MAX_CONCURRENTES) → procesar inmediatamente
 *   2. Si la cola tiene lugar (cola.length < MAX_EN_COLA) → encolar con timeout
 *   3. Si la cola está llena → responder 503 inmediatamente
 *
 * Cuando un request activo termina (res.on('finish')), se despacha el
 * siguiente de la cola automáticamente.
 *
 * @returns {Function} Middleware de Express (req, res, next)
 */
function middlewareCola() {
  return (req, res, next) => {
    const usuarioId = req.user?.usuario_id || 'anon';

    // Verificar límite per-usuario antes de procesar o encolar.
    // Cuenta requests activos + encolados del mismo usuario.
    const countUsuario = requestsPorUsuario.get(usuarioId) || 0;
    if (countUsuario >= MAX_POR_USUARIO) {
      return res.status(429).json({
        error: 'Tenés demasiados mensajes en espera. Esperá a que se procesen antes de enviar más.',
      });
    }

    // Registrar que este usuario tiene un request más en el sistema
    requestsPorUsuario.set(usuarioId, countUsuario + 1);

    // Caso 1: hay slot disponible → procesar inmediatamente
    if (activos < MAX_CONCURRENTES) {
      iniciarRequest(res, next, usuarioId);
      return;
    }

    // Caso 2: cola llena → rechazar con 503
    if (cola.length >= MAX_EN_COLA) {
      decrementarUsuario(usuarioId);
      totalRechazados++;
      logEstado('rechazado');
      return res.status(503).json({
        error: 'El servidor está procesando muchas solicitudes. Por favor intentá en unos segundos.',
      });
    }

    // Caso 3: encolar el request con timeout
    logEstado('encolado');

    const promesa = new Promise((resolve, reject) => {
      // Timer que rechaza el request si espera demasiado en la cola
      const timer = setTimeout(() => {
        // Remover de la cola (puede ya haberse despachado)
        const idx = cola.findIndex((item) => item.timer === timer);
        if (idx !== -1) cola.splice(idx, 1);
        decrementarUsuario(usuarioId);
        reject();
      }, TIMEOUT_COLA_MS);

      cola.push({ resolve, reject, timer, usuarioId });
    });

    promesa
      .then(() => {
        // El request fue despachado desde la cola → procesar
        iniciarRequest(res, next, usuarioId);
      })
      .catch(() => {
        // Timeout en la cola → responder 503 si no se envió respuesta todavía
        if (!res.headersSent) {
          res.status(503).json({
            error: 'Tu solicitud esperó demasiado tiempo en la cola. Por favor intentá de nuevo.',
          });
        }
      });
  };
}

// === Helpers internos ===

/**
 * Marca un request como activo y configura la liberación del slot al terminar.
 * Cuando el response se completa (finish), libera el slot, decrementa el conteo
 * del usuario y despacha el siguiente en cola.
 */
function iniciarRequest(res, next, usuarioId) {
  activos++;
  totalProcesados++;

  // Liberar el slot cuando el response se complete (éxito o error)
  res.on('finish', () => {
    activos--;
    decrementarUsuario(usuarioId);
    despacharSiguiente();
  });

  next();
}

/**
 * Decrementa el conteo de requests activos/encolados de un usuario.
 * Si llega a 0, elimina la entrada del Map para no acumular memoria.
 */
function decrementarUsuario(usuarioId) {
  const count = requestsPorUsuario.get(usuarioId) || 0;
  if (count <= 1) {
    requestsPorUsuario.delete(usuarioId);
  } else {
    requestsPorUsuario.set(usuarioId, count - 1);
  }
}

/**
 * Despacha el siguiente request de la cola si hay alguno esperando.
 * Se ejecuta cada vez que un request activo termina.
 */
function despacharSiguiente() {
  if (cola.length === 0) return;

  const siguiente = cola.shift();
  clearTimeout(siguiente.timer);
  siguiente.resolve();
}

/**
 * Loguea el estado actual de la cola.
 * Solo loguea si pasó suficiente tiempo desde el último log (evita spam).
 * @param {string} evento - Tipo de evento que disparó el log ('encolado', 'rechazado')
 */
function logEstado(evento) {
  const ahora = Date.now();
  if (ahora - ultimoLog < LOG_INTERVALO_MS) return;
  ultimoLog = ahora;
  logInfo('cola', `${evento} | Activos: ${activos}/${MAX_CONCURRENTES} | En cola: ${cola.length}/${MAX_EN_COLA} | Procesados: ${totalProcesados} | Rechazados: ${totalRechazados}`);
}

// === API pública ===

/**
 * Retorna el estado actual de la cola para el endpoint /api/status.
 * @returns {{ activos, enCola, maxConcurrentes, maxEnCola, totalProcesados, totalRechazados }}
 */
function obtenerEstadoCola() {
  return {
    activos,
    enCola: cola.length,
    maxConcurrentes: MAX_CONCURRENTES,
    maxEnCola: MAX_EN_COLA,
    maxPorUsuario: MAX_POR_USUARIO,
    totalProcesados,
    totalRechazados,
    // Cantidad de usuarios distintos con requests activos o encolados
    usuariosActivos: requestsPorUsuario.size,
  };
}

module.exports = { middlewareCola, obtenerEstadoCola };
