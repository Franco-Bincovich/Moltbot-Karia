const fs = require('fs');
const path = require('path');

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
 * Descarga un archivo desde una URL y lo guarda en /tmp.
 * @param {string} url - URL del archivo a descargar
 * @param {string} filename - Nombre con el que guardar el archivo
 * @returns {Promise<string>} Ruta local del archivo descargado
 */
async function downloadToTmp(url, filename) {
  const res = await fetchConTimeout(url, {}, TIMEOUT_DESCARGA_MS);
  if (!res.ok) throw new Error(`Error descargando PDF: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const filePath = path.join('/tmp', filename);
  fs.writeFileSync(filePath, buffer);
  console.log(`[gamma] PDF descargado: ${filePath} (${buffer.length} bytes)`);
  return filePath;
}

// === Función principal ===

/**
 * Genera una presentación en Gamma y retorna el link.
 * Timeout global de 3 minutos para toda la operación (creación + polling).
 * @param {string} topic - Tema de la presentación
 * @param {string} details - Detalles y estilo
 * @returns {Promise<string>} Mensaje con el link de la presentación
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

  // Paso 1: Crear la generación (timeout 30s)
  console.log(`[gamma] Creando presentación: "${topic}"`);
  const createRes = await fetchConTimeout(`${BASE_URL}/generations`, {
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

  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`Gamma API error ${createRes.status}: ${text}`);
  }

  const createData = await createRes.json();
  const generationId = createData.generationId ?? createData.id;
  console.log(`[gamma] generationId: ${generationId}`);

  if (!generationId) {
    console.warn('[gamma] No se recibió generationId. Respuesta:', JSON.stringify(createData));
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
      console.warn(`[gamma] Timeout global alcanzado (${TIMEOUT_GLOBAL_MS / 1000}s)`);
      return 'La generación de la presentación está tomando más tiempo del esperado. Intentalo de nuevo en unos minutos.';
    }

    await new Promise((r) => setTimeout(r, 5000));

    let statusRes;
    try {
      statusRes = await fetchConTimeout(`${BASE_URL}/generations/${generationId}`, {
        headers: { 'X-API-KEY': GAMMA_API_KEY },
      }, TIMEOUT_POLLING_MS);
    } catch (err) {
      console.warn(`[gamma] Polling intento ${i + 1} falló: ${err.message}`);
      continue;
    }

    console.log(`[gamma] Polling intento ${i + 1}: HTTP ${statusRes.status}`);
    if (!statusRes.ok) continue;

    const statusData = await statusRes.json();
    console.log(`[gamma] status: ${statusData.status}`);

    if (statusData.status === 'completed') {
      console.log('[gamma] Respuesta completa al completarse:', JSON.stringify(statusData));
      const exportUrl = statusData.exportUrl;
      const gammaUrl = statusData.gammaUrl ?? statusData.url;

      if (exportUrl) {
        const safeTopic = topic.replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ ]/g, '').trim().replace(/\s+/g, '_');
        const pdfFilename = `presentacion_${safeTopic}_${Date.now()}.pdf`;
        try {
          await downloadToTmp(exportUrl, pdfFilename);
          return `Presentación lista. Descargá el PDF acá: ${exportUrl}\n[PDF guardado localmente: ${pdfFilename}]`;
        } catch (dlErr) {
          console.warn('[gamma] No se pudo descargar el PDF:', dlErr.message);
          return `Presentación lista. Descargá el PDF acá: ${exportUrl}`;
        }
      }
      if (gammaUrl) return `Presentación creada. Accedela acá: ${gammaUrl}`;
      console.warn('[gamma] completed sin ninguna URL disponible.');
    }

    if (statusData.status === 'failed') {
      return `La generación de la presentación falló: ${statusData.error || 'error desconocido'}.`;
    }
  }

  return 'La generación de la presentación está tomando más tiempo del esperado. Intentalo de nuevo en unos minutos.';
}

module.exports = { generatePresentation };
