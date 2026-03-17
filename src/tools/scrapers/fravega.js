const BASE_URL = 'https://www.fravega.com';
const API_URL = `${BASE_URL}/api/v1/search`;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Accept-Language': 'es-AR,es;q=0.9',
  Referer: 'https://www.fravega.com/',
};

/**
 * Busca productos en Frávega usando su API interna y devuelve los primeros 5 resultados.
 * @param {string} query - Término de búsqueda (ej: "televisor Samsung 50 pulgadas")
 * @returns {Promise<Array<{nombre: string, precio: string|null, precioAnterior: string|null, url: string|null}>>}
 */
async function scrapeFravega(query) {
  const url = `${API_URL}?keyword=${encodeURIComponent(query)}&page=1&pageSize=5`;
  console.log(`[fravega] Consultando API: ${url}`);

  let res;
  try {
    res = await fetch(url, { headers: HEADERS });
  } catch (err) {
    console.error('[fravega] Error de red:', err.message);
    throw new Error(`Frávega no responde: ${err.message}`);
  }

  console.log(`[fravega] HTTP ${res.status} ${res.statusText}`);

  if (res.status === 403 || res.status === 429) {
    throw new Error(`Frávega bloqueó la request (HTTP ${res.status})`);
  }

  if (!res.ok) {
    throw new Error(`Frávega devolvió HTTP ${res.status}`);
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(`Frávega devolvió respuesta no-JSON: ${err.message}`);
  }

  console.log(`[fravega] Respuesta JSON recibida. Keys: ${Object.keys(data).join(', ')}`);

  const items = data.results ?? data.products ?? data.items ?? [];
  console.log(`[fravega] Productos en respuesta: ${items.length}`);

  if (items.length === 0) {
    console.warn('[fravega] Sin resultados. Respuesta completa:', JSON.stringify(data).slice(0, 500));
  }

  return items.slice(0, 5).map((item) => {
    const nombre = item.title ?? item.name ?? null;
    const precioRaw = item.sellingPrice ?? item.price ?? null;
    const precioAnteriorRaw = item.originalPrice ?? null;
    const slug = item.slug ?? item.url ?? null;

    const precio = precioRaw != null ? formatPrice(precioRaw) : null;
    const precioAnterior =
      precioAnteriorRaw != null && precioAnteriorRaw !== precioRaw
        ? formatPrice(precioAnteriorRaw)
        : null;
    const url = slug ? `${BASE_URL}/p/${slug}` : null;

    return { nombre, precio, precioAnterior, url };
  });
}

function formatPrice(value) {
  if (typeof value === 'string') return value;
  return `$${Number(value).toLocaleString('es-AR')}`;
}

/**
 * Formatea los resultados como texto para incluir en la respuesta del agente.
 */
function formatFravegaResults(results, query) {
  if (results.length === 0) {
    return `**Frávega**: No se encontraron resultados para "${query}". Podés buscar directamente en ${BASE_URL}/l/?keyword=${encodeURIComponent(query)}`;
  }

  const lines = [`**Frávega** — resultados para "${query}":\n`];
  for (const r of results) {
    const nombre = r.nombre ?? 'Sin nombre';
    const precio = r.precio ?? 'Consultar';
    const descuento = r.precioAnterior ? ` ~~${r.precioAnterior}~~` : '';
    const link = r.url ? ` → [Ver producto](${r.url})` : '';
    lines.push(`- ${nombre}: **${precio}**${descuento}${link}`);
  }
  return lines.join('\n');
}

module.exports = { scrapeFravega, formatFravegaResults };
