const fs = require('fs');
const path = require('path');
const { conReintentos } = require('../utils/reintentos');
const { logInfo, logWarn } = require('../utils/logger');

const GAMMA_API_KEY = process.env.GAMMA_API_KEY;
const BASE_URL = 'https://public-api.gamma.app/v1.0';

// === Timeouts ===

const TIMEOUT_CREACION_MS = 30_000;   // 30 segundos para la llamada inicial de creación
const TIMEOUT_POLLING_MS = 10_000;    // 10 segundos para cada request de polling
const TIMEOUT_GLOBAL_MS = 180_000;    // 3 minutos máximo para toda la operación
const TIMEOUT_DESCARGA_MS = 30_000;   // 30 segundos para descargar el PDF

// === Helpers ===

/**
 * Ejecuta un fetch con timeout usando AbortController.
 * @param {string} url
 * @param {object} options - Opciones de fetch
 * @param {number} timeoutMs - Timeout en milisegundos
 * @returns {Promise<Response>}
 */
async function fetchConTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`La solicitud a Gamma excedió el tiempo límite (${Math.round(timeoutMs / 1000)}s).`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Valida que una URL sea segura para hacer fetch desde el servidor.
 *
 * Prevención de SSRF (Server-Side Request Forgery):
 *   Sin esta validación, si la API de Gamma devuelve una URL maliciosa
 *   (ej: por compromiso de su infraestructura), el servidor podría:
 *   - Acceder al metadata service de cloud (http://169.254.169.254) y robar credenciales AWS/GCP
 *   - Escanear servicios internos (http://localhost:3000, http://10.0.0.x)
 *   - Leer archivos locales (file:///etc/passwd)
 *   Solo se permiten URLs HTTPS a hosts públicos.
 *
 * @param {string} url - URL a validar
 * @throws {Error} Si la URL no es segura
 */
function validarUrlSegura(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`URL de descarga inválida: ${url}`);
  }

  // Solo HTTPS — bloquea http:, file:, ftp:, data:, etc.
  if (parsed.protocol !== 'https:') {
    throw new Error(`URL de descarga no permitida: solo se acepta HTTPS (recibido: ${parsed.protocol})`);
  }

  // Bloquear hosts locales y de metadata de cloud
  const hostname = parsed.hostname.toLowerCase();
  const hostsBloqueados = ['localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254', '[::1]'];
  if (hostsBloqueados.includes(hostname)) {
    throw new Error(`URL de descarga bloqueada: host no permitido (${hostname}).`);
  }

  // Bloquear rangos de IPs privadas: 10.x.x.x, 172.16-31.x.x, 192.168.x.x
  const ipPrivada = /^(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)$/;
  if (ipPrivada.test(hostname)) {
    throw new Error(`URL de descarga bloqueada: IP privada no permitida (${hostname}).`);
  }
}

/**
 * Descarga un archivo desde una URL y lo guarda en /tmp.
 * Valida la URL contra SSRF antes de hacer el fetch.
 * @param {string} url - URL del archivo a descargar
 * @param {string} filename - Nombre con el que guardar el archivo
 * @returns {Promise<string>} Ruta local del archivo descargado
 */
async function downloadToTmp(url, filename) {
  validarUrlSegura(url);

  const res = await fetchConTimeout(url, {}, TIMEOUT_DESCARGA_MS);
  if (!res.ok) throw new Error(`Error descargando PDF de Gamma: HTTP ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const filePath = path.join('/tmp', filename);

  // Verificar que /tmp sea escribible antes de intentar guardar.
  // Puede fallar si el disco está lleno, /tmp tiene permisos restringidos,
  // o el container tiene filesystem read-only sin volumen montado.
  try {
    fs.accessSync('/tmp', fs.constants.W_OK);
  } catch {
    throw new Error('No se puede escribir en /tmp. Verificá permisos y espacio disponible.');
  }

  // Escribir el PDF descargado a disco.
  // Puede fallar por disco lleno aun si /tmp existía al momento del accessSync.
  try {
    fs.writeFileSync(filePath, buffer);
  } catch (err) {
    throw new Error(`No se pudo guardar el PDF "${filename}": ${err.message}`);
  }

  logInfo('gamma',` PDF descargado: ${filePath} (${buffer.length} bytes)`);
  return filePath;
}

// === Función principal ===
//
// Flujo completo de generatePresentation:
//
//   1. CREACIÓN (POST /generations)
//      Envía el tema y detalles a la API de Gamma. Timeout 30s con 3 reintentos.
//      Gamma devuelve un generationId para hacer polling.
//
//   2. POLLING (GET /generations/{id}) — cada 5 segundos
//      Consulta el estado de la generación. Tres resultados posibles:
//      - "completed" → tiene exportUrl (PDF) y/o gammaUrl (editor web)
//      - "failed" → la generación falló, retorna mensaje de error
//      - otro → sigue esperando (siguiente intento de polling)
//      Timeout global de 3 minutos para todo el polling.
//
//   3. DESCARGA DEL PDF (si hay exportUrl)
//      Descarga el PDF a /tmp para que pueda adjuntarse por email después.
//      Si la descarga falla, igual retorna el link de Gamma para descarga manual.
//
//   Retorno al agente:
//   - "Presentación lista. Descargá el PDF acá: {url}\n[PDF guardado localmente: {filename}]"
//   - El agente usa el filename para adjuntarlo si el usuario pide enviarlo por email.

/**
 * Genera una presentación en Gamma y retorna el link.
 * Timeout global de 3 minutos para toda la operación (creación + polling).
 * @param {string} topic - Tema de la presentación
 * @param {string} details - Detalles y estilo (incluye preferencia del usuario: Formal/Moderno/Minimalista)
 * @returns {Promise<string>} Mensaje con el link de descarga y nombre del PDF local
 */
async function generatePresentation(topic, details) {
  if (!GAMMA_API_KEY) {
    return 'Error: GAMMA_API_KEY no configurada.';
  }

  let inputText = topic;
  if (details) {
    inputText += `\n\n${details}`;
  }

  // Registrar inicio para controlar el timeout global
  const inicioGlobal = Date.now();

  // Paso 1: Crear la generación (timeout 30s, hasta 3 reintentos)
  // Reintentos porque la API de Gamma puede devolver errores de red o 5xx transitorios
  logInfo('gamma',` Creando presentación: "${topic}"`);
  const createRes = await conReintentos(
    async () => {
      const res = await fetchConTimeout(`${BASE_URL}/generations`, {
        method: 'POST',
        headers: {
          'X-API-KEY': GAMMA_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputText,
          textMode: 'generate',
          format: 'presentation',
          numCards: 10,
          exportAs: 'pdf',
        }),
      }, TIMEOUT_CREACION_MS);

      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`Gamma API error ${res.status}: ${text}`);
        err.status = res.status;
        throw err;
      }
      return res;
    },
    {
      intentos: 3,
      esperaMs: 2000,
      onReintento: (err, intento, espera) => {
        logWarn('gamma',` Reintento ${intento} de creación (espera ${espera}ms): ${err.message}`);
      },
    }
  );

  const createData = await createRes.json();
  const generationId = createData.generationId ?? createData.id;
  logInfo('gamma',` generationId: ${generationId}`);

  if (!generationId) {
    logWarn('gamma', No se recibió generationId. Respuesta:', JSON.stringify(createData));
    if (createData.exportUrl) return `Presentación lista. Descargá el PDF acá: ${createData.exportUrl}`;
    if (createData.gammaUrl ?? createData.url) {
      return `Presentación creada. Accedela acá: ${createData.gammaUrl ?? createData.url}`;
    }
    throw new Error('Gamma no devolvió un generationId.');
  }

  // Paso 2: Polling hasta completed, failed o timeout global
  const maxAttempts = 40;
  for (let i = 0; i < maxAttempts; i++) {
    // Verificar timeout global antes de cada intento
    if (Date.now() - inicioGlobal > TIMEOUT_GLOBAL_MS) {
      logWarn('gamma',` Timeout global alcanzado (${TIMEOUT_GLOBAL_MS / 1000}s)`);
      return 'La generación de la presentación está tomando más tiempo del esperado. Intentalo de nuevo en unos minutos.';
    }

    await new Promise((r) => setTimeout(r, 5000));

    let statusRes;
    try {
      statusRes = await fetchConTimeout(`${BASE_URL}/generations/${generationId}`, {
        headers: { 'X-API-KEY': GAMMA_API_KEY },
      }, TIMEOUT_POLLING_MS);
    } catch (err) {
      logWarn('gamma',` Polling intento ${i + 1} falló: ${err.message}`);
      continue;
    }

    logInfo('gamma',` Polling intento ${i + 1}: HTTP ${statusRes.status}`);
    if (!statusRes.ok) continue;

    const statusData = await statusRes.json();
    logInfo('gamma',` status: ${statusData.status}`);

    if (statusData.status === 'completed') {
      logInfo('gamma', Respuesta completa al completarse:', JSON.stringify(statusData));
      const exportUrl = statusData.exportUrl;
      const gammaUrl = statusData.gammaUrl ?? statusData.url;

      if (exportUrl) {
        const safeTopic = topic.replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ ]/g, '').trim().replace(/\s+/g, '_');
        const pdfFilename = `presentacion_${safeTopic}_${Date.now()}.pdf`;
        try {
          await downloadToTmp(exportUrl, pdfFilename);
          return `Presentación lista. Descargá el PDF acá: ${exportUrl}\n[PDF guardado localmente: ${pdfFilename}]`;
        } catch (dlErr) {
          logWarn('gamma', No se pudo descargar el PDF:', dlErr.message);
          return `Presentación lista. Descargá el PDF acá: ${exportUrl}`;
        }
      }
      if (gammaUrl) return `Presentación creada. Accedela acá: ${gammaUrl}`;
      logWarn('gamma', completed sin ninguna URL disponible.');
    }

    if (statusData.status === 'failed') {
      return `La generación de la presentación falló: ${statusData.error || 'error desconocido'}.`;
    }
  }

  return 'La generación de la presentación está tomando más tiempo del esperado. Intentalo de nuevo en unos minutos.';
}

module.exports = { generatePresentation };
