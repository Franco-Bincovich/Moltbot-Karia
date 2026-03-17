const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;

async function searchCompetitors(query) {
  if (!PERPLEXITY_API_KEY) {
    return 'Error: PERPLEXITY_API_KEY no configurada.';
  }

  const systemPrompt = `Sos un asistente de investigación de mercado argentino.
Buscá información SOLO en estos sitios: fravega.com, oncity.com, geneciohogar.com.ar, naldo.com.ar y cetrogar.com.ar.
Devolvé los resultados en formato de tabla comparativa con columnas: Competidor | Precio | Stock | Promociones/Cuotas.
Si no encontrás información de algún competidor, indicalo claramente con "No encontrado".
Respondé siempre en español. No inventes datos.`;

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar-pro',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: query },
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
