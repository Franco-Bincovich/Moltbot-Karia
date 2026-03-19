/**
 * Middleware que intercepta los errores acumulados por express-validator.
 *
 * Si hay errores de validación en el request, corta la cadena de middlewares
 * y devuelve una respuesta uniforme con código 400 antes de llegar al handler.
 * Si no hay errores, pasa el control al siguiente middleware con next().
 *
 * Uso: encadenar después de las reglas de validación en cada ruta.
 *   app.post('/ruta', reglasDeValidacion, manejarErroresValidacion, handler)
 */

const { validationResult } = require('express-validator');

/**
 * Revisa si el request tiene errores de validación y responde con 400 si los hay.
 * La respuesta incluye un array con todos los errores para que el frontend
 * pueda mostrarlos al usuario de forma específica por campo.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function manejarErroresValidacion(req, res, next) {
  const errores = validationResult(req);

  // Si no hay errores, continuar con el handler de la ruta
  if (errores.isEmpty()) return next();

  // Formatear los errores: incluir campo y mensaje para facilitar el debug
  const listaErrores = errores.array().map((e) => ({
    campo: e.path,
    mensaje: e.msg,
  }));

  console.warn(`[validacion] Errores en ${req.method} ${req.path}:`, listaErrores);

  return res.status(400).json({
    error: 'Datos de entrada inválidos.',
    errores: listaErrores,
  });
}

module.exports = { manejarErroresValidacion };
