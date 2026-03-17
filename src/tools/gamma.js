const GAMMA_API_KEY = process.env.GAMMA_API_KEY;

async function generatePresentation(topic, details) {
  if (!GAMMA_API_KEY) {
    return 'Error: GAMMA_API_KEY no configurada.';
  }

  // Paso 1: Crear la generación
  const createRes = await fetch('https://api.gamma.app/v1/generate', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GAMMA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'presentation',
      topic,
      notes: details || '',
      language: 'es',
    }),
  });

  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`Gamma API error ${createRes.status}: ${text}`);
  }

  const createData = await createRes.json();
  const generationId = createData.id;

  if (createData.url) {
    return `Presentacion creada. Accedela aca: ${createData.url}`;
  }

  // Paso 2: Polling hasta que termine
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 3000));

    const statusRes = await fetch(
      `https://api.gamma.app/v1/generate/${generationId}`,
      {
        headers: { Authorization: `Bearer ${GAMMA_API_KEY}` },
      }
    );

    if (!statusRes.ok) continue;

    const statusData = await statusRes.json();

    if (statusData.status === 'completed' && statusData.url) {
      return `Presentacion creada. Accedela aca: ${statusData.url}`;
    }

    if (statusData.status === 'failed') {
      return `La generacion de la presentacion fallo: ${statusData.error || 'error desconocido'}.`;
    }
  }

  return 'La generacion de la presentacion esta tomando mas tiempo del esperado. Intentalo de nuevo en unos minutos.';
}

module.exports = { generatePresentation };
