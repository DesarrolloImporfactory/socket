/* Efectividad de cada mensaje de remarketing (cron) en chats atendidos por IA:
   ¿el cliente contestó dentro de las 24 h siguientes? ¿cerró? Agrupado por el
   arranque del texto. Uso: node remk.js mx|ec [dias=7] */

require('dotenv').config();
const { db } = require('../../src/database/config.js');
const { normalizar } = require('../../src/utils/productoNombrado.js');
const pais = process.argv[2]; const dias = Number(process.argv[3] || 7);
const CIERRE = new Set(['generar_guia','guia_generada','guia_creada','en_transito','entregada','retiro_agencia','novedad','devolucion']);
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
(async () => {
  const cfgs = await db.query(`SELECT c.id FROM configuraciones c WHERE LOWER(c.pais)=? AND c.suspendido=0 AND EXISTS (SELECT 1 FROM kanban_columnas k WHERE k.id_configuracion=c.id AND k.activa_ia=1 AND k.activo=1)`, { replacements: [pais], type: db.QueryTypes.SELECT });
  const desde = new Date(Date.now() - (dias + 1) * 864e5); desde.setHours(0, 0, 0, 0);
  const hasta = new Date(); hasta.setHours(0, 0, 0, 0);
  const grupos = new Map(); // clave → {n, resp24, cerr, secuencia}
  const porOrden = {}; // 1er, 2do, 3er mensaje de cron del chat
  let chats = 0, chatsConCron = 0, chatsRespTrasCron = 0;
  for (const { id: cfg } of cfgs) {
    const clientes = await db.query(`SELECT id, estado_contacto FROM clientes_chat_center WHERE id_configuracion=? AND deleted_at IS NULL AND created_at >= ? AND created_at < ?`, { replacements: [cfg, desde, hasta], type: db.QueryTypes.SELECT });
    if (!clientes.length) continue;
    const msgs = await db.query(`SELECT celular_recibe cli, rol_mensaje r, responsable resp, tipo_mensaje tipo, LEFT(texto_mensaje,120) t, created_at ts FROM mensajes_clientes WHERE id_configuracion=? AND rol_mensaje IN (0,1) AND deleted_at IS NULL AND created_at >= ? ORDER BY id`, { replacements: [cfg, desde], type: db.QueryTypes.SELECT });
    const porCli = new Map(); for (const m of msgs) { const a = porCli.get(m.cli); if (a) a.push(m); else porCli.set(m.cli, [m]); }
    for (const c of clientes) {
      const ms = porCli.get(c.id); if (!ms) continue;
      if (!ms.some((m) => m.r === 1 && /^IA_/.test(m.resp || ''))) continue;
      chats++;
      const cerrado = CIERRE.has(c.estado_contacto);
      let orden = 0, algunaResp = false;
      for (let i = 0; i < ms.length; i++) {
        const m = ms[i];
        if (!(m.r === 1 && /^cron/.test(m.resp || ''))) continue;
        orden++;
        const ts = new Date(m.ts).getTime();
        const resp24 = ms.slice(i + 1).some((x) => x.r === 0 && new Date(x.ts).getTime() - ts <= 864e5);
        if (resp24) algunaResp = true;
        const clave = `${m.resp === 'cron_remarketing_rr' ? 'FIJO' : m.resp === 'cron_remarketing_ia' ? 'IA' : m.resp}: ${normalizar(m.t || '').slice(0, 42) || `(${m.tipo})`}`;
        const g = grupos.get(clave) || { n: 0, resp24: 0, cerr: 0 }; g.n++; if (resp24) g.resp24++; if (cerrado) g.cerr++; grupos.set(clave, g);
        const o = porOrden[orden] || (porOrden[orden] = { n: 0, resp24: 0 }); o.n++; if (resp24) o.resp24++;
      }
      if (orden) { chatsConCron++; if (algunaResp) chatsRespTrasCron++; }
    }
  }
  const filas = [...grupos.entries()].filter(([, g]) => g.n >= 40).sort((a, b) => b[1].n - a[1].n).map(([k, g]) => `${String(g.n).padStart(6)}  resp24h ${String(pct(g.resp24, g.n)).padStart(5)}%  cerró ${String(pct(g.cerr, g.n)).padStart(5)}%  | ${k}`);
  console.log({ pais, chats_ia: chats, chats_con_remarketing: chatsConCron, pct_chats_que_respondieron_a_algun_remarketing: pct(chatsRespTrasCron, chatsConCron) });
  console.log('por orden del mensaje:', Object.fromEntries(Object.entries(porOrden).map(([k, v]) => [k, `${v.n} · resp24h ${pct(v.resp24, v.n)}%`])));
  console.log(filas.join('\n'));
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
