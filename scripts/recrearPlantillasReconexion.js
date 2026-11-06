/* Recrea en la WABA actual de una conexión las plantillas de Meta que sus
   automatizaciones referencian (tablero global, Dropi, remarketing, guía,
   Shopify, agenda, encuestas). Es lo mismo que hace el server solo cuando
   el cliente reconecta un número nuevo (plantillas_reconexion.service); este
   script sirve para las cuentas que ya cambiaron de número antes de eso
   (cfg 793 NEXUS SHOP, 2026-11-06: el número se editó a mano en la BD y la
   WABA nueva quedó con 0 plantillas) o para revisar cualquier cuenta.

   node scripts/recrearPlantillasReconexion.js --cfg 793            solo diagnóstico
   node scripts/recrearPlantillasReconexion.js --cfg 793 --aplicar  crea las que falten

   Sin --aplicar no toca Meta ni la BD: lista qué referencia la cuenta, qué
   hay en la WABA y qué se crearía. Las plantillas creadas quedan PENDING
   hasta que Meta las apruebe (minutos). */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const { db } = require('../src/database/config');
const {
  plantillasReferenciadas,
  recrearPlantillasTrasReconexion,
} = require('../src/services/plantillas_reconexion.service');
const { getTemplatesMetaMerged } = require('../src/utils/kanban_catalogo.provider');

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const cfgId = Number(arg('cfg'));
const aplicar = arg('aplicar') === true;

(async () => {
  if (!cfgId) {
    console.log('Uso: node scripts/recrearPlantillasReconexion.js --cfg N [--aplicar]');
    process.exit(1);
  }

  const [cfg] = await db.query(
    `SELECT id, nombre_configuracion, telefono, id_telefono, id_whatsapp, wa_status,
            kanban_global_id, token IS NOT NULL AS con_token
       FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [cfgId], type: db.QueryTypes.SELECT },
  );
  if (!cfg) {
    console.log(`No existe la configuración ${cfgId}`);
    process.exit(1);
  }
  console.log(
    `cfg ${cfg.id} ${cfg.nombre_configuracion} · tel ${cfg.telefono} · phone_id ${cfg.id_telefono || '-'} · WABA ${cfg.id_whatsapp || '-'} · ${cfg.wa_status || 'sin estado'} · tablero ${cfg.kanban_global_id || '-'}`,
  );
  if (!cfg.id_whatsapp || !cfg.con_token) {
    console.log('La conexión no tiene WABA o token: primero hay que conectar el número.');
    process.exit(1);
  }

  const { nombres, fuentes } = await plantillasReferenciadas(cfgId);
  const catalogo = new Set((await getTemplatesMetaMerged()).map((t) => t.name));

  let enWaba = new Map();
  try {
    const { data } = await axios.get(
      `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${cfg.id_whatsapp}/message_templates`,
      { params: { access_token: process.env.FB_PROVIDER_TOKEN, limit: 200, fields: 'name,status' } },
    );
    enWaba = new Map((data.data || []).map((t) => [t.name, t.status]));
  } catch (e) {
    console.log('No se pudo listar la WABA:', JSON.stringify(e?.response?.data || e.message));
    process.exit(1);
  }
  console.log(`\nPlantillas en la WABA: ${enWaba.size}`);

  console.log(`\nReferenciadas por la cuenta: ${nombres.size}`);
  const faltan = [];
  const noRecreables = [];
  for (const n of [...nombres].sort()) {
    const estado = enWaba.get(n);
    let marca;
    if (estado) marca = `ya está (${estado})`;
    else if (catalogo.has(n)) {
      marca = 'FALTA, se crearía';
      faltan.push(n);
    } else {
      marca = 'FALTA y no está en el catálogo (creada a mano: no se puede recrear)';
      noRecreables.push(n);
    }
    console.log(`  ${n.padEnd(36)} ${marca}   ← ${fuentes[n].join(', ')}`);
  }

  if (!aplicar) {
    console.log(
      `\nSe crearían ${faltan.length} plantilla(s)` +
        (noRecreables.length ? `; ${noRecreables.length} no recreable(s)` : '') +
        '. Corre con --aplicar para crearlas.',
    );
    process.exit(0);
  }

  console.log('\nCreando…');
  const r = await recrearPlantillasTrasReconexion(cfgId, {
    motivo: 'script',
    waba_anterior: null,
  });
  console.log(JSON.stringify({ ...r, fuentes: undefined }, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
