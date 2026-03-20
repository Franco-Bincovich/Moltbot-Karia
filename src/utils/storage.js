/**
 * Storage externo con Supabase Storage para archivos generados.
 *
 * Problema que resuelve:
 *   Guardar archivos en /tmp tiene dos limitaciones críticas:
 *   1. Si hay múltiples instancias del servidor (load balancer), un archivo
 *      generado en instancia A no se puede descargar desde instancia B.
 *   2. /tmp se llena con el tiempo y depende de limpieza periódica.
 *
 *   Supabase Storage resuelve ambos problemas: los archivos son accesibles
 *   desde cualquier instancia vía URL firmada, y Supabase maneja el ciclo
 *   de vida del storage (no se llena el disco del servidor).
 *
 * Buckets:
 *   - "documentos": archivos Word (.docx) y Excel (.xlsx) generados por export.js
 *   - "presentaciones": PDFs descargados de Gamma
 *
 * Flujo:
 *   1. El archivo se genera en /tmp (como antes)
 *   2. Se sube a Supabase Storage
 *   3. Se elimina de /tmp
 *   4. Se retorna una URL firmada con expiración de 2 horas
 *   5. El endpoint /download/:filename redirige a la URL firmada
 */

const fs = require('fs');
const { supabase } = require('../config/supabase');
const { logInfo, logWarn, logError } = require('./logger');

// === Configuración ===

/** Duración de las URLs firmadas en segundos (2 horas) */
const EXPIRACION_URL_SEGUNDOS = 2 * 60 * 60;

// === Funciones públicas ===

/**
 * Sube un archivo local a Supabase Storage y retorna una URL firmada.
 *
 * @param {string} filePath - Ruta completa del archivo local (en /tmp)
 * @param {string} bucket - Nombre del bucket: "documentos" o "presentaciones"
 * @param {string} nombreArchivo - Nombre con el que guardar en Storage (incluye extensión)
 * @returns {Promise<string>} URL firmada con expiración de 2 horas
 * @throws {Error} Si Supabase no está configurado o la subida falla
 */
async function subirArchivo(filePath, bucket, nombreArchivo) {
  if (!supabase) {
    logWarn('storage', 'Supabase no configurado — el archivo queda en /tmp como fallback');
    return null;
  }

  // Leer el archivo local
  const fileBuffer = await fs.promises.readFile(filePath);

  // Determinar el MIME type según la extensión
  const ext = nombreArchivo.split('.').pop().toLowerCase();
  const mimeTypes = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  // Subir a Supabase Storage
  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(nombreArchivo, fileBuffer, {
      contentType,
      upsert: false, // No sobreescribir si ya existe (los nombres son únicos por entropía)
    });

  if (uploadError) {
    logError('storage', `Error subiendo ${nombreArchivo} a ${bucket}: ${uploadError.message}`);
    throw new Error(`No se pudo subir el archivo a Storage: ${uploadError.message}`);
  }

  // Generar URL firmada con expiración
  const { data: urlData, error: urlError } = await supabase.storage
    .from(bucket)
    .createSignedUrl(nombreArchivo, EXPIRACION_URL_SEGUNDOS);

  if (urlError) {
    logError('storage', `Error generando URL firmada para ${nombreArchivo}: ${urlError.message}`);
    throw new Error(`No se pudo generar la URL de descarga: ${urlError.message}`);
  }

  // Eliminar el archivo local de /tmp — ya está en Storage
  try {
    await fs.promises.unlink(filePath);
    logInfo('storage', `Archivo local eliminado: ${filePath}`);
  } catch (err) {
    // No crítico: la limpieza periódica lo atrapará
    logWarn('storage', `No se pudo eliminar ${filePath} de /tmp: ${err.message}`);
  }

  logInfo('storage', `${nombreArchivo} subido a ${bucket} (${fileBuffer.length} bytes, URL expira en ${EXPIRACION_URL_SEGUNDOS / 3600}h)`);
  return urlData.signedUrl;
}

/**
 * Elimina un archivo de Supabase Storage.
 *
 * @param {string} bucket - Nombre del bucket
 * @param {string} nombreArchivo - Nombre del archivo a eliminar
 * @returns {Promise<boolean>} true si se eliminó, false si falló
 */
async function eliminarArchivo(bucket, nombreArchivo) {
  if (!supabase) return false;

  const { error } = await supabase.storage
    .from(bucket)
    .remove([nombreArchivo]);

  if (error) {
    logWarn('storage', `Error eliminando ${nombreArchivo} de ${bucket}: ${error.message}`);
    return false;
  }

  logInfo('storage', `${nombreArchivo} eliminado de ${bucket}`);
  return true;
}

/**
 * Genera una URL firmada para un archivo ya existente en Storage.
 * Útil para regenerar URLs expiradas sin volver a subir el archivo.
 *
 * @param {string} bucket - Nombre del bucket
 * @param {string} nombreArchivo - Nombre del archivo en Storage
 * @returns {Promise<string|null>} URL firmada o null si falla
 */
async function obtenerUrlFirmada(bucket, nombreArchivo) {
  if (!supabase) return null;

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(nombreArchivo, EXPIRACION_URL_SEGUNDOS);

  if (error) {
    logWarn('storage', `Error generando URL para ${nombreArchivo}: ${error.message}`);
    return null;
  }

  return data.signedUrl;
}

module.exports = { subirArchivo, eliminarArchivo, obtenerUrlFirmada };
