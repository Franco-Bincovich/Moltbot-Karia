const GAMMA_API_KEY = process.env.GAMMA_API_KEY;
const BASE_URL = 'https://public-api.gamma.app/v1.0';

async function generatePresentation(topic, details) {
  if (!GAMMA_API_KEY) {
    return 'Error: GAMMA_API_KEY no configurada.';
  }

  const inputText = details ? `${topic}\n\n${details}` : topic;

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
    if (createData.gammaUrl ?? createData.url) {
      return `Presentación creada. Accedela acá: ${createData.gammaUrl ?? createData.url}`;
    }
    throw new Error('Gamma no devolvió un generationId.');
  }

  // Paso 2: Polling cada 5 segundos hasta completed o failed
  const maxAttempts = 24; // 2 minutos máximo
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
      const url = statusData.gammaUrl ?? statusData.url;
      if (url) return `Presentación creada. Accedela acá: ${url}`;
      console.warn('[gamma] completed pero sin URL. Data:', JSON.stringify(statusData));
    }

    if (statusData.status === 'failed') {
      return `La generación de la presentación falló: ${statusData.error || 'error desconocido'}.`;
    }
  }

  return 'La generación de la presentación está tomando más tiempo del esperado. Intentalo de nuevo en unos minutos.';
}

module.exports = { generatePresentation };
