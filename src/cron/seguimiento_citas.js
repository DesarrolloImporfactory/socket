'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   Qué pasa con la tarjeta DESPUÉS de la cita.

   El tablero de servicios tenía el ciclo abierto: algo movía al cliente hasta
   "Cita agendada" y ahí se quedaba para siempre. "Asistió", "No asistió" y "En
   tratamiento" existían pero eran inalcanzables — nadie las tocaba salvo a mano.
   Sin esto, todo lo que viene después de la cita (saber si vino, agendar la
   siguiente sesión, recuperar al que faltó) simplemente no ocurría.

   Nadie marca la entrada al local, así que el sistema no puede SABER si vino.
   Lo que hace es, por orden de certeza:

     status = 'Completado' en la agenda  → Asistió      (alguien lo marcó)
     status = 'Cancelado'  en la agenda  → No asistió   (alguien lo marcó)
     nadie marcó nada y la cita ya pasó  → Asistió, y se le pregunta cómo le fue

   El tercer caso es un supuesto, no un hecho: si contesta que no pudo ir, el
   asistente de "Asistió" la corrige con [no_asistio]:true. Se prefiere asumir
   que vino porque el costo de equivocarse es un "¿cómo te fue?" a quien faltó,
   mientras que al revés se le reclama la falta a una clienta que sí vino.
   ──────────────────────────────────────────────────────────────────────────── */

const cron = require('node-cron');
const { db } = require('../database/config');

// Margen tras el fin de la cita: ni encima de la clienta saliendo del local,
// ni tan tarde que la pregunta llegue al día siguiente.
const MINUTOS_TRAS_LA_CITA = 90;

// Más allá de esto la cita es historia y remover la tarjeta solo confunde.
const HORAS_MAXIMO_ATRAS = 48;

async function withLock(lockName, fn) {
  const conn = await db.connectionManager.getConnection({ type: 'read' });
  try {
    const [row] = await db.query(`SELECT GET_LOCK(?, 1) AS got`, {
      replacements: [lockName],
      type: db.QueryTypes.SELECT,
    });
    if (!row || Number(row.got) !== 1) return;
    try {
      await fn();
    } finally {
      await db.query(`DO RELEASE_LOCK(?)`, {
        replacements: [lockName],
        type: db.QueryTypes.RAW,
      });
    }
  } finally {
    db.connectionManager.releaseConnection(conn);
  }
}

/* Citas ya pasadas cuyo cliente sigue esperando en "Cita agendada".
   Solo cuentas que tengan la columna destino: un tablero de dropshipping no
   tiene "asistio" y no debe verse afectado. */
const SQL_CITAS_CERRABLES = `
  SELECT a.id            AS id_cita,
         a.title         AS titulo,
         a.status        AS estado_cita,
         cal.account_id  AS id_configuracion,
         cli.id          AS id_cliente,
         cli.celular_cliente AS telefono,
         cli.nombre_cliente  AS nombre
    FROM appointments a
    JOIN calendars cal            ON cal.id = a.calendar_id
    JOIN appointment_invitees inv ON inv.appointment_id = a.id
    JOIN clientes_chat_center cli
      ON cli.id_configuracion = cal.account_id
     AND cli.celular_last9 = RIGHT(REGEXP_REPLACE(inv.phone, '[^0-9]', ''), 9)
   WHERE a.status IN ('Agendado', 'Confirmado', 'Completado', 'Cancelado')
     AND a.end_utc < UTC_TIMESTAMP() - INTERVAL ? MINUTE
     AND a.end_utc > UTC_TIMESTAMP() - INTERVAL ? HOUR
     AND cli.estado_contacto = 'cita_agendada'
     AND EXISTS (
           SELECT 1 FROM kanban_columnas kc
            WHERE kc.id_configuracion = cal.account_id
              AND kc.estado_db = 'asistio' AND kc.activo = 1
         )
     /* Si ya tiene otra cita por delante sigue siendo "Cita agendada": la que
        acaba de pasar era una sesión anterior o una reprogramación. */
     AND NOT EXISTS (
           SELECT 1
             FROM appointments a2
             JOIN calendars cal2 ON cal2.id = a2.calendar_id
             JOIN appointment_invitees i2 ON i2.appointment_id = a2.id
            WHERE cal2.account_id = cal.account_id
              AND RIGHT(REGEXP_REPLACE(i2.phone, '[^0-9]', ''), 9) = cli.celular_last9
              AND a2.status IN ('Agendado', 'Confirmado')
              AND a2.start_utc > UTC_TIMESTAMP()
         )
   GROUP BY a.id
   ORDER BY a.end_utc ASC
   LIMIT 200`;

async function cerrarCitasPasadas() {
  const citas = await db.query(SQL_CITAS_CERRABLES, {
    replacements: [MINUTOS_TRAS_LA_CITA, HORAS_MAXIMO_ATRAS],
    type: db.QueryTypes.SELECT,
  });

  if (!citas.length) return;

  const { programarRemarketingKanban } = require('../services/kanban_ia.service');

  for (const cita of citas) {
    try {
      const destino = cita.estado_cita === 'Cancelado' ? 'no_asistio' : 'asistio';

      await db.query(
        `UPDATE clientes_chat_center SET estado_contacto = ? WHERE id = ?`,
        { replacements: [destino, cita.id_cliente], type: db.QueryTypes.UPDATE },
      );

      console.log(
        `📋 Cita ${cita.id_cita} ("${cita.titulo}") cerrada · cliente=${cita.id_cliente} → ${destino} · marca en agenda="${cita.estado_cita}"`,
      );

      /* El cambio de columna no habla con nadie por sí solo. El seguimiento
         ("¿cómo te fue?", "¿reagendamos?") sale por el motor de remarketing de
         la columna a la que acaba de llegar. */
      await programarRemarketingKanban({
        id_configuracion: cita.id_configuracion,
        id_cliente: cita.id_cliente,
        telefono: cita.telefono,
        estado_contacto: destino,
      });
    } catch (err) {
      console.error(
        `❌ seguimiento_citas · cita ${cita.id_cita}: ${err.message}`,
      );
    }
  }
}

let corriendo = false;

cron.schedule('*/15 * * * *', async () => {
  if (corriendo) return;
  corriendo = true;
  try {
    await withLock('seguimiento_citas_cron_lock', cerrarCitasPasadas);
  } catch (err) {
    console.error('❌ seguimiento_citas:', err.message);
  } finally {
    corriendo = false;
  }
});

module.exports = { cerrarCitasPasadas };
