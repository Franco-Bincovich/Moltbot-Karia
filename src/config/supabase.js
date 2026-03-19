/**
 * Configuración centralizada del cliente Supabase (singleton).
 *
 * Este módulo exporta una única instancia del cliente que se reutiliza
 * en todo el servidor. Usar un singleton evita crear múltiples conexiones
 * HTTP por request — el SDK de Supabase mantiene internamente un pool
 * de conexiones HTTP/2 persistentes que se reutilizan automáticamente.
 *
 * Usa la service_key (no anon_key) para bypasear RLS en todas las
 * operaciones del servidor. Las políticas RLS protegen las consultas
 * directas desde el frontend, pero el servidor opera como "superusuario".
 *
 * Requiere en .env:
 *   SUPABASE_URL=https://xxx.supabase.co
 *   SUPABASE_SERVICE_KEY=eyJ...
 */

const { createClient } = require('@supabase/supabase-js');

// === Validación de variables de entorno ===

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn('[supabase] ⚠️  SUPABASE_URL o SUPABASE_SERVICE_KEY no configuradas en .env');
  console.warn('[supabase] Las funciones que dependen de Supabase (login, sesiones, conversaciones) no estarán disponibles.');
}

// === Creación del cliente singleton ===

/**
 * Cliente Supabase configurado con opciones de performance.
 * null si las variables de entorno no están configuradas.
 */
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: {
        // No persistir sesión de usuario en el servidor — cada request
        // se autentica con JWT propio, no con Supabase Auth
        persistSession: false,
        // No detectar sesión automáticamente desde URL (solo relevante en browser)
        detectSessionInUrl: false,
        // No refrescar token automáticamente — usamos service_key que no expira
        autoRefreshToken: false,
      },
      // Timeout global para queries a Supabase (15 segundos)
      // Evita que el servidor se cuelgue si Supabase está lento o caído
      global: {
        fetch: (url, options = {}) => {
          return fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
        },
      },
    })
  : null;

// === Verificación de conectividad ===

/**
 * Verifica que la conexión a Supabase funcione haciendo una query mínima.
 * Se ejecuta al importar el módulo (inicio del servidor).
 * No bloquea el arranque — solo loguea el resultado.
 */
async function verificarConexion() {
  if (!supabase) return;

  try {
    const { error } = await supabase.from('usuarios').select('id').limit(1);
    if (error) {
      console.error(`[supabase] ❌ Error de conexión: ${error.message}`);
    } else {
      console.log('[supabase] ✅ Conexión verificada correctamente');
    }
  } catch (err) {
    console.error(`[supabase] ❌ No se pudo conectar: ${err.message}`);
  }
}

// Ejecutar verificación al importar (no bloqueante)
verificarConexion();

module.exports = { supabase };
