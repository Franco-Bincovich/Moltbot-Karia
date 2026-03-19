const { google } = require('googleapis');

let _oauth2Client = null;
let _configured = false;

/**
 * Scopes de OAuth2 requeridos por las herramientas de Google del agente.
 *
 * IMPORTANTE: el refresh token almacenado en GOOGLE_REFRESH_TOKEN debe haber
 * sido generado solicitando TODOS estos scopes. Si se agrega un scope nuevo,
 * hay que renegociar el token ejecutando el flujo OAuth2 de nuevo.
 */
const SCOPES = [
  // Permite leer y modificar correos de Gmail (leer no leídos, buscar emails)
  'https://www.googleapis.com/auth/gmail.modify',

  // Permite enviar emails desde la cuenta de Gmail
  'https://www.googleapis.com/auth/gmail.send',

  // Permite leer y escribir eventos en Google Calendar
  'https://www.googleapis.com/auth/calendar',

  // Permite subir y leer archivos del Google Drive del usuario
  'https://www.googleapis.com/auth/drive.file',

  // Permite leer los contactos guardados en Google Contacts (People API)
  // Requerido por src/tools/google/contactos_gmail.js
  'https://www.googleapis.com/auth/contacts.readonly',
];

/**
 * Inicializa y devuelve el cliente OAuth2 de Google.
 * Si las credenciales no están en .env, devuelve null y loguea warning.
 */
function getAuthClient() {
  if (_oauth2Client) return _oauth2Client;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    console.warn('[google-auth] Credenciales de Google no configuradas. Las tools de Google no estarán disponibles.');
    console.warn('[google-auth] Configurá GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y GOOGLE_REFRESH_TOKEN en .env');
    _configured = false;
    return null;
  }

  _oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  _oauth2Client.setCredentials({ refresh_token: refreshToken, scope: SCOPES.join(' ') });
  _configured = true;

  console.log('[google-auth] Cliente OAuth2 configurado correctamente.');
  return _oauth2Client;
}

/**
 * Devuelve true si las credenciales de Google están configuradas.
 */
function isConfigured() {
  if (_oauth2Client) return _configured;
  getAuthClient();
  return _configured;
}

module.exports = { getAuthClient, isConfigured, SCOPES };
