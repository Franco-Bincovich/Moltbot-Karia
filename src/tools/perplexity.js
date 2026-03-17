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

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
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

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Perplexity API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || 'No se obtuvieron resultados.';
}

module.exports = { searchCompetitors };
