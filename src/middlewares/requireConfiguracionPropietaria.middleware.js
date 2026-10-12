/**
 * Candado de «dueño de la configuración» para rutas que reciben un
 * `id_configuracion` en el body o el query y actúan sobre esa cuenta.
 *
 * Nació por «Probar como cliente» (pruebas_webhook.routes, 2026-10-12): esas
 * rutas pedían estar autenticado pero no miraban de quién era la cuenta. Con
 * una sesión de cualquier cliente se podía mandar la cuenta y el teléfono de
 * otro: el mensaje entraba por el webhook como si lo hubiera escrito ese
 * cliente, se saltaba el horario y la lista blanca del bot (es_prueba), el
 * bot le contestaba al cliente REAL por WhatsApp y la respuesta se podía leer
 * por /mensajes. Con el bot de Expertos v2 además podía incluir en qué paso
 * va la carga de ese cliente.
 *
 * Misma regla que `chatPropietario.middleware`: los sub-usuarios y las
 * configuraciones comparten `id_usuario`; si no coincide, la cuenta es de otro
 * cliente. El soporte interno (`super_administrador`) sí puede operar sobre
 * cuentas ajenas, porque desde el panel de administración prueba bots de
 * clientes.
 *
 * Deja la fila en `req.configuracionPropietaria` ({ id, id_usuario }) y el id
 * ya saneado en `req.body.id_configuracion`.
 */
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');

const esStaff = (actor) => actor?.rol === 'super_administrador';

exports.requireConfiguracionPropietaria = (campo = 'id_configuracion') =>
  catchAsync(async (req, res, next) => {
    const crudo = req.body?.[campo] ?? req.query?.[campo];
    const id = Number(crudo);
    if (!Number.isInteger(id) || id <= 0) {
      return next(new AppError(`${campo} es requerido`, 400));
    }

    const actor = req.sessionUser;
    if (!actor?.id_usuario) {
      return next(new AppError('No autenticado', 401));
    }

    const [cfg] = await db.query(
      `SELECT id, id_usuario FROM configuraciones WHERE id = ? LIMIT 1`,
      { replacements: [id], type: db.QueryTypes.SELECT },
    );
    if (!cfg) return next(new AppError('Configuración no encontrada', 404));

    if (String(cfg.id_usuario) !== String(actor.id_usuario) && !esStaff(actor)) {
      // Queda rastro: Daniel preguntó si alguien lo había usado así.
      console.warn(
        `[configuracionPropietaria] sub_usuario=${actor.id_sub_usuario} (usuario ${actor.id_usuario}, rol ${actor.rol || '—'}) ` +
          `intentó ${req.method} ${req.originalUrl} sobre la cfg ${id} (usuario ${cfg.id_usuario}). Denegado.`,
      );
      return next(new AppError('Esa conexión no pertenece a tu cuenta.', 403));
    }

    if (req.body && Object.prototype.hasOwnProperty.call(req.body, campo)) {
      req.body[campo] = id;
    }
    req.configuracionPropietaria = cfg;
    next();
  });
