/**
 * Reparte por igual los casos ABIERTOS y SIN ASESOR del embudo de recuperación
 * (pedido 2026-10-15). Así cada asesor ve los suyos con «Mis casos».
 *
 *  1) Si el chat del cliente en Expertos ya lo atiende uno de los asesores,
 *     el caso es de él: no se parte una conversación en curso.
 *  2) El resto, cohorte por cohorte, al que lleve menos casos de esa cohorte
 *     (empate: menos casos en total). Queda parejo en total y por cohorte.
 *
 * Con --acceso, antes agrega a Alexandra Quishpi (2779) al departamento de
 * Expertos (sin asignación automática, solo WhatsApp) y a los asesores.
 *
 *   node scripts/repartirCasosRecuperacion.js            → simula, no escribe
 *   node scripts/repartirCasosRecuperacion.js --aplicar  → reparte
 *   node scripts/repartirCasosRecuperacion.js --acceso --aplicar
 */
require('dotenv').config();
const { db } = require('../src/database/config');
const recuperacion = require('../src/services/recuperacion.service');

const APLICAR = process.argv.includes('--aplicar');
const ACCESO = process.argv.includes('--acceso');
const ASESORES = [1886, 2474, 2779]; // Johan Chico, Juan Garzón, Alexandra Quishpi
const ALEXANDRA = { id_sub_usuario: 2779, email: 'a.quishpi@imporfactorylatam.com', nombre: 'Alexandra Quishpi' };
const DEPTO_EXPERTOS = 7;

const q = (sql, replacements = [], type = db.QueryTypes.SELECT) => db.query(sql, { replacements, type });

async function darAcceso() {
  const [ya] = await q(`SELECT id FROM sub_usuarios_departamento WHERE id_departamento = ? AND id_sub_usuario = ?`, [DEPTO_EXPERTOS, ALEXANDRA.id_sub_usuario]);
  console.log(ya ? '· Ya estaba en el departamento de Expertos' : '· Se agrega al departamento de Expertos (asignación automática apagada, WhatsApp)');
  if (!ya && APLICAR) {
    await q(
      `INSERT INTO sub_usuarios_departamento (id_departamento, id_sub_usuario, asignacion_auto, canales) VALUES (?, ?, 0, 'wa')`,
      [DEPTO_EXPERTOS, ALEXANDRA.id_sub_usuario],
      db.QueryTypes.INSERT,
    );
  }
  console.log('· Se agrega (o reactiva) como asesora de recuperación');
  if (APLICAR) {
    await q(
      `INSERT INTO recuperacion_asesores_chat_center (id_sub_usuario, email, nombre, activo)
       VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE activo = 1`,
      [ALEXANDRA.id_sub_usuario, ALEXANDRA.email, ALEXANDRA.nombre],
      db.QueryTypes.INSERT,
    );
  }
}

(async () => {
  console.log(APLICAR ? '=== APLICANDO ===' : '=== SIMULACIÓN (agrega --aplicar para escribir) ===');
  if (ACCESO) await darAcceso();

  const subs = await q(
    `SELECT id_sub_usuario, COALESCE(NULLIF(TRIM(nombre_encargado), ''), usuario, email) AS nombre
       FROM sub_usuarios_chat_center WHERE id_sub_usuario IN (?)`,
    [ASESORES],
  );
  const nombre = new Map(subs.map((s) => [Number(s.id_sub_usuario), s.nombre.trim()]));
  if (nombre.size !== ASESORES.length) throw new Error('Falta algún subusuario de la lista ASESORES');

  // Casos abiertos sin asesor, con la cohorte actual del cliente.
  const filas = await recuperacion.clientesEnRiesgo();
  const porUsuario = new Map(filas.map((f) => [f.id_usuario, f]));
  const casos = (await q(`SELECT id_caso, id_usuario, cohorte FROM recuperacion_casos_chat_center WHERE estado = 'abierto' AND asignado_a_id IS NULL`))
    .map((c) => ({ ...c, f: porUsuario.get(c.id_usuario) || null }))
    .map((c) => ({ ...c, cohorte: c.f?.cohorte || c.cohorte || 'manual' }));

  const chats = await recuperacion.chatsExpertos(casos.map((c) => c.f?.whatsapp_digits));
  const total = new Map(ASESORES.map((a) => [a, 0]));
  const porCohorte = new Map();
  const cuenta = (a, coh) => {
    total.set(a, total.get(a) + 1);
    const k = `${coh}|${a}`;
    porCohorte.set(k, (porCohorte.get(k) || 0) + 1);
  };
  const plan = [];

  // 1) Ya conversa con uno de ellos
  const resto = [];
  for (const c of casos) {
    const chat = c.f?.whatsapp_digits ? chats.get(String(c.f.whatsapp_digits).slice(-9)) : null;
    if (chat?.encargado_id && ASESORES.includes(chat.encargado_id)) {
      plan.push({ ...c, asesor: chat.encargado_id, por: 'chat' });
      cuenta(chat.encargado_id, c.cohorte);
    } else resto.push(c);
  }

  // 2) Parejo por cohorte
  const prioridad = (coh) => recuperacion.COHORTES[coh]?.prioridad ?? 99;
  resto.sort((a, b) => prioridad(a.cohorte) - prioridad(b.cohorte) || a.id_caso - b.id_caso);
  for (const c of resto) {
    const elegido = [...ASESORES].sort(
      (a, b) => (porCohorte.get(`${c.cohorte}|${a}`) || 0) - (porCohorte.get(`${c.cohorte}|${b}`) || 0) || total.get(a) - total.get(b),
    )[0];
    plan.push({ ...c, asesor: elegido, por: 'reparto' });
    cuenta(elegido, c.cohorte);
  }

  // Resumen
  const cohortes = [...new Set(plan.map((p) => p.cohorte))].sort((a, b) => prioridad(a) - prioridad(b));
  console.log(`\nCasos abiertos sin asesor: ${casos.length}`);
  console.table(
    ASESORES.map((a) => ({
      asesor: nombre.get(a),
      total: total.get(a),
      por_su_chat: plan.filter((p) => p.asesor === a && p.por === 'chat').length,
      ...Object.fromEntries(cohortes.map((coh) => [coh, porCohorte.get(`${coh}|${a}`) || 0])),
    })),
  );

  if (!APLICAR) {
    console.log('\nNo se escribió nada. Corre con --aplicar para repartir.');
    process.exit(0);
  }
  let n = 0;
  for (const p of plan) {
    await q(
      `UPDATE recuperacion_casos_chat_center
          SET asignado_a_id = ?, asignado_a_nombre = ?, asignado_en = NOW()
        WHERE id_caso = ? AND estado = 'abierto' AND asignado_a_id IS NULL`,
      [p.asesor, nombre.get(p.asesor), p.id_caso],
      db.QueryTypes.UPDATE,
    );
    n += 1;
  }
  console.log(`\nListo: ${n} casos repartidos.`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
