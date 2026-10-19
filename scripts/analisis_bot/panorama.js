/* Panorama del bot por país: una pasada por cuenta, consultas indexadas
   (idx_mensajes_rol_config, idx_cc_cfg_deleted_created). Mide con datos:
   H1 foto adjunta en listados · H2 "Dejame revisar" (disparos, falsos, salida)
   H3 objeción de precio y qué contesta el bot · H4 pidió precio y calló
   H5 "tienen X" fuera de catálogo · H6 "solo eso tienen" · H8 wizard precio primero
   Uso: node panorama.js mx|ec [dias=7] [salida.json] */

require('dotenv').config();
const fs = require('fs');
const { db } = require('../../src/database/config.js');
const { productoNombrado, tokensProducto, normalizar } = require('../../src/utils/productoNombrado.js');

const pais = process.argv[2];
const dias = Number(process.argv[3] || 7);
const salida = process.argv[4];
const CIERRE = new Set(['generar_guia','guia_generada','guia_creada','en_transito','entregada','retiro_agencia','novedad','devolucion']);

const RE_PRECIO = /\b(precio|presio|cuanto (cuesta|vale|sale|es)|costo|cuanto\b|valor|q precio|que precio)\b/;
const RE_OBJ_PRECIO = /\b(caro|cara|carisimo|presupuesto|no me alcanza|muy alto|mucho dinero|descuento|rebaja|mas barato|lo pienso|lo checo|dejame pensar|lo voy a pensar|lo consulto|le comento a mi|lo platico)\b/;
const RE_SOLO_ESO = /\b(solo eso tienen|apenas tienen|nada mas tienen|eso nomas tienen|solo tienen eso|no tienen (mas|otra cosa|otro))\b/;
const RE_TIENEN = /^(tienen|tiene|tendran|tendra|hay|venden|vende|manejan|maneja|me vende|tal vez tienen|y tal vez tienen)\b/;
const RE_REVISAR = /^dejame revisar en el catalogo/;
const RE_CIUDAD_Q = /a que ciudad|desde que ciudad|en que ciudad|ciudad te l/;
const RE_ENTIENDO = /^(entiendo|perfecto|claro|de acuerdo|ok)\b.*(gracias|cuando quieras|cuando estes list|cambias de opinion|aqui estare|quedo atent)/;
const RE_CANT_Q = /cuantas unidades|cuantos quieres|1 o aprovechas|prefieres 1|quieres 1|te llevas 1/;
const RE_NO_TENEMOS = /no (lo |los |las |la )?(tenemos|manejamos|contamos|disponemos|vendemos)|no (esta|lo tengo) disponible|por ahora solo|solo (manejamos|tenemos|contamos)/;
const RE_TAMBIEN = /\b(tambien|ademas|junto con|agregar|agregamos|sumamos|los dos|ambos)\b/;

const norm = (s) => normalizar(s);
const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);

function productosNombrados(texto, productos) {
  const dicho = norm(texto); const out = [];
  for (const p of productos) {
    const tk = tokensProducto(p.nombre); if (!tk.length) continue;
    const need = tk.length <= 2 ? tk.length : Math.max(2, Math.ceil(tk.length * 0.6));
    let ac = 0; for (const t of tk) if (new RegExp(`(?:^|\\s)${t}(?:s|es)?(?=\\s|$)`).test(dicho)) ac++;
    if (ac >= need) out.push(p.nombre);
  }
  return [...new Set(out)];
}

(async () => {
  const t0 = Date.now();
  const cfgs = await db.query(
    `SELECT c.id, c.nombre_configuracion nombre FROM configuraciones c
      WHERE LOWER(c.pais)=? AND c.suspendido=0
        AND EXISTS (SELECT 1 FROM kanban_columnas k WHERE k.id_configuracion=c.id AND k.activa_ia=1 AND k.activo=1)`,
    { replacements: [pais], type: db.QueryTypes.SELECT });
  const R = {
    pais, dias, cuentas: cfgs.length, chats: 0, respondieron: 0, cerraron: 0, cerraron_resp: 0,
    h1: { turnos_listado: 0, con_foto: 0, chats_con_foto: new Set(), ej: [] },
    h2: { disparos: 0, chats: 0, prev_corto: 0, prev_producto_en_catalogo: 0, prev_pide_precio: 0, humano_despues: 0, cliente_volvio: 0, cerraron: 0, ej_prev: new Map() },
    h3: { chats: 0, cerraron: 0, bot_repite_ciudad: 0, bot_se_despide: 0, bot_pregunta_cantidad: 0, bot_otro: 0, ej: [] },
    h4: { chats: 0, cerraron: 0, con_remarketing_despues: 0, respondio_tras_remarketing: 0, ult_bot_resp: new Map(), ult_bot: new Map() },
    h5: { msgs: 0, en_catalogo: 0, fuera_bot_revisar: 0, fuera_bot_no_tenemos: 0, fuera_bot_tambien: 0, fuera_bot_otro: 0, ej_tambien: [], ej_otro: [] },
    h6: { chats: 0, cerraron: 0, ej: [] },
    h8: { wizard_precio: { chats: 0, resp: 0, cerr_resp: 0 }, sin_wizard: { chats: 0, resp: 0, cerr_resp: 0 } },
    ult_cli: new Map(), ult_bot: new Map(), objeciones_texto: { precio: 0, luego: 0, tiempo_entrega: 0, ya_no: 0 },
    por_cuenta: [],
  };
  const desde = new Date(Date.now() - (dias + 1) * 864e5); desde.setHours(0, 0, 0, 0);
  const hasta = new Date(); hasta.setHours(0, 0, 0, 0); // excluye hoy

  for (const cfg of cfgs) {
    const clientes = await db.query(
      `SELECT id, estado_contacto FROM clientes_chat_center
        WHERE id_configuracion=? AND deleted_at IS NULL AND created_at >= ? AND created_at < ?`,
      { replacements: [cfg.id, desde, hasta], type: db.QueryTypes.SELECT });
    if (!clientes.length) continue;
    const productos = await db.query(
      `SELECT nombre FROM productos_chat_center WHERE id_configuracion=? AND eliminado=0`,
      { replacements: [cfg.id], type: db.QueryTypes.SELECT });
    const msgs = await db.query(
      `SELECT celular_recibe cli, rol_mensaje r, responsable resp, tipo_mensaje tipo, LEFT(texto_mensaje,220) t, created_at ts
         FROM mensajes_clientes
        WHERE id_configuracion=? AND rol_mensaje IN (0,1) AND deleted_at IS NULL AND created_at >= ?
        ORDER BY id`,
      { replacements: [cfg.id, desde], type: db.QueryTypes.SELECT });
    const porCli = new Map();
    for (const m of msgs) { const a = porCli.get(m.cli); if (a) a.push(m); else porCli.set(m.cli, [m]); }
    const cta = { cfg: cfg.id, nombre: cfg.nombre, chats: 0, resp: 0, cerr_resp: 0, h3: 0, h4: 0, h2: 0, wiz: { chats: 0, resp: 0, cerr: 0 }, nowiz: { chats: 0, resp: 0, cerr: 0 } };

    for (const c of clientes) {
      const ms = porCli.get(c.id); if (!ms) continue;
      const esIA = (m) => m.r === 1 && /^IA_/.test(m.resp || '');
      const esModelo = (m) => esIA(m) && !/^IA_(mensaje_fijo|colchon|respuesta_rapida)$/.test(m.resp || '');
      const esCron = (m) => m.r === 1 && /^cron/.test(m.resp || '');
      const esHum = (m) => m.r === 1 && !esIA(m) && !esCron(m) && m.resp !== 'sistema_ia' && m.tipo !== 'notificacion';
      if (!ms.some(esIA)) continue; // conversación atendida por IA
      const cerrado = CIERRE.has(c.estado_contacto);
      R.chats++; cta.chats++; if (cerrado) R.cerraron++;
      const idxIA1 = ms.findIndex(esIA);
      const respondio = ms.slice(idxIA1 + 1).some((m) => m.r === 0 && m.tipo !== 'referral');
      if (respondio) { R.respondieron++; cta.resp++; if (cerrado) { R.cerraron_resp++; cta.cerr_resp++; } }

      // H8 wizard precio primero
      const primerBot = ms.find((m) => m.r === 1 && m.resp !== 'sistema_ia' && m.t);
      const wiz = primerBot && primerBot.resp === 'IA_mensaje_fijo' && /\$\s?\d|\d+ por \$/.test(primerBot.t || '');
      const b = wiz ? R.h8.wizard_precio : R.h8.sin_wizard;
      b.chats++; if (respondio) { b.resp++; if (cerrado) b.cerr_resp++; }
      const bc = wiz ? cta.wiz : cta.nowiz; bc.chats++; if (respondio) { bc.resp++; if (cerrado) bc.cerr++; }

      const cliMs = ms.filter((m) => m.r === 0 && m.tipo !== 'referral' && m.t);
      const botIA = ms.filter(esIA).filter((m) => m.t);
      const allCli = norm(cliMs.map((m) => m.t).join(' '));
      if (cliMs.length) inc(R.ult_cli, norm(cliMs[cliMs.length - 1].t).slice(0, 45));
      if (botIA.length) inc(R.ult_bot, norm(botIA[botIA.length - 1].t).slice(0, 50));
      if (RE_OBJ_PRECIO.test(allCli)) R.objeciones_texto.precio++;
      if (/\b(luego|despues|mas tarde|manana|quincena|cuando cobre)\b/.test(allCli)) R.objeciones_texto.luego++;
      if (/\b(cuanto tarda|en que tiempo|cuando llega|dias habiles|tiempo de entrega)\b/.test(allCli)) R.objeciones_texto.tiempo_entrega++;
      if (/\b(ya no|ya compre|ya lo tengo|ya lo consegui)\b/.test(allCli)) R.objeciones_texto.ya_no++;

      const siguienteBot = (i) => { for (let j = i + 1; j < ms.length && j <= i + 6; j++) { if (ms[j].r === 0) return null; if (esIA(ms[j]) && ms[j].t) return ms[j]; } return null; };

      let h3hit = false, h5seen = false, h6hit = false;
      for (let i = 0; i < ms.length; i++) {
        const m = ms[i];
        if (m.r === 0 && m.tipo !== 'referral' && m.t) {
          const nt = norm(m.t);
          // H3 objeción de precio → qué contesta el bot
          if (!h3hit && RE_OBJ_PRECIO.test(nt)) {
            h3hit = true; R.h3.chats++; cta.h3++; if (cerrado) R.h3.cerraron++;
            const nb = siguienteBot(i); const nbt = nb ? norm(nb.t) : '';
            if (!nb) R.h3.bot_otro++;
            else if (RE_CIUDAD_Q.test(nbt)) R.h3.bot_repite_ciudad++;
            else if (RE_ENTIENDO.test(nbt)) R.h3.bot_se_despide++;
            else if (RE_CANT_Q.test(nbt)) R.h3.bot_pregunta_cantidad++;
            else R.h3.bot_otro++;
            if (R.h3.ej.length < 12) R.h3.ej.push(`[${cfg.id}] C: ${m.t.slice(0, 90)} → B: ${(nb?.t || '(sin respuesta IA)').slice(0, 110)}`);
          }
          // H6 "solo eso tienen"
          if (!h6hit && RE_SOLO_ESO.test(nt)) { h6hit = true; R.h6.chats++; if (cerrado) R.h6.cerraron++; const nb = siguienteBot(i); if (R.h6.ej.length < 10) R.h6.ej.push(`[${cfg.id}] C: ${m.t.slice(0, 80)} → B: ${(nb?.t || '').slice(0, 110)}`); }
          // H5 "tienen X"
          if (RE_TIENEN.test(nt) && nt.length > 8 && !RE_PRECIO.test(nt) && !/\b(envio|envios|entrega|entregas|pago|cobertura|garantia|sucursal|tienda fisica|domicilio|servicio|llegan|mandan|pedidos en|factura|stock|disponible|disponibilidad|existencia)\b/.test(nt)) {
            R.h5.msgs++;
            const enCat = productoNombrado(m.t, productos);
            if (enCat) R.h5.en_catalogo++;
            else {
              const nb = siguienteBot(i); const nbt = nb ? norm(nb.t) : '';
              if (RE_REVISAR.test(nbt)) R.h5.fuera_bot_revisar++;
              else if (RE_NO_TENEMOS.test(nbt)) R.h5.fuera_bot_no_tenemos++;
              else if (RE_TAMBIEN.test(nbt)) { R.h5.fuera_bot_tambien++; if (R.h5.ej_tambien.length < 15) R.h5.ej_tambien.push(`[${cfg.id}] C: ${m.t.slice(0, 80)} → B: ${(nb?.t || '').slice(0, 120)}`); }
              else { R.h5.fuera_bot_otro++; if (R.h5.ej_otro.length < 15) R.h5.ej_otro.push(`[${cfg.id}] C: ${m.t.slice(0, 80)} → B: ${(nb?.t || '(sin respuesta IA)').slice(0, 120)}`); }
            }
          }
        }
        if (esIA(m) && m.t) {
          const nt = norm(m.t);
          // H1 (solo turnos del modelo) listado de 2+ productos con foto en el mismo turno
          const nombrados = esModelo(m) && productos.length >= 2 ? productosNombrados(m.t, productos) : [];
          if (nombrados.length >= 2) {
            R.h1.turnos_listado++;
            const ts = new Date(m.ts).getTime();
            const foto = ms.some((x) => x.resp === m.resp && x.tipo === 'image' && Math.abs(new Date(x.ts).getTime() - ts) <= 15000);
            if (foto) { R.h1.con_foto++; R.h1.chats_con_foto.add(`${cfg.id}:${c.id}`); if (R.h1.ej.length < 10) R.h1.ej.push(`[${cfg.id}/${c.id}] ${m.t.slice(0, 120)}`); }
          }
          // H2 "Dejame revisar"
          if (RE_REVISAR.test(nt)) {
            R.h2.disparos++; cta.h2++;
            let prev = null; for (let j = i - 1; j >= 0; j--) if (ms[j].r === 0 && ms[j].t) { prev = ms[j]; break; }
            const pt = prev ? norm(prev.t) : '';
            if (pt && pt.split(' ').length <= 2 && !RE_TIENEN.test(pt)) R.h2.prev_corto++;
            if (prev && productoNombrado(prev.t, productos)) R.h2.prev_producto_en_catalogo++;
            if (RE_PRECIO.test(pt)) R.h2.prev_pide_precio++;
            inc(R.h2.ej_prev, pt.slice(0, 40));
            const resto = ms.slice(i + 1);
            if (resto.some(esHum)) R.h2.humano_despues++;
            if (resto.some((x) => x.r === 0)) R.h2.cliente_volvio++;
          }
        }
      }
      if (ms.some((m) => esIA(m) && RE_REVISAR.test(norm(m.t || '')))) { R.h2.chats++; if (cerrado) R.h2.cerraron++; }
      // H4 pidió precio y calló: último mensaje del cliente pide precio, el bot contestó y no volvió
      if (cliMs.length && !cerrado) {
        const lc = cliMs[cliMs.length - 1];
        if (RE_PRECIO.test(norm(lc.t))) {
          const i = ms.lastIndexOf(lc); const nb = siguienteBot(i);
          if (nb) { R.h4.chats++; cta.h4++; inc(R.h4.ult_bot, norm(nb.t).replace(/\$\s?[\d.,]+/g, '$N').slice(0, 60)); inc(R.h4.ult_bot_resp, nb.resp); const k = ms.lastIndexOf(nb); const rm = ms.slice(k + 1).findIndex(esCron); if (rm >= 0) { R.h4.con_remarketing_despues++; if (ms.slice(k + 1 + rm + 1).some((x) => x.r === 0)) R.h4.respondio_tras_remarketing++; } }
        }
      }
    }
    if (cta.chats >= 20) R.por_cuenta.push(cta);
    process.stderr.write(`cfg ${cfg.id} ${cfg.nombre}: ${cta.chats} chats, ${msgs.length} msgs (${Math.round((Date.now() - t0) / 1000)}s)\n`);
  }

  const out = {
    ...R,
    pct_resp: pct(R.respondieron, R.chats), pct_cierre_resp: pct(R.cerraron_resp, R.respondieron),
    h1: { ...R.h1, chats_con_foto: R.h1.chats_con_foto.size },
    h2: { ...R.h2, pct_humano_despues: pct(R.h2.humano_despues, R.h2.disparos), pct_cerraron: pct(R.h2.cerraron, R.h2.chats), ej_prev: top(R.h2.ej_prev, 25) },
    h3: { ...R.h3, pct_cierre: pct(R.h3.cerraron, R.h3.chats) },
    h4: { ...R.h4, pct_de_no_cerrados_que_respondieron: pct(R.h4.chats, R.respondieron - R.cerraron_resp), ult_bot_resp: top(R.h4.ult_bot_resp, 8), ult_bot: top(R.h4.ult_bot, 15) },
    h6: { ...R.h6 },
    h8: { wizard_precio: { ...R.h8.wizard_precio, pct_resp: pct(R.h8.wizard_precio.resp, R.h8.wizard_precio.chats), pct_cierre_resp: pct(R.h8.wizard_precio.cerr_resp, R.h8.wizard_precio.resp) }, sin_wizard: { ...R.h8.sin_wizard, pct_resp: pct(R.h8.sin_wizard.resp, R.h8.sin_wizard.chats), pct_cierre_resp: pct(R.h8.sin_wizard.cerr_resp, R.h8.sin_wizard.resp) } },
    ult_cli: top(R.ult_cli, 30), ult_bot: top(R.ult_bot, 25),
    por_cuenta: R.por_cuenta.sort((a, b) => b.resp - a.resp).slice(0, 25).map((c) => ({ ...c, pct_cierre: pct(c.cerr_resp, c.resp) })),
    segundos: Math.round((Date.now() - t0) / 1000),
  };
  const txt = JSON.stringify(out, null, 1);
  if (salida) fs.writeFileSync(salida, txt);
  console.log(txt);
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
