// ════════════════════════════════════════════════════════════
// onboarding.service.js — avisos de arranque para cuentas que no han empezado.
//
// POR QUÉ EXISTE ESTE ARCHIVO
//
// Pedido 2026-10-22: quien entra por primera vez (o no ha avanzado) debe ver
// una invitación a agendar su implementación con el equipo comercial
// (Calendly). "No ha empezado" = tiene UNA conexión como máximo y ninguna
// está conectada: ni WhatsApp (id_telefono + id_whatsapp), ni Messenger ni
// Instagram. Quien ya tiene dos conexiones —aunque una esté sin conectar— ya
// pagó la segunda y maneja el sistema: no se le molesta.
//
// La respuesta del dueño se guarda por cuenta (no por navegador) en
// onboarding_avisos_chat_center: «agendó» y «no volver a mostrar» son
// definitivos; «no por ahora» pospone 3 días. La tabla se crea sola al
// primer uso (mismo patrón que recuperación); onboarding_avisos_migration.sql
// es solo registro.
// ════════════════════════════════════════════════════════════
'use strict';

const { db } = require('../database/config');

const AVISO_IMPLEMENTACION = 'agendar_implementacion';
const CALENDLY_IMPLEMENTACION =
  process.env.CALENDLY_IMPLEMENTACION_URL ||
  'https://calendly.com/comercial-imporchat/30min';
const POSPONER_DIAS = 3;

let tablaLista = false;
async function ensureTabla() {
  if (tablaLista) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS onboarding_avisos_chat_center (
      id INT AUTO_INCREMENT PRIMARY KEY,
      id_usuario INT NOT NULL,
      aviso VARCHAR(40) NOT NULL,
      estado ENUM('pendiente','pospuesto','agendado','descartado') NOT NULL DEFAULT 'pendiente',
      veces_mostrado INT NOT NULL DEFAULT 0,
      pospuesto_hasta DATETIME NULL,
      respondido_por INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY ux_usuario_aviso (id_usuario, aviso)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  tablaLista = true;
}

/* Cuántas conexiones vivas tiene la cuenta y cuántas están conectadas por
   cualquier canal. Misma definición que listarConexionesSubUser. */
async function resumenConexiones(id_usuario) {
  const [row] = await db.query(
    `SELECT COUNT(*) AS conexiones,
            SUM(
              (COALESCE(c.id_telefono,'') <> '' AND COALESCE(c.id_whatsapp,'') <> '')
              OR EXISTS (SELECT 1 FROM messenger_pages mp
                          WHERE mp.id_configuracion = c.id AND mp.subscribed = 1 AND mp.status = 'active')
              OR EXISTS (SELECT 1 FROM instagram_pages ip
                          WHERE ip.id_configuracion = c.id AND ip.subscribed = 1 AND ip.status = 'active')
            ) AS conectadas
       FROM configuraciones c
      WHERE c.id_usuario = ? AND c.suspendido = 0`,
    { replacements: [id_usuario], type: db.QueryTypes.SELECT },
  );
  return {
    conexiones: Number(row?.conexiones || 0),
    conectadas: Number(row?.conectadas || 0),
  };
}

/**
 * ¿Hay que mostrarle la invitación a agendar? Devuelve también por qué no,
 * para depurar desde el front sin adivinar.
 */
async function estadoImplementacion(id_usuario) {
  await ensureTabla();
  const [[dueno], conexiones, [aviso]] = await Promise.all([
    db.query(
      `SELECT nombre, email_propietario AS email, created_at FROM usuarios_chat_center WHERE id_usuario = ? LIMIT 1`,
      { replacements: [id_usuario], type: db.QueryTypes.SELECT },
    ),
    resumenConexiones(id_usuario),
    db.query(
      `SELECT estado, veces_mostrado, pospuesto_hasta FROM onboarding_avisos_chat_center
        WHERE id_usuario = ? AND aviso = ? LIMIT 1`,
      { replacements: [id_usuario, AVISO_IMPLEMENTACION], type: db.QueryTypes.SELECT },
    ),
  ]);

  const base = {
    mostrar: false,
    motivo: null,
    calendly_url: CALENDLY_IMPLEMENTACION,
    dueno: dueno ? { nombre: dueno.nombre || null, email: dueno.email || null } : null,
    conexiones,
    aviso: aviso || null,
  };
  if (!dueno) return { ...base, motivo: 'sin_cuenta' };
  if (conexiones.conexiones > 1) return { ...base, motivo: 'varias_conexiones' };
  if (conexiones.conectadas > 0) return { ...base, motivo: 'ya_conectado' };
  if (aviso?.estado === 'agendado') return { ...base, motivo: 'ya_agendo' };
  if (aviso?.estado === 'descartado') return { ...base, motivo: 'no_mostrar' };
  if (
    aviso?.estado === 'pospuesto' &&
    aviso.pospuesto_hasta &&
    new Date(aviso.pospuesto_hasta) > new Date()
  ) {
    return { ...base, motivo: 'pospuesto' };
  }
  return { ...base, mostrar: true, motivo: 'sin_empezar' };
}

/* Se llama cuando el modal se muestra: cuenta las veces (dato para medir). */
async function marcarMostrado(id_usuario) {
  await ensureTabla();
  await db.query(
    `INSERT INTO onboarding_avisos_chat_center (id_usuario, aviso, estado, veces_mostrado)
     VALUES (?, ?, 'pendiente', 1)
     ON DUPLICATE KEY UPDATE veces_mostrado = veces_mostrado + 1`,
    { replacements: [id_usuario, AVISO_IMPLEMENTACION], type: db.QueryTypes.INSERT },
  );
}

const ACCIONES = {
  agendo: { estado: 'agendado', pospuesto_hasta: null },
  no_por_ahora: { estado: 'pospuesto', pospuesto_hasta: 'POSPONER' },
  no_mostrar: { estado: 'descartado', pospuesto_hasta: null },
};

async function responderImplementacion({ id_usuario, accion, id_sub_usuario }) {
  const a = ACCIONES[accion];
  if (!a) throw new Error('Acción inválida: agendo | no_por_ahora | no_mostrar');
  await ensureTabla();
  await db.query(
    `INSERT INTO onboarding_avisos_chat_center
       (id_usuario, aviso, estado, pospuesto_hasta, respondido_por)
     VALUES (?, ?, ?, ${a.pospuesto_hasta ? `DATE_ADD(NOW(), INTERVAL ${POSPONER_DIAS} DAY)` : 'NULL'}, ?)
     ON DUPLICATE KEY UPDATE
       estado = VALUES(estado),
       pospuesto_hasta = VALUES(pospuesto_hasta),
       respondido_por = VALUES(respondido_por)`,
    {
      replacements: [id_usuario, AVISO_IMPLEMENTACION, a.estado, id_sub_usuario || null],
      type: db.QueryTypes.INSERT,
    },
  );
  return { estado: a.estado, posponer_dias: a.pospuesto_hasta ? POSPONER_DIAS : null };
}

module.exports = {
  AVISO_IMPLEMENTACION,
  CALENDLY_IMPLEMENTACION,
  estadoImplementacion,
  marcarMostrado,
  responderImplementacion,
};
