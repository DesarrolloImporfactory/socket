/* Objeción de precio: qué contesta el bot a la PRIMERA objeción ("está caro",
   "lo pienso", "sale de mi presupuesto"…) y qué pasó después. También mide
   "¿solo eso tienen?" (decepción con el surtido) y "¿hay descuento?".
   Uso: node scripts/analisis_bot/objecion.js mx|ec [dias=7] */
require('dotenv').config();
const { db } = require('../../src/database/config');
const { normalizar } = require('../../src/utils/productoNombrado');
const pais = process.argv[2]; const dias = Number(process.argv[3] || 7);
const CIERRE = new Set(['generar_guia','guia_generada','guia_creada','en_transito','entregada','retiro_agencia','novedad','devolucion']);
const RE_OBJ = /\b(caro|cara|carisimo|carisima|muy alto|mucho dinero|mucha plata|no me alcanza|presupuesto|no tengo (dinero|plata|para)|mas barato|mas economico|lo pienso|lo voy a pensar|dejame pensar|deja lo pienso|lo checo|lo consulto|le comento a mi|lo platico|lo hablo con|no por ahora|quiza despues|quizas despues|tal vez despues|mas adelante|otro dia|en la quincena|cuando cobre|cuando me paguen)\b/;
const RE_DESC = /\b(descuento|rebaja|rebajita|promocion|oferta|mas barato|menos)\b.*\?|\b(hay|tienen|me hace|me da|me deja)\b.*\b(descuento|rebaja|rebajita|mas barato|en menos)\b/;
const RE_SOLO_ESO = /\b(solo eso tienen|apenas tienen|nada mas tienen|eso nomas tienen|solo tienen eso|no tienen (mas|otra cosa|otro|otros|otras)|es lo unico que tienen)\b/;
const norm = normalizar; const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
function cel(obj, k, cerrado, resp) { const o = obj[k] || (obj[k] = { n: 0, cerr: 0, volvio: 0 }); o.n++; if (cerrado) o.cerr++; if (resp) o.volvio++; }
function fmt(obj) { const out = {}; for (const [k, v] of Object.entries(obj).sort((a, b) => b[1].n - a[1].n)) out[k] = `${v.n} · volvió ${pct(v.volvio, v.n)}% · cerró ${pct(v.cerr, v.n)}%`; return out; }
function tipoRespuesta(t) {
  const n = norm(t);
  if (!n) return 'sin_respuesta_ia';
  if (/asesor|te paso con|compan[e]r[ao]/.test(n)) return 'pasa_a_asesor';
  if (/descuento|rebaja|te lo dejo en|precio especial/.test(n)) return 'ofrece_descuento';
  if (/a que ciudad|desde que ciudad|en que ciudad/.test(n)) return 'repite_ciudad';
  if (/cuantas unidades|cuantos quieres|prefieres 1|te llevas 1|1 o aprovech|quieres 1/.test(n)) return 'pregunta_cantidad';
  if (/^(entiendo|perfecto|claro|de acuerdo|ok|comprendo|esta bien|tranquil)/.test(n) && /gracias|cuando quieras|cuando estes list|cambias de (opinion|idea)|aqui estare|quedo atent|me avisas|avisame|buen dia|que tengas/.test(n)) return 'se_despide';
  if (/pagas al recibir|contra ?entrega|envio gratis|garantia|calidad|dura|resiste|te sirve|beneficio|ahorr|combo|unidad sale|cada uno queda/.test(n)) return 'argumenta_valor';
  if (/\?/.test(t)) return 'otra_pregunta';
  return 'otro';
}
(async () => {
  const cfgs = await db.query(`SELECT c.id FROM configuraciones c WHERE LOWER(c.pais)=? AND c.suspendido=0 AND EXISTS (SELECT 1 FROM kanban_columnas k WHERE k.id_configuracion=c.id AND k.activa_ia=1 AND k.activo=1)`, { replacements: [pais], type: db.QueryTypes.SELECT });
  const desde = new Date(Date.now() - (dias + 1) * 864e5); desde.setHours(0, 0, 0, 0);
  const hasta = new Date(); hasta.setHours(0, 0, 0, 0);
  const R = { chats_ia: 0, obj: { chats: 0, cerr: 0, volvio: 0 }, tipo: {}, tipo_x_dio_precio_antes: {}, desc: { chats: 0, cerr: 0 }, tipo_desc: {}, solo_eso: { chats: 0, cerr: 0 }, tipo_solo_eso: {}, ej: {}, ej_solo_eso: [] };
  for (const { id: cfg } of cfgs) {
    const clientes = await db.query(`SELECT id, estado_contacto FROM clientes_chat_center WHERE id_configuracion=? AND deleted_at IS NULL AND created_at >= ? AND created_at < ?`, { replacements: [cfg, desde, hasta], type: db.QueryTypes.SELECT });
    if (!clientes.length) continue;
    const msgs = await db.query(`SELECT celular_recibe cli, rol_mensaje r, responsable resp, tipo_mensaje tipo, LEFT(texto_mensaje,300) t, created_at ts FROM mensajes_clientes WHERE id_configuracion=? AND rol_mensaje IN (0,1) AND deleted_at IS NULL AND created_at >= ? ORDER BY id`, { replacements: [cfg, desde], type: db.QueryTypes.SELECT });
    const porCli = new Map(); for (const m of msgs) { const a = porCli.get(m.cli); if (a) a.push(m); else porCli.set(m.cli, [m]); }
    for (const c of clientes) {
      const ms = porCli.get(c.id); if (!ms) continue;
      const esIA = (m) => m.r === 1 && /^IA_/.test(m.resp || '');
      if (!ms.some(esIA)) continue;
      R.chats_ia++;
      const cerrado = CIERRE.has(c.estado_contacto);
      const sigBot = (i) => { for (let j = i + 1; j < ms.length && j <= i + 6; j++) { if (ms[j].r === 0) return null; if (esIA(ms[j]) && ms[j].t) return ms[j]; } return null; };
      const iO = ms.findIndex((m) => m.r === 0 && m.t && RE_OBJ.test(norm(m.t)));
      if (iO >= 0) {
        R.obj.chats++; if (cerrado) R.obj.cerr++;
        const volvio = ms.slice(iO + 1).some((m, k) => m.r === 0 && ms.slice(iO + 1, iO + 1 + k).some(esIA));
        if (volvio) R.obj.volvio++;
        const nb = sigBot(iO); const tipo = tipoRespuesta(nb?.t || '');
        cel(R.tipo, tipo, cerrado, volvio);
        const dioPrecioAntes = ms.slice(0, iO).some((m) => m.r === 1 && /\$\s?\d|\d+[.,]\d\d\b|cuesta/i.test(m.t || ''));
        cel(R.tipo_x_dio_precio_antes, `${dioPrecioAntes ? 'con_precio_dado' : 'sin_precio_dado'}`, cerrado, volvio);
        (R.ej[tipo] = R.ej[tipo] || []); if (R.ej[tipo].length < 5) R.ej[tipo].push(`[${cfg}] C: ${ms[iO].t.slice(0, 70)} → B: ${(nb?.t || '(sin respuesta IA)').replace(/\n/g, ' | ').slice(0, 150)}`);
      }
      const iD = ms.findIndex((m) => m.r === 0 && m.t && RE_DESC.test(norm(m.t)));
      if (iD >= 0) { R.desc.chats++; if (cerrado) R.desc.cerr++; const nb = sigBot(iD); cel(R.tipo_desc, tipoRespuesta(nb?.t || ''), cerrado, ms.slice(iD + 1).some((m) => m.r === 0)); }
      const iS = ms.findIndex((m) => m.r === 0 && m.t && RE_SOLO_ESO.test(norm(m.t)));
      if (iS >= 0) { R.solo_eso.chats++; if (cerrado) R.solo_eso.cerr++; const nb = sigBot(iS); cel(R.tipo_solo_eso, tipoRespuesta(nb?.t || ''), cerrado, ms.slice(iS + 1).some((m) => m.r === 0)); if (R.ej_solo_eso.length < 8) R.ej_solo_eso.push(`[${cfg}] C: ${ms[iS].t.slice(0, 70)} → B: ${(nb?.t || '').replace(/\n/g, ' | ').slice(0, 140)}`); }
    }
  }
  console.log(JSON.stringify({ pais, dias, chats_ia: R.chats_ia,
    objecion_precio: { ...R.obj, pct_volvio: pct(R.obj.volvio, R.obj.chats), pct_cierre: pct(R.obj.cerr, R.obj.chats) },
    respuesta_del_bot: fmt(R.tipo), ya_tenia_precio: fmt(R.tipo_x_dio_precio_antes),
    pide_descuento: { ...R.desc, pct_cierre: pct(R.desc.cerr, R.desc.chats), respuesta: fmt(R.tipo_desc) },
    solo_eso_tienen: { ...R.solo_eso, respuesta: fmt(R.tipo_solo_eso), ej: R.ej_solo_eso },
    ejemplos: R.ej }, null, 1));
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
