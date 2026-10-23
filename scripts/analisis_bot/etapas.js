/* Hasta qué etapa llegó cada conversación que respondió al bot, y dónde se
   cae: precio dado → pidió datos → cliente dio datos → confirmación (resumen) →
   cierre (kanban). Por país o por cuenta. También: cuántos datos pide el bot
   (campos) y cuántos turnos del cliente hubo hasta el cierre.
   Uso: node scripts/analisis_bot/etapas.js mx|ec|co [dias=7] [id_configuracion] */
require('dotenv').config();
const { db } = require('../../src/database/config');
const { normalizar } = require('../../src/utils/productoNombrado');
const pais = process.argv[2]; const dias = Number(process.argv[3] || 7); const soloCfg = Number(process.argv[4] || 0) || null;
const CIERRE = new Set(['generar_guia','guia_generada','guia_creada','en_transito','entregada','retiro_agencia','novedad','devolucion']);
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
const RE_PRECIO_DADO = /\$\s?\d|\d+[.,]\d\d(?!\d)|\bcuesta\b|\d+ (pesos|dolares|usd|mxn)/i;
const RE_PIDE_DATOS = /nombre completo|direccion exacta|tu direccion|codigo postal|ultimo paso|dame tu nombre|me confirmas (tu|la) direccion|numero de telefono/;
const RE_CONFIRMA = /pedido confirmado|resumen de tu pedido|resumen del pedido|📦|🧑 nombre|listo pedido|tu pedido queda/;
const RE_CLIENTE_DATOS = /\b\d{7,}\b|calle|colonia|avenida|av\.|mz|manzana|lote|barrio|sector|frente a|junto a|cp \d|c\.p|codigo postal/;
(async () => {
  const cfgs = soloCfg
    ? [{ id: soloCfg }]
    : await db.query(`SELECT c.id FROM configuraciones c WHERE LOWER(c.pais)=? AND c.suspendido=0 AND EXISTS (SELECT 1 FROM kanban_columnas k WHERE k.id_configuracion=c.id AND k.activa_ia=1 AND k.activo=1)`, { replacements: [pais], type: db.QueryTypes.SELECT });
  const desde = new Date(Date.now() - (dias + 1) * 864e5); desde.setHours(0, 0, 0, 0);
  const hasta = new Date(); hasta.setHours(0, 0, 0, 0);
  const E = { chats_ia: 0, respondieron: 0, precio_dado: 0, pidio_datos: 0, cliente_dio_datos: 0, confirmo: 0, cerrado: 0,
    perdidos_tras: { sin_precio: 0, con_precio_sin_pedir_datos: 0, pidio_datos_cliente_no_dio: 0, dio_datos_sin_confirmar: 0, confirmo_sin_cerrar: 0 },
    turnos_cliente_hasta_cierre: [], humano_intervino: 0, humano_y_cerro: 0, campos_pedidos: new Map(), ult_bot_perdidos_con_precio: new Map() };
  for (const { id: cfg } of cfgs) {
    const clientes = await db.query(`SELECT id, estado_contacto FROM clientes_chat_center WHERE id_configuracion=? AND deleted_at IS NULL AND created_at >= ? AND created_at < ?`, { replacements: [cfg, desde, hasta], type: db.QueryTypes.SELECT });
    if (!clientes.length) continue;
    const msgs = await db.query(`SELECT celular_recibe cli, rol_mensaje r, responsable resp, tipo_mensaje tipo, LEFT(texto_mensaje,260) t FROM mensajes_clientes WHERE id_configuracion=? AND rol_mensaje IN (0,1) AND deleted_at IS NULL AND created_at >= ? ORDER BY id`, { replacements: [cfg, desde], type: db.QueryTypes.SELECT });
    const porCli = new Map(); for (const m of msgs) { const a = porCli.get(m.cli); if (a) a.push(m); else porCli.set(m.cli, [m]); }
    for (const c of clientes) {
      const ms = porCli.get(c.id); if (!ms) continue;
      const esIA = (m) => m.r === 1 && /^IA_/.test(m.resp || '');
      const esHum = (m) => m.r === 1 && m.resp && !/^IA_|^cron|^sistema_ia$/.test(m.resp) && m.tipo !== 'notificacion' && m.tipo !== 'template';
      if (!ms.some(esIA)) continue;
      E.chats_ia++;
      const i1 = ms.findIndex(esIA);
      const cli = ms.filter((m, i) => i > i1 && m.r === 0 && m.tipo !== 'referral');
      if (!cli.length) continue;
      E.respondieron++;
      const cerrado = CIERRE.has(c.estado_contacto);
      const bot = ms.filter((m) => m.r === 1 && m.t && (esIA(m) || esHum(m)));
      const nb = bot.map((m) => normalizar(m.t));
      const precio = bot.some((m) => RE_PRECIO_DADO.test(m.t));
      const pidio = nb.some((t) => RE_PIDE_DATOS.test(t));
      const dio = cli.some((m) => RE_CLIENTE_DATOS.test(normalizar(m.t || '')) || (m.tipo === 'location'));
      const conf = nb.some((t) => RE_CONFIRMA.test(t));
      if (precio) E.precio_dado++; if (pidio) E.pidio_datos++; if (dio) E.cliente_dio_datos++; if (conf) E.confirmo++; if (cerrado) E.cerrado++;
      /* Humano ANTES del cierre: su primer mensaje llega antes de la
         confirmación del bot (o el bot nunca confirmó). Si solo escribe
         después (p. ej. "tu guía es…"), el cierre fue del bot. */
      const iHum = ms.findIndex(esHum);
      const iConf = ms.findIndex((m) => m.r === 1 && m.t && (esIA(m)) && RE_CONFIRMA.test(normalizar(m.t)));
      const humAntes = iHum >= 0 && (iConf < 0 || iHum < iConf);
      if (humAntes) { E.humano_intervino++; if (cerrado) E.humano_y_cerro++; }
      if (iHum >= 0 && !humAntes) { E.humano_despues = (E.humano_despues || 0) + 1; }
      if (cerrado) E.turnos_cliente_hasta_cierre.push(cli.length);
      else {
        if (!precio) E.perdidos_tras.sin_precio++;
        else if (!pidio) { E.perdidos_tras.con_precio_sin_pedir_datos++; const ub = bot.filter(esIA).slice(-1)[0]; if (ub) { const k = normalizar(ub.t).replace(/\d+/g, 'N').slice(0, 50); E.ult_bot_perdidos_con_precio.set(k, (E.ult_bot_perdidos_con_precio.get(k) || 0) + 1); } }
        else if (!dio) E.perdidos_tras.pidio_datos_cliente_no_dio++;
        else if (!conf) E.perdidos_tras.dio_datos_sin_confirmar++;
        else E.perdidos_tras.confirmo_sin_cerrar++;
      }
      // qué campos pide el bot en el "último paso"
      const pide = nb.find((t) => RE_PIDE_DATOS.test(t));
      if (pide) { for (const campo of ['nombre', 'telefono', 'direccion', 'colonia', 'codigo postal', 'referencia', 'ciudad', 'correo', 'cedula']) if (pide.includes(campo)) E.campos_pedidos.set(campo, (E.campos_pedidos.get(campo) || 0) + 1); }
    }
  }
  const R = E.respondieron; const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  console.log(JSON.stringify({ pais, dias, cfg: soloCfg, chats_ia: E.chats_ia, respondieron: R,
    etapa_alcanzada_pct_de_respondieron: { precio_dado: pct(E.precio_dado, R), bot_pidio_datos: pct(E.pidio_datos, R), cliente_dio_datos: pct(E.cliente_dio_datos, R), confirmacion: pct(E.confirmo, R), cerrado: pct(E.cerrado, R) },
    perdidos_por_etapa: Object.fromEntries(Object.entries(E.perdidos_tras).map(([k, v]) => [k, `${v} (${pct(v, R - E.cerrado)}% de los perdidos)`])),
    humano: { intervino_antes_del_cierre: E.humano_intervino, solo_despues_del_cierre: E.humano_despues || 0, pct_de_respondieron: pct(E.humano_intervino, R), cerro_con_humano: E.humano_y_cerro, pct_cierre_con_humano: pct(E.humano_y_cerro, E.humano_intervino), pct_cierre_sin_humano: pct(E.cerrado - E.humano_y_cerro, R - E.humano_intervino) },
    turnos_cliente_hasta_cierre_mediana: med(E.turnos_cliente_hasta_cierre),
    campos_que_pide_el_bot: Object.fromEntries([...E.campos_pedidos.entries()].sort((a, b) => b[1] - a[1])),
    ultimo_mensaje_bot_perdidos_con_precio: [...E.ult_bot_perdidos_con_precio.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12) }, null, 1));
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
