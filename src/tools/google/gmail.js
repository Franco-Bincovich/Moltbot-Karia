const { google } = require('googleapis');
const { getAuthClient, isConfigured } = require('./auth');
const fs = require('fs');
const path = require('path');
const { conReintentos } = require('../../utils/reintentos');

const NOT_CONFIGURED = 'Integración con Google no configurada. Configurá las credenciales de Google en el archivo .env.';

// === Timeouts ===

// 15 segundos para todas las operaciones de Gmail (lectura, envío, búsqueda)
const TIMEOUT_MS = 15_000;

/** Crea y retorna el cliente de Gmail autenticado con timeout configurado. */
function getGmail() {
  const auth = getAuthClient();
  if (!auth) return null;
  return google.gmail({ version: 'v1', auth, timeout: TIMEOUT_MS });
}

// === Helpers ===

/**
 * Extrae adjuntos del payload de un email recorriendo parts recursivamente.
 * @param {object} payload - Payload del mensaje de Gmail
 * @returns {Array<{filename, mimeType}>}
 */
function getAttachments(payload) {
  const attachments = [];

  function walkParts(parts) {
    if (!parts) return;
    for (const part of parts) {
      if (part.filename && part.filename.length > 0) {
        attachments.push({ filename: part.filename, mimeType: part.mimeType || 'unknown' });
      }
      if (part.parts) walkParts(part.parts);
    }
  }

  if (payload.filename && payload.filename.length > 0) {
    attachments.push({ filename: payload.filename, mimeType: payload.mimeType || 'unknown' });
  }
  walkParts(payload.parts);
  return attachments;
}

/**
 * Formatea un mensaje de Gmail como entrada de texto legible.
 * Reutilizado por getUnreadEmails y searchEmails.
 * @param {object} detail - Respuesta completa de gmail.users.messages.get
 * @returns {string} Entrada formateada con De, Asunto, Preview, Fecha y adjuntos
 */
function buildEmailEntry(detail) {
  const headers = detail.data.payload.headers;
  const from = headers.find((h) => h.name === 'From')?.value || 'Desconocido';
  const subject = headers.find((h) => h.name === 'Subject')?.value || '(Sin asunto)';
  const date = headers.find((h) => h.name === 'Date')?.value || '';
  const snippet = detail.data.snippet || '';
  const attachments = getAttachments(detail.data.payload);

  let entry = `- **De:** ${from}\n  **Asunto:** ${subject}\n  **Preview:** ${snippet}\n  **Fecha:** ${date}`;
  if (attachments.length > 0) {
    const attachList = attachments.map((a) => `${a.filename} (${a.mimeType})`).join(', ');
    entry += `\n  **Adjuntos (${attachments.length}):** ${attachList}`;
  }
  return entry;
}

/**
 * Obtiene los detalles completos de una lista de IDs de mensajes.
 * @param {object} gmail - Cliente Gmail
 * @param {Array<{id}>} messages - Lista de IDs a resolver
 * @returns {Promise<string[]>} Entradas formateadas
 */
async function fetchEmailEntries(gmail, messages) {
  const entries = [];
  for (const msg of messages) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'full',
    });
    entries.push(buildEmailEntry(detail));
  }
  return entries;
}

// === Funciones públicas ===

/**
 * Obtiene los últimos N emails no leídos.
 * @param {number} limit - Cantidad máxima de emails (default 10)
 * @returns {string} Emails formateados
 */
async function getUnreadEmails(limit = 10) {
  if (!isConfigured()) return NOT_CONFIGURED;

  const gmail = getGmail();
  console.log(`[gmail] Buscando últimos ${limit} emails no leídos...`);

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread',
    maxResults: limit,
  });

  const messages = res.data.messages || [];
  if (messages.length === 0) return 'No hay emails no leídos.';

  const entries = await fetchEmailEntries(gmail, messages);
  console.log(`[gmail] ${entries.length} emails no leídos encontrados.`);
  return `Emails no leídos (${entries.length}):\n\n${entries.join('\n\n')}`;
}

/**
 * Envía un email desde moltbotkaria@gmail.com.
 * Soporta adjuntos en formato multipart/mixed.
 * @param {string} to - Destinatario
 * @param {string} subject - Asunto
 * @param {string} body - Cuerpo del email en texto plano
 * @param {string[]} attachmentFilenames - Nombres de archivos en /tmp para adjuntar
 * @returns {string} Confirmación del envío
 */
async function sendEmail(to, subject, body, attachmentFilenames = []) {
  if (!isConfigured()) return NOT_CONFIGURED;

  const gmail = getGmail();

  // Resolver archivos adjuntos desde /tmp
  const attachments = [];
  for (const filename of attachmentFilenames) {
    const filePath = path.join('/tmp', filename);
    if (fs.existsSync(filePath)) {
      attachments.push({ filename, filePath });
    } else {
      console.warn(`[gmail] Adjunto no encontrado: ${filePath}`);
    }
  }

  console.log(`[gmail] Enviando email a ${to} | Asunto: "${subject}" | Adjuntos: ${attachments.length}`);

  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
  const rawMessage = attachments.length === 0
    ? buildSimpleEmail(to, encodedSubject, body)
    : buildMultipartEmail(to, encodedSubject, body, attachments);

  const encodedMessage = Buffer.from(rawMessage, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  // Reintentos en el envío porque puede fallar por errores de red o rate limits de Gmail API.
  // No se reintenta en errores de autenticación o datos inválidos (esos se propagan directo).
  const res = await conReintentos(
    () => gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodedMessage } }),
    {
      intentos: 3,
      esperaMs: 1000,
      onReintento: (err, intento, espera) => {
        console.warn(`[gmail] Reintento ${intento} de envío a ${to} (espera ${espera}ms): ${err.message}`);
      },
    }
  );

  console.log(`[gmail] Email enviado: ${res.data.id}`);
  const adjuntosInfo = attachments.length > 0
    ? `\nAdjuntos: ${attachments.map((a) => a.filename).join(', ')}`
    : '';
  return `Email enviado correctamente a **${to}**.\nAsunto: ${subject}${adjuntosInfo}`;
}

/**
 * Busca emails por término compatible con operadores de Gmail.
 * @param {string} query - Término de búsqueda (ej: "from:juan", "subject:factura")
 * @returns {string} Emails encontrados formateados
 */
async function searchEmails(query) {
  if (!isConfigured()) return NOT_CONFIGURED;

  const gmail = getGmail();
  console.log(`[gmail] Buscando emails: "${query}"`);

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 10,
  });

  const messages = res.data.messages || [];
  if (messages.length === 0) return `No se encontraron emails para: "${query}"`;

  const entries = await fetchEmailEntries(gmail, messages);
  console.log(`[gmail] ${entries.length} emails encontrados.`);
  return `Resultados para "${query}" (${entries.length}):\n\n${entries.join('\n\n')}`;
}

// === Constructores de formato MIME ===

/** Construye un email simple sin adjuntos. */
function buildSimpleEmail(to, encodedSubject, body) {
  return [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'MIME-Version: 1.0',
    '',
    Buffer.from(body, 'utf-8').toString('base64'),
  ].join('\r\n');
}

/** Construye un email multipart con adjuntos. */
function buildMultipartEmail(to, encodedSubject, body, attachments) {
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const parts = [];

  // Parte de texto
  parts.push([
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf-8').toString('base64'),
  ].join('\r\n'));

  // Partes de adjuntos
  for (const att of attachments) {
    const fileData = fs.readFileSync(att.filePath);
    const ext = path.extname(att.filename).toLowerCase();
    const mimeType = ext === '.pdf' ? 'application/pdf'
      : ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : ext === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'application/octet-stream';

    const encodedFilename = `=?UTF-8?B?${Buffer.from(att.filename, 'utf-8').toString('base64')}?=`;

    parts.push([
      `--${boundary}`,
      `Content-Type: ${mimeType}; name="${encodedFilename}"`,
      `Content-Disposition: attachment; filename="${encodedFilename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      fileData.toString('base64'),
    ].join('\r\n'));
  }

  parts.push(`--${boundary}--`);

  return [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    parts.join('\r\n'),
  ].join('\r\n');
}

module.exports = { getUnreadEmails, sendEmail, searchEmails };
