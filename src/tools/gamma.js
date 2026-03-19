const fs = require('fs');
const path = require('path');

const GAMMA_API_KEY = process.env.GAMMA_API_KEY;
const BASE_URL = 'https://public-api.gamma.app/v1.0';

/**
 * Downloads a file from a URL and saves it to /tmp.
 * Returns the local file path.
 */
async function downloadToTmp(url, filename) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Error descargando PDF: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const filePath = path.join('/tmp', filename);
  fs.writeFileSync(filePath, buffer);
  console.log(`[gamma] PDF descargado: ${filePath} (${buffer.length} bytes)`);
  return filePath;
}

async function generatePresentation(topic, details) {
  if (!GAMMA_API_KEY) {
    return 'Error: GAMMA_API_KEY no configurada.';
  }

  // Build inputText with topic and details (includes style preference from agent)
  let inputText = topic;
  if (details) {
    inputText += `\n\n${details}`;
  }

  // Paso 1: Crear la generación
  console.log(`[gamma] Creando presentación: "${topic}"`);
  const createRes = await fetch(`${BASE_URL}/generations`, {
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
  });

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

  // Paso 2: Polling cada 5 segundos hasta completed o failed
  const maxAttempts = 40; // ~3.5 minutos máximo
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 5000));

    const statusRes = await fetch(`${BASE_URL}/generations/${generationId}`, {
      headers: { 'X-API-KEY': GAMMA_API_KEY },
    });

    console.log(`[gamma] Polling intento ${i + 1}: HTTP ${statusRes.status}`);

    if (!statusRes.ok) continue;

    const statusData = await statusRes.json();
    console.log(`[gamma] status: ${statusData.status}`);

    if (statusData.status === 'completed') {
      console.log('[gamma] Respuesta completa al completarse:', JSON.stringify(statusData));
      const exportUrl = statusData.exportUrl;
      const gammaUrl = statusData.gammaUrl ?? statusData.url;

      if (exportUrl) {
        // Download PDF to /tmp for potential email attachment
        const safeTopic = topic.replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ ]/g, '').trim().replace(/\s+/g, '_');
        const pdfFilename = `presentacion_${safeTopic}_${Date.now()}.pdf`;
        try {
          const localPath = await downloadToTmp(exportUrl, pdfFilename);
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
