'use strict';

/**
 * scripts/probarSolucionNovedadDropi.js
 *
 * Prueba si POST /orders/saveincidencesolution (el endpoint con el que el
 * panel de Dropi solventa novedades) funciona con NUESTRA llave de
 * integración (header dropi-integration-key, base .../integrations). El panel
 * lo llama en .../api con la sesión del usuario; acá se valida que también
 * exista bajo /integrations.
 *
 * OJO: Dropi valida la IP del servidor. Desde una máquina local responde
 * 401 "Access denied" para todas las llaves: hay que correrlo EN EL SERVIDOR.
 *
 * Uso (en el servidor):
 *   1) Sondeo SEGURO (no toca ninguna orden: manda data vacía):
 *        node scripts/probarSolucionNovedadDropi.js --cfg=312
 *      404           → la ruta no existe bajo /integrations
 *      401/403       → existe, pero no acepta la llave de integración
 *      200 / 400/422 → existe y acepta la llave (400/422 = queja por data vacía)
 *
 *   2) Solventar DE VERDAD una novedad (escribe en Dropi):
 *        node scripts/probarSolucionNovedadDropi.js --cfg=312 --order=7176481 \
 *          --solucion="Cliente confirma que recibe mañana" --apply
 *      Opción por defecto: { value: 1, descripcion: "Volver a ofrecer" }.
 *      --fecha=YYYY-MM-DD cambia dateToSend (por defecto hoy).
 */

require('dotenv').config({
  path: require('path').join(__dirname, '..', '.env'),
});

const { db } = require('../src/database/config');
const { decryptToken } = require('../src/utils/cryptoToken');
const dropiService = require('../src/services/dropi.service');

const arg = (nombre) => {
  const a = process.argv.find((x) => x.startsWith(`--${nombre}=`));
  return a ? a.slice(nombre.length + 3) : null;
};
const flag = (nombre) => process.argv.includes(`--${nombre}`);

(async () => {
  const cfg = Number(arg('cfg'));
  if (!cfg) {
    console.log('Falta --cfg=<id_configuracion>');
    process.exit(1);
  }

  const [rows] = await db.query(
    `SELECT id, store_name, country_code, integration_key_enc
       FROM dropi_integrations
      WHERE id_configuracion = :cfg AND deleted_at IS NULL AND is_active = 1
      ORDER BY id DESC LIMIT 1`,
    { replacements: { cfg } },
  );
  const it = rows[0];
  if (!it) {
    console.log(`No hay integración Dropi activa para cfg ${cfg}`);
    process.exit(1);
  }
  const integrationKey = decryptToken(it.integration_key_enc);
  console.log(`Integración ${it.id} (${it.store_name}, ${it.country_code})`);

  const order = Number(arg('order'));
  const real = flag('apply') && order;

  let payload;
  if (real) {
    const solucion = arg('solucion');
    if (!solucion) {
      console.log('Falta --solucion="..."');
      process.exit(1);
    }
    payload = {
      data: [
        {
          order_id: order,
          direccionConfirma: '',
          nombreConfirma: '',
          datosAdicionalDir: '',
          telefonoBaseConfirma: '',
          fechaConfirma: '',
          solution: solucion,
          essolucion: 1,
          tipocategoria: 0,
          selectValueConfirma: { value: 1, descripcion: 'Volver a ofrecer' },
          dateToSend:
            arg('fecha') ||
            new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10),
          location_url: '',
        },
      ],
    };
    console.log('⚠️  MODO REAL: se va a solventar la orden', order);
  } else {
    payload = { data: [] };
    console.log('Sondeo seguro: data vacía, no toca ninguna orden');
  }

  try {
    const r = await dropiService.saveIncidenceSolution({
      integrationKey,
      payload,
      country_code: it.country_code,
    });
    console.log('✅ RESPUESTA 200:', JSON.stringify(r, null, 2));
  } catch (e) {
    console.log(`❌ ${e.statusCode || e.status}: ${e.message}`);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
