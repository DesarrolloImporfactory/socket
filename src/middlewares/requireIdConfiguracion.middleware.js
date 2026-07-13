const AppError = require('../utils/appError');

/**
 * Valida y normaliza id_configuracion. Debe ser un entero > 0.
 * Devuelve el número o null si es inválido/ausente.
 */
function parseIdConfiguracion(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Para rutas que CREAN clientes en clientes_chat_center.
 * id_configuracion es OBLIGATORIO: evita que se generen clientes huérfanos
 * (sin id_configuracion) que rompen el filtrado por tienda/kanban.
 * Busca en body primero y luego en query. Normaliza req.body.id_configuracion
 * a número entero para el controlador.
 */
exports.requireIdConfiguracion = (req, res, next) => {
  const id = parseIdConfiguracion(
    req.body?.id_configuracion ?? req.query?.id_configuracion,
  );

  if (id === null) {
    return next(
      new AppError(
        'id_configuracion es requerido y debe ser un entero válido',
        400,
      ),
    );
  }

  // Deja el valor ya saneado (número) disponible para el controlador.
  if (req.body) req.body.id_configuracion = id;
  next();
};

/**
 * Para rutas que ACTUALIZAN clientes.
 * No exige id_configuracion (updates parciales), pero si viene en el body
 * NO puede ser null/''/0/inválido: eso dejaría huérfano a un cliente existente.
 * Si es válido, lo normaliza a número.
 */
exports.rejectNullIdConfiguracion = (req, res, next) => {
  if (
    req.body &&
    Object.prototype.hasOwnProperty.call(req.body, 'id_configuracion')
  ) {
    const id = parseIdConfiguracion(req.body.id_configuracion);
    if (id === null) {
      return next(
        new AppError(
          'id_configuracion no puede quedar vacío o inválido en una actualización',
          400,
        ),
      );
    }
    req.body.id_configuracion = id;
  }
  next();
};
