const Planes_chat_center = require('../models/planes_chat_center.model');
const Usuarios_chat_center = require('../models/usuarios_chat_center.model');
const { db } = require('../database/config');
const {
  PLAN_IC_ID,
  PLAN_IL_ID,
  PLAN_COMUNIDAD_ID,
  PLAN_METHOD_ID,
  TRIAL_DAYS,
  TRIAL_DAYS_COMUNIDAD,
  IL_TRIAL_IMAGES,
  PROMO_FIRST_MONTH_PRICE,
  getPromoPlans,
  tipoPlanUI,
  trialDiasParaPlan,
} = require('../config/planes.config');

/**
 * ✅ Asigna un plan al usuario sin activarlo
 * Este paso solo marca la intención de pago, no cambia el estado.
 */
exports.seleccionarPlan = async (req, res) => {
  try {
    const { id_plan, id_plataforma = null } = req.body;
    const id_usuario = req.user?.id || req.body.id_usuario || req.body.id_users;

    if (!id_plan || !id_usuario) {
      return res.status(400).json({
        status: 'fail',
        message: 'Faltan datos necesarios (id_plan, id_usuario)',
      });
    }

    // Validar que el plan exista
    const plan = await Planes_chat_center.findByPk(id_plan);
    if (!plan) {
      return res
        .status(404)
        .json({ status: 'fail', message: 'El plan no existe' });
    }

    // Validar que el usuario exista
    const usuario = await Usuarios_chat_center.findByPk(id_usuario);
    if (!usuario) {
      return res
        .status(404)
        .json({ status: 'fail', message: 'El usuario no existe' });
    }

    // ✅ Activar directamente el Plan Free (id_plan === 1)
    if (parseInt(id_plan) === 1) {
      const hoy = new Date();
      const nuevaFechaRenovacion = new Date(hoy);
      nuevaFechaRenovacion.setDate(hoy.getDate() + 30);

      await usuario.update({
        id_plan: 1,
        fecha_inicio: hoy,
        fecha_renovacion: nuevaFechaRenovacion,
        estado: 'activo',
        free_trial_used: 1,
        id_plataforma: id_plataforma,
      });

      return res.status(200).json({
        status: 'success',
        message: 'Plan gratuito activado correctamente',
      });
    }

    // 🟣 Otros planes: solo actualizar intención
    await usuario.update({ id_plan });

    return res.status(200).json({
      status: 'success',
      message: 'Plan seleccionado correctamente, pendiente de pago',
    });
  } catch (error) {
    console.error('Error al seleccionar plan:', error);
    return res
      .status(500)
      .json({ status: 'fail', message: 'Error interno al seleccionar plan' });
  }
};
/**
 * Devuelve el catálogo YA RESUELTO para el usuario que pregunta.
 *
 * POR QUÉ DEVUELVE MÁS QUE LA TABLA
 * El front decidía qué planes mostrar con Sets hardcodeados
 * (PLANES_VISIBLES / HIDDEN_PLANS / SORT_ORDER en PlanesView.jsx), así que
 * cambiar el catálogo obligaba a redesplegar el SPA. Peor: la elegibilidad
 * quedaba del lado del cliente, donde cualquiera puede editarla. Ahora la
 * visibilidad se calcula aquí y el front solo pinta lo que recibe.
 *
 * `data` mantiene exactamente la forma de siempre (array de filas del
 * catálogo) para no romper a ningún consumidor existente; lo nuevo va como
 * campos adicionales por plan y en el bloque `config`.
 *
 * Un plan se muestra si:
 *   1. visible_publico = 1 (catálogo público), o
 *   2. está en unlocked_plans del usuario (lo desbloqueó con código promo), o
 *   3. es el plan que el usuario tiene hoy (para que se vea a sí mismo aunque
 *      el plan ya no se venda).
 */
exports.obtenerPlanes = async (req, res) => {
  try {
    const id_usuario = req.sessionUser?.id_usuario || null;

    // SELECT * a propósito: `visible_publico` puede no existir todavía si la
    // migración no corrió. Con el modelo de Sequelize el findAll reventaría;
    // así simplemente llega undefined y se asume visible.
    const [planes] = await db.query(
      `SELECT * FROM planes_chat_center
        WHERE activo = 1
        ORDER BY sort_order ASC, id_plan ASC`,
    );

    let usuario = null;
    if (id_usuario) {
      usuario = await Usuarios_chat_center.findByPk(id_usuario, {
        attributes: [
          'id_usuario',
          'id_plan',
          'unlocked_plans',
          'free_trial_used',
          'promo_plan2_used',
        ],
      });
    }

    // unlocked_plans se guarda como JSON en texto; un valor corrupto no puede
    // tumbar el catálogo entero.
    let desbloqueados = [];
    try {
      const raw = JSON.parse(usuario?.unlocked_plans || '[]');
      if (Array.isArray(raw)) desbloqueados = raw.map(Number).filter(Boolean);
    } catch (e) {
      console.warn('[planes] unlocked_plans inválido:', e?.message);
    }

    const planActualId = Number(usuario?.id_plan || 0) || null;
    const promoPlans = getPromoPlans();
    const promoDisponible = Number(usuario?.promo_plan2_used || 0) === 0;

    // Si la migración de `visible_publico` todavía no corrió, NO se manda el
    // campo `visible`: el front detecta su ausencia y decide con su lista de
    // respaldo. Mandarlo en true para todo mostraría hasta las filas TEST.
    const hayColumnaVisibilidad =
      (planes || []).length > 0 && planes[0].visible_publico !== undefined;

    if (!hayColumnaVisibilidad) {
      console.warn(
        '[planes] falta la columna visible_publico — aplicar planes_visibilidad_migration.sql',
      );
    }

    // ─── Planes "hermanos": mismo producto de Stripe, distinto precio ───
    //
    // Al subir un precio se crea una fila legacy que clona el plan y conserva
    // el price viejo, para que quien ya paga no cambie de tarifa. Esa fila
    // comparte `id_product_stripe` con la pública.
    //
    // Sin esto, el cliente antiguo veía DOS tarjetas con el mismo nombre — la
    // suya a $29 y la pública a $39 — y si tocaba la segunda, `cambiarPlan` lo
    // leía como upgrade y le cobraba prorrateo por el MISMO producto, más caro.
    // Así que al que ya tiene una variante se le oculta la otra.
    const planActual = (planes || []).find(
      (p) => Number(p.id_plan) === planActualId,
    );
    const productoActual = planActual?.id_product_stripe || null;

    const data = (planes || []).map((plan) => {
      const idPlan = Number(plan.id_plan);
      const esActual = !!planActualId && planActualId === idPlan;

      const esHermanoDelActual =
        !!productoActual &&
        !esActual &&
        plan.id_product_stripe === productoActual;

      const visibilidad = hayColumnaVisibilidad
        ? {
            visible:
              !esHermanoDelActual &&
              (Number(plan.visible_publico) === 1 ||
                desbloqueados.includes(idPlan) ||
                esActual),
          }
        : {};

      return {
        ...plan,
        ...visibilidad,
        es_plan_actual: esActual,
        tipo_ui: tipoPlanUI(plan),
        trial_dias: trialDiasParaPlan(idPlan, usuario),
        promo_aplicable: promoDisponible && promoPlans.has(idPlan),
      };
    });

    return res.status(200).json({
      status: 'success',
      data,
      config: {
        plan_imporchat_id: PLAN_IC_ID,
        plan_insta_landing_id: PLAN_IL_ID,
        plan_comunidad_id: PLAN_COMUNIDAD_ID,
        plan_method_id: PLAN_METHOD_ID,
        trial_dias: TRIAL_DAYS,
        trial_dias_comunidad: TRIAL_DAYS_COMUNIDAD,
        il_trial_imagenes: IL_TRIAL_IMAGES,
        promo_primer_mes_precio: PROMO_FIRST_MONTH_PRICE,
      },
    });
  } catch (error) {
    console.error('Error al obtener planes:', error);
    return res.status(500).json({
      status: 'fail',
      message: 'Error interno al obtener los planes',
    });
  }
};
