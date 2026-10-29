/* ¿Qué ficha le pega «Un asesor lo revisa…» a las respuestas de la IA en la 265?
   Solo lee. Una línea por día al final de /home/ubuntu/logs/ia265_pases_fichas.log
   (o a la pantalla con --ver). No avisa a nadie. Lo lee la automejora del bot.

   Para cada respuesta de la IA que pasa el caso (esPase), busca la ficha con
   `pasar_a` cuyo texto usó: trozos de 6 palabras de su respuesta o sus pasos
   que no estén en los textos fijos (los avisos de pase son de todos).
   «sin ficha» = el pase no salió del texto de ninguna ficha con `pasar_a`.

     node scripts/medir_pases_fichas_265.js                 (hoy, al log)
     node scripts/medir_pases_fichas_265.js --dia 2026-10-25 --ver
*/
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
process.chdir(RAIZ);
require('dotenv').config({ path: path.join(RAIZ, '.env') });
const { db } = require('../src/database/config');
const { esPase } = require('../src/utils/soporteExpertos/escalado');
const { sinTildes } = require('../src/utils/soporteExpertos/texto');
const { validarFichas, RUTA_FICHAS } = require('../src/utils/soporteExpertos/fichas');
const T = require('../src/utils/soporteExpertos/textos');

const CUENTA = 265;
const LOG = '/home/ubuntu/logs/ia265_pases_fichas.log';
const N = 6;

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const VER = process.argv.includes('--ver');

const pals = (s) => sinTildes(String(s || '')).toLowerCase().split(/[^a-z0-9ñ]+/).filter(Boolean);
const trozos = (s) => {
  const p = pals(s);
  const out = new Set();
  for (let i = 0; i + N <= p.length; i++) out.add(p.slice(i, i + N).join(' '));
  return out;
};
const textosDe = (v, acc = []) => {
  if (typeof v === 'string') acc.push(v);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) textosDe(x, acc);
  return acc;
};

(async () => {
  const Q = (s, r = []) => db.query(s, { replacements: r, type: db.QueryTypes.SELECT, logging: false });
  const dia = arg('--dia') || (await Q("SELECT DATE_FORMAT(NOW(),'%Y-%m-%d') d"))[0].d;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) throw new Error(`día inválido: ${dia}`);

  // Los textos fijos (avisos de pase, «Recibí…») no identifican a ninguna ficha.
  const fijos = textosDe(T).join('\n').replace(/apenas abramos/g, 'en breve');
  const comunes = new Set([...trozos(textosDe(T).join('\n')), ...trozos(fijos)]);

  const { fichas } = validarFichas(JSON.parse(fs.readFileSync(RUTA_FICHAS, 'utf8')));
  const conPase = fichas
    .filter((f) => f.pasar_a && f.respuesta_base && !f.junta_datos)
    .map((f) => ({ id: f.id, area: f.pasar_a, t: new Set([...trozos([f.respuesta_base, ...f.pasos].join('\n'))].filter((x) => !comunes.has(x))) }));

  const filas = await Q(
    `SELECT celular_recibe c, texto_mensaje t
       FROM mensajes_clientes
      WHERE id_configuracion = ? AND rol_mensaje = 1 AND responsable LIKE 'IA\\_%' AND responsable <> 'IA_respaldo'
        AND deleted_at IS NULL AND created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)`,
    [CUENTA, dia, dia],
  );

  let pases = 0;
  let deFicha = 0;
  const porFicha = {};
  for (const x of filas) {
    const t = String(x.t || '');
    if (!esPase(sinTildes(t).toLowerCase()) && !esPase(t)) continue;
    pases++;
    const mios = trozos(t);
    let mejor = null;
    for (const f of conPase) {
      let n = 0;
      for (const z of f.t) if (mios.has(z)) n++;
      if (n && (!mejor || n > mejor.n)) mejor = { f, n };
    }
    if (!mejor) continue;
    deFicha++;
    const o = (porFicha[mejor.f.id] ||= { area: mejor.f.area, turnos: 0, chats: new Set() });
    o.turnos++;
    o.chats.add(x.c);
  }

  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)} %` : '-');
  const top = Object.entries(porFicha)
    .sort((a, b) => b[1].chats.size - a[1].chats.size || b[1].turnos - a[1].turnos)
    .map(([id, o]) => `${id}×${o.chats.size}/${o.turnos}[${o.area}]`)
    .join(' · ');
  const linea =
    `${dia} | turnos IA ${filas.length} | con pase ${pases} | por ficha ${deFicha} (${pct(deFicha, pases)}) | ` +
    `sin ficha ${pases - deFicha} | fichas (chats/turnos): ${top || '-'}`;

  if (VER) console.log(linea);
  else fs.appendFileSync(LOG, `${linea}\n`);
  process.exit(0);
})().catch((e) => {
  const linea = `${new Date().toISOString()} | ERROR, no se pudo medir: ${e.message}`;
  if (VER) console.error(linea);
  else try { fs.appendFileSync(LOG, `${linea}\n`); } catch { console.error(linea); }
  process.exit(1);
});
