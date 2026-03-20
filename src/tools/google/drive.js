const { google } = require('googleapis');
const { Readable } = require('stream');
const { getAuthClient, isConfigured } = require('./auth');
const { conReintentos } = require('../../utils/reintentos');
const { logInfo, logWarn } = require('../../utils/logger');
const { CircuitBreaker } = require('../../utils/circuitBreaker');

// === Circuit Breaker ===

// Comparte un breaker para todas las operaciones de Drive.
// Si Drive falla 5 veces consecutivas, deja de intentar por 30 segundos.
const cbDrive = new CircuitBreaker('drive', { umbralFallos: 5, cooldownMs: 30_000 });

const NOT_CONFIGURED = 'Integración con Google no configurada. Configurá las credenciales de Google en el archivo .env.';

// === Timeouts ===

const TIMEOUT_LECTURA_MS = 15_000;  // 15 segundos para lectura y listado
const TIMEOUT_SUBIDA_MS = 30_000;   // 30 segundos para subida de archivos

/** Crea y retorna el cliente de Google Drive autenticado con timeout de lectura por defecto. */
function getDrive() {
  const auth = getAuthClient();
  if (!auth) return null;
  return google.drive({ version: 'v3', auth, timeout: TIMEOUT_LECTURA_MS });
}

/** Crea y retorna el cliente de Google Drive con timeout extendido para subidas. */
function getDriveUpload() {
  const auth = getAuthClient();
  if (!auth) return null;
  return google.drive({ version: 'v3', auth, timeout: TIMEOUT_SUBIDA_MS });
}

/**
 * Lista archivos de Google Drive, con búsqueda opcional.
 * @param {string} query - Término de búsqueda (opcional)
 * @returns {string} Archivos formateados
 */
async function listFiles(query = '') {
  if (!isConfigured()) return NOT_CONFIGURED;

  const drive = getDrive();

  // Google Drive API usa una query language propia para filtrar archivos.
  // Caracteres como comillas (', "), backslashes (\) y paréntesis () son operadores
  // de esa query language. Sin escapar, un input como `test' or name contains '`
  // podría alterar la lógica de la consulta (inyección de query).
  // Se eliminan todos los caracteres especiales de la query language antes de interpolar.
  let q = 'trashed = false';
  if (query) {
    const safeQuery = query.replace(/['"\\\(\)]/g, '');
    q += ` and name contains '${safeQuery}'`;
  }

  logInfo('drive',` Listando archivos${query ? ` (búsqueda: "${query}")` : ''}...`);

  const res = await cbDrive.ejecutar(() => drive.files.list({
    q,
    pageSize: 20,
    fields: 'files(id, name, mimeType, modifiedTime, size, webViewLink)',
    orderBy: 'modifiedTime desc',
  }));

  const files = res.data.files || [];

  if (files.length === 0) {
    return query
      ? `No se encontraron archivos para: "${query}"`
      : 'No hay archivos en Drive.';
  }

  const formatted = files.map((f) => {
    const type = getMimeLabel(f.mimeType);
    const date = new Date(f.modifiedTime).toLocaleDateString('es-AR', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
    const size = f.size ? formatSize(parseInt(f.size, 10)) : '';
    return `- **${f.name}** | ${type}${size ? ` | ${size}` : ''} | Modificado: ${date}\n  ID: ${f.id}${f.webViewLink ? ` | [Abrir](${f.webViewLink})` : ''}`;
  });

  logInfo('drive',` ${files.length} archivos encontrados.`);
  return `Archivos en Drive (${files.length}):\n\n${formatted.join('\n\n')}`;
}

/**
 * Obtiene el contenido de un archivo de texto o Google Doc.
 * @param {string} fileId - ID del archivo en Drive
 * @returns {string} Contenido del archivo
 */
async function getFile(fileId) {
  if (!isConfigured()) return NOT_CONFIGURED;

  const drive = getDrive();

  logInfo('drive',` Obteniendo archivo: ${fileId}`);

  // Primero obtener metadata para saber el tipo
  const meta = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType',
  });

  const { name, mimeType } = meta.data;

  // Google Docs: exportar como texto plano
  if (mimeType === 'application/vnd.google-apps.document') {
    const res = await drive.files.export({
      fileId,
      mimeType: 'text/plain',
    });
    logInfo('drive',` Google Doc exportado: "${name}"`);
    return `**${name}** (Google Doc):\n\n${res.data}`;
  }

  // Google Sheets: exportar como CSV
  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    const res = await drive.files.export({
      fileId,
      mimeType: 'text/csv',
    });
    logInfo('drive',` Google Sheet exportado: "${name}"`);
    return `**${name}** (Google Sheet):\n\n${res.data}`;
  }

  // Archivos de texto plano: descargar directamente
  if (mimeType.startsWith('text/') || mimeType === 'application/json') {
    const res = await drive.files.get({
      fileId,
      alt: 'media',
    });
    logInfo('drive',` Archivo descargado: "${name}"`);
    return `**${name}**:\n\n${res.data}`;
  }

  return `El archivo "${name}" es de tipo ${mimeType} y no se puede leer como texto. Usá el link de Drive para descargarlo.`;
}

/**
 * Sube un archivo a Google Drive.
 * @param {string} name - Nombre del archivo
 * @param {string} content - Contenido del archivo
 * @param {string} mimeType - Tipo MIME (default text/plain)
 * @returns {string} Confirmación con link
 */
async function uploadFile(name, content, mimeType = 'text/plain') {
  if (!isConfigured()) return NOT_CONFIGURED;

  // Usar cliente con timeout extendido (30s) para subidas
  const drive = getDriveUpload();

  logInfo('drive',` Subiendo archivo: "${name}" (${mimeType})`);

  // Reintentos en la subida porque puede fallar por errores de red o rate limits de Drive API.
  // El stream se recrea en cada intento porque un Readable consumido no se puede reutilizar.
  // No se reintenta en errores de autenticación o permisos (esos se propagan directo).
  // Circuit breaker envuelve los reintentos: si los 3 intentos fallan, cuenta como 1 fallo.
  const res = await cbDrive.ejecutar(() => conReintentos(
    () => {
      const stream = new Readable();
      stream.push(content);
      stream.push(null);
      return drive.files.create({
        requestBody: { name, mimeType },
        media: { mimeType, body: stream },
        fields: 'id, name, webViewLink',
      });
    },
    {
      intentos: 3,
      esperaMs: 2000,
      onReintento: (err, intento, espera) => {
        logWarn('drive',` Reintento ${intento} de subida de "${name}" (espera ${espera}ms): ${err.message}`);
      },
    }
  ));

  const file = res.data;
  logInfo('drive',` Archivo subido: ${file.id}`);

  return `Archivo guardado en Drive: **${file.name}**\nID: ${file.id}${file.webViewLink ? `\nLink: ${file.webViewLink}` : ''}`;
}

// === Helpers ===

function getMimeLabel(mimeType) {
  const labels = {
    'application/vnd.google-apps.document': 'Google Doc',
    'application/vnd.google-apps.spreadsheet': 'Google Sheet',
    'application/vnd.google-apps.presentation': 'Google Slides',
    'application/vnd.google-apps.folder': 'Carpeta',
    'application/pdf': 'PDF',
    'text/plain': 'Texto',
    'application/json': 'JSON',
    'image/png': 'Imagen PNG',
    'image/jpeg': 'Imagen JPEG',
  };
  return labels[mimeType] || mimeType;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

module.exports = { listFiles, getFile, uploadFile };
