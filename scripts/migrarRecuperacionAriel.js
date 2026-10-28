/**
 * Migración del embudo de recuperación de Alexandra Quishpi (2779) a Ariel
 * Caraguay (2988), pedido 2026-10-28. Ariel se encarga del "fallo": pago
 * rebotado y cancelación programada.
 *
 *  1) Acceso: Ariel entra al departamento de Expertos (conexión 265) sin
 *     asignación automática, solo WhatsApp (igual que estaba Alexandra). Sin
 *     esto el botón «Chat desde Expertos» le dice que no pertenece al
 *     departamento. Alexandra ya no está en la lista de asesores; sus casos
 *     siguen a su nombre y eso es lo que se reparte aquí.
 *  2) Casos: Daniel quiere a Ariel a full con la cartera (Beto y Juan son de
 *     seguimiento y apoyo y en 30 días registraron 2 seguimientos), así que
 *     TODOS los casos abiertos pasan a Ariel, de cualquier cohorte y de
 *     cualquier asesor. Única excepción: si Beto o Juan tienen el chat del
 *     cliente en Expertos y el cliente les escribió en los últimos
 *     --dias-vivo días (7), ese caso se queda con ellos: no se parte una
 *     conversación en curso. Con --solo-foco se limita a pago_rebotado y
 *     cancelacion_programada más el resto de Alexandra.
 *  3) Chats en Expertos: el chat del cliente queda a nombre de Ariel para que
 *     pueda abrirlo (el panel bloquea el chat de otro asesor), con fila en
 *     historial_encargados. Solo se toman los chats del propio equipo de
 *     recuperación (sin encargado, Alexandra, Beto, Juan). Los que tiene
 *     soporte de Expertos (Johan, Belén, David, Vivi, Wendy) NO se tocan:
 *     puede ser un tema de importaciones y, si se los quedara Ariel, las
 *     próximas consultas de importaciones de ese cliente le caerían a él.
 *     El caso igual es de Ariel y ve la conversación en modo lectura desde
 *     la ficha; si necesita escribir desde Expertos, pide la transferencia.
 *     Con --tomar-soporte-inactivos se toman también los de soporte donde el
 *     cliente no escribió en los últimos --dias-vivo días.
 *  4) Lista los clientes del foco que respondieron a una automatización y
 *     nadie les registró seguimiento, para que Ariel arranque por ahí.
 *
 *   node scripts/migrarRecuperacionAriel.js                → simula
 *   node scripts/migrarRecuperacionAriel.js --aplicar      → escribe
 *   opciones: --solo-foco (solo pago rebotado + cancelación + resto de Alexandra)
 *             --dias-vivo=7 (ventana para considerar una conversación viva)
 *             --sin-chats (no transfiere chats)
 *             --tomar-soporte-inactivos (toma chats de soporte sin actividad del cliente)
 */
require('dotenv').config();
const { db } = require('../src/database/config');
const recuperacion = require('../src/services/recuperacion.service');

const arg = (k, def) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split('=')[1] : def;
};
const APLICAR = process.argv.includes('--aplicar');
const SIN_CHATS = process.argv.includes('--sin-chats');
const SOLO_FOCO = process.argv.includes('--solo-foco');
const TOMAR_SOPORTE = process.argv.includes('--tomar-soporte-inactivos');
const DIAS_CHAT_VIVO = Number(arg('dias-vivo', 7)) || 7;

const ARIEL = 2988;
const ALEXANDRA = 2779;
const BETO = 1886;
const JUAN = 2474;
const DEPTO_EXPERTOS = 7;
const CFG_EXPERTOS = Number(process.env.RECUPERACION_CONEXION_EXPERTOS || 265);
const FOCO = ['pago_rebotado', 'cancelacion_programada'];

const q = (sql, replacements = [], type = db.QueryTypes.SELECT) => db.query(sql, { replacements, type });

async function nombresDe(ids) {
  const rows = await q(
    `SELECT id_sub_usuario, COALESCE(NULLIF(TRIM(nombre_encargado), ''), usuario, email) AS nombre
       FROM sub_usuarios_chat_center WHERE id_sub_usuario IN (?)`,
    [ids],
  );
  const m = new Map(rows.map((r) => [Number(r.id_sub_usuario), String(r.nombre).trim()]));
  for (const id of ids) if (!m.has(id)) throw new Error(`No existe el subusuario ${id}`);
  return m;
}

async function darAcceso() {
  console.log('\n== 1) Acceso de Ariel ==');
  const [dep] = await q(`SELECT id FROM sub_usuarios_departamento WHERE id_departamento = ? AND id_sub_usuario = ?`, [DEPTO_EXPERTOS, ARIEL]);
  console.log(dep ? '· Ya está en el departamento de Expertos' : '· Se agrega al departamento de Expertos (asignación automática apagada, solo WhatsApp)');
  if (!dep && APLICAR) {
    await q(
      `INSERT INTO sub_usuarios_departamento (id_departamento, id_sub_usuario, asignacion_auto, canales) VALUES (?, ?, 0, 'wa')`,
      [DEPTO_EXPERTOS, ARIEL],
      db.QueryTypes.INSERT,
    );
  }
  const [ase] = await q(`SELECT activo FROM recuperacion_asesores_chat_center WHERE id_sub_usuario = ?`, [ARIEL]);
  console.log(ase ? `· Ya es asesor de recuperación (activo=${ase.activo})` : '· Se agrega como asesor de recuperación');
  if ((!ase || !Number(ase.activo)) && APLICAR) {
    await q(
      `INSERT INTO recuperacion_asesores_chat_center (id_sub_usuario, email, nombre, activo)
       VALUES (?, 'a.caraguay@imporfactorylatam.com', 'Ariel Caraguay', 1) ON DUPLICATE KEY UPDATE activo = 1`,
      [ARIEL],
      db.QueryTypes.INSERT,
    );
  }
}

async function asignar(ids, asesor, nombre) {
  if (!ids.length || !APLICAR) return 0;
  const [, r] = await db.query(
    `UPDATE recuperacion_casos_chat_center
        SET asignado_a_id = ?, asignado_a_nombre = ?, asignado_en = NOW()
      WHERE id_caso IN (?) AND estado = 'abierto'`,
    { replacements: [asesor, nombre, ids], type: db.QueryTypes.UPDATE },
  );
  return r?.affectedRows ?? ids.length;
}

(async () => {
  console.log(APLICAR ? '=== APLICANDO ===' : '=== SIMULACIÓN (agrega --aplicar para escribir) ===');
  console.log(`alcance=${SOLO_FOCO ? 'solo foco + resto de Alexandra' : 'todos los casos'} · chats=${SIN_CHATS ? 'no' : 'sí'} · conversación viva = cliente escribió en ${DIAS_CHAT_VIVO} días (no se toca)`);
  const nombre = await nombresDe([ARIEL, ALEXANDRA, BETO, JUAN]);
  const ASESORES_RECUP = [ARIEL, BETO, JUAN];

  await darAcceso();

  // Cohorte ACTUAL del cliente (la del caso puede estar vieja).
  const filas = await recuperacion.clientesEnRiesgo();
  const porUsuario = new Map(filas.map((f) => [f.id_usuario, f]));
  const casos = (await q(`SELECT id_caso, id_usuario, cohorte, asignado_a_id, asignado_a_nombre FROM recuperacion_casos_chat_center WHERE estado = 'abierto'`))
    .map((c) => ({ ...c, asignado_a_id: c.asignado_a_id == null ? null : Number(c.asignado_a_id), f: porUsuario.get(c.id_usuario) || null }))
    .map((c) => ({ ...c, cohorte_hoy: c.f?.cohorte || c.cohorte }));

  // Chats en Expertos de todos los casos y qué conversaciones están vivas
  // (el cliente escribió en los últimos DIAS_CHAT_VIVO días).
  const chats = await recuperacion.chatsExpertos(casos.map((c) => c.f?.whatsapp_digits));
  const chatDe = (c) => (c.f?.whatsapp_digits ? chats.get(String(c.f.whatsapp_digits).slice(-9)) || null : null);
  const idsChat = [...new Set([...chats.values()].map((x) => x.id_cliente))];
  const vivos = new Map();
  if (idsChat.length) {
    const rows = await q(
      `SELECT celular_recibe AS id_cliente, MAX(created_at) AS ultimo_entrante
         FROM mensajes_clientes
        WHERE id_configuracion = ? AND rol_mensaje = 0 AND celular_recibe IN (?)
          AND created_at >= NOW() - INTERVAL ? DAY
        GROUP BY celular_recibe`,
      [CFG_EXPERTOS, idsChat, DIAS_CHAT_VIVO],
    );
    for (const r of rows) vivos.set(Number(r.id_cliente), r.ultimo_entrante);
  }
  const vivoDe = (chat) => (chat ? vivos.get(Number(chat.id_cliente)) || null : null);

  // 2) Casos → Ariel
  console.log('\n== 2) Casos ==');
  const elegibles = casos.filter((c) => c.asignado_a_id !== ARIEL && (!SOLO_FOCO || FOCO.includes(c.cohorte_hoy) || c.asignado_a_id === ALEXANDRA || c.asignado_a_id === null));
  const aAriel = [];
  const seQuedan = [];
  for (const c of elegibles) {
    const chat = chatDe(c);
    const vivo = vivoDe(chat);
    if ([BETO, JUAN].includes(c.asignado_a_id) && chat && chat.encargado_id === c.asignado_a_id && vivo) seQuedan.push({ ...c, chat, vivo });
    else aAriel.push(c);
  }
  const resumen = {};
  for (const c of aAriel) {
    const k = `${c.cohorte_hoy} · de ${c.asignado_a_nombre || 'nadie'}`;
    resumen[k] = (resumen[k] || 0) + 1;
  }
  console.log(`· Pasan a ${nombre.get(ARIEL)}: ${aAriel.length} casos`);
  console.table(resumen);
  console.log(`· Se quedan con Beto/Juan porque el cliente conversa con ellos ahora: ${seQuedan.length}`);
  if (seQuedan.length) console.table(seQuedan.map((x) => ({ id_usuario: x.id_usuario, empresa: x.f?.empresa, cohorte: x.cohorte_hoy, asesor: x.asignado_a_nombre, cliente_escribio: x.vivo })));
  const n1 = await asignar(aAriel.map((c) => c.id_caso), ARIEL, nombre.get(ARIEL));
  if (APLICAR) console.log(`  escritos: ${n1}`);
  const idsAriel = new Set(aAriel.map((c) => c.id_caso));
  const totales = {};
  for (const c of casos) {
    const duenio = idsAriel.has(c.id_caso) || c.asignado_a_id === ARIEL ? nombre.get(ARIEL) : c.asignado_a_nombre || 'nadie';
    totales[duenio] = (totales[duenio] || 0) + 1;
  }
  console.log('· Casos abiertos por asesor después de la migración:', totales);

  // 3) Chats en Expertos de los casos que pasan a Ariel
  const transferir = [];
  const vivosSoporte = [];
  for (const c of aAriel) {
    const chat = chatDe(c);
    if (!chat || chat.encargado_id === ARIEL) continue;
    const enc = chat.encargado_id;
    const esDelEquipo = enc === null || enc === ALEXANDRA || ASESORES_RECUP.includes(enc);
    const vivo = vivoDe(chat);
    if (!esDelEquipo && (vivo || !TOMAR_SOPORTE)) vivosSoporte.push({ ...c, chat, vivo });
    else transferir.push({ ...c, chat });
  }
  console.log(`\n== 3) Chats en Expertos (${SIN_CHATS ? 'solo informe' : 'transferencia'}) ==`);
  const resChat = {};
  for (const x of transferir) {
    const k = `de ${x.chat.encargado_nombre || 'nadie'}`;
    resChat[k] = (resChat[k] || 0) + 1;
  }
  console.log(`· Chats que pasan a ${nombre.get(ARIEL)}: ${transferir.length}`);
  console.table(resChat);
  const porSoporte = {};
  for (const x of vivosSoporte) {
    const k = `${x.chat.encargado_nombre}${x.vivo ? ' (cliente escribió hace poco)' : ' (sin actividad del cliente)'}`;
    porSoporte[k] = (porSoporte[k] || 0) + 1;
  }
  console.log(`· Chats de soporte de Expertos que NO se tocan: ${vivosSoporte.length}. El caso es de Ariel y ve el chat en modo lectura desde la ficha.`);
  console.table(porSoporte);
  const vivosFoco = vivosSoporte.filter((x) => FOCO.includes(x.cohorte_hoy));
  console.log(`  de esos, del foco (pago rebotado / cancelación): ${vivosFoco.length}`);
  if (vivosFoco.length) console.table(vivosFoco.map((x) => ({ id_usuario: x.id_usuario, empresa: x.f?.empresa, cohorte: x.cohorte_hoy, chat_de: x.chat.encargado_nombre, cliente_escribio: x.vivo })));
  if (APLICAR && !SIN_CHATS) {
    let n = 0;
    for (const x of transferir) {
      await q(
        `UPDATE clientes_chat_center SET id_encargado = ? WHERE id = ? AND id_configuracion = ? AND (id_encargado IS NULL OR id_encargado = ?)`,
        [ARIEL, x.chat.id_cliente, CFG_EXPERTOS, x.chat.encargado_id],
        db.QueryTypes.UPDATE,
      );
      await q(
        `INSERT INTO historial_encargados (id_cliente_chat_center, id_departamento_asginado, id_encargado_anterior, id_encargado_nuevo, motivo)
         VALUES (?, ?, ?, ?, ?)`,
        [x.chat.id_cliente, DEPTO_EXPERTOS, x.chat.encargado_id, ARIEL, 'Recuperación: migración del embudo a Ariel Caraguay'],
        db.QueryTypes.INSERT,
      );
      n += 1;
    }
    console.log(`  chats transferidos: ${n}`);
  }

  // 4) Respondieron a una automatización y nadie registró seguimiento
  console.log('\n== 4) Respondieron a la automatización (pago/cancelación) y no tienen seguimiento después ==');
  const resp = await q(
    `SELECT e.id_usuario, a.clave, MAX(e.respondio_en) AS respondio, c.asignado_a_nombre, u.nombre AS empresa,
            (SELECT COUNT(*) FROM seguimiento_clientes_chat_center s WHERE s.id_usuario = e.id_usuario AND s.fecha_seguimiento >= MAX(e.respondio_en)) AS seg_despues
       FROM recuperacion_automatizacion_envios e
       JOIN recuperacion_automatizaciones a ON a.id = e.id_automatizacion
       LEFT JOIN recuperacion_casos_chat_center c ON c.id_usuario = e.id_usuario AND c.estado = 'abierto'
       LEFT JOIN usuarios_chat_center u ON u.id_usuario = e.id_usuario
      WHERE e.respondio_en IS NOT NULL AND a.clave IN ('pago_rebotado', 'cancelacion_programada')
      GROUP BY e.id_usuario, a.clave, c.asignado_a_nombre, u.nombre
     HAVING seg_despues = 0
      ORDER BY respondio DESC`,
  );
  const enRiesgo = resp.filter((r) => porUsuario.has(r.id_usuario));
  const fuera = resp.filter((r) => !porUsuario.has(r.id_usuario));
  console.log(`· Siguen en riesgo (los ve en el embudo con «Respondió … falta seguimiento manual»): ${enRiesgo.length}`);
  console.table(enRiesgo.map((r) => ({ id_usuario: r.id_usuario, empresa: r.empresa, secuencia: r.clave, respondio: r.respondio, cohorte_hoy: porUsuario.get(r.id_usuario)?.cohorte })));
  console.log(`· Ya salieron del embudo (pagaron o se fueron; se buscan por nombre en «Historial»): ${fuera.length}`);
  console.table(fuera.map((r) => ({ id_usuario: r.id_usuario, empresa: r.empresa, secuencia: r.clave, respondio: r.respondio })));

  if (!APLICAR) console.log('\nNo se escribió nada. Corre con --aplicar para migrar.');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
