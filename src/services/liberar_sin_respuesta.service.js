/**
 * Libera a «En espera» los chats que el vendedor no respondió a tiempo.
 *
 * Regla (pedida para la configuración 242): si el cliente escribió y el
 * vendedor asignado no le responde en 3 HORAS HÁBILES (lunes a viernes de
 * 8:00 a 17:00, hora de Ecuador), el chat se desasigna y queda en
 * «En espera» para que lo tome otro vendedor.
 *
 * Cómo se decide que un chat está esperando — y por qué no se usa
 * vista_chats.mensaje_rol:
 *
 *   El trigger trg_ultimo_mensaje copia en clientes_chat_center el rol del
 *   ÚLTIMO mensaje insertado, sea cual sea. Una notificación interna ("X te
 *   transfirió este chat", rol 3) o una plantilla automática ("tu cuota está
 *   vencida", rol 1) pisan el dato y el chat deja de verse como "cliente
 *   esperando" aunque nadie le haya contestado. Por eso acá se mira
 *   mensajes_clientes directamente:
 *
 *     - última respuesta HUMANA: rol 1 que no sea automático (ver
 *       esAutomatico). Ante la duda cuenta como humana: equivocarse para ese
 *       lado deja un chat con su dueño; equivocarse al revés le quitaría un
 *       chat a alguien que sí respondió.
 *     - inicio de la espera: el PRIMER mensaje del cliente posterior a esa
 *       respuesta (no el último: si no, un cliente que escribe seguido
 *       reiniciaría el reloj con cada mensaje).
 *
 * El reloj arranca en lo más tarde entre el inicio de la espera y el momento
 * en que el dueño actual recibió el chat. Sin eso, un chat liberado que otro
 * vendedor toma vendría con horas acumuladas y se le volvería a quitar en la
 * siguiente pasada.
 *
 * «Solo desde que se active»: únicamente cuentan los mensajes del cliente
 * posteriores a ACTIVO_DESDE. Los chats que ya estaban esperando al
 * activarse se quedan con su dueño (eran ~515 en la 242 el 2026-09-22).
 *
 * Idempotente y seguro con varias instancias: el UPDATE exige que el chat
 * siga con el mismo dueño y sin respuesta humana nueva, y el historial solo
 * se escribe si ese UPDATE cambió la fila. No hace falta un lock.
 *
 * No se inserta una notificación en el chat al liberarlo: por el mismo
 * trigger, taparía que el cliente sigue esperando y el chat dejaría de verse
 * en rojo en «En espera». El movimiento queda en historial_encargados.
 */
const { db } = require('../database/config');
const dashboardEmitter = require('../controllers/dashboardEmitter');
const {
  enviarConsultaAPI,
} = require('../utils/webhook_whatsapp/enviar_consulta_socket');

const CONFIG = {
  configuraciones: [242],
  horasLimite: 3,
  horaInicio: 8, // 08:00
  horaFin: 17, // 17:00
  diasHabiles: [1, 2, 3, 4, 5], // lunes a viernes (0 = domingo)
  offsetMinutos: -5 * 60, // Ecuador, sin horario de verano

  /* Mensajes del cliente anteriores a esta fecha no cuentan. Ajustar a la
     fecha real de despliegue; también se puede fijar con la variable de
     entorno LIBERAR_SIN_RESPUESTA_DESDE ("YYYY-MM-DD HH:mm:ss", hora Ecuador). */
  activoDesde:
    process.env.LIBERAR_SIN_RESPUESTA_DESDE || '2026-09-23 08:00:00',
};

/** Motivo en historial_encargados. El round robin lo busca por este texto. */
const MOTIVO_LIBERADO = 'Sin respuesta en 3 horas hábiles: devuelto a En espera';

/* Remitentes automáticos (columna `responsable`). Todo lo demás en rol 1 se
   toma como respuesta de una persona: el nombre del vendedor, «Whatsapp
   Business» (contestó desde el celular), «Messenger Inbox», etc. */
const PREFIJOS_AUTOMATICOS = ['IA\\_%', 'cron\\_%'];
const RESPONSABLES_AUTOMATICOS = [
  'CRM Ventas',
  'Dropi Status',
  'Aliclik Status',
  'Bot Confirmación',
  'Sistema de valoraciones',
  'Shopify Confirmación',
  'Shopify Recovery',
  'Automatizador | Cotizador Pro',
  'Encuesta Link Público',
  'Aviso calendario',
  'Agenda',
  'sistema',
];

/** Fragmento SQL: el mensaje `m` es una respuesta humana. */
const SQL_RESPUESTA_HUMANA = `
  m.rol_mensaje = 1
  AND m.deleted_at IS NULL
  AND m.tipo_mensaje <> 'revoke'
  AND NOT (
    m.responsable IS NOT NULL AND (
      ${PREFIJOS_AUTOMATICOS.map(() => 'm.responsable LIKE ?').join(' OR ')}
      OR m.responsable IN (${RESPONSABLES_AUTOMATICOS.map(() => '?').join(', ')})
    )
  )`;
const PARAMS_RESPUESTA_HUMANA = [
  ...PREFIJOS_AUTOMATICOS,
  ...RESPONSABLES_AUTOMATICOS,
];

/** Misma regla que SQL_RESPUESTA_HUMANA pero en memoria (dashboard de atención). */
function esResponsableAutomatico(responsable) {
  if (!responsable) return false;
  const r = String(responsable).trim();
  if (/^(IA_|cron_)/i.test(r)) return true;
  return RESPONSABLES_AUTOMATICOS.some(
    (a) => a.toLowerCase() === r.toLowerCase(),
  );
}

/* ── "Atendido" (cronómetro y dashboard de atención) ──
   Distinto de "humano": acá el bot (IA_*) SÍ cuenta como respuesta, porque
   si el bot le contestó al cliente, el cliente no está esperando. Lo único
   que no cierra la espera son los envíos que no responden a nadie: las
   plantillas del cron, los avisos de Dropi/Shopify, el remarketing, etc.
   liberar_sin_respuesta sigue usando la versión humana: ahí la pregunta es
   otra (si el vendedor asignado atendió). */
const PREFIJOS_NO_RESPUESTA = ['cron\\_%'];
const SQL_RESPUESTA_ATENDIDA = `
  m.rol_mensaje = 1
  AND m.deleted_at IS NULL
  AND m.tipo_mensaje <> 'revoke'
  AND NOT (
    m.responsable IS NOT NULL AND (
      ${PREFIJOS_NO_RESPUESTA.map(() => 'm.responsable LIKE ?').join(' OR ')}
      OR m.responsable IN (${RESPONSABLES_AUTOMATICOS.map(() => '?').join(', ')})
    )
  )`;
const PARAMS_RESPUESTA_ATENDIDA = [
  ...PREFIJOS_NO_RESPUESTA,
  ...RESPONSABLES_AUTOMATICOS,
];

/** Envío que no es respuesta a nadie (cron, avisos automáticos). */
function esRemitenteNoRespuesta(responsable) {
  if (!responsable) return false;
  const r = String(responsable).trim();
  if (/^cron_/i.test(r)) return true;
  return RESPONSABLES_AUTOMATICOS.some(
    (a) => a.toLowerCase() === r.toLowerCase(),
  );
}

/** Respuesta del bot de IA. */
const esBot = (responsable) => /^IA_/i.test(String(responsable || '').trim());

/* ── Tiempo ──────────────────────────────────────────────────────────── */

const MS_MIN = 60_000;
const MS_DIA = 24 * 60 * MS_MIN;

/** "YYYY-MM-DD HH:mm:ss" en hora de Ecuador (como devuelve la base) → ms. */
function parseFechaBD(valor) {
  if (!valor) return null;
  if (valor instanceof Date) return valor.getTime();
  const texto = String(valor).trim().replace(' ', 'T');
  const conZona = /[zZ]|[+-]\d{2}:?\d{2}$/.test(texto) ? texto : `${texto}-05:00`;
  const ms = new Date(conZona).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Minutos hábiles entre dos instantes: solo cuenta lo que cae dentro de la
 * ventana horaria en días hábiles. Se trabaja en "hora local como si fuera
 * UTC" (desplazando el offset) para cortar los días en la medianoche de
 * Ecuador sin depender de la zona del servidor.
 */
function minutosHabiles(desdeMs, hastaMs, cfg = CONFIG) {
  if (desdeMs == null || hastaMs == null || hastaMs <= desdeMs) return 0;
  const aLocal = (ms) => ms + cfg.offsetMinutos * MS_MIN;
  const desde = aLocal(desdeMs);
  const hasta = aLocal(hastaMs);

  let total = 0;
  for (let dia = Math.floor(desde / MS_DIA) * MS_DIA; dia < hasta; dia += MS_DIA) {
    if (!cfg.diasHabiles.includes(new Date(dia).getUTCDay())) continue;
    const abre = Math.max(desde, dia + cfg.horaInicio * 60 * MS_MIN);
    const cierra = Math.min(hasta, dia + cfg.horaFin * 60 * MS_MIN);
    if (cierra > abre) total += (cierra - abre) / MS_MIN;
  }
  return total;
}

/* ── Consulta ────────────────────────────────────────────────────────── */

/**
 * Chats asignados de las configuraciones habilitadas con un cliente
 * esperando desde después de ACTIVO_DESDE, con los datos para el reloj.
 * El filtro de horas hábiles se hace en JS (minutosHabiles).
 */
async function buscarCandidatos(cfg = CONFIG) {
  return db.query(
    `
    SELECT x.*,
      (SELECT MIN(m.created_at)
         FROM mensajes_clientes m
        WHERE m.celular_recibe = x.id
          AND m.id_configuracion = x.id_configuracion
          AND m.rol_mensaje = 0
          AND m.deleted_at IS NULL
          AND m.created_at >= ?
          AND m.created_at > COALESCE(x.ultima_respuesta, '1970-01-01')
      ) AS inicio_espera
    FROM (
      SELECT c.id, c.id_configuracion, c.id_encargado, c.id_departamento,
        (SELECT MAX(m.created_at)
           FROM mensajes_clientes m
          WHERE m.celular_recibe = c.id
            AND m.id_configuracion = c.id_configuracion
            AND ${SQL_RESPUESTA_HUMANA}
        ) AS ultima_respuesta
      FROM clientes_chat_center c
      WHERE c.id_configuracion IN (?)
        AND c.propietario <> 1
        AND c.chat_cerrado = 0
        AND c.id_encargado IS NOT NULL
        AND c.deleted_at IS NULL
        AND c.ultimo_mensaje_at >= ?
        ${cfg.soloChat ? 'AND c.id = ?' : ''}
    ) x
    HAVING inicio_espera IS NOT NULL
    `,
    {
      replacements: [
        cfg.activoDesde,
        ...PARAMS_RESPUESTA_HUMANA,
        cfg.configuraciones,
        cfg.activoDesde,
        // soloChat: únicamente para scripts/probarLiberarSinRespuesta.js
        ...(cfg.soloChat ? [cfg.soloChat] : []),
      ],
      type: db.QueryTypes.SELECT,
    },
  );
}

/**
 * Cuándo recibió cada chat a su dueño actual (última fila del historial con
 * ese encargado como nuevo). Va en UNA consulta y solo para los chats que ya
 * vencerían contando desde la espera: historial_encargados no tiene índice
 * por id_cliente_chat_center (ver historial_encargados_idx_cliente_migration
 * .sql) y una subconsulta por chat recorría la tabla entera cada vez —
 * 46 s para 815 chats de la 242, medido el 2026-09-22.
 */
async function fechasAsignacion(chats) {
  const mapa = new Map();
  if (!chats.length) return mapa;
  const filas = await db.query(
    `SELECT id_cliente_chat_center AS id, id_encargado_nuevo AS enc,
            MAX(fecha_registro) AS asignado_at
       FROM historial_encargados
      WHERE id_cliente_chat_center IN (?)
      GROUP BY id_cliente_chat_center, id_encargado_nuevo`,
    {
      replacements: [chats.map((c) => c.id)],
      type: db.QueryTypes.SELECT,
    },
  );
  for (const f of filas) mapa.set(`${f.id}:${f.enc}`, f.asignado_at);
  return mapa;
}

/**
 * Aplica el reloj y devuelve los chats que ya se pasaron del límite.
 *
 * Dos pasos: primero se cuenta desde el inicio de la espera, que sale gratis
 * de la consulta. La fecha de asignación solo puede ATRASAR el reloj, nunca
 * adelantarlo, así que un chat que no vence contando desde la espera tampoco
 * vence con ella; solo a los que sí vencen se les busca la asignación.
 */
async function vencidos(candidatos, ahoraMs = Date.now(), cfg = CONFIG) {
  const limite = cfg.horasLimite * 60;
  const reloj = (c, asignado_at) => {
    const desde = Math.max(
      parseFechaBD(c.inicio_espera) ?? 0,
      parseFechaBD(asignado_at) ?? 0,
    );
    return minutosHabiles(desde, ahoraMs, cfg);
  };

  const posibles = candidatos.filter((c) => reloj(c, null) >= limite);
  const asignaciones = await fechasAsignacion(posibles);

  return posibles
    .map((c) => {
      const asignado_at = asignaciones.get(`${c.id}:${c.id_encargado}`) ?? null;
      return { ...c, asignado_at, minutos_habiles: reloj(c, asignado_at) };
    })
    .filter((c) => c.minutos_habiles >= limite);
}

/* ── Liberación ──────────────────────────────────────────────────────── */

/**
 * Desasigna un chat. Devuelve true solo si ESTA llamada lo liberó: si en el
 * medio alguien respondió, lo tomó o lo cerró, el UPDATE no afecta filas y
 * no se toca el historial.
 */
async function liberarChat(chat) {
  const [, filas] = await db.query(
    `UPDATE clientes_chat_center c
        SET c.id_encargado = NULL
      WHERE c.id = ?
        AND c.id_encargado = ?
        AND c.chat_cerrado = 0
        AND NOT EXISTS (
          SELECT 1 FROM mensajes_clientes m
           WHERE m.celular_recibe = c.id
             AND m.created_at > ?
             AND ${SQL_RESPUESTA_HUMANA}
        )`,
    {
      replacements: [
        chat.id,
        chat.id_encargado,
        chat.inicio_espera,
        ...PARAMS_RESPUESTA_HUMANA,
      ],
      type: db.QueryTypes.UPDATE,
    },
  );
  if (!filas) return false;

  await db.query(
    `INSERT INTO historial_encargados
       (id_cliente_chat_center, id_departamento_asginado,
        id_encargado_anterior, id_encargado_nuevo, motivo)
     VALUES (?, ?, ?, NULL, ?)`,
    {
      replacements: [
        chat.id,
        chat.id_departamento ?? null,
        chat.id_encargado,
        MOTIVO_LIBERADO,
      ],
      type: db.QueryTypes.INSERT,
    },
  );
  return true;
}

/**
 * Una pasada completa. Con `dryRun` solo calcula y devuelve lo que liberaría,
 * sin escribir nada (sirve para revisar contra datos reales). `cfg` permite
 * otra configuración u otro límite; solo lo usa
 * scripts/probarLiberarSinRespuesta.js; el cron siempre usa CONFIG.
 */
async function ejecutarPasada({
  dryRun = false,
  ahoraMs = Date.now(),
  cfg = CONFIG,
} = {}) {
  const candidatos = await buscarCandidatos(cfg);
  const aLiberar = await vencidos(candidatos, ahoraMs, cfg);
  if (dryRun) return { candidatos: candidatos.length, aLiberar, liberados: [] };

  const liberados = [];
  for (const chat of aLiberar) {
    try {
      if (await liberarChat(chat)) liberados.push(chat);
    } catch (err) {
      console.error(
        `[liberar-sin-respuesta] chat ${chat.id}: ${err.message}`,
      );
    }
  }

  // Refresca las listas abiertas: el chat sale de «Mis chats» del vendedor
  // y aparece en «En espera» de los demás.
  const configsTocadas = new Set();
  for (const chat of liberados) {
    configsTocadas.add(chat.id_configuracion);
    enviarConsultaAPI(chat.id_configuracion, chat.id);
  }
  for (const id of configsTocadas) {
    dashboardEmitter.emitByConfig(id, 'chat_transferred');
  }

  return { candidatos: candidatos.length, aLiberar, liberados };
}

/**
 * Para el round robin: si el último movimiento del chat fue una liberación
 * por falta de respuesta, devuelve a quién se le quitó, para no dárselo de
 * nuevo. Deja de aplicar en cuanto el chat pasa por otras manos.
 */
async function vendedorExcluido(id_cliente) {
  const [ultimo] = await db.query(
    `SELECT motivo, id_encargado_anterior
       FROM historial_encargados
      WHERE id_cliente_chat_center = ?
      ORDER BY id DESC
      LIMIT 1`,
    { replacements: [id_cliente], type: db.QueryTypes.SELECT },
  );
  return ultimo?.motivo === MOTIVO_LIBERADO
    ? Number(ultimo.id_encargado_anterior) || null
    : null;
}

module.exports = {
  CONFIG,
  MOTIVO_LIBERADO,
  SQL_RESPUESTA_HUMANA,
  PARAMS_RESPUESTA_HUMANA,
  SQL_RESPUESTA_ATENDIDA,
  PARAMS_RESPUESTA_ATENDIDA,
  esResponsableAutomatico,
  esRemitenteNoRespuesta,
  esBot,
  minutosHabiles,
  parseFechaBD,
  vencidos,
  ejecutarPasada,
  vendedorExcluido,
};
