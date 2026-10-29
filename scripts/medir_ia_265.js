/* ¿Cuánto resuelve sola la IA en la línea 265 (Expertos)? Meta de Daniel: 70 %.
   Solo lee. Una línea por día al final de /home/ubuntu/logs/ia265_resuelve.log
   (o a la pantalla con --ver). No avisa a nadie.

   Caso = chat (celular_recibe) × día con al menos un mensaje real del cliente
   (no «ok/gracias», no avisos automáticos de tiendas o de Meta).
   IA sola = la IA contestó, no pasó el caso (ni nota de escala ni texto de pase)
   y ninguna persona escribió ese día.

     node scripts/medir_ia_265.js                 (hoy, al log)
     node scripts/medir_ia_265.js --dia 2026-10-26 --ver
*/
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
process.chdir(RAIZ);
require('dotenv').config({ path: path.join(RAIZ, '.env') });
const { db } = require('../src/database/config');
const { esPase } = require('../src/utils/soporteExpertos/escalado');
const { esMensajeDeBot } = require('../src/utils/soporteExpertos/senales');

const CUENTA = 265;
const LOG = '/home/ubuntu/logs/ia265_resuelve.log';
const AUTOMATICOS = new Set(['Sistema de valoraciones', 'cron_template_programado', 'Automatizador | Cotizador Pro', 'Soporte Importaciones', 'Encuesta Webhook']);
const ACUSE = /^(ok+|okey|okay|gracias|muchas gracias|listo|ya|si|sí|perfecto|dale|bueno|vale|de acuerdo|👍|🙏|ok gracias)[\s.!🙏👍]*$/i;

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const VER = process.argv.includes('--ver');

(async () => {
  const Q = (s, r = []) => db.query(s, { replacements: r, type: db.QueryTypes.SELECT, logging: false });
  const dia = arg('--dia') || (await Q("SELECT DATE_FORMAT(NOW(),'%Y-%m-%d') d"))[0].d;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) throw new Error(`día inválido: ${dia}`);

  const filas = await Q(
    `SELECT celular_recibe c, rol_mensaje r, responsable p, texto_mensaje t, tipo_mensaje tm
       FROM mensajes_clientes
      WHERE id_configuracion = ? AND deleted_at IS NULL AND created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)`,
    [CUENTA, dia, dia],
  );

  const casos = {};
  for (const x of filas) {
    const o = (casos[x.c] ||= { real: 0, ia: 0, pase: 0, esc: 0, hum: 0, fallo: 0 });
    const p = x.p || '';
    const t = String(x.t || '').trim();
    if (+x.r === 0) {
      if (x.tm === 'text' && (ACUSE.test(t) || esMensajeDeBot(t))) continue;
      o.real++;
    } else if (+x.r === 1) {
      if (p === 'IA_respaldo') o.fallo++;
      else if (p.startsWith('IA_')) { o.ia++; if (esPase(t)) o.pase++; }
      else if (!AUTOMATICOS.has(p)) o.hum++;
    } else if (+x.r === 3) {
      if (p === 'IA_Escalado Expertos') o.esc++;
      if (p === 'sistema_ia') o.fallo++;
    }
  }

  const n = { casos: 0, ia_sola: 0, ia_paso: 0, ia_y_persona: 0, solo_persona: 0, fallo: 0, nadie: 0 };
  for (const o of Object.values(casos)) {
    if (!o.real) continue;
    n.casos++;
    if (o.ia && !o.pase && !o.esc && !o.hum) n.ia_sola++;
    else if (o.ia && (o.pase || o.esc)) n.ia_paso++;
    else if (o.ia && o.hum) n.ia_y_persona++;
    else if (o.hum) n.solo_persona++;
    else if (o.fallo) n.fallo++;
    else n.nadie++;
  }
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)} %` : '-');
  const contesto = n.ia_sola + n.ia_paso + n.ia_y_persona;
  const linea =
    `${dia} | casos ${n.casos} | IA sola ${n.ia_sola} (${pct(n.ia_sola, n.casos)}; meta 70 %) | ` +
    `IA y pasó ${n.ia_paso} | IA + persona ${n.ia_y_persona} | solo persona ${n.solo_persona} | ` +
    `fallo ${n.fallo} | nadie ${n.nadie} | la IA contestó en ${pct(contesto, n.casos)}`;

  if (VER) console.log(linea);
  else fs.appendFileSync(LOG, `${linea}\n`);
  process.exit(0);
})().catch((e) => {
  const linea = `${new Date().toISOString()} | ERROR, no se pudo medir: ${e.message}`;
  if (VER) console.error(linea);
  else try { fs.appendFileSync(LOG, `${linea}\n`); } catch { console.error(linea); }
  process.exit(1);
});
