require('dotenv').config();
const { google } = require('googleapis');
const http = require('http');
const url = require('url');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌ Faltan GOOGLE_CLIENT_ID y/o GOOGLE_CLIENT_SECRET en el archivo .env\n');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES,
});

console.log('\n========================================');
console.log('  Google OAuth2 — Obtener Refresh Token');
console.log('========================================\n');
console.log('1. Abrí esta URL en tu navegador:\n');
console.log(authUrl);
console.log('\n2. Autorizá la cuenta de Google');
console.log('3. El refresh_token aparecerá acá automáticamente\n');
console.log('Esperando callback en', REDIRECT_URI, '...\n');

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (!parsed.pathname.startsWith('/auth/google/callback')) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const code = parsed.query.code;
  if (!code) {
    res.writeHead(400);
    res.end('No se recibió código de autorización.');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Listo! Podés cerrar esta pestaña.</h1><p>Revisá la consola para ver el refresh_token.</p>');

    console.log('========================================');
    console.log('  ✅ Token obtenido correctamente');
    console.log('========================================\n');
    console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
    console.log('\nAgregá esa línea a tu archivo .env\n');

    if (tokens.access_token) {
      console.log('(Access token: ' + tokens.access_token.slice(0, 20) + '...)\n');
    }

    server.close(() => process.exit(0));
  } catch (err) {
    res.writeHead(500);
    res.end('Error al intercambiar el código: ' + err.message);
    console.error('\n❌ Error al obtener tokens:', err.message);
    server.close(() => process.exit(1));
  }
});

const port = new URL(REDIRECT_URI).port || 3000;
server.listen(port, () => {
  console.log(`Servidor escuchando en puerto ${port}...`);
});
