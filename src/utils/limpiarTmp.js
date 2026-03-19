/**
 * Limpieza automática de archivos temporales en /tmp.
 *
 * Problema que resuelve:
 *   Cada presentación (Gamma), documento Word y planilla Excel que genera
 *   el agente se guarda en /tmp y nunca se elimina automáticamente.
 *   En producción con uso diario, el disco se llena en semanas.
 *
 * Estrategia:
 *   - Solo eliminar archivos generados por el proyecto (.pdf, .docx, .xlsx)
 *   - No tocar otros archivos de /tmp que puedan pertenecer al sistema
 *   - Eliminar archivos con más de 2 horas de antigüedad
 *   - Ejecutar cada 30 minutos vía setInterval desde server.js
 */

const fs = require('fs');
const path = require('path');
const { logInfo, logWarn } = require('./logger');

// === Configuración ===

const TMP_DIR = '/tmp';

/** Antigüedad máxima en milisegundos antes de eliminar un archivo (2 horas) */
const MAX_ANTIGUEDAD_MS = 2 * 60 * 60 * 1000;

/**
 * Extensiones de archivos generados por el proyecto.
 * Solo se eliminan archivos con estas extensiones para no afectar otros procesos.
 */
const EXTENSIONES_PROYECTO = new Set(['.pdf', '.docx', '.xlsx']);

// === Función principal ===

/**
 * Elimina archivos temporales generados por el proyecto que tengan
 * más de 2 horas de antigüedad.
 *
 * Recorre /tmp buscando archivos con extensiones conocidas (.pdf, .docx, .xlsx),
 * verifica su fecha de modificación y elimina los que superan el umbral.
 * Cada eliminación individual tiene su propio try-catch para que un archivo
 * con permisos bloqueados no interrumpa la limpieza de los demás.
 *
 * @returns {{ eliminados: number, bytesLiberados: number }} Resultado de la limpieza
 */
function limpiarArchivosTmp() {
  let eliminados = 0;
  let bytesLiberados = 0;

  // Leer el contenido de /tmp. Si falla (ej: directorio no existe), loguear y salir.
  let archivos;
  try {
    archivos = fs.readdirSync(TMP_DIR);
  } catch (err) {
    logWarn('cleanup', `No se pudo leer ${TMP_DIR}: ${err.message}`);
    return { eliminados, bytesLiberados };
  }

  const ahora = Date.now();

  for (const nombre of archivos) {
    // Solo procesar archivos con extensiones del proyecto
    const ext = path.extname(nombre).toLowerCase();
    if (!EXTENSIONES_PROYECTO.has(ext)) continue;

    const filePath = path.join(TMP_DIR, nombre);

    try {
      const stats = fs.statSync(filePath);

      // Ignorar directorios (solo archivos regulares)
      if (!stats.isFile()) continue;

      // Verificar antigüedad: si fue modificado hace menos de MAX_ANTIGUEDAD_MS, saltar
      const antiguedadMs = ahora - stats.mtimeMs;
      if (antiguedadMs < MAX_ANTIGUEDAD_MS) continue;

      // Eliminar el archivo
      fs.unlinkSync(filePath);
      eliminados++;
      bytesLiberados += stats.size;
    } catch (err) {
      // Error individual (ej: archivo eliminado entre readdir y stat, o sin permisos).
      // Loguear y continuar con el siguiente — no interrumpir la limpieza.
      logWarn('cleanup', `No se pudo eliminar ${nombre}: ${err.message}`);
    }
  }

  // Loguear resultado solo si se eliminó algo (evita spam en logs)
  if (eliminados > 0) {
    const mbLiberados = (bytesLiberados / (1024 * 1024)).toFixed(1);
    logInfo('cleanup', `${eliminados} archivo(s) eliminado(s), ${mbLiberados} MB liberados`);
  }

  return { eliminados, bytesLiberados };
}

module.exports = { limpiarArchivosTmp };
