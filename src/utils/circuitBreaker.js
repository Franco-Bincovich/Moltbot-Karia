/**
 * Circuit Breaker para APIs externas.
 *
 * Problema que resuelve:
 *   Sin circuit breaker, si Claude API o Google están caídos, los 10 slots
 *   de la cola se llenan con requests esperando 60 segundos de timeout cada uno.
 *   Con 500 usuarios concurrentes, la cola se satura en segundos y todos
 *   reciben "servidor ocupado" cuando en realidad el problema es la API externa.
 *   El circuit breaker detecta el patrón de fallos y rechaza rápido (~0ms)
 *   con un mensaje claro, liberando la cola para cuando el servicio se recupere.
 *
 * Estados y transiciones:
 *
 *   CERRADO (normal)
 *     │  Todo funciona. Las llamadas pasan normalmente.
 *     │  Si una llamada falla, incrementa el contador de fallos.
 *     │  Si los fallos alcanzan el umbral (5 consecutivos):
 *     ▼
 *   ABIERTO (rechaza rápido)
 *     │  Todas las llamadas se rechazan inmediatamente sin intentar.
 *     │  Retorna error descriptivo: "Servicio X no disponible temporalmente".
 *     │  Espera un cooldown (30 segundos) antes de probar de nuevo:
 *     ▼
 *   SEMI_ABIERTO (prueba de recuperación)
 *     │  Permite UNA sola llamada de prueba.
 *     │  Si la prueba tiene éxito → vuelve a CERRADO (resetea contador)
 *     │  Si la prueba falla → vuelve a ABIERTO (nuevo cooldown de 30s)
 *     ▼
 *   CERRADO (si la prueba tuvo éxito)
 */

const { logInfo, logWarn } = require('./logger');

// === Estados del circuito ===

const ESTADO = {
  CERRADO: 'CERRADO',
  ABIERTO: 'ABIERTO',
  SEMI_ABIERTO: 'SEMI_ABIERTO',
};

// === Clase CircuitBreaker ===

class CircuitBreaker {
  /**
   * @param {string} nombre - Nombre del servicio protegido (para logs). Ej: 'anthropic', 'google'
   * @param {object} opciones - Configuración del breaker
   * @param {number} opciones.umbralFallos - Fallos consecutivos para abrir el circuito (default 5)
   * @param {number} opciones.cooldownMs - Tiempo en ms antes de pasar a semi-abierto (default 30000)
   */
  constructor(nombre, opciones = {}) {
    this.nombre = nombre;
    this.umbralFallos = opciones.umbralFallos ?? 5;
    this.cooldownMs = opciones.cooldownMs ?? 30_000;

    // Estado interno
    this.estado = ESTADO.CERRADO;
    this.fallosConsecutivos = 0;
    this.ultimaApertura = 0; // Timestamp de la última vez que se abrió
  }

  /**
   * Ejecuta una función protegida por el circuit breaker.
   * @param {Function} fn - Función async a ejecutar
   * @returns {Promise<*>} Resultado de la función
   * @throws {Error} Si el circuito está abierto o la función falla
   */
  async ejecutar(fn) {
    // ABIERTO: verificar si pasó el cooldown para intentar semi-abierto
    if (this.estado === ESTADO.ABIERTO) {
      if (Date.now() - this.ultimaApertura < this.cooldownMs) {
        // Aún en cooldown → rechazar rápido sin intentar
        throw new Error(`El servicio ${this.nombre} no está disponible temporalmente. Intentá de nuevo en unos segundos.`);
      }
      // Cooldown terminó → pasar a semi-abierto para probar con UN request
      this._transicion(ESTADO.SEMI_ABIERTO);
    }

    // CERRADO o SEMI_ABIERTO: intentar la llamada
    try {
      const resultado = await fn();
      this._registrarExito();
      return resultado;
    } catch (err) {
      this._registrarFallo();
      throw err;
    }
  }

  /**
   * Retorna el estado actual del circuito para diagnóstico.
   * @returns {{ estado, fallosConsecutivos, nombre }}
   */
  obtenerEstado() {
    return {
      nombre: this.nombre,
      estado: this.estado,
      fallosConsecutivos: this.fallosConsecutivos,
    };
  }

  // === Métodos internos ===

  /** Una llamada exitosa: resetear contador y volver a CERRADO. */
  _registrarExito() {
    if (this.estado === ESTADO.SEMI_ABIERTO) {
      this._transicion(ESTADO.CERRADO);
    }
    this.fallosConsecutivos = 0;
  }

  /** Una llamada falló: incrementar contador y abrir si se alcanzó el umbral. */
  _registrarFallo() {
    this.fallosConsecutivos++;

    if (this.estado === ESTADO.SEMI_ABIERTO) {
      // La prueba de recuperación falló → volver a abrir
      this._transicion(ESTADO.ABIERTO);
    } else if (this.fallosConsecutivos >= this.umbralFallos) {
      // Demasiados fallos consecutivos → abrir el circuito
      this._transicion(ESTADO.ABIERTO);
    }
  }

  /** Cambia de estado y loguea la transición. */
  _transicion(nuevoEstado) {
    const anterior = this.estado;
    this.estado = nuevoEstado;

    if (nuevoEstado === ESTADO.ABIERTO) {
      this.ultimaApertura = Date.now();
      logWarn('circuit-breaker', `${this.nombre}: ${anterior} → ABIERTO (${this.fallosConsecutivos} fallos consecutivos). Rechazando requests por ${this.cooldownMs / 1000}s.`);
    } else if (nuevoEstado === ESTADO.SEMI_ABIERTO) {
      logInfo('circuit-breaker', `${this.nombre}: ${anterior} → SEMI_ABIERTO. Probando con 1 request...`);
    } else if (nuevoEstado === ESTADO.CERRADO) {
      logInfo('circuit-breaker', `${this.nombre}: ${anterior} → CERRADO. Servicio recuperado.`);
    }
  }
}

module.exports = { CircuitBreaker };
