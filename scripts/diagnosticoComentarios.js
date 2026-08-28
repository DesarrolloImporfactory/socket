/**
 * Verifica toda la cadena que hace falta para que funcionen los comentarios
 * de Facebook, y dice exactamente dónde está rota.
 *
 * Uso:
 *   node scripts/diagnosticoComentarios.js            → todas las páginas
 *   node scripts/diagnosticoComentarios.js --cfg=10   → sólo una configuración
 *
 * Sólo lee: no escribe en la base ni cambia nada en Meta.
 *
 * La cadena tiene cuatro eslabones y basta que falle uno para no recibir nada:
 *
 *   1. La APP suscrita al campo `feed`  → App Dashboard > Webhooks > Page
 *   2. La PÁGINA suscrita al campo `feed` → scripts/suscribirFeedPaginas.js
 *   3. El page_access_token vivo
 *   4. Los permisos del token
 *
 * El 1 es el que más se olvida porque no da error en ningún lado: las páginas
 * quedan "suscritas" y Meta simplemente nunca manda el evento.
 */

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const { db } = require('../src/database/config');
const { inspeccionarToken } = require('../src/services/messenger_pages_health.service');

const FB_VERSION = process.env.GRAPH_VERSION || 'v22.0';
const APP_ID = process.env.FB_APP_ID;
const APP_SECRET = process.env.FB_APP_SECRET;

const cfgArg = process.argv.find((x) => x.startsWith('--cfg='));
const CFG = cfgArg ? Number(cfgArg.split('=')[1]) : null;

const si = (b) => (b ? '✅' : '❌');

function appsecretProof(token) {
  if (!APP_SECRET) return null;
  return crypto.createHmac('sha256', APP_SECRET).update(token).digest('hex');
}

/** Eslabón 1: ¿la app pidió el campo `feed` para object=page? */
async function feedEnLaApp() {
  const { data } = await axios.get(
    `https://graph.facebook.com/${FB_VERSION}/${APP_ID}/subscriptions`,
    { params: { access_token: `${APP_ID}|${APP_SECRET}` }, timeout: 15000 },
  );
  const page = (data.data || []).find((s) => s.object === 'page');
  if (!page) return { existe: false };
  const campos = (page.fields || []).map((f) =>
    typeof f === 'string' ? f : f.name,
  );
  return {
    existe: true,
    activo: page.active,
    callback_url: page.callback_url,
    campos,
    tieneFeed: campos.includes('feed'),
  };
}

/** Eslabón 2: ¿esta página está suscrita a `feed`? */
async function feedEnLaPagina(page_id, token) {
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
  const mia = (data?.data || []).find((a) => String(a.id) === String(APP_ID));
  return mia?.subscribed_fields || [];
}

(async () => {
  console.log('═'.repeat(72));
  console.log(' DIAGNÓSTICO DEL MÓDULO DE COMENTARIOS DE FACEBOOK');
  console.log('═'.repeat(72));

  // ── Eslabón 1 ──────────────────────────────────────────────────────────────
  console.log('\n1) SUSCRIPCIÓN DE LA APP (App Dashboard > Webhooks > Page)\n');
  let app;
  try {
    app = await feedEnLaApp();
  } catch (err) {
    console.error(
      '   ❌ No se pudo consultar:',
      err.response?.data?.error?.message || err.message,
    );
    process.exit(1);
  }

  if (!app.existe) {
    console.log('   ❌ La app no tiene ninguna suscripción para object=page.');
  } else {
    console.log(`   callback_url : ${app.callback_url}`);
    console.log(`   activo       : ${si(app.activo)}`);
    console.log(`   campos       : ${app.campos.sort().join(', ')}`);
    console.log(`   campo 'feed' : ${si(app.tieneFeed)}`);
  }

  if (!app.tieneFeed) {
    console.log('');
    console.log('   ⚠️  ESTE ES EL INTERRUPTOR MAESTRO Y ESTÁ APAGADO.');
    console.log('       Sin él, Meta NO manda comentarios por más que las');
    console.log('       páginas estén suscritas. Se activa en el App Dashboard');
    console.log("       (Webhooks > Page > marcar 'feed'). No requiere App Review.");
  }

  // ── Eslabones 2, 3 y 4, por página ─────────────────────────────────────────
  console.log('\n' + '─'.repeat(72));
  console.log('2) ESTADO DE CADA PÁGINA CONECTADA\n');

  const paginas = await db.query(
    `SELECT id_configuracion, page_id, page_name, page_access_token
       FROM messenger_pages
      WHERE status = 'active'
        ${CFG ? 'AND id_configuracion = ?' : ''}
      ORDER BY id_configuracion`,
    { replacements: CFG ? [CFG] : [], type: db.QueryTypes.SELECT },
  );

  if (!paginas.length) {
    console.log(
      CFG
        ? `   (no hay páginas activas en la configuración ${CFG})`
        : '   (no hay páginas activas)',
    );
  }

  const listas = [];

  for (const p of paginas) {
    console.log(`   cfg=${p.id_configuracion}  "${p.page_name}"  (${p.page_id})`);

    const insp = await inspeccionarToken(p.page_access_token);

    if (!insp.concluyente) {
      // Distinción importante: un timeout o un 500 de Meta NO es un token
      // muerto. Marcarlo como muerto fue justamente el error de la vez pasada.
      console.log(`     ⏳ indeterminado (Meta no respondió): ${insp.error}`);
      console.log('');
      continue;
    }

    if (!insp.valido) {
      console.log(`     ☠️  token muerto: ${insp.error}`);
      console.log('        → el cliente tiene que reconectar la página');
      console.log('');
      continue;
    }

    const scopes = insp.scopes || [];
    const tieneLeer = scopes.includes('pages_read_engagement');
    const tieneResponder = scopes.includes('pages_manage_engagement');
    const tieneDM = scopes.includes('pages_messaging');

    let camposPagina = null;
    try {
      camposPagina = await feedEnLaPagina(p.page_id, p.page_access_token);
    } catch (err) {
      camposPagina = null;
      console.log(
        `     ⚠️  no se pudo leer la suscripción de la página: ` +
          `${err.response?.data?.error?.message?.split('\n')[0] || err.message}`,
      );
    }

    const suscritaFeed = camposPagina ? camposPagina.includes('feed') : false;
    const recibe = Boolean(app.tieneFeed && suscritaFeed);

    console.log(`     token vivo                    ${si(true)}`);
    console.log(`     página suscrita a 'feed'      ${si(suscritaFeed)}`);
    console.log(`     ── qué puede hacer hoy ──`);
    console.log(`     recibir comentarios           ${si(recibe)}`);
    console.log(`     saber quién comentó           ${si(tieneLeer)}   (pages_read_engagement)`);
    console.log(`     responder en público          ${si(tieneResponder)}   (pages_manage_engagement)`);
    console.log(`     responder en privado (DM)     ${si(tieneDM)}   (pages_messaging)`);
    console.log('');

    if (recibe && tieneLeer) listas.push(`cfg=${p.id_configuracion} "${p.page_name}"`);
  }

  // ── Veredicto ──────────────────────────────────────────────────────────────
  console.log('─'.repeat(72));
  console.log('3) VEREDICTO\n');

  if (!app.tieneFeed) {
    console.log("   Falta activar 'feed' en el App Dashboard. Hasta que eso pase,");
    console.log('   ninguna página puede recibir comentarios.');
  } else if (!listas.length) {
    console.log('   Ninguna página está lista todavía.');
  } else {
    console.log(`   ${listas.length} página(s) listas para recibir comentarios:`);
    for (const l of listas) console.log(`     • ${l}`);
  }

  await db.close();
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
