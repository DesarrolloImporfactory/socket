'use strict';

/**
 * utils/interruptorBot.js
 *
 * ¿El cliente APAGÓ el bot desde la vista de Asistentes?
 *
 * El switch (openai_assistants.activo, tipo 'ventas') ya callaba al cerebro de
 * la IA (kanban_ia) y al ENVÍO del cron de remarketing de WhatsApp, pero los
 * remarketings se seguían CREANDO igual — el cliente los veía como
 * "programados" en el chat sin que fueran a salir nunca. Este util es la
 * fuente única para que apagado corte el remarketing COMPLETO (creación WA/
 * IG/MS y envío IG/MS, que no tenían el filtro del cron de WA).
 *
 * QUÉ NO CORTA, A PROPÓSITO: las plantillas de estado de Dropi/Aliclik/
 * Shopify (dropi_notifier, aliclik_notifier, enviarPendienteConfirmacion-
 * Shopify) y el respondedor logístico. Hay cuentas (p. ej. la 886) que
 * instalan el bot SOLO para las plantillas de seguimiento y lo mantienen
 * apagado como vendedor: esos flujos viven de sus propios interruptores
 * (dropi_plantillas_config.activo, respondedor_logistico_config.activo) y
 * deben funcionar sin importar este switch.
 *
 * OJO CON LA SEMÁNTICA: apagado EXPLÍCITO = existe la fila con activo = 0.
 * SIN fila NO cuenta como apagado aquí, a diferencia del gate del cerebro IA
 * (kanban_ia, donde sin fila = bot nunca encendido = silencio). La diferencia
 * es a propósito: una cuenta que jamás activó un bot pero configuró
 * remarketing de solo-plantillas no debe perder envíos por eso.
 */

const { db } = require('../database/config');

// Se consulta en flujos calientes (webhook de Dropi, cron de remarketing):
// caché corto igual que planAcceso. Se invalida al guardar desde Asistentes
// (mismo proceso); entre procesos el TTL lo resuelve solo.
const TTL_MS = 60 * 1000;
const cache = new Map(); // id_configuracion → { at, apagado }

/**
 * true SOLO si el cliente apagó el bot expresamente en la vista de Asistentes.
 * Ante un error de BD devuelve false (no apagar nada por un fallo transitorio).
 */
async function botApagadoExplicito(id_configuracion) {
  const idCfg = Number(id_configuracion);
  if (!idCfg) return false;

  const hit = cache.get(idCfg);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.apagado;

  let apagado = false;
  try {
    const [row] = await db.query(
      `SELECT activo FROM openai_assistants
        WHERE id_configuracion = ? AND tipo = 'ventas' AND deleted_at IS NULL
        LIMIT 1`,
      { replacements: [idCfg], type: db.QueryTypes.SELECT },
    );
    apagado = !!row && Number(row.activo) === 0;
  } catch (e) {
    console.error(
      `[interruptorBot] error consultando cfg ${idCfg} (se asume encendido):`,
      e?.message,
    );
  }
  cache.set(idCfg, { at: Date.now(), apagado });
  return apagado;
}

/** Invalidar tras guardar el switch desde la pantalla de Asistentes. */
function invalidarInterruptorBot(id_configuracion) {
  if (id_configuracion) cache.delete(Number(id_configuracion));
  else cache.clear();
}

module.exports = { botApagadoExplicito, invalidarInterruptorBot };
