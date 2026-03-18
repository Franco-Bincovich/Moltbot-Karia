const { google } = require('googleapis');
const { getAuthClient, isConfigured } = require('./auth');

const NOT_CONFIGURED = 'Integración con Google no configurada. Configurá las credenciales de Google en el archivo .env.';

function getGmail() {
  const auth = getAuthClient();
  if (!auth) return null;
  return google.gmail({ version: 'v1', auth });
}

/**
 * Extrae adjuntos del payload de un email (recorre parts recursivamente).
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
  // Check top-level payload and its parts
  if (payload.filename && payload.filename.length > 0) {
    attachments.push({ filename: payload.filename, mimeType: payload.mimeType || 'unknown' });
  }
  walkParts(payload.parts);
  return attachments;
}

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

  if (messages.length === 0) {
    return 'No hay emails no leídos.';
  }

  const emails = [];
  for (const msg of messages) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'full',
    });

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
    emails.push(entry);
  }

  console.log(`[gmail] ${emails.length} emails no leídos encontrados.`);
  return `Emails no leídos (${emails.length}):\n\n${emails.join('\n\n')}`;
}

/**
 * Envía un email desde moltbotkaria@gmail.com.
 * @param {string} to - Destinatario
 * @param {string} subject - Asunto
 * @param {string} body - Cuerpo del email en texto plano
 * @returns {string} Confirmación
 */
async function sendEmail(to, subject, body) {
  if (!isConfigured()) return NOT_CONFIGURED;

  const gmail = getGmail();

  console.log(`[gmail] Enviando email a ${to} | Asunto: "${subject}"`);

  // Encode subject as RFC 2047 UTF-8 to handle special characters
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;

  const rawMessage = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'MIME-Version: 1.0',
    '',
    Buffer.from(body, 'utf-8').toString('base64'),
  ].join('\r\n');

  const encodedMessage = Buffer.from(rawMessage, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encodedMessage },
  });

  console.log(`[gmail] Email enviado: ${res.data.id}`);
  return `Email enviado correctamente a **${to}**.\nAsunto: ${subject}`;
}

/**
 * Busca emails por término.
 * @param {string} query - Término de búsqueda (compatible con operadores de Gmail)
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

  if (messages.length === 0) {
    return `No se encontraron emails para: "${query}"`;
  }

  const emails = [];
  for (const msg of messages) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'full',
    });

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
    emails.push(entry);
  }

  console.log(`[gmail] ${emails.length} emails encontrados.`);
  return `Resultados para "${query}" (${emails.length}):\n\n${emails.join('\n\n')}`;
}

module.exports = { getUnreadEmails, sendEmail, searchEmails };
