'use strict';

/**
 * utils/planAcceso.js
 *
 * ¿Esta configuración puede usar las AUTOMATIZACIONES?
 *
 * PROBLEMA QUE RESUELVE
 * `middlewares/checkPlanActivo` protege las ~37 rutas HTTP del panel, pero el
 * webhook de Meta lo llama Meta, no el cliente: no pasa por ningún middleware.
 * Resultado: al vencer el plan, el panel se bloquea pero el bot sigue
 * vendiendo, el remarketing sigue enviando y las automatizaciones de Dropi
 * siguen creando órdenes. Se midieron 8 cuentas sin plan con 2.085 mensajes de
 * IA en 7 días, una de ellas cancelada desde hacía dos meses.
 *
 * QUÉ CORTA Y QUÉ NO
 * Solo lo automático: bot IA, remarketing, plantillas programadas y
 * automatizaciones de Dropi. Los mensajes entrantes se siguen guardando y el
 * agente puede responder a mano. Así, cuando el cliente paga, no perdió
 * ninguna conversación.
 *
 * OJO CON `estado`
 * No basta con mirar usuarios_chat_center.estado. checkPlanActivo marca
 * 'vencido' de forma PEREZOSA: solo cuando el usuario entra al panel. El que
 * deja de pagar y no vuelve a entrar se queda marcado 'activo' para siempre —
 * de hecho las dos cuentas que más consumían estaban así. Por eso aquí se
 * evalúan las MISMAS reglas del middleware (permanente, trial_end,
 * fecha_renovacion, plan del catálogo), no el campo `estado`.
 */

const { db } = require('../database/config');

// Margen tras fecha_renovacion antes de cortar. Cubre el desfase normal de
// cobro de Stripe (reintentos de tarjeta): no queremos apagarle el bot en
// pleno horario de ventas a alguien que sí va a pagar.
const DIAS_GRACIA = 3;

// Caché en memoria: el bot consulta esto en CADA mensaje entrante.
const TTL_MS = 60 * 1000;
const cache = new Map(); // id_configuracion → { at, permitido, motivo }

function cacheGet(id) {
  const hit = cache.get(id);
  if (!hit || Date.now() - hit.at > TTL_MS) return null;
  return hit;
}

function cacheSet(id, permitido, motivo) {
  cache.set(id, { at: Date.now(), permitido, motivo });
  return { permitido, motivo };
}

/** Invalida la caché de una configuración (tras pagar / reactivar). */
function invalidarAccesoCache(id_configuracion) {
  if (id_configuracion) cache.delete(Number(id_configuracion));
  else cache.clear();
}

/**
 * @returns {Promise<{permitido: boolean, motivo: string}>}
 *
 * Ante un error de BD devuelve permitido=true a propósito: un fallo transitorio
 * de infraestructura no puede dejar sin bot a toda la plataforma. Se prefiere
 * regalar unos minutos de servicio a provocar una caída masiva.
 */
async function verificarAccesoAutomatizaciones(id_configuracion) {
  const idCfg = Number(id_configuracion);
  if (!idCfg) return { permitido: false, motivo: 'sin_configuracion' };

  const hit = cacheGet(idCfg);
  if (hit) return { permitido: hit.permitido, motivo: hit.motivo };

  try {
    const [row] = await db.query(
      `SELECT c.suspendido,
              u.id_usuario, u.id_plan, u.permanente, u.estado,
              u.trial_end, u.fecha_renovacion,
              p.activo AS plan_activo
         FROM configuraciones c
         LEFT JOIN usuarios_chat_center u ON u.id_usuario = c.id_usuario
         LEFT JOIN planes_chat_center p ON p.id_plan = u.id_plan
        WHERE c.id = ?
        LIMIT 1`,
      { replacements: [idCfg], type: db.QueryTypes.SELECT },
    );

    if (!row) return cacheSet(idCfg, false, 'configuracion_inexistente');
    if (Number(row.suspendido) === 1)
      return cacheSet(idCfg, false, 'conexion_suspendida');
    if (!row.id_usuario) return cacheSet(idCfg, false, 'sin_usuario');

    // Plan permanente: pasa siempre (igual que el middleware).
    if (Number(row.permanente) === 1)
      return cacheSet(idCfg, true, 'permanente');

    // Bloqueos duros de cuenta.
    if (row.estado === 'suspendido' || row.estado === 'cancelado')
      return cacheSet(idCfg, false, `cuenta_${row.estado}`);

    const ahora = Date.now();

    // Trial de Stripe vigente.
    if (row.trial_end && ahora <= new Date(row.trial_end).getTime())
      return cacheSet(idCfg, true, 'trial');

    // Trial/promo por uso (Insta Landing, códigos promocionales): son otro
    // producto y el middleware los deja pasar mientras tengan cupo. No se
    // cortan aquí para no bloquear a quien el panel sí deja entrar.
    if (row.estado === 'trial_usage' || row.estado === 'promo_usage')
      return cacheSet(idCfg, true, row.estado);

    if (!row.id_plan) return cacheSet(idCfg, false, 'sin_plan');

    // Vencimiento con gracia.
    if (row.fecha_renovacion) {
      const limite =
        new Date(row.fecha_renovacion).getTime() +
        DIAS_GRACIA * 24 * 60 * 60 * 1000;
      if (ahora > limite) return cacheSet(idCfg, false, 'plan_vencido');
    }

    // `estado` se evalúa DESPUÉS de las fechas: por la marcación perezosa,
    // 'activo' no garantiza nada, pero 'inactivo'/'vencido' sí niegan.
    if (row.estado !== 'activo') return cacheSet(idCfg, false, 'plan_inactivo');

    // El plan debe seguir vigente en el catálogo.
    if (row.plan_activo !== null && Number(row.plan_activo) !== 1)
      return cacheSet(idCfg, false, 'plan_descatalogado');

    return cacheSet(idCfg, true, 'ok');
  } catch (e) {
    console.error(
      `[planAcceso] error verificando cfg ${idCfg} (se permite por seguridad):`,
      e?.message,
    );
    return { permitido: true, motivo: 'error_verificacion' };
  }
}

/** Azúcar para los sitios que solo necesitan el booleano. */
async function puedeAutomatizar(id_configuracion) {
  const { permitido } = await verificarAccesoAutomatizaciones(id_configuracion);
  return permitido;
}

module.exports = {
  verificarAccesoAutomatizaciones,
  puedeAutomatizar,
  invalidarAccesoCache,
  DIAS_GRACIA,
};
