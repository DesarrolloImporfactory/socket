'use strict';

/**
 * Limpia los avisos de RETIRO EN AGENCIA que salieron por el despacho en la
 * agencia de ORIGEN (ver utils/retiroEnOrigen.js) y deja el terreno listo
 * para que el retiro real, si llega, sí se avise.
 *
 * Por cada reclamo "RETIRO EN AGENCIA" en dropi_plantillas_enviadas desde
 * --desde cuya orden se clasifica como despacho de origen:
 *   1. borra el reclamo si la orden sigue viva (no ENTREGADO/CANCELADO/
 *      DEVOLUCION), para que el notifier pueda avisar el retiro verdadero;
 *   2. limpia agencia_retiro/agencia_motivo/agencia_at del cache (era la
 *      agencia del proveedor: el bot y la vista no deben citarla);
 *   3. cancela los recordatorios k1/k2/k3 de retiro que quedaron agendados
 *      (remarketing_pendientes) y aún no salieron;
 *   4. si el chat sigue parado en la columna de retiro y la orden está viva,
 *      lo devuelve a la columna de GUIA GENERADA.
 *
 * Uso:
 *   node scripts/limpiarRetirosEnOrigen.js                 (dry-run, todas las cuentas)
 *   node scripts/limpiarRetirosEnOrigen.js --cfg=841       (una cuenta)
 *   node scripts/limpiarRetirosEnOrigen.js --desde=2026-08-15
 *   node scripts/limpiarRetirosEnOrigen.js --apply         (ejecuta)
 *
 * No manda ningún mensaje al cliente: avisarle que el aviso anterior fue un
 * error es decisión de cada cuenta.
 */

require('dotenv').config();
const { db } = require('../src/database/config');
const {
  clasificarPorMovimientos,
  ESTADOS_SIN_TRANSITO,
} = require('../src/utils/retiroEnOrigen');
const { normalizePhone } = require('../src/services/dropi_notifier.service');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CFG = (args.find((a) => a.startsWith('--cfg=')) || '').split('=')[1];
const DESDE =
  (args.find((a) => a.startsWith('--desde=')) || '').split('=')[1] ||
  '2026-09-01';

const ESTADOS_TERMINALES = /ENTREGAD|CANCELAD|ANULAD|DEVOLUCION|DEVUELT|RECHAZAD/i;

const q = (sql, replacements = []) =>
  db.query(sql, { replacements, type: db.QueryTypes.SELECT });

async function main() {
  console.log(
    `${APPLY ? 'APLICANDO' : 'DRY-RUN'} · reclamos RETIRO EN AGENCIA desde ${DESDE}${CFG ? ` · cfg ${CFG}` : ''}`,
  );

  const reclamos = await q(
    `SELECT e.id reclamo_id, e.dropi_order_id, e.id_configuracion, e.phone,
            e.sent_at, e.template_name,
            c.status, c.city, c.agencia_retiro, c.order_data, c.order_created_at
       FROM dropi_plantillas_enviadas e
       JOIN dropi_orders_cache c
         ON c.dropi_order_id = e.dropi_order_id
        AND c.id_configuracion = e.id_configuracion
      WHERE e.estado_dropi = 'RETIRO EN AGENCIA'
        AND e.sent_at >= ?
        ${CFG ? 'AND e.id_configuracion = ?' : ''}
      ORDER BY e.id_configuracion, e.sent_at`,
    CFG ? [DESDE, Number(CFG)] : [DESDE],
  );
  console.log(`reclamos revisados: ${reclamos.length}`);

  // columnas por cuenta (retiro y guía generada) + país
  const cfgCache = new Map();
  async function datosCfg(id_configuracion) {
    if (cfgCache.has(id_configuracion)) return cfgCache.get(id_configuracion);
    const cols = await q(
      `SELECT estado_dropi, columna_destino
         FROM dropi_plantillas_config
        WHERE id_configuracion = ? AND proveedor = 'dropi'
          AND estado_dropi IN ('RETIRO EN AGENCIA', 'GUIA GENERADA')`,
      [id_configuracion],
    );
    const [integ] = await q(
      `SELECT country_code FROM dropi_integrations WHERE id_configuracion = ? LIMIT 1`,
      [id_configuracion],
    ).catch(() => []);
    const d = {
      colRetiro:
        cols.find((c) => c.estado_dropi === 'RETIRO EN AGENCIA')
          ?.columna_destino || null,
      colGuia:
        cols.find((c) => c.estado_dropi === 'GUIA GENERADA')?.columna_destino ||
        'guia_generada',
      country: integ?.country_code || 'EC',
    };
    cfgCache.set(id_configuracion, d);
    return d;
  }

  const resumen = {}; // cfg → contadores
  const bump = (cfg, k) => {
    resumen[cfg] = resumen[cfg] || {
      revisados: 0,
      origen: 0,
      reclamos_borrados: 0,
      agencias_limpiadas: 0,
      recordatorios_cancelados: 0,
      chats_devueltos: 0,
      terminales: 0,
    };
    resumen[cfg][k]++;
  };
  const detalleOrigen = [];

  for (const r of reclamos) {
    bump(r.id_configuracion, 'revisados');
    let od = {};
    try {
      od = typeof r.order_data === 'string' ? JSON.parse(r.order_data) : r.order_data || {};
    } catch (_) {}

    // Igual que en producción: primero nuestro historial, luego Dropi. Aquí
    // el "estado previo" es el que había ANTES del reclamo, no el último.
    let clase = await clasificarPorEventosAntesDe(r.dropi_order_id, r.sent_at);
    if (!clase) clase = clasificarPorMovimientos(od.servientrega_movements);
    if (!clase || !clase.enOrigen) continue;

    bump(r.id_configuracion, 'origen');
    const terminal = ESTADOS_TERMINALES.test(String(r.status || ''));
    if (terminal) bump(r.id_configuracion, 'terminales');
    detalleOrigen.push(
      `cfg ${r.id_configuracion} · orden ${r.dropi_order_id} · ${r.city} · avisó "${r.agencia_retiro || '-'}" el ${r.sent_at} · hoy ${r.status} · ${clase.fuente}`,
    );

    const { colRetiro, colGuia, country } = await datosCfg(r.id_configuracion);
    const phoneNorm = normalizePhone(r.phone, country);

    // 1. reclamo (solo si la orden sigue viva)
    if (!terminal) {
      bump(r.id_configuracion, 'reclamos_borrados');
      if (APPLY) {
        await db.query(
          `DELETE FROM dropi_plantillas_enviadas WHERE id = ?`,
          { replacements: [r.reclamo_id], type: db.QueryTypes.DELETE },
        );
      }
    }

    // 2. agencia en cache
    if (r.agencia_retiro) {
      bump(r.id_configuracion, 'agencias_limpiadas');
      if (APPLY) {
        await db.query(
          `UPDATE dropi_orders_cache
              SET agencia_retiro = NULL, agencia_motivo = NULL, agencia_at = NULL
            WHERE dropi_order_id = ? AND id_configuracion = ?`,
          {
            replacements: [r.dropi_order_id, r.id_configuracion],
            type: db.QueryTypes.UPDATE,
          },
        );
      }
    }

    // 3. recordatorios pendientes de retiro
    if (colRetiro && phoneNorm) {
      const pend = await q(
        `SELECT id FROM remarketing_pendientes
          WHERE id_configuracion = ? AND estado_contacto_origen = ?
            AND enviado = 0 AND cancelado = 0
            AND (telefono = ? OR telefono LIKE ?)
            AND creado_en >= ?`,
        [
          r.id_configuracion,
          colRetiro,
          phoneNorm,
          `%${phoneNorm.slice(-9)}`,
          r.sent_at,
        ],
      );
      for (const p of pend) {
        bump(r.id_configuracion, 'recordatorios_cancelados');
        if (APPLY) {
          await db.query(
            `UPDATE remarketing_pendientes SET cancelado = 1 WHERE id = ?`,
            { replacements: [p.id], type: db.QueryTypes.UPDATE },
          );
        }
      }
    }

    // 4. chat parado en la columna de retiro con orden viva
    if (!terminal && colRetiro && phoneNorm) {
      const [cli] = await q(
        `SELECT id FROM clientes_chat_center
          WHERE id_configuracion = ? AND deleted_at IS NULL
            AND estado_contacto = ?
            AND (REPLACE(celular_cliente, ' ', '') = ?
                 OR telefono_limpio = ?
                 OR celular_cliente LIKE ?)
          LIMIT 1`,
        [
          r.id_configuracion,
          colRetiro,
          phoneNorm,
          phoneNorm,
          `%${phoneNorm.slice(-9)}`,
        ],
      );
      if (cli) {
        bump(r.id_configuracion, 'chats_devueltos');
        if (APPLY) {
          await db.query(
            `UPDATE clientes_chat_center SET estado_contacto = ? WHERE id = ?`,
            { replacements: [colGuia, cli.id], type: db.QueryTypes.UPDATE },
          );
        }
      }
    }
  }

  console.log('\nDespachos de origen detectados:');
  for (const l of detalleOrigen) console.log('  ' + l);

  console.log('\nResumen por cuenta (solo cuentas con casos):');
  const filas = Object.entries(resumen)
    .filter(([, v]) => v.origen > 0)
    .map(([cfg, v]) => ({ cfg: Number(cfg), ...v }));
  console.table(filas);
  const tot = filas.reduce((a, f) => {
    for (const k of Object.keys(f)) if (k !== 'cfg') a[k] = (a[k] || 0) + f[k];
    return a;
  }, {});
  console.log('TOTAL', tot, APPLY ? '' : '(dry-run: nada se modificó)');
}

/** Último estado no-retiro registrado ANTES de la fecha del reclamo. */
async function clasificarPorEventosAntesDe(dropi_order_id, antesDe) {
  const rows = await q(
    `SELECT status FROM dropi_webhook_events
      WHERE dropi_order_id = ? AND status NOT LIKE 'PARA RETIRO%'
        AND created_at <= ?
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [dropi_order_id, antesDe],
  );
  // Sin eventos previos (orden solo por cron) → que decidan los movimientos.
  if (!rows.length) return null;
  const prev = String(rows[0].status || '').trim().toUpperCase();
  return {
    enOrigen: ESTADOS_SIN_TRANSITO.has(prev),
    fuente: 'eventos',
    detalle: `estado previo "${prev}"`,
  };
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
