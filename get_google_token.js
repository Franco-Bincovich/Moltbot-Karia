/**
 * Script para generar el GOOGLE_REFRESH_TOKEN de la cuenta moltbotkaria@gmail.com.
 *
 * Uso:
 *   node get_google_token.js
 *
 * Requisitos previos:
 *   - GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y GOOGLE_REDIRECT_URI deben estar
 *     definidos en el archivo .env de la raíz del proyecto.
 *   - El puerto de GOOGLE_REDIRECT_URI debe estar libre (por defecto: 3000).
 *
 * Los scopes solicitados se importan directamente de src/tools/google/auth.js
 * para garantizar que el token cubra exactamente los permisos que el agente usa.
 */

require('dotenv').config();
const { google } = require('googleapis');
const http = require('http');
const url = require('url');

// Importar la lista canónica de scopes desde auth.js para mantener sincronía
const { SCOPES } = require('./src/tools/google/auth');

// ─── Validación de variables de entorno ─────────────────────────────────────

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌ ERROR: faltan variables en .env');
  console.error('   Asegurate de tener definidas:');
  console.error('     GOOGLE_CLIENT_ID=...');
  console.error('     GOOGLE_CLIENT_SECRET=...\n');
  process.exit(1);
}

// ─── Configuración del cliente OAuth2 ───────────────────────────────────────

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// Generar la URL de autorización solicitando todos los scopes del agente
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline', // necesario para recibir un refresh token
  prompt: 'consent',      // forzar pantalla de consentimiento para obtener refresh token siempre
  scope: SCOPES,
});

// ─── Instrucciones para el usuario ──────────────────────────────────────────

const separador = '═'.repeat(60);

console.log(`\n${separador}`);
console.log('  Google OAuth2 — Generador de Refresh Token');
console.log(`${separador}\n`);

console.log('Scopes que se van a solicitar:');
SCOPES.forEach((s) => console.log('  •', s));

console.log('\n── PASOS ──────────────────────────────────────────────────\n');
console.log('  1. Copiá y abrí la siguiente URL en tu navegador:');
console.log(`\n     ${authUrl}\n`);
console.log('  2. Iniciá sesión con la cuenta moltbotkaria@gmail.com');
console.log('     (o la cuenta que quieras autorizar).\n');
console.log('  3. Aceptá todos los permisos solicitados en la pantalla');
console.log('     de consentimiento de Google.\n');
console.log('  4. Google va a redirigirte automáticamente a:');
console.log(`     ${REDIRECT_URI}`);
console.log('     El refresh token aparecerá aquí en la consola.\n');
console.log(`  Esperando autorización en el puerto ${new URL(REDIRECT_URI).port || 3000}...`);
console.log(`\n${separador}\n`);

// ─── Servidor HTTP para recibir el callback de Google ───────────────────────

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  // Ignorar cualquier request que no sea el callback de OAuth2
  if (!parsed.pathname.startsWith('/auth/google/callback')) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  // Google cancela el flujo si el usuario rechaza los permisos
  if (parsed.query.error) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>Autorización cancelada. Podés cerrar esta pestaña.</h2>');
    console.error(`\n❌ El usuario canceló la autorización: ${parsed.query.error}\n`);
    server.close(() => process.exit(1));
    return;
  }

  const code = parsed.query.code;
  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>No se recibió el código de autorización.</h2>');
    console.error('\n❌ No se recibió código de autorización en el callback.\n');
    server.close(() => process.exit(1));
    return;
  }

  // Intercambiar el código de autorización por los tokens
  try {
    const { tokens } = await oauth2Client.getToken(code);

    // Responder al navegador
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <html><body style="font-family:sans-serif;padding:2rem">
        <h2>✅ Autorización exitosa</h2>
        <p>Podés cerrar esta pestaña y volver a la consola.</p>
      </body></html>
    `);

    // Mostrar el resultado en la consola
    console.log(`${separador}`);
    console.log('  ✅ Token obtenido correctamente');
    console.log(`${separador}\n`);

    if (tokens.refresh_token) {
      console.log('Copiá esta línea y pegala en tu archivo .env:\n');
      console.log(`  GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    } else {
      // Puede ocurrir si la cuenta ya había autorizado este cliente antes
      // y Google no reemite el refresh token
      console.warn('⚠️  Google no devolvió un refresh token nuevo.');
      console.warn('   Esto pasa cuando la cuenta ya autorizó este cliente.');
      console.warn('   Para forzar un token nuevo:');
      console.warn('     1. Ir a https://myaccount.google.com/permissions');
      console.warn('     2. Revocar el acceso a la app "Karia Agent"');
      console.warn('     3. Volver a ejecutar: node get_google_token.js\n');
    }

    server.close(() => process.exit(0));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>Error al intercambiar el código.</h2><pre>${err.message}</pre>`);
    console.error('\n❌ Error al obtener tokens:', err.message, '\n');
    server.close(() => process.exit(1));
  }
});

const port = new URL(REDIRECT_URI).port || 3000;
server.listen(port);
