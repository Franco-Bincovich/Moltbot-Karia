const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;

const PRIORITY_SITES = [
  'fravega.com',
  'oncity.com',
  'naldo.com.ar',
  'megatone.net',
  'musimundo.com',
];

const SYSTEM_PROMPT = `Sos un asistente de investigación de precios para el mercado argentino.
Cuando te consulten por un producto, buscá precios actuales priorizando estos sitios en este orden: ${PRIORITY_SITES.join(', ')}.
Si no encontrás resultados en alguno de esos sitios, completá con precios reales de cualquier otra tienda argentina que tengas indexada.
Devolvé al menos 3 resultados reales con precio, organizados en una tabla con columnas: Tienda | Precio | Cuotas | Link.
- Mostrá precios en pesos argentinos.
- Si hay cuotas sin interés, indicá la cantidad (ej: "12 cuotas sin interés").
- Incluí el link directo al producto o a la búsqueda en esa tienda.
- Solo mostrá resultados con precio real — no inventes ni pongas "Consultar" si no tenés el dato.
- Respondé siempre en español.`;

async function searchCompetitors(query) {
  if (!PERPLEXITY_API_KEY) {
    console.error('[perplexity] PERPLEXITY_API_KEY no configurada');
    return 'Error: PERPLEXITY_API_KEY no configurada.';
  }

  const siteFilter = PRIORITY_SITES.map((s) => `site:${s}`).join(' OR ');
  const searchQuery = `${query} precio Argentina 2025 ${siteFilter}`;
  console.log(`[perplexity] Query: "${searchQuery}"`);
  console.log(`[perplexity] Llamando a API (modelo: sonar-pro)...`);

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
        search_recency_filter: 'month',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
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
    console.error(`[perplexity] Error de API: ${res.status} | ${text}`);
    throw new Error(`Perplexity API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    console.warn('[perplexity] Respuesta vacía. Data completa:', JSON.stringify(data));
    return 'No se obtuvieron resultados.';
  }

  console.log(`[perplexity] OK. Primeros 300 chars: ${content.slice(0, 300)}`);
  return content;
}

module.exports = { searchCompetitors };
