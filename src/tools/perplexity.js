const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;

const STORE_DOMAINS = [
  'fravega.com',
  'oncity.com.ar',
  'geneciohogar.com.ar',
  'naldo.com.ar',
  'cetrogar.com.ar',
];

function buildSearchQuery(query) {
  const domainList = STORE_DOMAINS.join(', ');
  return `¿Cuál es el precio actual de ${query} en ${domainList}? Incluí stock disponible y opciones de cuotas sin interés.`;
}

async function searchCompetitors(query) {
  if (!PERPLEXITY_API_KEY) {
    console.error('[perplexity] PERPLEXITY_API_KEY no configurada');
    return 'Error: PERPLEXITY_API_KEY no configurada.';
  }

  const storeList = STORE_DOMAINS.join(', ');
  const systemPrompt = `Sos un asistente de investigación de mercado argentino especializado en electrodomésticos.
Debés buscar el producto indicado en estos sitios de venta online: fravega.com, oncity.com, geneciohogar.com.ar, naldo.com.ar, cetrogar.com.ar.
Organizá los resultados en una tabla con columnas: Tienda | Precio | Stock | Promociones/Cuotas | URL del producto.
- Incluí una fila por cada tienda donde encontraste el producto.
- Si en una tienda no hay resultados, igualmente incluí la fila con "No encontrado" en Precio y Stock.
- Para cada resultado encontrado, incluí la URL directa al producto o a la búsqueda en esa tienda.
- Mostrá precios en pesos argentinos. Si hay cuotas sin interés, indicá la cantidad de cuotas.
- No inventes precios ni URLs. Si no tenés el dato exacto, escribí "Consultar en ${storeList}".
- Respondé siempre en español.`;

  const searchQuery = buildSearchQuery(query);

  console.log(`[perplexity] Query original: "${query}"`);
  console.log(`[perplexity] Query construido: "${searchQuery}"`);
  console.log(`[perplexity] Llamando a Perplexity API (modelo: sonar-reasoning-pro)...`);

  let res;
  try {
    res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar-reasoning-pro',
        search_recency_filter: 'month',
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
