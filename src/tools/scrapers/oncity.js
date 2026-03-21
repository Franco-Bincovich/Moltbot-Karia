const { logInfo, logWarn, logError } = require('../../utils/logger');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache',
};

/**
 * Formatea un número o string de precio al formato argentino: $249.499
 */
function formatearPrecio(raw) {
  const str = String(raw).replace(/[$\s]/g, '').replace(/,/g, '');
  const num = parseFloat(str);
  if (isNaN(num)) return null;
  return '$' + Math.round(num).toLocaleString('es-AR');
}

/**
 * Extrae precio de una página de producto de OnCity.
 * Estrategias en orden de confiabilidad:
 *   1. JSON-LD schema.org (offers.price)
 *   2. VTEX __STATE__ JSON embebido
 *   3. Regex sobre clase vtex-product-price / sellingPrice
 *
 * @param {string} url - URL del producto en oncity.com
 * @returns {string|null} Precio formateado (ej: "$249.499") o null si falla
 */
async function scrapeOnCity(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    logInfo('scraper-oncity', `Scraping: ${url}`);
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });

    if (!res.ok) {
      logWarn('scraper-oncity', `HTTP ${res.status} para ${url}`);
      return null;
    }

    const html = await res.text();

    // Estrategia 1: JSON-LD con @type Product
    const jsonLdMatches = html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
    for (const m of jsonLdMatches) {
      try {
        const data = JSON.parse(m[1]);
        const entries = Array.isArray(data) ? data : [data];
        for (const entry of entries) {
          const price = entry?.offers?.price ?? entry?.offers?.[0]?.price;
          if (price) {
            const formateado = formatearPrecio(price);
            if (formateado) {
              logInfo('scraper-oncity', `Precio por JSON-LD: ${formateado}`);
              return formateado;
            }
          }
        }
      } catch (_) { /* JSON inválido, continuar */ }
    }

    // Estrategia 2: VTEX __STATE__ embebido
    const stateMatch = html.match(/window\.__STATE__\s*=\s*({[\s\S]*?})(?:<\/script>|;)/);
    if (stateMatch) {
      try {
        const state = JSON.parse(stateMatch[1]);
        for (const key of Object.keys(state)) {
          const node = state[key];
          if (node?.sellingPrice) {
            const formateado = formatearPrecio(node.sellingPrice / 100); // VTEX guarda en centavos
            if (formateado) {
              logInfo('scraper-oncity', `Precio por __STATE__: ${formateado}`);
              return formateado;
            }
          }
        }
      } catch (_) { /* JSON inválido, continuar */ }
    }

    // Estrategia 3: regex sobre clases conocidas de OnCity / VTEX
    // Patrón de precio completo en formato argentino: $359.999 o $1.359.999
    const patterns = [
      /class="[^"]*vtex-product-price[^"]*"[^>]*>[\s\S]{0,100}?(\$[\d]{1,3}(?:\.[\d]{3})+)/,
      /class="[^"]*sellingPrice[^"]*"[^>]*>[\s\S]{0,100}?(\$[\d]{1,3}(?:\.[\d]{3})+)/,
      /"sellingPrice"\s*:\s*([\d]+)/,
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        const formateado = formatearPrecio(match[1]);
        if (formateado) {
          logInfo('scraper-oncity', `Precio por regex: ${formateado}`);
          return formateado;
        }
      }
    }

    logWarn('scraper-oncity', `No se encontró precio en ${url}`);
    return null;
  } catch (err) {
    if (err.name === 'AbortError') {
      logWarn('scraper-oncity', `Timeout (5s) para ${url}`);
    } else {
      logError('scraper-oncity', `Error: ${err.message}`);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { scrapeOnCity };
