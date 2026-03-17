const BASE_URL = 'https://www.fravega.com';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Accept-Language': 'es-AR,es;q=0.9',
  Referer: 'https://www.fravega.com/',
};

// URLs candidatas en orden de prueba
function buildCandidateUrls(query) {
  const q = encodeURIComponent(query);
  return [
    `https://www.fravega.com/api/search?term=${q}&page=1&limit=5`,
    `https://www.fravega.com/api/catalog/search?q=${q}`,
    `https://api.fravega.com/v1/products?q=${q}`,
  ];
}

function extractItems(data) {
  return data.results ?? data.products ?? data.items ?? data.data ?? [];
}

/**
 * Prueba cada URL candidata en orden hasta obtener 200 OK con datos válidos.
 * Loguea qué URL funcionó.
 */
async function scrapeFravega(query) {
  const candidates = buildCandidateUrls(query);
  let lastError = null;

  for (const url of candidates) {
    console.log(`[fravega] Probando: ${url}`);

    let res;
    try {
      res = await fetch(url, { headers: HEADERS });
    } catch (err) {
      console.error(`[fravega] Error de red en ${url}: ${err.message}`);
      lastError = err;
      continue;
    }

    console.log(`[fravega] HTTP ${res.status} para ${url}`);

    if (!res.ok) {
      lastError = new Error(`HTTP ${res.status}`);
      continue;
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      console.error(`[fravega] Respuesta no-JSON en ${url}: ${err.message}`);
      lastError = err;
      continue;
    }

    const items = extractItems(data);
    console.log(`[fravega] URL exitosa: ${url} | Productos: ${items.length} | Keys: ${Object.keys(data).join(', ')}`);

    if (items.length === 0) {
      console.warn('[fravega] Sin resultados. Respuesta:', JSON.stringify(data).slice(0, 500));
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
      const productUrl = slug ? `${BASE_URL}/p/${slug}` : null;

      return { nombre, precio, precioAnterior, url: productUrl };
    });
  }

  throw new Error(`Todas las URLs fallaron. Último error: ${lastError?.message}`);
}

function formatPrice(value) {
  if (typeof value === 'string') return value;
  return `$${Number(value).toLocaleString('es-AR')}`;
}

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
