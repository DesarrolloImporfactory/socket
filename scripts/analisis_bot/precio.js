/* H9: la respuesta del bot a la PRIMERA pregunta de precio del cliente y su
   relación con cerrar. Misma carga acotada que panorama.js.
   Uso: node precio.js mx|ec [dias=7] [solo_modelo] */

require('dotenv').config();
const { db } = require('../../src/database/config.js');
const { normalizar } = require('../../src/utils/productoNombrado.js');
const pais = process.argv[2]; const dias = Number(process.argv[3] || 7); const SOLO_MODELO = process.argv[4] === 'solo_modelo';
const CIERRE = new Set(['generar_guia','guia_generada','guia_creada','en_transito','entregada','retiro_agencia','novedad','devolucion']);
const RE_PRECIO = /\b(precio|presio|cuanto (cuesta|vale|sale|es)|costo|cuanto\b|valor|q precio|que precio|precios)\b/;
const RE_DIO_PRECIO = /\$\s?\d|\d+[.,]\d\d(?!\d)|\bcuesta\b|\bvale\b|\d+ (pesos|dolares|usd|mxn)/i;
const norm = normalizar; const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
function cel(obj, k, cerrado, resp) { const o = obj[k] || (obj[k] = { n: 0, cerr: 0, volvio: 0 }); o.n++; if (cerrado) o.cerr++; if (resp) o.volvio++; }
function fmt(obj) { const out = {}; for (const [k, v] of Object.entries(obj).sort((a, b) => b[1].n - a[1].n)) out[k] = `${v.n} · volvió ${pct(v.volvio, v.n)}% · cerró ${pct(v.cerr, v.n)}%`; return out; }

(async () => {
  const cfgs = await db.query(`SELECT c.id FROM configuraciones c WHERE LOWER(c.pais)=? AND c.suspendido=0 AND EXISTS (SELECT 1 FROM kanban_columnas k WHERE k.id_configuracion=c.id AND k.activa_ia=1 AND k.activo=1)`, { replacements: [pais], type: db.QueryTypes.SELECT });
  const desde = new Date(Date.now() - (dias + 1) * 864e5); desde.setHours(0, 0, 0, 0);
  const hasta = new Date(); hasta.setHours(0, 0, 0, 0);
  const R = { chats_ia: 0, con_pregunta_precio: 0, cerr_con_pregunta: 0, sin_pregunta_precio: 0, cerr_sin_pregunta: 0,
    quien: {}, dio_precio: {}, cruce: {}, por_cuenta: {}, ab: {}, ab_detalle: {}, latencia: {}, foto: {}, video: {}, combos: {}, pregunta_final: {}, largo: {}, momento: {}, respondio_antes: {},
    remk_despues: { n: 0, volvio: 0, cerr: 0 }, remk_texto: new Map(), remk_horas: {}, sin_respuesta_ia: 0, ej_sin_volver: [], ej_cerraron: [] };
  for (const { id: cfg } of cfgs) {
    const clientes = await db.query(`SELECT id, estado_contacto FROM clientes_chat_center WHERE id_configuracion=? AND deleted_at IS NULL AND created_at >= ? AND created_at < ?`, { replacements: [cfg, desde, hasta], type: db.QueryTypes.SELECT });
    if (!clientes.length) continue;
    const msgs = await db.query(`SELECT celular_recibe cli, rol_mensaje r, responsable resp, tipo_mensaje tipo, LEFT(texto_mensaje,260) t, created_at ts FROM mensajes_clientes WHERE id_configuracion=? AND rol_mensaje IN (0,1) AND deleted_at IS NULL AND created_at >= ? ORDER BY id`, { replacements: [cfg, desde], type: db.QueryTypes.SELECT });
    const porCli = new Map(); for (const m of msgs) { const a = porCli.get(m.cli); if (a) a.push(m); else porCli.set(m.cli, [m]); }
    for (const c of clientes) {
      const ms = porCli.get(c.id); if (!ms) continue;
      const esIA = (m) => m.r === 1 && /^IA_/.test(m.resp || '');
      const esCron = (m) => m.r === 1 && /^cron/.test(m.resp || '');
      if (!ms.some(esIA)) continue;
      R.chats_ia++;
      const cerrado = CIERRE.has(c.estado_contacto);
      const iP = ms.findIndex((m) => m.r === 0 && m.t && RE_PRECIO.test(norm(m.t)));
      if (iP < 0) { R.sin_pregunta_precio++; if (cerrado) R.cerr_sin_pregunta++; continue; }
      R.con_pregunta_precio++; if (cerrado) R.cerr_con_pregunta++;
      let iB = -1; for (let j = iP + 1; j < ms.length; j++) { if (ms[j].r === 0) break; if (esIA(ms[j]) && ms[j].t) { iB = j; break; } }
      if (iB < 0) { R.sin_respuesta_ia++; continue; }
      const b = ms[iB]; const nb = norm(b.t);
      if (SOLO_MODELO && !/^IA_Contacto/i.test(b.resp || '')) continue;
      const volvio = ms.slice(iB + 1).some((m) => m.r === 0);
      const tsB = new Date(b.ts).getTime(); const tsP = new Date(ms[iP].ts).getTime();
      const lat = (tsB - tsP) / 1000;
      const latK = lat <= 15 ? '≤15s' : lat <= 60 ? '16-60s' : lat <= 300 ? '1-5min' : lat <= 1800 ? '5-30min' : '>30min';
      const cerca = ms.slice(Math.max(0, iB - 4), iB + 5);
      const hayFoto = cerca.some((x) => x.r === 1 && x.tipo === 'image' && Math.abs(new Date(x.ts).getTime() - tsB) <= 20000);
      const hayVideo = cerca.some((x) => x.r === 1 && x.tipo === 'video' && Math.abs(new Date(x.ts).getTime() - tsB) <= 20000);
      const combos = /combo|2 por|2 unidades|x2|2x/.test(nb);
      const dioPrecio = RE_DIO_PRECIO.test(b.t || '');
      let iU = iB; for (let j = iB + 1; j < ms.length && j <= iB + 4; j++) { if (ms[j].r === 0) break; if (esIA(ms[j]) && ms[j].t) iU = j; }
      const nu = norm(ms[iU].t);
      const preg = /ciudad/.test(nu) ? 'ciudad' : /cuantas unidades|cuantos|1 o aprovech|prefieres 1|te llevas 1|unidad o|1 2 o 3|una o dos/.test(nu) ? 'cantidad' : /color|talla|modelo|variedad/.test(nu) ? 'variedad' : /nombre completo|direccion|telefono/.test(nu) ? 'datos' : /\?/.test(ms[iU].t) ? 'otra_pregunta' : 'sin_pregunta';
      const largo = nb.length <= 120 ? 'corto(≤120)' : nb.length <= 250 ? 'medio(121-250)' : 'largo(>250)';
      const primerCli = ms.findIndex((m) => m.r === 0 && m.tipo !== 'referral' && m.t);
      const momento = iP === primerCli ? 'primer_mensaje_escrito' : 'despues';
      const yaHabiaRespondido = ms.slice(0, iP).some((m) => m.r === 0 && m.tipo !== 'referral' && m.t);
      cel(R.quien, b.resp, cerrado, volvio);
      cel(R.dio_precio, dioPrecio ? 'dio_precio' : 'NO_dio_precio', cerrado, volvio);
      cel(R.cruce, `${dioPrecio ? 'precio' : 'SIN_precio'}+${combos ? 'combos' : 'sin_combos'}+${preg}`, cerrado, volvio);
      const pc = R.por_cuenta[cfg] || (R.por_cuenta[cfg] = {}); cel(pc, `${dioPrecio ? 'precio' : 'SIN_precio'}+${combos ? 'combos' : 'sin_combos'}`, cerrado, volvio);
      /* A/B de México (kanban_ia AB_PRECIO_MX): brazo B = id de cliente par.
         Se registra siempre; en EC sirve de control (ahí no hay experimento). */
      const brazo = Number(c.id) % 2 === 0 ? 'B_par' : 'A_impar';
      cel(R.ab, brazo, cerrado, volvio);
      cel(R.ab_detalle, `${brazo}+${combos ? 'combos' : 'sin_combos'}+${preg}`, cerrado, volvio);
      cel(R.latencia, latK, cerrado, volvio); cel(R.foto, hayFoto ? 'con_foto' : 'sin_foto', cerrado, volvio);
      cel(R.video, hayVideo ? 'con_video' : 'sin_video', cerrado, volvio); cel(R.combos, combos ? 'menciona_combos' : 'sin_combos', cerrado, volvio);
      cel(R.pregunta_final, preg, cerrado, volvio); cel(R.largo, largo, cerrado, volvio); cel(R.momento, momento, cerrado, volvio);
      cel(R.respondio_antes, yaHabiaRespondido ? 'ya_habia_escrito_antes' : 'precio_fue_su_primer_texto', cerrado, volvio);
      if (!volvio) {
        const rm = ms.slice(iU + 1).find(esCron);
        if (rm) { R.remk_despues.n++; const h = (new Date(rm.ts).getTime() - tsB) / 36e5; const hk = h <= 1 ? '≤1h' : h <= 4 ? '1-4h' : h <= 24 ? '4-24h' : '>24h'; R.remk_horas[hk] = (R.remk_horas[hk] || 0) + 1; inc(R.remk_texto, norm(rm.t || '').slice(0, 55)); const k = ms.indexOf(rm); if (ms.slice(k + 1).some((m) => m.r === 0)) R.remk_despues.volvio++; if (cerrado) R.remk_despues.cerr++; }
        if (R.ej_sin_volver.length < 12) R.ej_sin_volver.push(`[${cfg}] C: ${ms[iP].t.slice(0, 50)} → B(${b.resp}, ${Math.round(lat)}s): ${b.t.replace(/\n/g, ' | ').slice(0, 170)}`);
      } else if (cerrado && R.ej_cerraron.length < 8) R.ej_cerraron.push(`[${cfg}] C: ${ms[iP].t.slice(0, 50)} → B(${b.resp}, ${Math.round(lat)}s): ${b.t.replace(/\n/g, ' | ').slice(0, 170)}`);
    }
  }
  const out = { pais, solo_modelo: SOLO_MODELO, chats_ia: R.chats_ia, con_pregunta_precio: `${R.con_pregunta_precio} (cierre ${pct(R.cerr_con_pregunta, R.con_pregunta_precio)}%)`, sin_pregunta_precio: `${R.sin_pregunta_precio} (cierre ${pct(R.cerr_sin_pregunta, R.sin_pregunta_precio)}%)`, sin_respuesta_ia: R.sin_respuesta_ia,
    quien: fmt(R.quien), dio_precio: fmt(R.dio_precio), cruce: fmt(R.cruce), ab: fmt(R.ab), ab_detalle: fmt(R.ab_detalle),
    por_cuenta: Object.fromEntries(Object.entries(R.por_cuenta).filter(([, v]) => Object.values(v).reduce((a, o) => a + o.n, 0) >= 80).map(([k, v]) => [k, fmt(v)])),
    latencia: fmt(R.latencia), foto: fmt(R.foto), video: fmt(R.video), combos: fmt(R.combos), pregunta_final: fmt(R.pregunta_final), largo: fmt(R.largo), momento: fmt(R.momento), respondio_antes: fmt(R.respondio_antes),
    remarketing_tras_precio_sin_volver: { ...R.remk_despues, pct_volvio: pct(R.remk_despues.volvio, R.remk_despues.n), horas: R.remk_horas, textos: top(R.remk_texto, 12) }, ej_sin_volver: R.ej_sin_volver, ej_cerraron: R.ej_cerraron };
  console.log(JSON.stringify(out, null, 1));
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
