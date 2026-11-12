// ════════════════════════════════════════════════════════════
// onboarding.service.js — avisos de arranque para cuentas que no han empezado.
//
// POR QUÉ EXISTE ESTE ARCHIVO
//
// Pedido 2026-10-22: quien entra por primera vez (o no ha avanzado) debe ver
// una invitación a agendar su implementación con el equipo comercial.
// Hasta el 2026-11-04 abría un Calendly; ahora abre la agenda pública de
// ImporChat (/agendar, services/agenda_publica.service.js), que deja la
// reunión en la agenda del asesor y avisa por correo y WhatsApp.
// "No ha empezado" = tiene UNA conexión como máximo y ninguna
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

// ── Ajustes (a propósito en código y no en .env: nadie los va a tocar desde
//    el servidor; cuando cambien, cambian aquí con un commit) ──────────────
// Agenda del equipo comercial: la pública de ImporChat. El front le agrega la
// cuenta (u=) y los datos del dueño para prellenar el formulario.
const AGENDA_IMPLEMENTACION = '/agendar?origen=modal';
// Interruptor general: con la agenda llena, poner en false y desplegar. Las
// respuestas guardadas no se tocan; al volver a true cada cuenta sigue donde
// estaba.
const MODAL_ACTIVO = true;
// «No por ahora» → se vuelve a ofrecer a los N días.
const POSPONER_DIAS = 3;
// «Agendar» solo dice que ABRIÓ la agenda, no que reservó. Si a la semana
// sigue sin conectar nada, se le vuelve a ofrecer (con otro texto en el
// front). 7 y no 5: la cita suele caer dentro de la semana y a los 5 días
// podría salirle con la llamada ya agendada para el día siguiente.
const REOFRECER_TRAS_AGENDAR_DIAS = 7;

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
  const [[dueno], conexiones, [aviso], reserva] = await Promise.all([
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
    /* Reunión ya reservada en la agenda pública y todavía por venir: no se
       insiste aunque siga sin conectar nada (la va a conectar en la cita). */
    require('./agenda_publica.service')
      .reservaPendienteDeCuenta(id_usuario)
      .catch(() => null),
  ]);

  const base = {
    mostrar: false,
    motivo: null,
    agenda_url: AGENDA_IMPLEMENTACION,
    reserva: reserva ? { inicio: reserva.inicio } : null,
    dueno: dueno ? { nombre: dueno.nombre || null, email: dueno.email || null } : null,
    conexiones,
    aviso: aviso || null,
  };
  if (!MODAL_ACTIVO) return { ...base, motivo: 'desactivado' };
  if (!dueno) return { ...base, motivo: 'sin_cuenta' };
  if (conexiones.conexiones > 1) return { ...base, motivo: 'varias_conexiones' };
  if (conexiones.conectadas > 0) return { ...base, motivo: 'ya_conectado' };
  if (aviso?.estado === 'descartado') return { ...base, motivo: 'no_mostrar' };
  if (reserva) return { ...base, motivo: 'reunion_pendiente' };
  const enEspera =
    aviso?.pospuesto_hasta && new Date(aviso.pospuesto_hasta) > new Date();
  if (aviso?.estado === 'agendado') {
    // Abrió la agenda pero sigue sin conectar nada: a la semana se le vuelve
    // a ofrecer, con otro texto (el front mira el motivo).
    if (enEspera) return { ...base, motivo: 'ya_agendo' };
    return { ...base, mostrar: true, motivo: 'agendo_sin_avanzar' };
  }
  if (aviso?.estado === 'pospuesto' && enEspera) {
    return { ...base, motivo: 'pospuesto' };
  }
  return { ...base, mostrar: true, motivo: 'sin_empezar' };
}

/* Se llama cuando el modal se muestra: cuenta las veces (dato para medir). */
async function marcarMostrado(id_usuario, aviso = AVISO_IMPLEMENTACION) {
  await ensureTabla();
  await db.query(
    `INSERT INTO onboarding_avisos_chat_center (id_usuario, aviso, estado, veces_mostrado)
     VALUES (?, ?, 'pendiente', 1)
     ON DUPLICATE KEY UPDATE veces_mostrado = veces_mostrado + 1`,
    { replacements: [id_usuario, aviso], type: db.QueryTypes.INSERT },
  );
}

// ════════════════════════════════════════════════════════════
// Oferta del complemento ImporKiller (pedido 2026-11-11, tras la clase donde
// se mostró la herramienta).
//
// Sale CADA VEZ que el administrador entra (la X solo lo oculta en esa sesión
// del navegador) hasta que lo compra o pulsa «No volver a mostrar». Solo a
// cuentas que pueden activarlo con un clic: suscripción de Stripe viva
// (active o trialing), porque «Obtenerlo ahora» llama a comprarAddon y suma
// el complemento al plan con la tarjeta guardada. Sin suscripción la compra
// respondería NO_SUBSCRIPTION: a esas cuentas ya las empuja el modal de
// planes y no se les encima otro. Tampoco sale a quien debe (past_due), a las
// cuentas permanentes (lo tienen incluido) ni a quien ya lo tiene.
//
// Reutiliza onboarding_avisos_chat_center con aviso = 'imporkiller_addon':
// descartado = «No volver a mostrar»; veces_mostrado mide el alcance.
// Conversión: cuentas con fila de este aviso y usuarios_chat_center.imporkiller = 1.
// ════════════════════════════════════════════════════════════
const AVISO_IMPORKILLER = 'imporkiller_addon';
// Interruptor general de la oferta (en código, como MODAL_ACTIVO).
const MODAL_IMPORKILLER_ACTIVO = true;
const PRECIO_IMPORKILLER = 10;

async function estadoImporKiller(id_usuario) {
  await ensureTabla();
  const base = { mostrar: false, motivo: null, precio: PRECIO_IMPORKILLER, en_trial: false };
  if (!MODAL_IMPORKILLER_ACTIVO) return { ...base, motivo: 'desactivado' };

  const [[cuenta], [aviso]] = await Promise.all([
    db.query(
      `SELECT permanente, imporkiller, estado, stripe_subscription_id, stripe_subscription_status
         FROM usuarios_chat_center WHERE id_usuario = ? LIMIT 1`,
      { replacements: [id_usuario], type: db.QueryTypes.SELECT },
    ),
    db.query(
      `SELECT estado, veces_mostrado FROM onboarding_avisos_chat_center
        WHERE id_usuario = ? AND aviso = ? LIMIT 1`,
      { replacements: [id_usuario, AVISO_IMPORKILLER], type: db.QueryTypes.SELECT },
    ),
  ]);

  if (!cuenta) return { ...base, motivo: 'sin_cuenta' };
  if (Number(cuenta.imporkiller || 0) > 0) return { ...base, motivo: 'ya_lo_tiene' };
  if (Number(cuenta.permanente) === 1) return { ...base, motivo: 'incluido' };
  if (!cuenta.stripe_subscription_id) return { ...base, motivo: 'sin_suscripcion' };
  // Filas viejas sin stripe_subscription_status: se cae al estado de la cuenta.
  const estadoSub = String(cuenta.stripe_subscription_status || '').toLowerCase();
  const viva = estadoSub
    ? ['active', 'trialing'].includes(estadoSub)
    : cuenta.estado === 'activo';
  if (!viva) return { ...base, motivo: 'suscripcion_no_activa' };
  if (aviso?.estado === 'descartado') return { ...base, motivo: 'no_mostrar' };

  return {
    ...base,
    mostrar: true,
    motivo: 'oferta',
    // En prueba comprarAddon no cobra hoy: se factura con el plan al terminar.
    en_trial: estadoSub === 'trialing',
    veces_mostrado: Number(aviso?.veces_mostrado || 0),
  };
}

/* «No volver a mostrar» de la oferta de ImporKiller. */
async function descartarImporKiller({ id_usuario, id_sub_usuario }) {
  await ensureTabla();
  await db.query(
    `INSERT INTO onboarding_avisos_chat_center (id_usuario, aviso, estado, respondido_por)
     VALUES (?, ?, 'descartado', ?)
     ON DUPLICATE KEY UPDATE estado = 'descartado', respondido_por = VALUES(respondido_por)`,
    {
      replacements: [id_usuario, AVISO_IMPORKILLER, id_sub_usuario || null],
      type: db.QueryTypes.INSERT,
    },
  );
  return { estado: 'descartado' };
}

// dias = en cuántos días se vuelve a ofrecer si sigue sin avanzar (null = nunca).
const ACCIONES = {
  agendo: { estado: 'agendado', dias: REOFRECER_TRAS_AGENDAR_DIAS },
  no_por_ahora: { estado: 'pospuesto', dias: POSPONER_DIAS },
  no_mostrar: { estado: 'descartado', dias: null },
};

async function responderImplementacion({ id_usuario, accion, id_sub_usuario }) {
  const a = ACCIONES[accion];
  if (!a) throw new Error('Acción inválida: agendo | no_por_ahora | no_mostrar');
  await ensureTabla();
  await db.query(
    `INSERT INTO onboarding_avisos_chat_center
       (id_usuario, aviso, estado, pospuesto_hasta, respondido_por)
     VALUES (?, ?, ?, ${a.dias ? `DATE_ADD(NOW(), INTERVAL ${Number(a.dias)} DAY)` : 'NULL'}, ?)
     ON DUPLICATE KEY UPDATE
       estado = VALUES(estado),
       pospuesto_hasta = VALUES(pospuesto_hasta),
       respondido_por = VALUES(respondido_por)`,
    {
      replacements: [id_usuario, AVISO_IMPLEMENTACION, a.estado, id_sub_usuario || null],
      type: db.QueryTypes.INSERT,
    },
  );
  return { estado: a.estado, posponer_dias: a.dias };
}

/* La agenda pública avisa que la cuenta RESERVÓ de verdad (no solo abrió la
   agenda): el modal no vuelve a salir hasta pasada la cita. */
async function marcarReservaHecha(id_usuario, hasta) {
  await ensureTabla();
  await db.query(
    `INSERT INTO onboarding_avisos_chat_center (id_usuario, aviso, estado, pospuesto_hasta)
     VALUES (?, ?, 'agendado', ?)
     ON DUPLICATE KEY UPDATE estado = 'agendado', pospuesto_hasta = VALUES(pospuesto_hasta)`,
    { replacements: [id_usuario, AVISO_IMPLEMENTACION, hasta], type: db.QueryTypes.INSERT },
  );
}

module.exports = {
  AVISO_IMPLEMENTACION,
  AGENDA_IMPLEMENTACION,
  marcarReservaHecha,
  estadoImplementacion,
  marcarMostrado,
  responderImplementacion,
  AVISO_IMPORKILLER,
  estadoImporKiller,
  descartarImporKiller,
};
