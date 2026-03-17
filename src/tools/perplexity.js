const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;

const SITES = [
  'fravega.com',
  'oncity.com',
  'geneciohogar.com.ar',
];

function buildSearchQuery(query) {
  const siteFilter = SITES.map((s) => `site:${s}`).join(' OR ');
  return `(${siteFilter}) ${query} precio stock cuotas Argentina`;
}

async function searchCompetitors(query) {
  if (!PERPLEXITY_API_KEY) {
    console.error('[perplexity] PERPLEXITY_API_KEY no configurada');
    return 'Error: PERPLEXITY_API_KEY no configurada.';
  }

  const systemPrompt = `Sos un asistente de investigación de mercado argentino especializado en electrodomésticos.
Tu tarea es buscar el producto indicado en estos sitios: fravega.com, oncity.com, geneciohogar.com.ar.
Devolvé los resultados en formato de tabla con columnas: Competidor | Precio | Stock | Promociones/Cuotas.
- Incluí todos los sitios donde encontraste resultados, aunque sea uno solo.
- Si en algún sitio no hay resultados, escribí "No encontrado" en esa fila.
- Mostrá precios en pesos argentinos, stock disponible y opciones de financiación/cuotas si las hay.
- No inventes datos. Si no tenés información de precio exacto, indicá "Consultar".
- Respondé siempre en español.`;

  const searchQuery = buildSearchQuery(query);

  console.log(`[perplexity] Query original: "${query}"`);
  console.log(`[perplexity] Query con sites: "${searchQuery}"`);
  console.log(`[perplexity] Llamando a Perplexity API (modelo: sonar-pro)...`);

  let res;
  try {
    res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: searchQuery },
        ],
      }),
    });
  } catch (fetchErr) {
    console.error('[perplexity] Error de red al llamar a Perplexity:', fetchErr.message);
    throw fetchErr;
  }

  console.log(`[perplexity] Respuesta HTTP: ${res.status} ${res.statusText}`);

  if (!res.ok) {
    const text = await res.text();
    console.error(`[perplexity] Error de API: ${res.status} | Body: ${text}`);
    throw new Error(`Perplexity API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    console.warn('[perplexity] Respuesta vacía de Perplexity. Data completa:', JSON.stringify(data));
    return 'No se obtuvieron resultados.';
  }

  console.log(`[perplexity] Respuesta recibida (primeros 300 chars): ${content.slice(0, 300)}`);
  return content;
}

module.exports = { searchCompetitors };
