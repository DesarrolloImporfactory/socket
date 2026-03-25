// Middleware que bloquea usuarios con Plan 21 (Method Ecommerce)
// que NO tienen stripe_subscription_id.
//

const Usuarios_chat_center = require('../models/usuarios_chat_center.model');

// Planes que requieren captura de tarjeta antes de usar features core
const PLANES_REQUIRE_CARD = new Set([21]);

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

    // Solo aplica a planes que requieren captura
    if (!PLANES_REQUIRE_CARD.has(Number(usuario.id_plan))) {
      return next();
    }

    // Si ya tiene suscripción Stripe → todo bien
    if (usuario.stripe_subscription_id) {
      return next();
    }

    // Plan 21 sin Stripe → bloquear y enviar a checkout
    return res.status(402).json({
      status: 'fail',
      code: 'CARD_CAPTURE_REQUIRED',
      message:
        'Para usar esta función, primero debes registrar tu método de pago. No se realizará ningún cobro hasta que termine tu período incluido.',
      redirectTo: '/capturar-tarjeta',
      plan_id: usuario.id_plan,
      action: 'capturarTarjetaPlan21',
    });
  } catch (err) {
    return next(err);
  }
};

module.exports = requireStripeSubscription;
