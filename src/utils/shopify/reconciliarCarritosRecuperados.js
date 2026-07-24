'use strict';

const { db } = require('../../database/config');

const last9 = (p) =>
  String(p || '')
    .replace(/\D/g, '')
    .slice(-9);

/**
 * Marca como recuperado=1 los carritos abandonados cuyo teléfono (últimos 9
 * dígitos) tenga una orden en Dropi de esa misma configuración — sin importar
 * el canal (Shopify o WhatsApp). Complementa al webhook orders/create de
 * Shopify (que solo detecta recuperaciones por checkout Shopify con teléfono
 * exacto y se pierde las que se cerraron por WhatsApp / con formato distinto).
 *
 * @param {number} id_configuracion
 * @returns {Promise<number>} cuántos carritos marcó como recuperados
 */
async function reconciliarCarritosRecuperados(id_configuracion) {
  if (!id_configuracion) return 0;

  const [carts] = await db.query(
    `SELECT id, phone_normalizado
       FROM shopify_carritos_abandonados
      WHERE id_configuracion = ? AND recuperado = 0
        AND phone_normalizado IS NOT NULL AND phone_normalizado <> ''`,
    { replacements: [id_configuracion] },
  );
  if (!carts.length) return 0;

  const [ords] = await db.query(
    `SELECT DISTINCT phone FROM dropi_orders_cache
      WHERE id_configuracion = ? AND id_usuario = 0
        AND (status <> 'REEMPLAZADA' OR status IS NULL)
        AND phone IS NOT NULL`,
    { replacements: [id_configuracion] },
  );
  const set = new Set(ords.map((o) => last9(o.phone)).filter(Boolean));

  const ids = carts
    .filter((c) => set.has(last9(c.phone_normalizado)))
    .map((c) => c.id);
  if (!ids.length) return 0;

  await db.query(
    `UPDATE shopify_carritos_abandonados SET recuperado = 1 WHERE id IN (?)`,
    { replacements: [ids] },
  );
  return ids.length;
}

module.exports = { reconciliarCarritosRecuperados };
