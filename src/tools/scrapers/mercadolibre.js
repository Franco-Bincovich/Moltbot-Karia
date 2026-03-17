const API_URL = 'https://api.mercadolibre.com/sites/MLA/search';

// Nicknames de vendedores oficiales en MercadoLibre (en mayúsculas para comparación)
const OFFICIAL_SELLERS = ['FRAVEGA', 'ONCITY', 'ON CITY', 'NALDO', 'CETROGAR', 'GENECIO', 'GENECIOHOGAR'];

function matchesSeller(nickname = '') {
  const upper = nickname.toUpperCase();
  return OFFICIAL_SELLERS.some((s) => upper.includes(s));
}

function formatPrice(value) {
  return `$${Number(value).toLocaleString('es-AR')}`;
}

function formatInstallments(inst) {
  if (!inst || !inst.quantity) return null;
  const rate = inst.rate === 0 ? ' sin interés' : '';
  return `${inst.quantity}x ${formatPrice(inst.amount)}${rate}`;
}

/**
 * Busca productos en MercadoLibre filtrando por vendedores oficiales.
 * Pide 50 resultados para tener margen después del filtrado.
 * @param {string} query
 * @returns {Promise<Array<{tienda, nombre, precio, stock, cuotas, url}>>}
 */
async function searchMercadoLibre(query) {
  const url = `${API_URL}?q=${encodeURIComponent(query)}&limit=50`;
  console.log(`[mercadolibre] GET ${url}`);

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    console.error('[mercadolibre] Error de red:', err.message);
    throw new Error(`MercadoLibre no responde: ${err.message}`);
  }

  console.log(`[mercadolibre] HTTP ${res.status}`);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MercadoLibre API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const total = data.results?.length ?? 0;
  console.log(`[mercadolibre] Total resultados recibidos: ${total}`);

  const filtered = (data.results ?? []).filter((item) =>
    matchesSeller(item.seller?.nickname)
  );
  console.log(`[mercadolibre] Resultados de vendedores oficiales: ${filtered.length}`);

  if (filtered.length === 0 && total > 0) {
    const sample = (data.results ?? []).slice(0, 5).map((r) => r.seller?.nickname);
    console.warn(`[mercadolibre] Ningún vendedor oficial encontrado. Muestra de nicknames: ${sample.join(', ')}`);
  }

  return filtered.slice(0, 10).map((item) => ({
    tienda: item.seller?.nickname ?? 'Desconocido',
    nombre: item.title ?? null,
    precio: item.price != null ? formatPrice(item.price) : null,
    stock: item.available_quantity != null ? String(item.available_quantity) : null,
    cuotas: formatInstallments(item.installments),
    url: item.permalink ?? null,
  }));
}

/**
 * Formatea los resultados agrupados por tienda.
 */
function formatMercadoLibreResults(results, query) {
  if (results.length === 0) {
    return `**MercadoLibre (tiendas oficiales)**: No se encontraron resultados de Frávega, OnCity, Naldo, Cetrogar ni Genecio para "${query}".`;
  }

  // Agrupar por tienda
  const byStore = {};
  for (const r of results) {
    const key = r.tienda;
    if (!byStore[key]) byStore[key] = [];
    byStore[key].push(r);
  }

  const sections = [];
  for (const [tienda, items] of Object.entries(byStore)) {
    const lines = [`**${tienda}**`];
    for (const r of items) {
      const precio = r.precio ?? 'Consultar';
      const stock = r.stock ? ` | Stock: ${r.stock}` : '';
      const cuotas = r.cuotas ? ` | Cuotas: ${r.cuotas}` : '';
      const link = r.url ? ` → [Ver](${r.url})` : '';
      lines.push(`- ${r.nombre ?? 'Sin nombre'}: **${precio}**${stock}${cuotas}${link}`);
    }
    sections.push(lines.join('\n'));
  }

  return `**MercadoLibre — tiendas oficiales** (resultados para "${query}"):\n\n${sections.join('\n\n')}`;
}

module.exports = { searchMercadoLibre, formatMercadoLibreResults };
