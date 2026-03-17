const cheerio = require('cheerio');

const BASE_URL = 'https://www.fravega.com';
const SEARCH_URL = `${BASE_URL}/l/`;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * Busca productos en Frávega y devuelve los primeros 5 resultados.
 * @param {string} query - Término de búsqueda (ej: "televisor Samsung 50 pulgadas")
 * @returns {Promise<Array<{nombre: string, precio: string, precioAnterior: string|null, url: string}>>}
 */
async function scrapeFravega(query) {
  const url = `${SEARCH_URL}?keyword=${encodeURIComponent(query)}`;
  console.log(`[fravega] Scraping: ${url}`);

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

  const html = await res.text();
  console.log(`[fravega] HTML recibido: ${html.length} caracteres`);

  const $ = cheerio.load(html);
  const results = [];

  // Frávega renderiza productos en <article> con data-testid="result-item"
  // Fallback: cualquier article dentro del listado de resultados
  const items = $('article[data-testid="result-item"], ul[class*="results"] li article').slice(0, 5);

  console.log(`[fravega] Artículos encontrados en HTML: ${items.length}`);

  items.each((_, el) => {
    const $el = $(el);

    const nombre =
      $el.find('[class*="title"], [class*="name"], h2, h3').first().text().trim() || null;

    // Precio actual: busca el span/div con clase que contenga "price" pero no "old" ni "before"
    const precioEl = $el
      .find('[class*="price"]:not([class*="old"]):not([class*="before"]):not([class*="previous"])')
      .first();
    const precio = precioEl.text().trim() || null;

    // Precio anterior (tachado)
    const precioAnteriorEl = $el
      .find('[class*="old-price"], [class*="before-price"], [class*="previous-price"], s, del')
      .first();
    const precioAnterior = precioAnteriorEl.text().trim() || null;

    // URL del producto
    const href = $el.find('a[href]').first().attr('href') || null;
    const url = href
      ? href.startsWith('http')
        ? href
        : `${BASE_URL}${href}`
      : null;

    if (nombre || precio) {
      results.push({ nombre, precio, precioAnterior, url });
    }
  });

  console.log(`[fravega] Resultados parseados: ${results.length}`);

  if (results.length === 0) {
    // Log de fragmento del HTML para diagnóstico
    console.warn('[fravega] Sin resultados. Fragmento del HTML (primeros 2000 chars):');
    console.warn(html.slice(0, 2000));
  }

  return results;
}

/**
 * Formatea los resultados como texto para incluir en la respuesta del agente.
 */
function formatFravegaResults(results, query) {
  if (results.length === 0) {
    return `**Frávega**: No se encontraron resultados para "${query}". Podés buscar directamente en https://www.fravega.com/l/?keyword=${encodeURIComponent(query)}`;
  }

  const lines = [`**Frávega** — resultados para "${query}":\n`];
  for (const r of results) {
    const nombre = r.nombre || 'Sin nombre';
    const precio = r.precio || 'Consultar';
    const descuento = r.precioAnterior ? ` ~~${r.precioAnterior}~~` : '';
    const link = r.url ? ` → [Ver producto](${r.url})` : '';
    lines.push(`- ${nombre}: **${precio}**${descuento}${link}`);
  }
  return lines.join('\n');
}

module.exports = { scrapeFravega, formatFravegaResults };
