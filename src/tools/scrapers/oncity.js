const { logInfo, logWarn, logError } = require('../../utils/logger');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
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
 * Extrae el SKU numérico del URL de producto de OnCity.
 * Ejemplo: https://www.oncity.com/smart-led-tv-...-153972/p → "153972"
 */
function extraerSku(url) {
  const match = url.match(/-(\d+)\/p/);
  return match ? match[1] : null;
}

/**
 * Consulta la API de catálogo VTEX de OnCity y devuelve el precio de venta.
 * Ruta: /api/catalog_system/pub/products/search?fq=productId:SKU
 * Precio en: items[0].sellers[0].commertialOffer.Price
 *
 * @param {string} url - URL del producto en oncity.com
 * @returns {string|null} Precio formateado (ej: "$249.499") o null si falla
 */
async function scrapeOnCity(url) {
  const sku = extraerSku(url);
  if (!sku) {
    logWarn('scraper-oncity', `No se pudo extraer SKU de: ${url}`);
    return null;
  }

  const apiUrl = `https://www.oncity.com/api/catalog_system/pub/products/search?fq=productId:${sku}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    logInfo('scraper-oncity', `API call SKU ${sku}: ${apiUrl}`);
    const res = await fetch(apiUrl, { headers: HEADERS, signal: controller.signal });

    if (!res.ok) {
      logWarn('scraper-oncity', `HTTP ${res.status} para SKU ${sku}`);
      return null;
    }

    const data = await res.json();

    const price = data?.[0]?.items?.[0]?.sellers?.[0]?.commertialOffer?.Price;
    if (!price) {
      logWarn('scraper-oncity', `Precio no encontrado en respuesta API para SKU ${sku}`);
      return null;
    }

    const formateado = formatearPrecio(price);
    logInfo('scraper-oncity', `Precio OK SKU ${sku}: ${formateado}`);
    return formateado;
  } catch (err) {
    if (err.name === 'AbortError') {
      logWarn('scraper-oncity', `Timeout (5s) para SKU ${sku}`);
    } else {
      logError('scraper-oncity', `Error: ${err.message}`);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { scrapeOnCity };
