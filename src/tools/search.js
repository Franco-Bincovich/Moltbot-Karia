const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

const SEARCH_SYSTEM_PROMPT = `Sos un asistente de investigación de precios de electrodomésticos para Córdoba, Argentina.

REGLA CRÍTICA — TIENDAS ESPECÍFICAS VS BÚSQUEDA LIBRE:
- Si el usuario menciona una o más tiendas específicas en su consulta (ej: "en Frávega", "en Frávega y Naldo", "buscame en OnCity"), buscá ÚNICAMENTE en esas tiendas. No busques en ninguna otra tienda.
- Cuando buscás en tiendas específicas, incluí SIEMPRE el nombre de la tienda en cada búsqueda web. Ej: si pide "lavarropas en Frávega", buscá "lavarropas Frávega" explícitamente.
- Si el usuario pidió una tienda específica y no encontrás el producto ahí, decilo claramente: "No encontré este producto en [tienda]". NO busques en otras tiendas como alternativa.
- Si el usuario NO menciona ninguna tienda, buscá libremente priorizando empresas de Córdoba Argentina: OnCity, Genecio Hogar, Naldo, Cetrogar, Musimundo, Fravega, Megatone. También podés incluir MercadoLibre y otras tiendas si tienen resultados relevantes.

FORMATO DE RESULTADOS:
- Organizá los resultados en una tabla con columnas: Tienda | Precio | Cuotas/Promociones | Link
- Para CADA resultado, incluí la URL real de donde obtuviste el dato. Nunca inventés URLs.
- Mostrá precios en pesos argentinos.
- Si hay cuotas sin interés, indicá la cantidad.
- Si no encontrás el producto en una tienda (en búsqueda libre), no la incluyas en la tabla.
- Respondé siempre en español, tono directo.`;

/**
 * Busca precios de electrodomésticos usando la búsqueda web nativa de Claude.
 * Prioriza tiendas de Córdoba Argentina y cita fuentes con URL.
 * @param {string} query - Producto a buscar
 * @returns {string} Resultados formateados con fuentes
 */
async function searchCompetitors(query) {
  const searchQuery = `Buscá precios actuales de "${query}" en tiendas de electrodomésticos de Córdoba Argentina. Incluí la URL de cada resultado.`;

  console.log(`[search] Búsqueda web iniciada: "${query}"`);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: SEARCH_SYSTEM_PROMPT,
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 10,
      },
    ],
    messages: [{ role: 'user', content: searchQuery }],
  });

  // Extraer texto de la respuesta (puede incluir múltiples bloques tras web_search)
  const textBlocks = response.content.filter((b) => b.type === 'text');
  const result = textBlocks.map((b) => b.text).join('\n');

  if (!result.trim()) {
    console.warn('[search] Respuesta vacía de Claude web_search');

    // Si stop_reason es tool_use, necesitamos continuar el loop
    if (response.stop_reason === 'tool_use') {
      return await continueSearchLoop(response, [{ role: 'user', content: searchQuery }]);
    }

    return 'No se encontraron resultados para este producto.';
  }

  console.log(`[search] OK. Primeros 300 chars: ${result.slice(0, 300)}`);
  return result;
}

/**
 * Continúa el loop de tool_use cuando Claude necesita hacer múltiples búsquedas.
 */
async function continueSearchLoop(initialResponse, messages) {
  let response = initialResponse;

  // Agregar respuesta del asistente al historial
  messages.push({ role: 'assistant', content: response.content });

  // Procesar tool results para web_search (server-side tool, results come automatically)
  // Con web_search server-side, Claude maneja los resultados internamente.
  // Si llegamos acá, re-enviar para que Claude procese los resultados.

  let attempts = 0;
  while (response.stop_reason === 'tool_use' && attempts < 5) {
    attempts++;

    // Para server-side tools como web_search, los resultados se inyectan automáticamente
    // Solo necesitamos volver a llamar si hay tool_use blocks que no son web_search
    const nonWebSearchTools = response.content.filter(
      (b) => b.type === 'tool_use' && b.name !== 'web_search'
    );

    if (nonWebSearchTools.length === 0) {
      // Todas son web_search — Claude las maneja server-side, la respuesta debería
      // llegar completa. Si no, hacemos otro request.
      response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: SEARCH_SYSTEM_PROMPT,
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 10,
          },
        ],
        messages,
      });

      messages.push({ role: 'assistant', content: response.content });
    } else {
      break;
    }
  }

  const textBlocks = response.content.filter((b) => b.type === 'text');
  const result = textBlocks.map((b) => b.text).join('\n');

  console.log(`[search] Loop completado tras ${attempts} iteraciones. Resultado: ${result.slice(0, 300)}`);
  return result || 'No se encontraron resultados para este producto.';
}

module.exports = { searchCompetitors };
