/**
 * Añade el campo `feed` a la suscripción de webhooks de las páginas ya conectadas.
 *
 * Las páginas que se conectaron antes del módulo de comentarios quedaron
 * suscritas sólo a los campos de mensajería, así que Meta nunca manda
 * entry.changes[] con los comentarios. Este script las pone al día; las páginas
 * nuevas ya salen bien desde messenger_connect.service.js.
 *
 * Uso:
 *   node scripts/suscribirFeedPaginas.js            → solo mira, no toca nada
 *   node scripts/suscribirFeedPaginas.js --aplicar  → suscribe de verdad
 *   node scripts/suscribirFeedPaginas.js --cfg=285  → solo una configuración
 *
 * Por defecto NO escribe en Meta: primero conviene ver a cuáles les falta.
 *
 * Ojo: suscribirse al campo es sólo la mitad. Para que el comentario traiga
 * `from` (quién comentó) el token necesita pages_read_engagement, y para poder
 * responder, pages_manage_engagement. Un token sin esos permisos recibirá los
 * webhooks igual, pero anónimos e incontestables: eso lo diagnostica
 * `node scripts/verificarPaginasMessenger.js`.
 */

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const { db } = require('../src/database/config');

const FB_VERSION = process.env.GRAPH_VERSION || 'v22.0';
const CAMPOS = [
  'messages',
  'messaging_postbacks',
  'message_deliveries',
  'message_reads',
  'message_echoes',
  'feed',
];

const args = process.argv.slice(2);
const aplicar = args.includes('--aplicar');
const cfgArg = args.find((x) => x.startsWith('--cfg='));
const cfg = cfgArg ? Number(cfgArg.split('=')[1]) : null;

function appsecretProof(token) {
  const secret = process.env.FB_APP_SECRET;
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(token).digest('hex');
}

async function camposActuales(page_id, token) {
  const proof = appsecretProof(token);
  const { data } = await axios.get(
    `https://graph.facebook.com/${FB_VERSION}/${page_id}/subscribed_apps`,
    {
      params: {
        access_token: token,
        ...(proof ? { appsecret_proof: proof } : {}),
      },
      timeout: 15000,
    },
  );
  // Puede haber varias apps suscritas; sólo interesa la nuestra.
  const mia = (data?.data || []).find(
    (a) => String(a.id) === String(process.env.FB_APP_ID),
  );
  return mia?.subscribed_fields || [];
}

async function suscribir(page_id, token) {
  const proof = appsecretProof(token);
  const { data } = await axios.post(
    `https://graph.facebook.com/${FB_VERSION}/${page_id}/subscribed_apps`,
    {},
    {
      params: {
        access_token: token,
        subscribed_fields: CAMPOS.join(','),
        ...(proof ? { appsecret_proof: proof } : {}),
      },
      timeout: 15000,
    },
  );
  return data;
}

(async () => {
  console.log(
    `Modo: ${aplicar ? 'APLICA la suscripción en Meta' : 'solo lectura (no escribe nada)'}`,
  );
  if (cfg) console.log(`Filtrado a id_configuracion=${cfg}`);
  console.log('');

  const paginas = await db.query(
    `SELECT id_configuracion, page_id, page_name, page_access_token, token_valido
       FROM messenger_pages
      WHERE status = 'active'
        ${cfg ? 'AND id_configuracion = ?' : ''}
      ORDER BY id_configuracion`,
    {
      replacements: cfg ? [cfg] : [],
      type: db.QueryTypes.SELECT,
    },
  );

  let yaTenian = 0;
  let actualizadas = 0;
  let fallaron = 0;
  const pendientes = [];

  for (const p of paginas) {
    const etiqueta = `cfg=${p.id_configuracion} "${p.page_name}" (${p.page_id})`;
    try {
      const campos = await camposActuales(p.page_id, p.page_access_token);
      if (campos.includes('feed')) {
        yaTenian++;
        console.log(`✅ ${etiqueta} → ya tiene 'feed'`);
        continue;
      }

      if (!aplicar) {
        pendientes.push(etiqueta);
        console.log(`○  ${etiqueta} → le falta 'feed'`);
        continue;
      }

      await suscribir(p.page_id, p.page_access_token);
      const despues = await camposActuales(p.page_id, p.page_access_token);
      if (despues.includes('feed')) {
        actualizadas++;
        console.log(`🆕 ${etiqueta} → suscrita a 'feed'`);
      } else {
        fallaron++;
        console.warn(
          `⚠️  ${etiqueta} → Meta aceptó la llamada pero 'feed' no quedó. ` +
            `Suele ser falta de permisos en el token.`,
        );
      }
    } catch (err) {
      fallaron++;
      const detalle = err.response?.data?.error?.message || err.message;
      console.error(`❌ ${etiqueta} → ${detalle}`);
      if (p.token_valido === 0) {
        console.error('   (esta página ya estaba marcada con el token muerto)');
      }
    }
  }

  console.log('');
  console.log('─'.repeat(60));
  console.log(`Total revisadas:   ${paginas.length}`);
  console.log(`Ya tenían 'feed':  ${yaTenian}`);
  if (aplicar) console.log(`Suscritas ahora:   ${actualizadas}`);
  else console.log(`Les falta 'feed':  ${pendientes.length}`);
  console.log(`Con error:         ${fallaron}`);

  if (!aplicar && pendientes.length) {
    console.log('');
    console.log('Para aplicarlo: node scripts/suscribirFeedPaginas.js --aplicar');
  }

  await db.close();
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
