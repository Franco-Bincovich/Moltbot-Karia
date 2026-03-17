const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;

const PRIORITY_SITES = [
  'fravega.com',
  'oncity.com',
  'naldo.com.ar',
  'megatone.net',
  'musimundo.com',
];

const SYSTEM_PROMPT = `Sos un asistente de investigación de precios para el mercado argentino.
Buscá el producto consultado ÚNICAMENTE en estas 5 tiendas: ${PRIORITY_SITES.join(', ')}.
Devolvé SIEMPRE una tabla con exactamente esas 5 tiendas como filas, en ese orden, con columnas: Tienda | Precio | Cuotas | Link.
- Si encontrás el producto en una tienda, completá Precio, Cuotas y Link con datos reales.
- Si NO encontrás el producto en una tienda, escribí "Sin datos" en Precio, Cuotas y Link.
- NO incluyas ninguna otra tienda fuera de esas 5 (ni Cetrogar, ni Jumbo, ni Samsung AR, ni ninguna otra).
- Mostrá precios en pesos argentinos.
- Si hay cuotas sin interés, indicá la cantidad (ej: "12 cuotas sin interés").
- Incluí el link directo al producto encontrado, no a la home del sitio.
- No inventes precios ni links.
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
