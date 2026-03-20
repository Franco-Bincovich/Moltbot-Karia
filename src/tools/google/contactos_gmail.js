/**
 * Búsqueda de contactos en Google People API.
 *
 * REQUISITO: Para que este módulo funcione, debés habilitar la API en Google Cloud Console:
 *   1. Ir a https://console.cloud.google.com/
 *   2. Seleccionar el proyecto "Karia Agent"
 *   3. Ir a "APIs y servicios" → "Biblioteca"
 *   4. Buscar "Google People API" y habilitarla
 *   5. Las credenciales OAuth2 ya configuradas en .env son suficientes (mismo cliente).
 *
 * Scopes requeridos (ya incluidos en el refresh token existente si se pidieron al generar):
 *   - https://www.googleapis.com/auth/contacts.readonly
 */

const { google } = require('googleapis');
const { getAuthClient } = require('./auth');
const { logInfo, logWarn, logError } = require('../../utils/logger');

/**
 * Normaliza un resultado de People API al formato interno de contacto:
 * { nombre, email }. Devuelve null si el resultado no tiene email.
 * @param {object} resultado - Un elemento de res.data.results de People API
 * @returns {{ nombre: string, email: string } | null}
 */
function normalizarResultado(resultado) {
  const persona = resultado.person;
  if (!persona) return null;

  // Tomar el primer email disponible
  const emailObj = persona.emailAddresses && persona.emailAddresses[0];
  if (!emailObj || !emailObj.value) return null;

  // Tomar el nombre de display; si no hay, usar el email como fallback
  const nombreObj = persona.names && persona.names[0];
  const nombre = nombreObj ? nombreObj.displayName : emailObj.value;

  return { nombre, email: emailObj.value };
}

/**
 * Busca contactos en Google People API filtrando por nombre o email.
 *
 * Devuelve el resultado en formato interno estandarizado:
 *   - { found: false }                                      → sin resultados
 *   - { found: true, unique: true, contact, fuente }        → 1 resultado
 *   - { found: true, unique: false, contacts, fuente }      → más de 1 resultado
 *
 * La propiedad "fuente: 'Gmail'" indica que los datos vienen de People API
 * y no de Supabase, para que el agente pueda informarlo al usuario.
 *
 * @param {string} query - Nombre o email parcial/completo a buscar
 * @returns {Promise<object>} Resultado de la búsqueda en formato interno
 */
async function buscarContactosGmail(query) {
  // Verificar que el cliente OAuth2 esté disponible
  const auth = getAuthClient();
  if (!auth) {
    logWarn('contactos-gmail', 'Cliente OAuth2 no disponible. Configurá las credenciales de Google en .env');
    return { found: false };
  }

  logInfo('contactos-gmail',` Buscando en People API: "${query}"`);

  try {
    const people = google.people({ version: 'v1', auth });

    // searchContacts busca dentro de los contactos guardados por el usuario autenticado
    const res = await people.people.searchContacts({
      query,
      readMask: 'names,emailAddresses', // solo los campos que necesitamos
      pageSize: 10,                      // máximo 10 resultados
    });

    const resultados = res.data.results || [];

    // Normalizar y filtrar entradas sin email
    const contactos = resultados
      .map(normalizarResultado)
      .filter(Boolean);

    if (contactos.length === 0) {
      logInfo('contactos-gmail',` Sin resultados en People API para "${query}"`);
      return { found: false };
    }

    if (contactos.length === 1) {
      logInfo('contactos-gmail',` Contacto único: ${contactos[0].nombre} <${contactos[0].email}>`);
      return { found: true, unique: true, contact: contactos[0], fuente: 'Gmail' };
    }

    logInfo('contactos-gmail',` ${contactos.length} contactos encontrados para "${query}"`);
    return { found: true, unique: false, contacts: contactos, fuente: 'Gmail' };

  } catch (err) {
    logError('contactos-gmail', `Error al consultar People API: ${err.message}`);
    // Si la API no está habilitada o hay un error de permisos, devolvemos not found
    // para no interrumpir el flujo del agente
    return { found: false };
  }
}

module.exports = { buscarContactosGmail };
