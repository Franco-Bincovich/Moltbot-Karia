const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

const SEARCH_SYSTEM_PROMPT = `Sos un asistente de investigación de precios de electrodomésticos para Córdoba, Argentina. Sé lo más CONCISO posible. Sin texto explicativo adicional, solo la tabla.

TIENDAS:
- Si el usuario menciona tiendas específicas: buscá SOLO en esas tiendas. Máximo 2 productos por tienda.
- Si NO menciona tienda: buscá libremente priorizando OnCity, Genecio Hogar, Naldo, Cetrogar, Fravega, Megatone. Máximo 1 producto por tienda, máximo 3 tiendas.
- Si pidió una tienda y no encontrás el producto ahí, decilo: "No encontré este producto en [tienda]".
- Cuando busques precios en comercios, solo devolvé resultados de tiendas que existan y estén operativas hoy. Si al buscar un comercio el sitio no carga, está caído, o los resultados indican que la empresa cerró o ya no opera, no lo incluyas en la respuesta. Nunca inventes ni asumas que una tienda sigue operando.

FORMATO:
- Tabla con SOLO 3 columnas: Tienda | Precio | Link
- LINKS: DEBE ser la URL EXACTA de la página del producto específico. NUNCA uses URL de listados, categorías ni home. Si no tenés la URL exacta, poné "No disponible".
- Precios en pesos argentinos. Si hay cuotas sin interés, agregalo al lado del precio.
- NO agregues texto antes de la tabla.
- SIEMPRE agregá esta aclaración al final de la tabla: "* Precios consultados al momento de la búsqueda. Verificar precio actual en el link del producto."`;

/**
 * Busca precios de electrodomésticos usando la búsqueda web nativa de Claude.
 * Prioriza tiendas de Córdoba Argentina y cita fuentes con URL.
 * @param {string} query - Producto a buscar
 * @returns {string} Resultados formateados con fuentes
 */
async function searchCompetitors(query) {
  // Detectar si el query incluye nombres de tiendas específicas
  const KNOWN_STORES = ['fravega', 'frávega', 'naldo', 'cetrogar', 'musimundo', 'megatone', 'oncity', 'on city', 'genecio', 'mercadolibre', 'mercado libre'];
  const queryLower = query.toLowerCase();
  const mentionedStores = KNOWN_STORES.filter((s) => queryLower.includes(s));

  let systemPrompt = SEARCH_SYSTEM_PROMPT;
  let searchQuery;

  if (mentionedStores.length > 0) {
    const storeNames = mentionedStores.join(', ');
    systemPrompt += `\n\nIMPORTANTE: El usuario pidió buscar específicamente en: ${storeNames}. Buscá ÚNICAMENTE en esas tiendas. Si no encontrás el producto ahí, respondé "No encontré este producto en ${storeNames}" — NO busques en otras tiendas como alternativa.`;
    searchQuery = `Buscá precios actuales de "${query}". Incluí la URL exacta del producto.`;
  } else {
    searchQuery = `Buscá precios actuales de "${query}" en tiendas de electrodomésticos de Córdoba Argentina. Incluí la URL de cada resultado.`;
  }

  console.log(`[search] Búsqueda web iniciada: "${query}" | Tiendas detectadas: ${mentionedStores.length > 0 ? mentionedStores.join(', ') : 'ninguna (libre)'}`);

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system: systemPrompt,
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
  let result = textBlocks.map((b) => b.text).join('\n');

  if (!result.trim()) {
    console.warn('[search] Respuesta vacía de Claude web_search');

    // Si stop_reason es tool_use, necesitamos continuar el loop
    if (response.stop_reason === 'tool_use') {
      result = await continueSearchLoop(response, [{ role: 'user', content: searchQuery }]);
    } else {
      return 'No se encontraron resultados para este producto.';
    }
  }

  // Truncar resultado a 1500 chars para evitar rate limit en el agente
  const MAX_CHARS = 1500;
  if (result.length > MAX_CHARS) {
    result = result.slice(0, MAX_CHARS) + '\n[Resultados truncados]';
  }

  console.log(`[search] OK (${result.length} chars). Primeros 300: ${result.slice(0, 300)}`);
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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
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
