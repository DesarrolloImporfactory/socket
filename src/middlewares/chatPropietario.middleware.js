/**
 * Candado de "dueño del chat" para las acciones que cambian un chat.
 *
 * Hasta ahora solo `transferirChat` comprobaba quién pedía la acción. El
 * resto (asignar encargado, cerrar/reabrir, bot, remarketing) recibía el id
 * del chat y lo actualizaba con `WHERE id = ?`, sin mirar la cuenta ni el
 * encargado: con una sesión de cualquier cliente se podía cerrar el chat de
 * otro, lo que además deja una nota dentro de esa conversación y, si la
 * cuenta tiene la encuesta activada, le programa un mensaje al cliente real.
 *
 * Se comprueban dos cosas:
 *   1. que el chat sea de la misma cuenta que quien lo pide;
 *   2. que sea su chat, que NO tenga dueño (los de «En espera», que cualquiera
 *      puede tomar) o que quien lo pide sea administrador.
 *
 * La segunda es la misma regla de la transferencia (`puedeTransferir`), para
 * que las dos puertas se comporten igual.
 *
 * Deja el chat en `req.chat` para que el controlador no lo vuelva a buscar.
 */
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');
const { puedeTransferir } = require('../utils/historialEncargados');

/** Soporte interno: puede operar sobre cuentas ajenas. */
const esStaff = (actor) => actor?.rol === 'super_administrador';

exports.requireChatPropietario = (campo = 'chatId') =>
  catchAsync(async (req, res, next) => {
    const crudo = req.body?.[campo] ?? req.query?.[campo];
    const id = Number(crudo);
    if (!Number.isInteger(id) || id <= 0) {
      return next(new AppError(`${campo} es requerido`, 400));
    }

    const [chat] = await db.query(
      `SELECT c.id, c.id_encargado, c.id_configuracion, cf.id_usuario
         FROM clientes_chat_center c
         INNER JOIN configuraciones cf ON cf.id = c.id_configuracion
        WHERE c.id = ?
        LIMIT 1`,
      { replacements: [id], type: db.QueryTypes.SELECT },
    );

    if (!chat) return next(new AppError('Chat no encontrado', 404));

    const actor = req.sessionUser;

    // 1) Misma cuenta. Los sub-usuarios y las configuraciones comparten
    //    id_usuario; si no coinciden, el chat es de otro cliente.
    if (String(chat.id_usuario) !== String(actor?.id_usuario) && !esStaff(actor)) {
      return next(new AppError('Ese chat no pertenece a tu cuenta.', 403));
    }

    // 2) Dueño, sin asignar, o administrador.
    if (!puedeTransferir(actor, chat)) {
      return next(
        new AppError(
          'Solo el encargado del chat o un administrador puede hacer esto.',
          403,
        ),
      );
    }

    req.chat = chat;
    next();
  });
