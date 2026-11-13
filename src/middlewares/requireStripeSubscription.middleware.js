// Middleware que bloquea usuarios con Plan 21 (Method Ecommerce)
// que NO tienen stripe_subscription_id.
//

const Usuarios_chat_center = require('../models/usuarios_chat_center.model');
const {
  PLANES_REQUIERE_TARJETA: PLANES_REQUIRE_CARD,
  MESES_CORTESIA_METHOD,
} = require('../config/planes.config');
const {
  comboPendienteDeUsuario,
  checkoutDeComboPendiente,
} = require('../services/combos.service');

const requireStripeSubscription = async (req, res, next) => {
  try {
    const sessionUser = req.sessionUser;

    if (!sessionUser?.id_usuario) {
      return res.status(401).json({
        status: 'fail',
        code: 'UNAUTHORIZED',
        message: 'Sesión inválida.',
      });
    }

    const usuario = await Usuarios_chat_center.findByPk(
      sessionUser.id_usuario,
      {
        attributes: [
          'id_usuario',
          'id_plan',
          'stripe_subscription_id',
          'estado',
        ],
      },
    );

    if (!usuario) {
      return res.status(404).json({
        status: 'fail',
        code: 'USER_NOT_FOUND',
        message: 'Usuario no encontrado.',
      });
    }

    // Si ya tiene suscripción Stripe → todo bien
    if (usuario.stripe_subscription_id) {
      return next();
    }

    // Un combo activado por el equipo (p. ej. Combo Implementación) a una
    // cuenta sin tarjeta pide lo mismo que el Plan 21, sea cual sea su plan.
    const combo = await comboPendienteDeUsuario(usuario.id_usuario);

    // Solo aplica a planes que requieren captura
    if (!combo && !PLANES_REQUIRE_CARD.has(Number(usuario.id_plan))) {
      return next();
    }

    // El front arma el aviso con estos datos (meses incluidos y cobro después).
    let meses = MESES_CORTESIA_METHOD;
    let precio_despues = null;
    if (combo) {
      meses = Number(combo.meses) || meses;
      const datos = await checkoutDeComboPendiente(combo).catch(() => null);
      precio_despues = datos?.precio_despues ?? null;
    }

    // Sin Stripe → bloquear y enviar a checkout
    return res.status(402).json({
      status: 'fail',
      code: 'CARD_CAPTURE_REQUIRED',
      message:
        'Para usar esta función, primero debes registrar tu método de pago. No se realizará ningún cobro hasta que termine tu período incluido.',
      redirectTo: '/capturar-tarjeta',
      plan_id: usuario.id_plan,
      action: 'capturarTarjetaPlan21',
      meses_incluidos: meses,
      precio_despues,
      combo: combo ? combo.clave : null,
    });
  } catch (err) {
    return next(err);
  }
};

module.exports = requireStripeSubscription;
