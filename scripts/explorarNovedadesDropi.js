'use strict';

/**
 * scripts/explorarNovedadesDropi.js
 *
 * SOLO LECTURA. Pide a Dropi órdenes con novedad pendiente por solucionar
 * (GET /orders/myorders con haveIncidenceProcesamiento=true) y muestra qué
 * campos trae la orden, para diseñar "solventar novedades desde ChatCenter".
 * No escribe en la BD ni en Dropi.
 *
 * OJO: Dropi valida la IP del servidor. Desde una máquina local responde
 * 401 "Access denied" para todas las llaves: hay que correrlo EN EL SERVIDOR.
 *
 * Uso (en el servidor):
 *   node scripts/explorarNovedadesDropi.js
 *   node scripts/explorarNovedadesDropi.js --cfg=277
 *   node scripts/explorarNovedadesDropi.js --pais=CO
 */

require('dotenv').config({
  path: require('path').join(__dirname, '..', '.env'),
});

const { db } = require('../src/database/config');
const { decryptToken } = require('../src/utils/cryptoToken');
const dropiService = require('../src/services/dropi.service');

const arg = (nombre) => {
  const a = process.argv.find((x) => x.startsWith(`--${nombre}=`));
  return a ? a.split('=')[1] : null;
};

const RE_NOVEDAD = /incid|novel|noved|issue|solu/i;

(async () => {
  const cfg = Number(arg('cfg')) || null;
  const pais = (arg('pais') || 'EC').toUpperCase();

  const [rows] = await db.query(
    `SELECT i.id, i.id_configuracion, i.store_name, i.country_code,
            i.integration_key_enc,
            (SELECT COUNT(*) FROM dropi_orders_cache c
              WHERE c.id_configuracion = i.id_configuracion
                AND c.classified_status = 'novedad') AS novedades
       FROM dropi_integrations i
      WHERE i.country_code = :pais
        ${cfg ? 'AND i.id_configuracion = :cfg' : ''}
      ORDER BY novedades DESC
      LIMIT 3`,
    { replacements: { pais, cfg } },
  );

  if (!rows.length) {
    console.log('No hay integraciones para esos filtros');
    process.exit(0);
  }

  for (const it of rows) {
    let key;
    try {
      key = decryptToken(it.integration_key_enc);
    } catch (e) {
      console.log(`No se pudo descifrar la llave de la integración ${it.id}`);
      continue;
    }

    try {
      const data = await dropiService.listMyOrders({
        integrationKey: key,
        country_code: it.country_code,
        params: {
          result_number: 3,
          start: 0,
          filter_date_by: 'FECHA DE CREADO',
          haveIncidenceProcesamiento: true,
          issue_solved_by_parent_order: false,
        },
      });
      const objs = data?.objects || [];
      console.log(
        `\n== Integración ${it.id} (${it.store_name}, cfg ${it.id_configuracion}) → ${objs.length} órdenes`,
      );
      if (!objs.length) continue;

      console.log(
        'STATUS DE LAS ÓRDENES:',
        objs.map((o) => `${o.id}:${o.status}`).join(' | '),
      );

      const o = objs[0];
      console.log('ORDEN', o.id, '| status:', o.status);
      console.log('CAMPOS:', Object.keys(o).join(', '));

      const relevantes = {};
      for (const [k, v] of Object.entries(o)) {
        if (RE_NOVEDAD.test(k)) relevantes[k] = v;
      }
      console.log(
        'CAMPOS DE NOVEDAD:',
        JSON.stringify(relevantes, null, 2).slice(0, 6000),
      );

      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === 'object' && RE_NOVEDAD.test(JSON.stringify(v))) {
          console.log(`ANIDADO ${k}:`, JSON.stringify(v, null, 2).slice(0, 3000));
        }
      }

      // Detalle de la misma orden: a veces trae el historial de la novedad.
      const det = await dropiService.getOrderDetail({
        integrationKey: key,
        orderId: o.id,
        country_code: it.country_code,
      });
      const d = det?.objects || det?.data || det;
      console.log('\nDETALLE CAMPOS:', Object.keys(d || {}).join(', '));
      for (const [k, v] of Object.entries(d || {})) {
        if (RE_NOVEDAD.test(k) || (v && typeof v === 'object' && RE_NOVEDAD.test(JSON.stringify(v)))) {
          console.log(`DETALLE ${k}:`, JSON.stringify(v, null, 2).slice(0, 3000));
        }
      }
      break;
    } catch (e) {
      console.log(`ERROR integración ${it.id}:`, e.message);
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
