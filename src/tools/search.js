const { searchMercadoLibre, formatMercadoLibreResults } = require('./scrapers/mercadolibre');

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;

const PERPLEXITY_DOMAINS = [
  'oncity.com.ar',
  'geneciohogar.com.ar',
  'naldo.com.ar',
  'cetrogar.com.ar',
];

function buildPerplexityQuery(query) {
  const domainList = PERPLEXITY_DOMAINS.join(', ');
  return `¿Cuál es el precio actual de ${query} en ${domainList}? Incluí stock disponible y opciones de cuotas sin interés.`;
}

async function searchPerplexity(query) {
  if (!PERPLEXITY_API_KEY) {
    console.error('[perplexity] PERPLEXITY_API_KEY no configurada');
    return 'Error: PERPLEXITY_API_KEY no configurada.';
  }

  const storeList = PERPLEXITY_DOMAINS.join(', ');
  const systemPrompt = `Sos un asistente de investigación de mercado argentino especializado en electrodomésticos.
Debés buscar el producto indicado en estos sitios de venta online: oncity.com.ar, geneciohogar.com.ar, naldo.com.ar, cetrogar.com.ar.
Organizá los resultados en una tabla con columnas: Tienda | Precio | Stock | Promociones/Cuotas | URL del producto.
- Incluí una fila por cada tienda donde encontraste el producto.
- Si en una tienda no hay resultados, igualmente incluí la fila con "No encontrado" en Precio y Stock.
- Para cada resultado encontrado, incluí la URL directa al producto o a la búsqueda en esa tienda.
- Mostrá precios en pesos argentinos. Si hay cuotas sin interés, indicá la cantidad de cuotas.
- No inventes precios ni URLs. Si no tenés el dato exacto, escribí "Consultar en ${storeList}".
- Respondé siempre en español.`;

  const searchQuery = buildPerplexityQuery(query);
  console.log(`[perplexity] Query: "${searchQuery}"`);
  console.log(`[perplexity] Llamando a API (modelo: sonar)...`);

  let res;
  try {
    res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar',
        search_recency_filter: 'month',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: searchQuery },
        ],
      }),
    });
  } catch (err) {
    console.error('[perplexity] Error de red:', err.message);
    throw err;
  }

  console.log(`[perplexity] HTTP ${res.status} ${res.statusText}`);

  if (!res.ok) {
    const text = await res.text();
    console.error(`[perplexity] Error: ${res.status} | ${text}`);
    throw new Error(`Perplexity API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    console.warn('[perplexity] Respuesta vacía. Data:', JSON.stringify(data));
    return 'No se obtuvieron resultados de OnCity, Genecio Hogar, Naldo y Cetrogar.';
  }

  console.log(`[perplexity] OK. Primeros 300 chars: ${content.slice(0, 300)}`);
  return content;
}

async function searchCompetitors(query) {
  console.log(`[search] Búsqueda iniciada: "${query}"`);

  const [mlResult, perplexityResult] = await Promise.allSettled([
    searchMercadoLibre(query),
    searchPerplexity(query),
  ]);

  const parts = [];

  if (mlResult.status === 'fulfilled') {
    parts.push(formatMercadoLibreResults(mlResult.value, query));
  } else {
    console.error('[search] Error en MercadoLibre:', mlResult.reason?.message);
    parts.push(`**MercadoLibre**: Error al obtener resultados (${mlResult.reason?.message})`);
  }

  if (perplexityResult.status === 'fulfilled') {
    parts.push(perplexityResult.value);
  } else {
    console.error('[search] Error en Perplexity:', perplexityResult.reason?.message);
    parts.push(`**Otras tiendas**: Error al obtener resultados (${perplexityResult.reason?.message})`);
  }

  return parts.join('\n\n---\n\n');
}

module.exports = { searchCompetitors };
