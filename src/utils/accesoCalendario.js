/**
 * Acceso a la agenda (calendars / appointments).
 *
 * TEMPORAL: habilitado para TODOS los planes mientras se termina de definir la
 * sección de planes. Se abre a propósito, no por descuido.
 *
 * Antes la regla era `restrictToPlanes([1, 3, 4])` en calendars.routes.js, con
 * la misma lista repetida en tres archivos del front. Resultado: el menú se veía
 * o no según el archivo, y la llamada a /calendars/ensure moría con 403 aunque
 * la pantalla se hubiera abierto.
 *
 * El equivalente del front vive en `src/utils/accesoCalendario.js` del repo
 * chatcenter-front: si se vuelve a restringir, hay que tocar los dos.
 *
 * Para restringir: poner los ids de plan en PLANES_CON_CALENDARIO (ej. [1,3,4]).
 * Con `null` entran todos.
 */
const PLANES_CON_CALENDARIO = null;

function puedeAccederCalendario(idPlan) {
  if (!Array.isArray(PLANES_CON_CALENDARIO)) return true;
  return PLANES_CON_CALENDARIO.includes(Number(idPlan));
}

/**
 * Middleware. Cuando PLANES_CON_CALENDARIO es null deja pasar sin consultar
 * nada — no tiene sentido cargar el sub-usuario para no usarlo.
 */
function requiereAccesoCalendario(req, res, next) {
  if (!Array.isArray(PLANES_CON_CALENDARIO)) return next();

  const restrictToPlanes = require('../middlewares/restrictToPlanes.middleware');
  return restrictToPlanes(PLANES_CON_CALENDARIO)(req, res, next);
}

module.exports = {
  PLANES_CON_CALENDARIO,
  puedeAccederCalendario,
  requiereAccesoCalendario,
};
