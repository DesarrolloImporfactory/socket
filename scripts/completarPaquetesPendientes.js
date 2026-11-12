'use strict';

/**
 * Completa el paquete fijo del wizard (foto + video + texto con el precio) en
 * los chats donde quedó a medias o no salió.
 *
 * Por qué existe (caso 1325, 12-11-2026): un envío a Meta que se cuelga o es
 * rechazado cortaba el paquete sin dejar rastro — al cliente le llegaba solo
 * la foto, o nada, y el turno se daba por cerrado. El motor ya reintenta y deja
 * la incidencia (`envio_fallido`); este script recoge los chats de ANTES del
 * arreglo, o los que se vuelvan a escapar.
 *
 * Dos grupos:
 *   A · TRUNCADO   lo último que le salió al cliente es una foto/video del
 *                  paquete fijo y después nadie le escribió (ni bot ni asesor).
 *   B · SIN PAQUETE entró por un anuncio de un producto con wizard, no le salió
 *                  ninguna pieza del paquete y el chat no avanzó: o nadie le
 *                  contestó, o solo le contestó la IA (el rescate) y el cliente
 *                  no volvió a escribir.
 *
 * No toca: chats donde contestó una persona, donde el cliente siguió
 * conversando, con el bot apagado (cuenta, columna o chat), cerrados, o que ya
 * recibieron el texto de un paquete fijo en las últimas 48 h. La media pasa por
 * el dedupe de siempre: la foto que sí llegó no se repite.
 *
 * Solo dentro de la ventana de 24 h de WhatsApp: fuera de ella Meta rechaza el
 * texto libre, así que --horas tiene tope 23.
 *
 * Uso:
 *   node scripts/completarPaquetesPendientes.js                    (solo muestra, últimas 20 h)
 *   node scripts/completarPaquetesPendientes.js --cfg 1325 --horas 12
 *   node scripts/completarPaquetesPendientes.js --aplicar          (envía)
 *   [--max 50]  tope de chats a los que se les envía en una corrida
 *   [--solo A|B]  un solo grupo
 *
 * Carga en la BD: UNA lectura por rango de fecha (idx_created_at) y después
 * consultas chiquitas por chat, solo para los candidatos.
 */

require('dotenv').config();
const { db } = require('../src/database/config');
const {
  resolverWizardDelAnuncio,
  resolverWizardPorTexto,
  botHabilitado,
  enviarPaqueteInicial,
} = require('../src/services/producto_wizard_runtime.service');

const arg = (nombre, def = null) => {
  const i = process.argv.indexOf(`--${nombre}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const APLICAR = arg('aplicar') === true;
const CFG = Number(arg('cfg')) || null;
const HORAS = Math.min(Math.max(Number(arg('horas')) || 20, 1), 23);
const MAX = Math.max(Number(arg('max')) || 50, 1);
const SOLO = typeof arg('solo') === 'string' ? arg('solo').toUpperCase() : null;

const FIJO = 'IA_mensaje_fijo';
// Un turno recién entrado todavía lo está atendiendo el servidor.
const MIN_EDAD_MS = 3 * 60 * 1000;

const sel = (sql, replacements = []) =>
  db.query(sql, { replacements, type: db.QueryTypes.SELECT, logging: false });
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const una = (v, max = 70) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const hora = (d) => {
  const f = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(f.getDate())}/${p(f.getMonth() + 1)} ${p(f.getHours())}:${p(f.getMinutes())}`;
};
// Lo que escribe el bot solo: IA_*, crons, plantillas de estado. El resto es gente.
const esAutomatico = (resp) =>
  /^(IA_|cron_|Dropi|sistema)/i.test(String(resp || ''));

async function main() {
  console.log(
    `Ventana: últimas ${HORAS} h${CFG ? ` · cfg ${CFG}` : ' · todas las cuentas'} · ${APLICAR ? 'APLICANDO (envía)' : 'solo muestra'}\n`,
  );

  // 1) Una sola lectura: piezas del paquete fijo y entradas por anuncio.
  const filas = await sel(
    `SELECT id, id_configuracion cfg, celular_recibe cli, tipo_mensaje tipo,
            responsable resp, created_at
       FROM mensajes_clientes
      WHERE created_at >= NOW() - INTERVAL ${HORAS} HOUR
        ${CFG ? 'AND id_configuracion = ?' : ''}
        AND (responsable = '${FIJO}' OR tipo_mensaje = 'referral')
        AND deleted_at IS NULL
      ORDER BY id`,
    CFG ? [CFG] : [],
  );

  const chats = new Map();
  for (const f of filas) {
    const k = `${f.cfg}:${f.cli}`;
    if (!chats.has(k)) chats.set(k, { cfg: f.cfg, cli: f.cli, fijos: [], refs: [] });
    if (f.resp === FIJO) chats.get(k).fijos.push(f);
    else chats.get(k).refs.push(f);
  }

  // Cuentas con algún wizard activo: el grupo B solo existe ahí.
  const conWizard = new Set(
    (
      await sel(
        `SELECT DISTINCT id_configuracion c FROM productos_wizard
          WHERE activo = 1 AND wizard_completado = 1`,
      )
    ).map((r) => Number(r.c)),
  );

  const candidatos = [];
  for (const c of chats.values()) {
    const ultFijo = c.fijos[c.fijos.length - 1];
    const ultRef = c.refs[c.refs.length - 1];
    if (ultFijo && ultFijo.tipo !== 'text') {
      candidatos.push({ ...c, grupo: 'A', desde: ultFijo.id });
    } else if (
      ultRef &&
      conWizard.has(Number(c.cfg)) &&
      !c.fijos.some((f) => f.id > ultRef.id)
    ) {
      candidatos.push({ ...c, grupo: 'B', desde: ultRef.id });
    }
  }
  const aRevisar = candidatos.filter((c) => !SOLO || c.grupo === SOLO);
  console.log(
    `${filas.length} filas leídas · ${chats.size} chats · ${aRevisar.length} candidatos a revisar\n`,
  );

  const pendientes = [];
  const descartes = {};
  const descartar = (m) => (descartes[m] = (descartes[m] || 0) + 1);

  for (const c of aRevisar) {
    await pausa(25);
    // Desde el mensaje disparador en adelante (índice celular_recibe + id).
    const cola = await sel(
      `SELECT id, rol_mensaje rol, tipo_mensaje tipo, responsable resp,
              LEFT(texto_mensaje, 200) texto, created_at
         FROM mensajes_clientes
        WHERE celular_recibe = ? AND id_configuracion = ? AND id >= ?
          AND deleted_at IS NULL
        ORDER BY id LIMIT 60`,
      [String(c.cli), c.cfg, c.desde],
    );
    const despues = cola.filter((m) => m.id > c.desde);
    const salidas = despues.filter((m) => Number(m.rol) === 1);
    const entradas = despues.filter(
      (m) => Number(m.rol) === 0 && m.tipo !== 'revoke',
    );

    let disparador;
    if (c.grupo === 'A') {
      // Tras la última pieza del paquete nadie le escribió.
      if (salidas.length) {
        descartar('A: alguien le escribió después');
        continue;
      }
      // El mensaje del cliente que disparó el paquete (para resolver por texto).
      const [prev] = await sel(
        `SELECT id, LEFT(texto_mensaje, 200) texto, created_at FROM mensajes_clientes
          WHERE celular_recibe = ? AND id_configuracion = ? AND id < ?
            AND rol_mensaje = 0 AND deleted_at IS NULL
          ORDER BY id DESC LIMIT 1`,
        [String(c.cli), c.cfg, c.desde],
      );
      disparador = entradas[entradas.length - 1] || prev || cola[0];
    } else {
      if (salidas.some((m) => !esAutomatico(m.resp))) {
        descartar('B: contestó una persona');
        continue;
      }
      const primeraSalida = salidas[0];
      if (primeraSalida && entradas.some((m) => m.id > primeraSalida.id)) {
        descartar('B: el cliente siguió conversando');
        continue;
      }
      if (entradas.length > 2) {
        descartar('B: el cliente siguió conversando');
        continue;
      }
      // La IA ya le dio el precio: el paquete llegaría repetido.
      if (salidas.some((m) => /\$\s?\d|\d\s?(usd|d[oó]lares|pesos)/i.test(m.texto || ''))) {
        descartar('B: la IA ya le dio el precio');
        continue;
      }
      disparador = cola[0];
    }

    const ultimoDelCliente =
      entradas[entradas.length - 1]?.created_at || disparador?.created_at;
    const edad = Date.now() - new Date(ultimoDelCliente).getTime();
    if (edad < MIN_EDAD_MS) {
      descartar('recién entró (lo atiende el servidor)');
      continue;
    }
    if (edad > 23.5 * 3600 * 1000) {
      descartar('fuera de la ventana de 24 h');
      continue;
    }

    const [cli] = await sel(
      `SELECT id, celular_cliente, nombre_cliente, estado_contacto, bot_openia,
              chat_cerrado, deleted_at
         FROM clientes_chat_center WHERE id = ? AND id_configuracion = ? LIMIT 1`,
      [c.cli, c.cfg],
    );
    if (!cli || cli.deleted_at || Number(cli.chat_cerrado) === 1) {
      descartar('chat cerrado o eliminado');
      continue;
    }
    if (Number(cli.bot_openia) !== 1) {
      descartar('bot apagado en el chat');
      continue;
    }
    if (!(await botHabilitado(c.cfg, cli.estado_contacto))) {
      descartar('bot apagado (cuenta o columna)');
      continue;
    }
    // Ya tiene el texto de un paquete fijo en las últimas 48 h: no se repite.
    const [yaTexto] = await sel(
      `SELECT id FROM mensajes_clientes
        WHERE celular_recibe = ? AND id_configuracion = ? AND responsable = '${FIJO}'
          AND tipo_mensaje = 'text' AND created_at >= NOW() - INTERVAL 48 HOUR
        LIMIT 1`,
      [String(c.cli), c.cfg],
    );
    if (yaTexto) {
      descartar('ya recibió un paquete fijo en 48 h');
      continue;
    }

    // Producto: el anuncio más reciente del cliente; si no, por el texto.
    const [ad] = await sel(
      `SELECT headline, source_id FROM cliente_productos_ad
        WHERE id_cliente = ? AND id_configuracion = ? ORDER BY id DESC LIMIT 1`,
      [c.cli, c.cfg],
    );
    let r = ad
      ? await resolverWizardDelAnuncio(c.cfg, ad.headline || '', ad.source_id || null)
      : null;
    if (!r) r = await resolverWizardPorTexto(c.cfg, disparador?.texto || '');
    if (!r) {
      descartar('el producto no tiene wizard / no se identifica');
      continue;
    }

    pendientes.push({ ...c, cli, r, disparador, salidas });
  }

  console.log('Descartados:');
  for (const [m, n] of Object.entries(descartes)) console.log(`  ${n}  ${m}`);
  console.log(`\nPendientes: ${pendientes.length}\n`);
  for (const p of pendientes) {
    console.log(
      `  [${p.grupo}] cfg ${p.cfg} · cliente ${p.cli.id} · ${p.cli.celular_cliente} · ${hora(p.disparador.created_at)} · "${una(p.disparador.texto, 50)}" → ${una(p.r.producto.nombre, 40)}` +
        (p.grupo === 'B' && p.salidas.length
          ? ` (la IA ya le dijo: "${una(p.salidas[0].texto, 40)}")`
          : ''),
    );
  }

  if (!APLICAR) {
    console.log('\nNada enviado. Con --aplicar se les completa el paquete.');
    return;
  }

  let ok = 0;
  let mal = 0;
  const tokens = new Map();
  for (const p of pendientes.slice(0, MAX)) {
    if (!tokens.has(p.cfg)) {
      const [conf] = await sel(
        `SELECT id_telefono, token FROM configuraciones
          WHERE id = ? AND suspendido = 0 LIMIT 1`,
        [p.cfg],
      );
      tokens.set(p.cfg, conf || null);
    }
    const conf = tokens.get(p.cfg);
    if (!conf?.token || !conf?.id_telefono) {
      console.log(`  ✗ cfg ${p.cfg} cliente ${p.cli.id}: cuenta suspendida o sin token`);
      mal++;
      continue;
    }
    const lineas = [];
    try {
      const res = await enviarPaqueteInicial({
        id_configuracion: p.cfg,
        id_cliente: p.cli.id,
        telefono: p.cli.celular_cliente,
        business_phone_id: conf.id_telefono,
        accessToken: conf.token,
        producto: p.r.producto,
        wizard: p.r.wizard,
        log: async (m) => lineas.push(m),
      });
      if (res.textoEnviado && !res.fallos.length) {
        ok++;
        console.log(
          `  ✓ cfg ${p.cfg} cliente ${p.cli.id}: ${res.imagenes} img, ${res.videos} video, texto sí`,
        );
      } else {
        mal++;
        console.log(
          `  ✗ cfg ${p.cfg} cliente ${p.cli.id}: ${res.fallos.join(' | ') || 'incompleto'}`,
        );
      }
    } catch (e) {
      mal++;
      console.log(`  ✗ cfg ${p.cfg} cliente ${p.cli.id}: ${e.message}`);
    }
    await pausa(1500);
  }
  if (pendientes.length > MAX) {
    console.log(`\nQuedaron ${pendientes.length - MAX} por el tope --max ${MAX}.`);
  }
  console.log(`\nCompletados: ${ok} · con fallo: ${mal}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  // Deja terminar el registro de incidencias (va sin await) antes de cerrar.
  .finally(() => pausa(800).then(() => db.close()));
