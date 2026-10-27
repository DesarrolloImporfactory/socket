/**
 * scripts/repararOrdenesPisadasPorPais.js
 *
 * Repara filas de dropi_orders_cache que el webhook pisó con la orden de
 * OTRO país que tenía el mismo dropi_order_id.
 *
 * Por qué pasa: los ids de orden de Dropi se repiten entre países (la
 * 6310143 de Ecuador y la 6310143 de México son órdenes distintas). El
 * procesador del webhook emparejaba el evento con el cache solo por
 * dropi_order_id, así que un evento de México entraba a la cuenta
 * ecuatoriana que tenía ese id y le sobreescribía estado, cliente, teléfono
 * y productos (90 filas en 25 cuentas EC + 9 en entidades por usuario al
 * 27-10-2026; en la cfg 277 "GAFAS BLUETOOH" de julio quedó como una orden
 * mexicana). Desde el fix, resolverIntegraciones filtra por el país del
 * evento. Este script repara el acumulado: pide a Dropi el detalle real con
 * la llave de la cuenta dueña y re-escribe la fila con upsertOrders.
 *
 * Solo corre en el servidor: la API de Dropi responde 401 desde otra IP.
 * Si Dropi no devuelve la orden (ya no existe para esa cuenta), la fila se
 * deja como está y se reporta para revisarla a mano.
 *
 * Uso:
 *   node scripts/repararOrdenesPisadasPorPais.js            (dry-run, todas)
 *   node scripts/repararOrdenesPisadasPorPais.js --cfg=277  (dry-run, una)
 *   node scripts/repararOrdenesPisadasPorPais.js --apply [--cfg=277]
 */
require('dotenv').config();
const { db } = require('../src/database/config');
const dropiService = require('../src/services/dropi.service');
const { decryptToken } = require('../src/utils/cryptoToken');
const { upsertOrders } = require('../src/services/dropi_notifier.service');
const {
  dropiDateToLocal,
} = require('../src/services/dropi_webhook_processor.service');

const args = process.argv.slice(2);
const CFG = Number(
  (args.find((a) => a.startsWith('--cfg=')) || '').split('=')[1] || 0,
);
const APPLY = args.includes('--apply');

// Mismo mapeo que codigoPaisDelEvento en el procesador del webhook.
const SQL_PAIS_ORDEN = `
  CASE UPPER(JSON_UNQUOTE(JSON_EXTRACT(c.order_data, '$.country')))
    WHEN 'ECUADOR' THEN 'EC' WHEN 'EC' THEN 'EC'
    WHEN 'MEXICO' THEN 'MX' WHEN 'MX' THEN 'MX'
    WHEN 'COLOMBIA' THEN 'CO' WHEN 'CO' THEN 'CO'
    WHEN 'GUATEMALA' THEN 'GT' WHEN 'GT' THEN 'GT'
  END`;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const filas = await db.query(
    `SELECT c.id, c.id_configuracion, c.id_usuario, c.dropi_order_id,
            c.status, c.name, c.surname, c.phone, c.updated_at,
            ${SQL_PAIS_ORDEN} pais_orden,
            UPPER(IFNULL(di.country_code, 'EC')) pais_cuenta
       FROM dropi_orders_cache c
       JOIN dropi_integrations di
         ON di.is_active = 1 AND di.deleted_at IS NULL
        AND (
          (c.id_configuracion > 0 AND di.id_configuracion = c.id_configuracion)
          OR (IFNULL(c.id_configuracion, 0) = 0
              AND IFNULL(di.id_configuracion, 0) = 0
              AND di.id_usuario = c.id_usuario)
        )
      WHERE ${SQL_PAIS_ORDEN} IS NOT NULL
        AND ${SQL_PAIS_ORDEN} <> UPPER(IFNULL(di.country_code, 'EC'))
        ${CFG ? 'AND c.id_configuracion = :cfg' : ''}
      GROUP BY c.id
      ORDER BY c.id_configuracion, c.dropi_order_id`,
    { replacements: CFG ? { cfg: CFG } : {}, type: db.QueryTypes.SELECT },
  );

  console.log(
    `\n${APPLY ? 'APLICANDO' : 'DRY-RUN'} — ${filas.length} fila(s) pisadas por otro país`,
  );
  console.table(
    filas.map((f) => ({
      cfg: f.id_configuracion,
      usr: f.id_usuario,
      orden: f.dropi_order_id,
      cuenta: f.pais_cuenta,
      orden_dice: f.pais_orden,
      status: f.status,
      cliente: `${f.name || ''} ${f.surname || ''}`.trim(),
      tel: f.phone,
      pisada: String(f.updated_at).slice(0, 19),
    })),
  );

  if (!APPLY) {
    console.log(
      '\nSin cambios. Agrega --apply para re-leer cada orden de Dropi.',
    );
    await db.close();
    return;
  }

  // Llaves por entidad (una config puede tener varias tiendas: se prueban
  // todas hasta que una devuelva la orden).
  const integraciones = await db.query(
    `SELECT id_configuracion, id_usuario, country_code, integration_key_enc
       FROM dropi_integrations
      WHERE is_active = 1 AND deleted_at IS NULL`,
    { type: db.QueryTypes.SELECT },
  );
  const llavesDe = (f) =>
    integraciones.filter((i) =>
      Number(f.id_configuracion) > 0
        ? Number(i.id_configuracion) === Number(f.id_configuracion)
        : !Number(i.id_configuracion || 0) &&
          Number(i.id_usuario) === Number(f.id_usuario),
    );

  let reparadas = 0;
  const sinDetalle = [];
  for (const f of filas) {
    const cacheInsertFields =
      Number(f.id_configuracion) > 0
        ? { id_configuracion: Number(f.id_configuracion), id_usuario: 0 }
        : { id_configuracion: 0, id_usuario: Number(f.id_usuario) };
    let ok = false;
    let ultimoError = 'sin integración activa';
    for (const integ of llavesDe(f)) {
      let integrationKey = '';
      try {
        integrationKey = decryptToken(integ.integration_key_enc);
      } catch (e) {
        ultimoError = `llave ilegible: ${e?.message}`;
        continue;
      }
      if (!integrationKey?.trim()) continue;
      try {
        const detail = await dropiService.getOrderDetail({
          integrationKey,
          orderId: f.dropi_order_id,
          country_code: integ.country_code,
        });
        const obj = detail?.objects;
        if (!obj || Number(obj.id) !== Number(f.dropi_order_id)) {
          ultimoError = 'Dropi no devolvió la orden';
          continue;
        }
        obj.created_at = dropiDateToLocal(obj.created_at, integ.country_code);
        await upsertOrders(cacheInsertFields, [obj]);
        console.log(
          `✔ cfg ${f.id_configuracion}/u${f.id_usuario} orden ${f.dropi_order_id}: ` +
            `${f.status} (${f.pais_orden}) → ${obj.status} (${integ.country_code}) ` +
            `${obj.name || ''} ${obj.surname || ''}`.trim(),
        );
        ok = true;
        reparadas++;
        break;
      } catch (e) {
        ultimoError = e?.message || String(e);
      }
      await dormir(300);
    }
    if (!ok) {
      sinDetalle.push({
        cfg: f.id_configuracion,
        usr: f.id_usuario,
        orden: f.dropi_order_id,
        motivo: ultimoError,
      });
      console.log(
        `✘ cfg ${f.id_configuracion}/u${f.id_usuario} orden ${f.dropi_order_id}: ${ultimoError}`,
      );
    }
    await dormir(300);
  }

  console.log(`\nReparadas: ${reparadas} de ${filas.length}`);
  if (sinDetalle.length) {
    console.log('Sin reparar (revisar a mano, la fila quedó como estaba):');
    console.table(sinDetalle);
  }
  await db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
