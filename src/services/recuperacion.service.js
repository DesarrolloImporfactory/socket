'use strict';

const { db } = require('../database/config');
const { ensureUnifiedClient } = require('../utils/unified/ensureUnifiedClient');

/**
 * Recuperación de clientes: el embudo de cuentas en riesgo, los casos que se
 * abren y cierran sobre ellas y las métricas del trabajo de los asesores.
 *
 * Pedido 2026-10-12: los asesores de la conexión de soporte "expertos" dan
 * seguimiento a los clientes de ImporChat que están por irse (cancelación
 * programada, renovación rebotada, vencidos, trial por vencer, cancelados
 * recientes). Necesitan una sola pantalla con quién hay que llamar hoy, qué
 * se le dijo, qué prometió, y al final cuánto se recuperó.
 *
 * Fuente: usuarios_chat_center (estado + campos de Stripe que ya mantiene el
 * webhook). No se consulta Stripe en vivo: el embudo debe abrir en <1 s.
 *
 * Casos: cada cliente que entra a una cohorte abre un caso (una fila en
 * recuperacion_casos_chat_center). El caso vive mientras el cliente siga en
 * riesgo; cuando sale del embudo, el sistema lo cierra solo: 'recuperado' si
 * quedó activo, 'perdido' si quedó cancelado/vencido/sin plan. Así la métrica
 * de recuperación no depende de que el asesor recuerde marcarla, y el monto
 * recuperado es el precio del plan que estaba en juego al abrir el caso.
 */

const COHORTES = {
  pago_rebotado: {
    label: 'Pago rebotado',
    descripcion: 'Renovación que Stripe no pudo cobrar o cuenta suspendida. Pagar la factura abierta la reactiva.',
    prioridad: 1,
    color: 'rose',
    icon: 'bx-credit-card-front',
  },
  cancelacion_programada: {
    label: 'Cancelación programada',
    descripcion: 'Pidió cancelar y sigue activo hasta que termine el periodo. Aún se puede retener.',
    prioridad: 2,
    color: 'amber',
    icon: 'bx-calendar-x',
  },
  vencido: {
    label: 'Vencido',
    descripcion: 'El plan venció en los últimos 60 días y no renovó.',
    prioridad: 3,
    color: 'orange',
    icon: 'bx-time',
  },
  cancelado_reciente: {
    label: 'Cancelado (30 días)',
    descripcion: 'Canceló hace menos de 30 días. Ventana para recuperarlo.',
    prioridad: 4,
    color: 'slate',
    icon: 'bx-user-x',
  },
  // Mismas definiciones que "Trial Stripe" y "Acceso manual (sin tarjeta)" del
  // dashboard admin (metricas.service COND_TRIAL_STRIPE / COND_ACCESO_MANUAL):
  // el área comercial les da seguimiento para que lleguen a pagar.
  en_prueba: {
    label: 'En prueba (con tarjeta)',
    descripcion: 'Stripe ya tiene su tarjeta y está en trial: al terminar cobra solo. Meta: que el primer cobro pase y se quede.',
    prioridad: 5,
    color: 'cyan',
    icon: 'bx-hourglass',
  },
  sin_tarjeta: {
    label: 'Sin tarjeta (acceso manual)',
    descripcion: 'Plan activo sin tarjeta: cortesía del curso o acceso manual. Meta: que capture tarjeta o pague antes de que venza.',
    prioridad: 6,
    color: 'violet',
    icon: 'bx-credit-card',
  },
};

// Qué quedó siendo el cliente cuando el sistema cerró el caso. Permite medir
// "cuántos llegaron a pagar" y "cuántos empezaron la prueba" por cohorte.
const ESTADO_FINAL = {
  pago: 'Pagando (Stripe activo)',
  prueba: 'Empezó la prueba',
  activo_otro: 'Activo sin Stripe',
  cancelado: 'Canceló',
  vencido: 'Venció',
  sin_plan: 'Sin plan',
  manual: 'Cerrado a mano',
  sin_cuenta: 'Cuenta eliminada',
};

const ESTADOS_CASO = ['abierto', 'recuperado', 'perdido', 'descartado'];

// ── Tablas ──────────────────────────────────────────────────────────────
// CREATE IF NOT EXISTS: idempotente y es lo mismo que recuperacion_migration.sql.
let tablasListas = false;
async function ensureTablas() {
  if (tablasListas) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS recuperacion_asesores_chat_center (
      id INT AUTO_INCREMENT PRIMARY KEY,
      id_sub_usuario INT NOT NULL,
      email VARCHAR(190) NULL,
      nombre VARCHAR(190) NULL,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      agregado_por INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_sub (id_sub_usuario)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS recuperacion_casos_chat_center (
      id_caso INT AUTO_INCREMENT PRIMARY KEY,
      id_usuario INT NOT NULL,
      cohorte VARCHAR(40) NOT NULL,
      estado ENUM('abierto','recuperado','perdido','descartado') NOT NULL DEFAULT 'abierto',
      monto_plan DECIMAL(10,2) NULL,
      asignado_a_id INT NULL,
      asignado_a_nombre VARCHAR(190) NULL,
      asignado_en DATETIME NULL,
      abierto_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      cerrado_en DATETIME NULL,
      cerrado_por VARCHAR(190) NULL,
      cierre_motivo VARCHAR(255) NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY ix_usuario_estado (id_usuario, estado),
      KEY ix_estado_cerrado (estado, cerrado_en),
      KEY ix_asignado (asignado_a_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // estado_final llegó después (12-10, tarde): en qué quedó el cliente al
  // cerrar. MySQL no tiene ADD COLUMN IF NOT EXISTS, así que se mira antes.
  const col = await db.query(
    `SHOW COLUMNS FROM recuperacion_casos_chat_center LIKE 'estado_final'`,
    { type: db.QueryTypes.SELECT },
  );
  if (!col.length) {
    await db.query(
      `ALTER TABLE recuperacion_casos_chat_center
         ADD COLUMN estado_final VARCHAR(30) NULL AFTER cierre_motivo`,
    );
  }
  tablasListas = true;
}

// ── Embudo ──────────────────────────────────────────────────────────────
// Un cliente puede cumplir varias condiciones; se queda con la más urgente
// (el orden del CASE es la prioridad). Permanentes (cortesía VIP) fuera: no
// pagan ni se les cobra.
const SQL_COHORTES = `
  SELECT * FROM (
    SELECT u.id_usuario, u.nombre AS empresa, u.email_propietario AS email,
           u.whatsapp_lead, u.whatsapp_lead_pais,
           u.id_plan, p.nombre_plan, p.precio_plan,
           u.estado, u.stripe_subscription_status AS stripe_status,
           u.stripe_subscription_id, u.cancel_at_period_end, u.cancel_at,
           u.fecha_renovacion, u.trial_end, u.canceled_at,
           u.created_at AS registrado_en,
           cx.telefono AS telefono_conexion,
           cx.nombre_configuracion AS nombre_conexion,
           CASE
             WHEN u.estado = 'suspendido'
               OR (COALESCE(u.stripe_subscription_id, '') <> ''
                   AND u.stripe_subscription_status IN ('past_due','unpaid')) THEN 'pago_rebotado'
             WHEN u.cancel_at_period_end = 1 AND u.estado = 'activo'
               AND (u.cancel_at IS NULL OR u.cancel_at >= NOW())
               AND COALESCE(u.stripe_subscription_status, '') <> 'canceled' THEN 'cancelacion_programada'
             WHEN u.estado = 'vencido'
               AND u.fecha_renovacion >= DATE_SUB(NOW(), INTERVAL 60 DAY) THEN 'vencido'
             WHEN u.estado = 'cancelado'
               AND u.canceled_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 'cancelado_reciente'
             WHEN u.estado = 'activo' AND COALESCE(u.stripe_subscription_id, '') <> ''
               AND u.stripe_subscription_status = 'trialing' THEN 'en_prueba'
             WHEN u.estado = 'activo' AND u.id_plan IS NOT NULL
               AND (COALESCE(u.stripe_subscription_id, '') = ''
                    OR u.stripe_subscription_status IS NULL
                    OR u.stripe_subscription_status NOT IN ('active','trialing'))
               AND (u.fecha_renovacion IS NULL OR u.fecha_renovacion > NOW()) THEN 'sin_tarjeta'
             ELSE NULL
           END AS cohorte
      FROM usuarios_chat_center u
      LEFT JOIN planes_chat_center p ON p.id_plan = u.id_plan
      -- Primera conexión activa de cada cuenta. Dos subconsultas
      -- correlacionadas por fila costaban ~550 ms de los ~700 del embudo.
      LEFT JOIN (
        SELECT c1.id_usuario, c1.telefono, c1.nombre_configuracion
          FROM configuraciones c1
          JOIN (SELECT id_usuario, MIN(id) AS id FROM configuraciones WHERE suspendido = 0 GROUP BY id_usuario) m
            ON m.id = c1.id
      ) cx ON cx.id_usuario = u.id_usuario
     WHERE COALESCE(u.permanente, 0) = 0
       AND COALESCE(p.nombre_plan, '') NOT LIKE '%TEST%'
  ) t
  WHERE t.cohorte IS NOT NULL`;

const fechaClaveDe = (r) => {
  switch (r.cohorte) {
    case 'cancelacion_programada':
      return r.cancel_at || r.fecha_renovacion;
    case 'en_prueba':
      return r.trial_end || r.fecha_renovacion;
    case 'cancelado_reciente':
      return r.canceled_at;
    default:
      return r.fecha_renovacion;
  }
};

const diasHasta = (fecha) => {
  if (!fecha) return null;
  const ms = new Date(fecha).getTime() - Date.now();
  return Math.round(ms / 86400000);
};

// Número al que el asesor puede escribir, en dígitos E.164 sin "+".
// `whatsapp_lead` es el WhatsApp PERSONAL del dueño de la cuenta (lo pide el
// registro) y viene local (0969…) con el país aparte (+593). Si no lo cargó,
// se usa el número de su conexión de ImporChat: es el del bot, sirve para
// llamar, pero un mensaje de API a API puede no entregarse. El front lo dice.
const digitsDe = (pais, numero) => {
  const n = String(numero || '').replace(/\D/g, '');
  if (!n) return null;
  const cc = String(pais || '').replace(/\D/g, '');
  const local = n.replace(/^0+/, '');
  if (!cc) return local.length >= 10 ? local : null;
  return local.startsWith(cc) && local.length > 10 ? local : `${cc}${local}`;
};

const telefonoDe = (r) => {
  const personal = digitsDe(r.whatsapp_lead_pais, r.whatsapp_lead);
  if (personal) {
    return {
      digits: personal,
      display: `+${personal}`,
      fuente: 'personal',
      url: `https://wa.me/${personal}`,
      conexion_nombre: null,
    };
  }
  const conexion = digitsDe(null, r.telefono_conexion);
  if (conexion) {
    return {
      digits: conexion,
      display: `+${conexion}`,
      fuente: 'conexion',
      url: `https://wa.me/${conexion}`,
      conexion_nombre: r.nombre_conexion || null,
    };
  }
  return { digits: null, display: null, fuente: null, url: null, conexion_nombre: null };
};

// Conexión de WhatsApp desde la que el equipo comercial le escribe al cliente
// ("Soporte Importaciones Expertos", cuenta Imporfactorypro). Las
// automatizaciones futuras saldrán de aquí. Se cambia con la variable
// RECUPERACION_CONEXION_EXPERTOS. Solo pueden abrir chat ahí los asesores
// de la cuenta dueña: el chat valida que la conexión sea de su cuenta.
const ID_CONEXION_EXPERTOS = Number(
  process.env.RECUPERACION_CONEXION_EXPERTOS || 265,
);
async function conexionExpertos(id_usuario_asesor) {
  const [c] = await db.query(
    `SELECT id, nombre_configuracion, telefono, id_telefono, id_usuario, suspendido,
            tipo_configuracion, id_plataforma
       FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [ID_CONEXION_EXPERTOS], type: db.QueryTypes.SELECT },
  );
  if (!c) {
    return {
      id_configuracion: ID_CONEXION_EXPERTOS,
      nombre: null,
      disponible: false,
      motivo: 'La conexión de Expertos no existe',
    };
  }
  const esDueno = Number(c.id_usuario) === Number(id_usuario_asesor);
  const disponible = esDueno && Number(c.suspendido) === 0;
  return {
    id_configuracion: c.id,
    nombre: c.nombre_configuracion,
    telefono: c.telefono,
    id_telefono: c.id_telefono,
    id_usuario: c.id_usuario,
    tipo_configuracion: c.tipo_configuracion || null,
    id_plataforma: c.id_plataforma || null,
    disponible,
    motivo: disponible
      ? null
      : c.suspendido
        ? 'La conexión de Expertos está suspendida'
        : 'Solo los asesores de la cuenta dueña de la conexión de Expertos pueden abrir el chat desde ahí',
  };
}

/**
 * Chat de cada número en la conexión de Expertos: quién lo atiende y cuándo
 * fue el último mensaje. Map por últimos 9 dígitos (0969… = 593969…).
 */
// Formas en que el mismo número puede estar guardado en clientes_chat_center
// (celular_cliente / telefono_limpio): con o sin país, con el 0 local, con el
// "1" de México o el "9" de Argentina. Se buscan todas por índice; antes se
// recorrían los 77.000 chats de Expertos con REGEXP_REPLACE (~800 ms por
// carga, también al abrir cada ficha).
// Pocas variantes a propósito: con 60 por número el IN(...) llegaba a 40.000
// constantes y tardaba más que el REGEXP. Ecuador y México son el 95 % de la
// cartera; el resto se cubre con el número tal cual y sus formas locales.
const PAISES_COMUNES = ['593', '52', '521', '57'];
function variantesNumero(d) {
  const s = String(d || '').replace(/\D/g, '');
  if (!s) return [];
  const l9 = s.slice(-9);
  const l10 = s.length >= 10 ? s.slice(-10) : null;
  const v = new Set([s, l9, `0${l9}`]);
  if (l10) v.add(l10).add(`0${l10}`);
  for (const cc of PAISES_COMUNES) {
    v.add(`${cc}${l9}`).add(`${cc}0${l9}`);
    if (l10) v.add(`${cc}${l10}`);
  }
  return [...v];
}
// Hasta este tamaño se busca por índice con las variantes; con la lista del
// embudo entero (1.000+ números) el IN(...) de 10.000 constantes tarda más
// que recorrer los chats una vez con REGEXP, así que ahí se recorre.
const MAX_NUMEROS_POR_INDICE = 60;
async function chatsExpertos(digitsList) {
  const numeros = [...new Set((digitsList || []).filter(Boolean).map((d) => String(d).replace(/\D/g, '')).filter(Boolean))];
  const claves = [...new Set(numeros.map((d) => d.slice(-9)))];
  if (!claves.length) return new Map();
  const cfg = ID_CONEXION_EXPERTOS;
  const rows =
    numeros.length <= MAX_NUMEROS_POR_INDICE
      ? await db.query(
          `SELECT RIGHT(REGEXP_REPLACE(cc.celular_cliente, '[^0-9]', ''), 9) AS clave,
                  cc.id AS id_cliente, cc.id_encargado, cc.ultimo_mensaje_at,
                  s.nombre_encargado, s.usuario
             FROM (
               SELECT id FROM clientes_chat_center WHERE id_configuracion = :cfg AND telefono_limpio IN (:lista)
               UNION
               SELECT id FROM clientes_chat_center WHERE id_configuracion = :cfg AND celular_cliente IN (:lista)
             ) ids
             JOIN clientes_chat_center cc ON cc.id = ids.id
             LEFT JOIN sub_usuarios_chat_center s ON s.id_sub_usuario = cc.id_encargado
            WHERE cc.deleted_at IS NULL AND cc.propietario != 1
            ORDER BY cc.ultimo_mensaje_at DESC`,
          { replacements: { cfg, lista: [...new Set(numeros.flatMap(variantesNumero))] }, type: db.QueryTypes.SELECT },
        )
      : await db.query(
          `SELECT x.* FROM (
             SELECT RIGHT(REGEXP_REPLACE(cc.celular_cliente, '[^0-9]', ''), 9) AS clave,
                    cc.id AS id_cliente, cc.id_encargado, cc.ultimo_mensaje_at,
                    s.nombre_encargado, s.usuario
               FROM clientes_chat_center cc
               LEFT JOIN sub_usuarios_chat_center s ON s.id_sub_usuario = cc.id_encargado
              WHERE cc.id_configuracion = :cfg AND cc.deleted_at IS NULL AND cc.propietario != 1
           ) x WHERE x.clave IN (:claves)
           ORDER BY x.ultimo_mensaje_at DESC`,
          { replacements: { cfg, claves }, type: db.QueryTypes.SELECT },
        );
  const buscadas = new Set(claves);
  const map = new Map();
  // Si hay duplicados del mismo número, manda el chat con actividad más reciente.
  for (const r of rows) {
    if (!buscadas.has(r.clave) || map.has(r.clave)) continue;
    map.set(r.clave, {
      id_cliente: r.id_cliente,
      encargado_id: r.id_encargado ? Number(r.id_encargado) : null,
      encargado_nombre: r.id_encargado ? (r.nombre_encargado || r.usuario || 'otro asesor').trim() : null,
      ultimo_mensaje_at: r.ultimo_mensaje_at || null,
    });
  }
  return map;
}
const chatDe = (map, digits) => (digits ? map.get(String(digits).slice(-9)) || null : null);

// Cohortes de salida: si la persona ya volvió con otra cuenta activa del mismo
// WhatsApp, no se le escribe por esta. En nutrición (prueba / sin tarjeta) no aplica.
const COHORTES_SALIDA = ['pago_rebotado', 'cancelacion_programada', 'vencido', 'cancelado_reciente'];
const claveNum = (d) => String(d || '').replace(/\D/g, '').slice(-9);

/** Cuentas ACTIVAS por número (últimos 9 dígitos de whatsapp_lead). */
async function cuentasActivasPorNumero() {
  const rows = await db.query(
    `SELECT id_usuario, email_propietario AS email, whatsapp_lead FROM usuarios_chat_center
      WHERE estado = 'activo' AND COALESCE(whatsapp_lead, '') <> ''`,
    { type: db.QueryTypes.SELECT },
  );
  const map = new Map();
  for (const r of rows) {
    const k = claveNum(r.whatsapp_lead);
    if (k.length !== 9) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

/**
 * Aviso para el asesor cuando el WhatsApp del cliente lo comparte otra cuenta:
 * no_molestar si ya volvió con otra cuenta activa; si no, solo coordinar.
 */
function numeroCompartido(f, activas, enEmbudo) {
  const k = claveNum(f.whatsapp_digits);
  if (k.length !== 9) return null;
  const otrasActivas = (activas.get(k) || []).filter((o) => o.id_usuario !== f.id_usuario);
  if (COHORTES_SALIDA.includes(f.cohorte) && otrasActivas.length) {
    return {
      no_molestar: true,
      cuentas: otrasActivas.map((o) => ({ id_usuario: o.id_usuario, email: o.email })),
      texto: `Ya usa otra cuenta activa con este número (${otrasActivas.map((o) => o.email).join(', ')}). No lo contactes por esta cuenta.`,
    };
  }
  const otrasEmbudo = (enEmbudo.get(k) || []).filter((o) => o.id_usuario !== f.id_usuario);
  if (otrasEmbudo.length) {
    return {
      no_molestar: false,
      cuentas: otrasEmbudo.map((o) => ({ id_usuario: o.id_usuario, email: o.email })),
      texto: `Mismo WhatsApp que ${otrasEmbudo.map((o) => o.email).join(', ')} (también en el embudo): es la misma persona, coordínalo con quien lleve ese caso.`,
    };
  }
  return null;
}

// Igual que el chat (chat.service findChats): estos roles abren cualquier chat.
const ROLES_VEN_TODO = ['administrador', 'admin_limitado'];

/**
 * Última automatización que le salió a cada cliente (enviada o en cola), para
 * que el embudo muestre «contactado por automatización» aparte del seguimiento manual.
 */
async function ultimasAutomatizaciones(ids) {
  if (!ids.length) return new Map();
  let rows;
  try {
    rows = await db.query(
      `SELECT e.id_usuario, e.estado, e.orden, a.nombre AS secuencia, p.titulo,
              COALESCE(e.enviado_en, e.created_at) AS fecha, e.respondio_en, e.id_cliente_chat
         FROM recuperacion_automatizacion_envios e
         JOIN recuperacion_automatizaciones a ON a.id = e.id_automatizacion
         LEFT JOIN recuperacion_automatizacion_pasos p ON p.id = e.id_paso
        WHERE e.id_usuario IN (:ids) AND e.estado IN ('enviado','encolado')
        ORDER BY e.id`,
      { replacements: { ids }, type: db.QueryTypes.SELECT },
    );
  } catch (e) {
    if (e?.original?.code === 'ER_NO_SUCH_TABLE') return new Map();
    throw e;
  }
  const textos = await textosDeRespuesta(rows);
  const map = new Map();
  for (const r of rows) {
    const prev = map.get(r.id_usuario);
    const respondio_en = r.respondio_en || prev?.respondio_en || null;
    map.set(r.id_usuario, {
      secuencia: r.secuencia,
      paso: r.orden,
      titulo: r.titulo,
      estado: r.estado,
      fecha: r.fecha,
      // Si respondió a cualquiera de los mensajes, queda marcado.
      respondio_en,
      // Qué contestó (primer mensaje entrante tras el envío): el asesor que
      // no tiene el chat igual sabe si dijo «ya pagué» o «no me interesa».
      respuesta_texto: (r.respondio_en && textos.get(`${r.id_cliente_chat}|${new Date(r.respondio_en).getTime()}`)) || prev?.respuesta_texto || null,
      total: (prev?.total || 0) + 1,
    });
  }
  return map;
}

/**
 * Texto del mensaje con el que el cliente respondió a cada envío: el primer
 * entrante en Expertos desde respondio_en. Map "<id_cliente_chat>|<ms>" →
 * texto corto. Una sola consulta para todos (los chats de soporte pueden
 * tener cientos de mensajes, por eso se acota a los que respondieron).
 */
async function textosDeRespuesta(envios) {
  const con = envios.filter((e) => e.respondio_en && e.id_cliente_chat);
  const out = new Map();
  if (!con.length) return out;
  // respondio_en es exactamente el created_at del primer entrante (lo fija el
  // motor), así que se busca por igualdad al segundo. Se arranca desde los
  // envíos (pocos) y se entra a mensajes por índice (celular_recibe): un
  // IN(...) con rango de fecha sobre la tabla completa tardaba 27 s.
  const rows = await db.query(
    `SELECT e.id_cliente_chat, e.respondio_en, m.texto_mensaje, m.tipo_mensaje
       FROM recuperacion_automatizacion_envios e
       JOIN mensajes_clientes m
         ON m.celular_recibe = e.id_cliente_chat
        AND m.created_at >= e.respondio_en AND m.created_at < e.respondio_en + INTERVAL 1 SECOND
        AND m.rol_mensaje = 0 AND m.id_configuracion = :cfg AND m.deleted_at IS NULL
      WHERE e.id_usuario IN (:ids) AND e.respondio_en IS NOT NULL AND e.id_cliente_chat IS NOT NULL
      ORDER BY m.id`,
    {
      replacements: { cfg: ID_CONEXION_EXPERTOS, ids: [...new Set(con.map((e) => e.id_usuario))] },
      type: db.QueryTypes.SELECT,
    },
  );
  for (const m of rows) {
    const k = `${m.id_cliente_chat}|${new Date(m.respondio_en).getTime()}`;
    if (!out.has(k)) out.set(k, resumenMensaje(m));
  }
  return out;
}

const resumenMensaje = (m, max = 160) => {
  const texto = String(m.texto_mensaje || '').replace(/\s+/g, ' ').trim();
  if (texto) return texto.length > max ? `${texto.slice(0, max - 1)}…` : texto;
  const tipo = String(m.tipo_mensaje || '').toLowerCase();
  return tipo && tipo !== 'text' ? `[${tipo}]` : '[sin texto]';
};

/**
 * Conversación del cliente en la conexión de Expertos, solo lectura: quién
 * atiende el chat y los últimos mensajes, con los envíos de automatización
 * marcados. Sirve para que el asesor del caso tenga contexto aunque el chat
 * lo tenga soporte de Expertos (no se le quita un chat en curso).
 */
const DIAS_CONVERSACION_VIVA = 7;
// Lo que el cliente escribe hasta 3 días después del envío se muestra como
// respuesta a ese mensaje; más tarde ya es otra conversación.
const HORAS_RESPUESTA_AUTOMATIZACION = 72;
// Los mensajes salientes guardan la plantilla con {{1}}: se rellena con los
// parámetros que el motor resolvió al encolar (array o {"1": "..."}).
const rellenarPlantilla = (texto, parametros) => {
  if (!texto) return texto;
  let p = parametros;
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch (_) { p = null; }
  }
  if (!p) return texto;
  const valor = (n) => (Array.isArray(p) ? p[n - 1] : p[n] ?? p[String(n)]);
  return String(texto).replace(/\{\{\s*(\d+)\s*\}\}/g, (todo, n) => {
    const v = valor(Number(n));
    return v == null ? todo : String(typeof v === 'object' ? v.text ?? v.value ?? JSON.stringify(v) : v);
  });
};
const mensajeCorto = (m) => ({
  id: m.id,
  entrante: Number(m.rol_mensaje) === 0,
  tipo: m.tipo_mensaje || null,
  texto: resumenMensaje(m, 1000),
  archivo: m.ruta_archivo || null,
  responsable: m.responsable || null,
  fecha: m.created_at,
});
async function conversacionExpertos(digits, { id_sub_usuario = null, limite = 40 } = {}) {
  if (!digits) return null;
  const chat = chatDe(await chatsExpertos([digits]), digits);
  if (!chat) return null;
  const cfg = ID_CONEXION_EXPERTOS;
  const id = String(chat.id_cliente);
  // Un chat de soporte puede tener miles de mensajes: se entra siempre por el
  // índice (celular_recibe, id_configuracion, created_at) y se leen primero
  // solo los ids; sin el FORCE el optimizador mezclaba índices y ordenaba
  // en memoria con los textos (2 s en el chat de Cristian Calle).
  const ultimo = (condicionRol) =>
    db.query(
      `SELECT created_at, TIMESTAMPDIFF(HOUR, created_at, NOW()) AS horas
         FROM mensajes_clientes FORCE INDEX (idx_msg_cel_config_fecha)
        WHERE celular_recibe = :id AND id_configuracion = :cfg AND ${condicionRol} AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      { replacements: { cfg, id }, type: db.QueryTypes.SELECT },
    );
  const [mensajes, [entrante], [saliente]] = await Promise.all([
    db.query(
      `SELECT m.id, m.rol_mensaje, m.tipo_mensaje, m.texto_mensaje, m.ruta_archivo, m.responsable, m.created_at
         FROM mensajes_clientes m
         JOIN (SELECT id FROM mensajes_clientes FORCE INDEX (idx_msg_cel_config_fecha)
                WHERE celular_recibe = :id AND id_configuracion = :cfg AND deleted_at IS NULL
                ORDER BY created_at DESC, id DESC LIMIT :limite) x ON x.id = m.id
        ORDER BY m.created_at DESC, m.id DESC`,
      { replacements: { cfg, id, limite }, type: db.QueryTypes.SELECT },
    ),
    ultimo('rol_mensaje = 0'),
    ultimo('rol_mensaje <> 0'),
  ]);
  const actividad = {
    ultimo_entrante_at: entrante?.created_at || null,
    ultimo_saliente_at: saliente?.created_at || null,
    horas_sin_escribir: entrante ? entrante.horas : null,
  };

  // Cada envío de automatización con el texto que salió y lo que el cliente
  // contestó después (hasta el siguiente envío). El emparejamiento se hace en
  // SQL por fecha: el front no compara horas (formatos distintos por navegador).
  let envios = [];
  let respuestas = [];
  let salientes = [];
  try {
    envios = await db.query(
      `SELECT e.id, e.orden AS paso, a.nombre AS secuencia, p.titulo, p.texto_sugerido, e.parametros_resueltos,
              COALESCE(e.enviado_en, e.created_at) AS fecha, e.respondio_en
         FROM recuperacion_automatizacion_envios e
         JOIN recuperacion_automatizaciones a ON a.id = e.id_automatizacion
         LEFT JOIN recuperacion_automatizacion_pasos p ON p.id = e.id_paso
        WHERE e.id_cliente_chat = :id AND e.estado = 'enviado'
        ORDER BY e.id`,
      { replacements: { id }, type: db.QueryTypes.SELECT },
    );
    if (envios.length) {
      [respuestas, salientes] = await Promise.all([
        db.query(
          `SELECT e.id AS id_envio, m.id, m.rol_mensaje, m.tipo_mensaje, m.texto_mensaje, m.ruta_archivo, m.responsable, m.created_at
             FROM recuperacion_automatizacion_envios e
             JOIN mensajes_clientes m
               ON m.celular_recibe = e.id_cliente_chat AND m.id_configuracion = :cfg
              AND m.rol_mensaje = 0 AND m.deleted_at IS NULL
              AND m.created_at >= COALESCE(e.enviado_en, e.created_at)
              AND m.created_at < LEAST(
                    COALESCE(e.enviado_en, e.created_at) + INTERVAL :horasRespuesta HOUR,
                    COALESCE(
                      (SELECT MIN(COALESCE(e2.enviado_en, e2.created_at)) FROM recuperacion_automatizacion_envios e2
                        WHERE e2.id_cliente_chat = e.id_cliente_chat AND e2.estado = 'enviado' AND e2.id > e.id),
                      NOW()))
            WHERE e.id_cliente_chat = :id AND e.estado = 'enviado'
            ORDER BY e.id, m.created_at, m.id`,
          { replacements: { cfg, id, horasRespuesta: HORAS_RESPUESTA_AUTOMATIZACION }, type: db.QueryTypes.SELECT },
        ),
        db.query(
          `SELECT e.id AS id_envio, m.id, m.rol_mensaje, m.tipo_mensaje, m.texto_mensaje, m.ruta_archivo, m.responsable, m.created_at
             FROM recuperacion_automatizacion_envios e
             JOIN mensajes_clientes m
               ON m.celular_recibe = e.id_cliente_chat AND m.id_configuracion = :cfg
              AND m.rol_mensaje <> 0 AND m.deleted_at IS NULL
              AND m.created_at >= COALESCE(e.enviado_en, e.created_at) - INTERVAL 2 MINUTE
              AND m.created_at <= COALESCE(e.enviado_en, e.created_at) + INTERVAL 3 MINUTE
            WHERE e.id_cliente_chat = :id AND e.estado = 'enviado'
            ORDER BY e.id, m.created_at, m.id`,
          { replacements: { cfg, id }, type: db.QueryTypes.SELECT },
        ),
      ]);
    }
  } catch (e) {
    if (e?.original?.code !== 'ER_NO_SUCH_TABLE') throw e;
  }
  const MAX_RESPUESTAS = 6;
  const porEnvio = new Map();
  for (const r of respuestas) {
    if (!porEnvio.has(r.id_envio)) porEnvio.set(r.id_envio, []);
    const lista = porEnvio.get(r.id_envio);
    if (lista.length < MAX_RESPUESTAS) lista.push(mensajeCorto(r));
  }
  const enviadoDe = new Map();
  for (const s of salientes) if (!enviadoDe.has(s.id_envio)) enviadoDe.set(s.id_envio, mensajeCorto(s));
  const automatizaciones = envios.map((e) => {
    const enviado = enviadoDe.get(e.id) || null;
    return {
      id: e.id,
      secuencia: e.secuencia,
      paso: e.paso,
      titulo: e.titulo,
      fecha: e.fecha,
      respondio_en: e.respondio_en,
      id_mensaje_enviado: enviado?.id || null,
      texto_enviado: rellenarPlantilla(enviado?.texto || (e.texto_sugerido ? String(e.texto_sugerido).trim() : null), e.parametros_resueltos),
      respuestas: porEnvio.get(e.id) || [],
    };
  });
  const idsRespuesta = new Set(automatizaciones.flatMap((a) => a.respuestas.map((r) => r.id)));
  const idsEnviados = new Set(automatizaciones.map((a) => a.id_mensaje_enviado).filter(Boolean));

  // ¿Se puede pedir el chat? Si el cliente no escribe hace DIAS_CONVERSACION_VIVA
  // días no hay nada en curso; si lo tiene el propio asesor o nadie, es suyo.
  const horas = actividad?.horas_sin_escribir == null ? null : Number(actividad.horas_sin_escribir);
  const esMio = id_sub_usuario && chat.encargado_id === Number(id_sub_usuario);
  let transferible = true;
  let motivo = 'Chat sin encargado: lo puedes abrir directo.';
  if (esMio) motivo = 'El chat ya es tuyo.';
  else if (chat.encargado_id && horas == null) motivo = `Lo tiene ${chat.encargado_nombre}, pero el cliente nunca ha escrito: pídeselo sin problema.`;
  else if (chat.encargado_id && horas < DIAS_CONVERSACION_VIVA * 24) {
    transferible = false;
    motivo = `Conversación en curso con ${chat.encargado_nombre}: el cliente escribió hace ${horas < 1 ? 'menos de una hora' : horas < 48 ? `${horas} h` : `${Math.floor(horas / 24)} días`}. No le quites el chat; coordina con esa persona o llama al cliente.`;
  } else if (chat.encargado_id) {
    motivo = `Lo tiene ${chat.encargado_nombre}, pero el cliente no escribe hace ${Math.floor(horas / 24)} días: no hay nada en curso, pídeselo.`;
  }

  return {
    id_cliente: chat.id_cliente,
    encargado_id: chat.encargado_id,
    encargado_nombre: chat.encargado_nombre,
    es_mio: !!esMio,
    ultimo_mensaje_at: chat.ultimo_mensaje_at,
    ultimo_entrante_at: actividad?.ultimo_entrante_at || null,
    ultimo_saliente_at: actividad?.ultimo_saliente_at || null,
    horas_sin_escribir: horas,
    transferible,
    motivo_transferible: motivo,
    mensajes: mensajes.reverse().map((m) => ({
      ...mensajeCorto(m),
      respuesta_automatizacion: idsRespuesta.has(m.id),
      automatizacion: idsEnviados.has(m.id),
    })),
    automatizaciones,
  };
}

async function ultimosSeguimientos(ids) {
  if (!ids.length) return new Map();
  const rows = await db.query(
    `SELECT s.id_usuario, s.id_seguimiento, s.tipo, s.resultado, s.asunto,
            s.fecha_seguimiento, s.proximo_contacto, s.ejecutado_por_id,
            s.ejecutado_por_nombre, s.motivo_cancelacion,
            c.n AS total_seguimientos
       FROM seguimiento_clientes_chat_center s
       JOIN (SELECT id_usuario, MAX(id_seguimiento) AS mx, COUNT(*) AS n
               FROM seguimiento_clientes_chat_center
              WHERE id_usuario IN (:ids)
              GROUP BY id_usuario) c
         ON c.mx = s.id_seguimiento`,
    { replacements: { ids }, type: db.QueryTypes.SELECT },
  );
  return new Map(rows.map((r) => [r.id_usuario, r]));
}

/**
 * Casos abiertos, uno por cliente. Si un cliente tiene dos abiertos (pasó
 * cuando el cron de la hora y una carga del embudo sincronizaron a la vez:
 * MERO y Valeria Enriquez el 22-10-2026), se conserva el que tiene asesor
 * —o el más viejo— y los demás se cierran como descartados «Caso duplicado»,
 * para que no cuenten como perdidos ni dupliquen la lista.
 */
async function casosAbiertos() {
  const rows = await db.query(
    `SELECT * FROM recuperacion_casos_chat_center WHERE estado = 'abierto'
      ORDER BY id_usuario, (asignado_a_id IS NULL), asignado_en, id_caso`,
    { type: db.QueryTypes.SELECT },
  );
  const map = new Map();
  const duplicados = [];
  for (const r of rows) {
    if (map.has(r.id_usuario)) duplicados.push(r.id_caso);
    else map.set(r.id_usuario, r);
  }
  if (duplicados.length) {
    await db.query(
      `UPDATE recuperacion_casos_chat_center
          SET estado = 'descartado', cerrado_en = NOW(), cerrado_por = 'sistema',
              cierre_motivo = 'Caso duplicado', estado_final = 'manual'
        WHERE id_caso IN (:ids) AND estado = 'abierto'`,
      { replacements: { ids: duplicados }, type: db.QueryTypes.UPDATE },
    );
    console.warn(`[recuperacion] ${duplicados.length} caso(s) duplicado(s) cerrados: ${duplicados.join(', ')}`);
  }
  return map;
}

/**
 * Sincroniza los casos con el embudo actual:
 *  - abre caso a quien entró a una cohorte y no tenía uno abierto;
 *  - cierra solo los casos de quien ya salió del embudo (recuperado/perdido).
 * Es barato (dos SELECT + inserts/updates puntuales) y corre en cada carga.
 */
async function sincronizarCasos(filas, abiertos) {
  const enRiesgo = new Set(filas.map((f) => f.id_usuario));

  const nuevos = filas.filter((f) => !abiertos.has(f.id_usuario));
  if (nuevos.length) {
    // Solo si no hay ya un caso abierto: dos sincronizaciones a la vez (cron +
    // carga del embudo) insertaban el mismo cliente dos veces.
    const values = nuevos.map((f) => [f.id_usuario, f.cohorte, f.precio_plan ?? null]);
    await db.query(
      `INSERT INTO recuperacion_casos_chat_center (id_usuario, cohorte, monto_plan)
       SELECT v.id_usuario, v.cohorte, v.monto_plan
         FROM (${values.map(() => 'SELECT ? AS id_usuario, ? AS cohorte, ? AS monto_plan').join(' UNION ALL ')}) v
        WHERE NOT EXISTS (SELECT 1 FROM recuperacion_casos_chat_center c
                           WHERE c.id_usuario = v.id_usuario AND c.estado = 'abierto')`,
      { replacements: values.flat(), type: db.QueryTypes.INSERT },
    );
  }

  const salieron = [...abiertos.values()].filter((c) => !enRiesgo.has(c.id_usuario));
  if (salieron.length) {
    const ids = salieron.map((c) => c.id_usuario);
    const estados = await db.query(
      `SELECT id_usuario, estado, stripe_subscription_status AS st, permanente
         FROM usuarios_chat_center WHERE id_usuario IN (:ids)`,
      { replacements: { ids }, type: db.QueryTypes.SELECT },
    );
    const porId = new Map(estados.map((e) => [e.id_usuario, e]));
    for (const c of salieron) {
      const e = porId.get(c.id_usuario);
      let estado = 'descartado';
      let estadoFinal = 'sin_cuenta';
      if (e) {
        const vivo =
          ['activo', 'trial_usage', 'promo_usage'].includes(e.estado) ||
          Number(e.permanente) === 1;
        estado = vivo ? 'recuperado' : 'perdido';
        if (e.estado === 'activo' && e.st === 'active') estadoFinal = 'pago';
        else if (e.estado === 'activo' && e.st === 'trialing') estadoFinal = 'prueba';
        else if (vivo) estadoFinal = 'activo_otro';
        else if (e.estado === 'cancelado') estadoFinal = 'cancelado';
        else if (e.estado === 'vencido') estadoFinal = 'vencido';
        else estadoFinal = 'sin_plan';
      }
      await db.query(
        `UPDATE recuperacion_casos_chat_center
            SET estado = ?, cerrado_en = NOW(), cerrado_por = 'sistema',
                cierre_motivo = ?, estado_final = ?
          WHERE id_caso = ? AND estado = 'abierto'`,
        {
          replacements: [estado, ESTADO_FINAL[estadoFinal], estadoFinal, c.id_caso],
          type: db.QueryTypes.UPDATE,
        },
      );
    }
  }

  if (nuevos.length || salieron.length) return casosAbiertos();
  return abiertos;
}

/**
 * Clientes en riesgo con cohorte, fecha clave y teléfono resuelto, sin tocar
 * casos ni seguimientos. Lo usan el embudo y el motor de automatizaciones.
 */
async function clientesEnRiesgo() {
  const base = await db.query(SQL_COHORTES, { type: db.QueryTypes.SELECT });
  return base.map((r) => {
    const tel = telefonoDe(r);
    const fechaClave = fechaClaveDe(r);
    return {
      id_usuario: r.id_usuario,
      empresa: r.empresa,
      email: r.email,
      nombre_plan: r.nombre_plan,
      precio_plan: r.precio_plan != null ? Number(r.precio_plan) : null,
      estado: r.estado,
      stripe_status: r.stripe_status,
      cohorte: r.cohorte,
      fecha_clave: fechaClave,
      dias: diasHasta(fechaClave),
      whatsapp: tel.display,
      whatsapp_digits: tel.digits,
      telefono_fuente: tel.fuente,
    };
  });
}

/**
 * Abre y cierra casos aunque nadie tenga la pantalla abierta (lo llama el
 * cron cada hora). Así "pagó", "quitó la cancelación" o "puso tarjeta" se
 * registran en Resultados al rato de pasar, no cuando alguien entra.
 */
async function sincronizarCasosGlobal() {
  await ensureTablas();
  const base = await db.query(SQL_COHORTES, { type: db.QueryTypes.SELECT });
  const antes = await casosAbiertos();
  const despues = await sincronizarCasos(base, antes);
  return { en_riesgo: base.length, abiertos_antes: antes.size, abiertos_despues: despues.size };
}

/**
 * Situación comercial de UNA cuenta, para la cabecera del chat de soporte:
 * en qué parte del embudo está (o si es un cliente a mantener), caso abierto
 * y quién lo lleva, último seguimiento, pagos reales y conexiones. Es lo que
 * el asesor necesita ver antes de responder, sin abrir el panel derecho.
 */
async function situacionDeUsuario(id_usuario) {
  await ensureTablas();
  const [u] = await db.query(
    `SELECT u.id_usuario, u.nombre AS empresa, u.estado, u.id_plan, p.nombre_plan, p.precio_plan,
            u.stripe_subscription_id, u.stripe_subscription_status AS stripe_status,
            u.cancel_at_period_end, u.cancel_at, u.fecha_renovacion, u.trial_end, u.permanente,
            u.created_at AS registrado_en,
            (SELECT COUNT(*) FROM configuraciones c WHERE c.id_usuario = u.id_usuario AND c.suspendido = 0) AS conexiones_activas,
            (SELECT COUNT(*) FROM configuraciones c WHERE c.id_usuario = u.id_usuario AND c.suspendido = 1) AS conexiones_suspendidas,
            (SELECT COUNT(*) FROM transacciones_stripe_chat t WHERE t.id_usuario = u.id_usuario AND t.id_pago LIKE 'in_%' AND t.monto > 0) AS pagos_reales,
            (SELECT MAX(t.fecha) FROM transacciones_stripe_chat t WHERE t.id_usuario = u.id_usuario AND t.id_pago LIKE 'in_%' AND t.monto > 0) AS ultimo_pago
       FROM usuarios_chat_center u
       LEFT JOIN planes_chat_center p ON p.id_plan = u.id_plan
      WHERE u.id_usuario = ? LIMIT 1`,
    { replacements: [id_usuario], type: db.QueryTypes.SELECT },
  );
  if (!u) return null;

  const [enRiesgo] = await db.query(`SELECT * FROM (${SQL_COHORTES}) x WHERE x.id_usuario = ?`, {
    replacements: [id_usuario],
    type: db.QueryTypes.SELECT,
  });
  const cohorte = enRiesgo?.cohorte || null;
  const fechaClave = enRiesgo ? fechaClaveDe(enRiesgo) : u.fecha_renovacion;
  const caso = await casoAbiertoDe(id_usuario);
  const ultimos = await ultimosSeguimientos([id_usuario]);
  const seg = ultimos.get(id_usuario) || null;
  const pagos = Number(u.pagos_reales || 0);

  // Nivel para el asesor, en una palabra:
  //  - riesgo: está en el embudo (la cohorte dice por qué);
  //  - recurrente: paga hace 2+ meses y está activo → cliente a mantener;
  //  - pagando: activo con 1 cobro real;
  //  - permanente: cortesía VIP;
  //  - activo (sin cobros aún) / inactivo / sin cuenta de pago.
  let nivel;
  if (cohorte) nivel = 'riesgo';
  else if (Number(u.permanente) === 1) nivel = 'permanente';
  else if (u.estado === 'activo' && u.stripe_status === 'active' && pagos >= 2) nivel = 'recurrente';
  else if (u.estado === 'activo' && u.stripe_status === 'active') nivel = 'pagando';
  else if (u.estado === 'activo') nivel = 'activo';
  else nivel = u.estado || 'inactivo';

  return {
    nivel,
    cohorte,
    cohorte_label: cohorte ? COHORTES[cohorte]?.label || cohorte : null,
    cohorte_descripcion: cohorte ? COHORTES[cohorte]?.descripcion || null : null,
    prioridad: cohorte ? COHORTES[cohorte]?.prioridad || null : null,
    estado: u.estado,
    stripe_status: u.stripe_status,
    tiene_stripe: !!u.stripe_subscription_id,
    permanente: Number(u.permanente) === 1,
    plan: u.nombre_plan || null,
    precio_plan: u.precio_plan != null ? Number(u.precio_plan) : null,
    fecha_clave: fechaClave,
    dias: diasHasta(fechaClave),
    fecha_renovacion: u.fecha_renovacion,
    cancel_at_period_end: Number(u.cancel_at_period_end) === 1,
    trial_end: u.trial_end,
    registrado_en: u.registrado_en,
    pagos_reales: pagos,
    ultimo_pago: u.ultimo_pago,
    conexiones_activas: Number(u.conexiones_activas || 0),
    conexiones_suspendidas: Number(u.conexiones_suspendidas || 0),
    caso: caso
      ? { id_caso: caso.id_caso, asignado_a_id: caso.asignado_a_id, asignado_a_nombre: caso.asignado_a_nombre, abierto_en: caso.abierto_en, cohorte_inicial: caso.cohorte }
      : null,
    ultimo_seguimiento: seg
      ? { fecha: seg.fecha_seguimiento, tipo: seg.tipo, resultado: seg.resultado, por: seg.ejecutado_por_nombre, asunto: seg.asunto, proximo_contacto: seg.proximo_contacto, total: Number(seg.total_seguimientos || 0) }
      : null,
  };
}

/**
 * Caché corta en memoria para lo pesado del embudo que cambia despacio
 * (cohortes desde Stripe, recorrido de los 77.000 chats de Expertos, cuentas
 * activas, envíos de automatización). Lo que el asesor acaba de tocar
 * (seguimientos, casos, actividad) se consulta siempre fresco, así al
 * registrar algo y recargar lo ve al instante. Se comparte entre todos los
 * asesores: cuatro personas recargando no multiplican el costo. Guarda la
 * promesa para que dos cargas simultáneas no disparen la misma consulta.
 */
const CACHE_EMBUDO_MS = 45 * 1000;
// Vencida pero con menos de esto, se entrega la copia vieja y se refresca
// por detrás: nadie espera el recorrido de chats salvo en el primer arranque.
const CACHE_EMBUDO_MAX_VIEJA_MS = 10 * 60 * 1000;
const cacheEmbudo = new Map();
function conCache(clave, fn) {
  const hit = cacheEmbudo.get(clave);
  const edad = hit ? Date.now() - hit.en : Infinity;
  if (hit && edad < CACHE_EMBUDO_MS) return hit.p;
  const refrescar = () => {
    const p = fn().catch((e) => {
      cacheEmbudo.delete(clave);
      throw e;
    });
    cacheEmbudo.set(clave, { en: Date.now(), p });
    return p;
  };
  if (hit && edad < CACHE_EMBUDO_MAX_VIEJA_MS) {
    const vieja = hit.p;
    refrescar().catch(() => {});
    return vieja;
  }
  return refrescar();
}
const invalidarCacheEmbudo = (clave = null) => (clave ? cacheEmbudo.delete(clave) : cacheEmbudo.clear());

// Mientras alguien tenga el embudo en uso (últimos 15 min), las dos
// consultas pesadas se refrescan solas por detrás: así ni la primera carga
// tras los 45 s espera el recorrido de chats. Sin uso, no se gasta nada.
const MANTENER_CALIENTE_MS = 15 * 60 * 1000;
let ultimoUsoEmbudo = 0;
let calentador = null;
function mantenerCaliente() {
  if (calentador) return;
  calentador = setInterval(() => {
    if (Date.now() - ultimoUsoEmbudo > MANTENER_CALIENTE_MS) return;
    conCache('cohortes', () => db.query(SQL_COHORTES, { type: db.QueryTypes.SELECT }))
      .then((base) => conCache('chats', () => chatsExpertos(base.map((r) => telefonoDe(r).digits))))
      .catch((e) => console.warn('recuperacion: no se pudo refrescar el caché del embudo —', e.message));
  }, CACHE_EMBUDO_MS - 5000);
  calentador.unref?.();
}

async function embudo({ id_sub_usuario, id_usuario, rol = null }) {
  await ensureTablas();
  ultimoUsoEmbudo = Date.now();
  mantenerCaliente();
  // Todo lo que no depende entre sí va en paralelo: en serie eran ~10
  // consultas una tras otra (2-3 s); así la carga dura lo que la más lenta.
  const [expertos, base, abiertosAntes, activas] = await Promise.all([
    conexionExpertos(id_usuario),
    conCache('cohortes', () => db.query(SQL_COHORTES, { type: db.QueryTypes.SELECT })),
    casosAbiertos(),
    conCache('activas', cuentasActivasPorNumero),
  ]);
  const ids = base.map((r) => r.id_usuario);
  const [[abiertos, actividad], ultimos, autos, chats] = await Promise.all([
    // La actividad por asesor cuenta casos abiertos: va después de sincronizar.
    sincronizarCasos(base, abiertosAntes).then(async (a) => [a, await actividadAsesores()]),
    ultimosSeguimientos(ids),
    conCache('autos', () => ultimasAutomatizaciones(ids)),
    conCache('chats', () => chatsExpertos(base.map((r) => telefonoDe(r).digits))),
  ]);
  const veTodo = ROLES_VEN_TODO.includes(rol);
  const enEmbudo = new Map();
  for (const r of base) {
    const k = claveNum(telefonoDe(r).digits);
    if (k.length !== 9) continue;
    if (!enEmbudo.has(k)) enEmbudo.set(k, []);
    enEmbudo.get(k).push({ id_usuario: r.id_usuario, email: r.email });
  }

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const en7 = new Date(hoy.getTime() + 7 * 86400000);

  const filas = base.map((r) => {
    const u = ultimos.get(r.id_usuario) || null;
    const caso = abiertos.get(r.id_usuario) || null;
    const fechaClave = fechaClaveDe(r);
    const proximo = u?.proximo_contacto ? new Date(u.proximo_contacto) : null;
    const promesa = u?.resultado === 'promesa_pago';
    const tel = telefonoDe(r);
    const chat = chatDe(chats, tel.digits);
    return {
      id_usuario: r.id_usuario,
      empresa: r.empresa,
      email: r.email,
      // Chat en Expertos: si lo atiende otra persona, el asesor no lo puede
      // abrir (el chat se lo niega); el front le dice a quién pedírselo.
      chat_expertos: chat
        ? {
            encargado_id: chat.encargado_id,
            encargado_nombre: chat.encargado_nombre,
            ultimo_mensaje_at: chat.ultimo_mensaje_at,
            es_mio: chat.encargado_id === Number(id_sub_usuario),
            bloqueado: !!chat.encargado_id && chat.encargado_id !== Number(id_sub_usuario) && !veTodo,
          }
        : null,
      whatsapp: tel.display,
      whatsapp_digits: tel.digits,
      whatsapp_url: tel.url,
      telefono_fuente: tel.fuente,
      conexion_nombre: tel.conexion_nombre,
      numero_compartido: numeroCompartido({ id_usuario: r.id_usuario, cohorte: r.cohorte, whatsapp_digits: tel.digits }, activas, enEmbudo),
      id_plan: r.id_plan,
      nombre_plan: r.nombre_plan,
      precio_plan: r.precio_plan != null ? Number(r.precio_plan) : null,
      estado: r.estado,
      stripe_status: r.stripe_status,
      tiene_stripe: !!r.stripe_subscription_id,
      cohorte: r.cohorte,
      prioridad: COHORTES[r.cohorte]?.prioridad ?? 99,
      fecha_clave: fechaClave,
      dias: diasHasta(fechaClave),
      registrado_en: r.registrado_en,
      ultimo_seguimiento: u
        ? {
            id_seguimiento: u.id_seguimiento,
            tipo: u.tipo,
            resultado: u.resultado,
            asunto: u.asunto,
            fecha: u.fecha_seguimiento,
            por: u.ejecutado_por_nombre,
            por_id: u.ejecutado_por_id,
            motivo_cancelacion: u.motivo_cancelacion,
          }
        : null,
      total_seguimientos: u?.total_seguimientos || 0,
      automatizacion: autos.get(r.id_usuario) || null,
      proximo_contacto: u?.proximo_contacto || null,
      proximo_vencido: !!(proximo && proximo < hoy),
      proximo_en_7d: !!(proximo && proximo >= hoy && proximo <= en7),
      promesa_pago: promesa,
      caso: caso
        ? {
            id_caso: caso.id_caso,
            cohorte_inicial: caso.cohorte,
            abierto_en: caso.abierto_en,
            asignado_a_id: caso.asignado_a_id,
            asignado_a_nombre: caso.asignado_a_nombre,
            es_mio: Number(caso.asignado_a_id) === Number(id_sub_usuario),
          }
        : null,
    };
  });

  // Más urgente primero: cohorte, luego la fecha clave más cercana.
  filas.sort((a, b) => {
    if (a.prioridad !== b.prioridad) return a.prioridad - b.prioridad;
    const da = a.dias == null ? 9999 : Math.abs(a.dias);
    const dbb = b.dias == null ? 9999 : Math.abs(b.dias);
    return da - dbb;
  });

  const resumen = {};
  for (const k of Object.keys(COHORTES)) resumen[k] = { n: 0, monto: 0 };
  let sinContacto = 0;
  let soloAutomatizacion = 0;
  let misCasos = 0;
  let sinAsignar = 0;
  let paraHoy = 0;
  let promesasVencidas = 0;
  for (const f of filas) {
    resumen[f.cohorte].n += 1;
    resumen[f.cohorte].monto += f.precio_plan || 0;
    if (!f.ultimo_seguimiento && !f.automatizacion) sinContacto += 1;
    if (!f.ultimo_seguimiento && f.automatizacion) soloAutomatizacion += 1;
    if (f.caso?.es_mio) misCasos += 1;
    if (f.caso && !f.caso.asignado_a_id) sinAsignar += 1;
    if (f.proximo_vencido || (f.proximo_contacto && new Date(f.proximo_contacto) <= new Date(hoy.getTime() + 86399000))) paraHoy += 1;
    if (f.promesa_pago && f.proximo_vencido) promesasVencidas += 1;
  }

  const r2 = (n) => Math.round(n * 100) / 100;
  return {
    generado: new Date().toISOString(),
    actividad,
    expertos: {
      id_configuracion: expertos.id_configuracion,
      nombre: expertos.nombre,
      telefono: expertos.telefono,
      disponible: expertos.disponible,
      motivo: expertos.motivo,
    },
    cohortes: Object.entries(COHORTES).map(([id, c]) => ({
      id,
      ...c,
      n: resumen[id].n,
      monto: r2(resumen[id].monto),
    })),
    kpis: {
      en_riesgo: filas.length,
      mrr_en_riesgo: r2(filas.reduce((s, f) => s + (f.precio_plan || 0), 0)),
      sin_contacto: sinContacto,
      solo_automatizacion: soloAutomatizacion,
      mis_casos: misCasos,
      sin_asignar: sinAsignar,
      para_hoy: paraHoy,
      promesas_vencidas: promesasVencidas,
    },
    filas,
  };
}

/**
 * Cuánto están trabajando los asesores: seguimientos registrados hoy / 7 días
 * / 30 días, en total y por asesor, junto con sus casos abiertos y cuántos de
 * esos no tienen ni un registro desde que se abrieron. Pedido del 22-10-2026:
 * el panel mostraba 1.159 casos abiertos y 1.061 asignados, pero en 14 días
 * solo había 2 seguimientos; sin este dato nadie lo veía. Incluye a todo
 * asesor activo aunque tenga cero, que es justo lo que hay que ver.
 */
async function actividadAsesores() {
  const [asesores, seguimientos, casos] = await Promise.all([
    db.query(
      `SELECT id_sub_usuario, nombre FROM recuperacion_asesores_chat_center WHERE activo = 1`,
      { type: db.QueryTypes.SELECT },
    ),
    db.query(
      `SELECT ejecutado_por_id, ejecutado_por_nombre,
              SUM(fecha_seguimiento >= CURDATE()) AS hoy,
              SUM(fecha_seguimiento >= CURDATE() - INTERVAL 6 DAY) AS semana,
              COUNT(*) AS mes,
              COUNT(DISTINCT CASE WHEN fecha_seguimiento >= CURDATE() - INTERVAL 6 DAY THEN id_usuario END) AS clientes_semana,
              MAX(fecha_seguimiento) AS ultimo
         FROM seguimiento_clientes_chat_center
        WHERE fecha_seguimiento >= CURDATE() - INTERVAL 29 DAY
        GROUP BY ejecutado_por_id, ejecutado_por_nombre`,
      { type: db.QueryTypes.SELECT },
    ),
    db.query(
      `SELECT c.asignado_a_id,
              COUNT(*) AS abiertos,
              SUM(NOT EXISTS (SELECT 1 FROM seguimiento_clientes_chat_center s
                               WHERE s.id_usuario = c.id_usuario
                                 AND s.fecha_seguimiento >= c.abierto_en)) AS sin_tocar
         FROM recuperacion_casos_chat_center c
        WHERE c.estado = 'abierto'
        GROUP BY c.asignado_a_id`,
      { type: db.QueryTypes.SELECT },
    ),
  ]);

  const porId = new Map();
  const fila = (id, nombre) => {
    const k = id == null ? 'sin_asignar' : String(id);
    if (!porId.has(k)) {
      porId.set(k, {
        id_sub_usuario: id ?? null,
        nombre: id == null ? 'Sin asignar' : nombre || `Subusuario ${id}`,
        es_asesor: false,
        abiertos: 0,
        sin_tocar: 0,
        hoy: 0,
        semana: 0,
        mes: 0,
        clientes_semana: 0,
        ultimo: null,
      });
    }
    return porId.get(k);
  };
  for (const a of asesores) fila(a.id_sub_usuario, a.nombre).es_asesor = true;
  for (const c of casos) {
    const x = fila(c.asignado_a_id, null);
    x.abiertos += Number(c.abiertos);
    x.sin_tocar += Number(c.sin_tocar);
  }
  const tot = { hoy: 0, semana: 0, mes: 0 };
  for (const s of seguimientos) {
    tot.hoy += Number(s.hoy);
    tot.semana += Number(s.semana);
    tot.mes += Number(s.mes);
    if (s.ejecutado_por_id == null) continue;
    const x = fila(s.ejecutado_por_id, s.ejecutado_por_nombre);
    if (!x.nombre || x.nombre.startsWith('Subusuario ')) x.nombre = s.ejecutado_por_nombre || x.nombre;
    x.hoy += Number(s.hoy);
    x.semana += Number(s.semana);
    x.mes += Number(s.mes);
    x.clientes_semana += Number(s.clientes_semana);
    x.ultimo = s.ultimo;
  }
  const lista = [...porId.values()]
    .filter((x) => x.id_sub_usuario != null)
    .sort((a, b) => b.semana - a.semana || b.hoy - a.hoy || b.abiertos - a.abiertos);
  const sinAsignar = porId.get('sin_asignar');
  return {
    ...tot,
    asesores_activos_semana: lista.filter((x) => x.semana > 0).length,
    asesores_total: lista.filter((x) => x.es_asesor).length,
    sin_asignar: sinAsignar ? { abiertos: sinAsignar.abiertos, sin_tocar: sinAsignar.sin_tocar } : { abiertos: 0, sin_tocar: 0 },
    asesores: lista,
  };
}

/**
 * Busca un cliente por empresa, correo o WhatsApp e informa su ÚLTIMO caso,
 * esté abierto o cerrado. El embudo solo lista casos abiertos: cuando un
 * cliente ya canceló (como JNstore el 21-10-2026) desaparece de la lista y el
 * asesor no tenía cómo saber qué pasó con él sin ir a Resultados.
 */
async function buscarCasos(q) {
  await ensureTablas();
  const texto = String(q || '').trim();
  if (texto.length < 3) return [];
  const like = `%${texto}%`;
  const digits = texto.replace(/\D/g, '');
  // Primero los clientes (20 máx.) y recién después sus casos y seguimientos:
  // con subconsultas correlacionadas sobre todos los usuarios tardaba minutos.
  const usuarios = await db.query(
    `SELECT u.id_usuario, u.nombre AS empresa, u.email_propietario AS email,
            u.estado, u.stripe_subscription_status AS stripe_status,
            u.cancel_at, u.canceled_at, u.fecha_renovacion,
            p.nombre_plan, p.precio_plan
       FROM usuarios_chat_center u
       LEFT JOIN planes_chat_center p ON p.id_plan = u.id_plan
      WHERE u.nombre LIKE :like OR u.email_propietario LIKE :like
         ${digits.length >= 6 ? 'OR u.whatsapp_lead LIKE :digits' : ''}
      ORDER BY u.updated_at DESC
      LIMIT 20`,
    { replacements: { like, digits: `%${digits}%` }, type: db.QueryTypes.SELECT },
  );
  if (!usuarios.length) return [];
  const ids = usuarios.map((u) => u.id_usuario);

  const [casos, seguimientos, autos] = await Promise.all([
    db.query(
      `SELECT c.*, m.total AS total_casos
         FROM recuperacion_casos_chat_center c
         JOIN (SELECT id_usuario, MAX(id_caso) AS mx, COUNT(*) AS total
                 FROM recuperacion_casos_chat_center WHERE id_usuario IN (:ids)
                GROUP BY id_usuario) m ON m.mx = c.id_caso`,
      { replacements: { ids }, type: db.QueryTypes.SELECT },
    ),
    db.query(
      `SELECT id_usuario, fecha_seguimiento FROM seguimiento_clientes_chat_center WHERE id_usuario IN (:ids)`,
      { replacements: { ids }, type: db.QueryTypes.SELECT },
    ),
    db.query(
      `SELECT id_usuario, COUNT(*) AS n FROM recuperacion_automatizacion_envios
        WHERE id_usuario IN (:ids) AND estado = 'enviado' GROUP BY id_usuario`,
      { replacements: { ids }, type: db.QueryTypes.SELECT },
    ),
  ]);
  const casoDe = new Map(casos.map((c) => [c.id_usuario, c]));
  const autosDe = new Map(autos.map((a) => [a.id_usuario, Number(a.n)]));
  const segsDe = new Map();
  for (const s of seguimientos) {
    if (!segsDe.has(s.id_usuario)) segsDe.set(s.id_usuario, []);
    segsDe.get(s.id_usuario).push(new Date(s.fecha_seguimiento));
  }

  const filas = usuarios.map((u) => {
    const c = casoDe.get(u.id_usuario) || null;
    const segs = segsDe.get(u.id_usuario) || [];
    const desde = c?.abierto_en ? new Date(c.abierto_en) : null;
    return {
      ...u,
      precio_plan: u.precio_plan != null ? Number(u.precio_plan) : null,
      id_caso: c?.id_caso ?? null,
      cohorte: c?.cohorte ?? null,
      cohorte_label: c ? COHORTES[c.cohorte]?.label || c.cohorte : null,
      estado_caso: c?.estado ?? null,
      asignado_a_id: c?.asignado_a_id ?? null,
      asignado_a_nombre: c?.asignado_a_nombre ?? null,
      asignado_en: c?.asignado_en ?? null,
      abierto_en: c?.abierto_en ?? null,
      cerrado_en: c?.cerrado_en ?? null,
      cerrado_por: c?.cerrado_por ?? null,
      cierre_motivo: c?.cierre_motivo ?? null,
      estado_final: c?.estado_final ?? null,
      estado_final_label: c?.estado_final ? ESTADO_FINAL[c.estado_final] || c.estado_final : null,
      caso_updated_at: c?.updated_at ?? null,
      total_casos: Number(c?.total_casos || 0),
      seguimientos_caso: desde ? segs.filter((d) => d >= desde).length : segs.length,
      total_seguimientos: segs.length,
      ultimo_seguimiento: segs.length ? new Date(Math.max(...segs)) : null,
      automatizaciones_enviadas: autosDe.get(u.id_usuario) || 0,
    };
  });
  // Con caso primero (el más reciente arriba); los que nunca entraron, al final.
  filas.sort((a, b) => {
    if (!!a.id_caso !== !!b.id_caso) return a.id_caso ? -1 : 1;
    return new Date(b.caso_updated_at || 0) - new Date(a.caso_updated_at || 0);
  });
  return filas;
}

// ── Casos ───────────────────────────────────────────────────────────────
async function casoAbiertoDe(id_usuario) {
  const rows = await db.query(
    `SELECT * FROM recuperacion_casos_chat_center
      WHERE id_usuario = ? AND estado = 'abierto' ORDER BY id_caso DESC LIMIT 1`,
    { replacements: [id_usuario], type: db.QueryTypes.SELECT },
  );
  return rows[0] || null;
}

async function abrirCasoSiFalta(id_usuario, cohorte = 'manual') {
  await ensureTablas();
  const existente = await casoAbiertoDe(id_usuario);
  if (existente) return existente;
  const [u] = await db.query(
    `SELECT p.precio_plan FROM usuarios_chat_center u
       LEFT JOIN planes_chat_center p ON p.id_plan = u.id_plan
      WHERE u.id_usuario = ? LIMIT 1`,
    { replacements: [id_usuario], type: db.QueryTypes.SELECT },
  );
  await db.query(
    `INSERT INTO recuperacion_casos_chat_center (id_usuario, cohorte, monto_plan)
     VALUES (?, ?, ?)`,
    { replacements: [id_usuario, cohorte, u?.precio_plan ?? null], type: db.QueryTypes.INSERT },
  );
  return casoAbiertoDe(id_usuario);
}

async function asignarCaso({ id_usuario, asignado_a_id, asignado_a_nombre }) {
  const caso = await abrirCasoSiFalta(id_usuario);
  await db.query(
    `UPDATE recuperacion_casos_chat_center
        SET asignado_a_id = ?, asignado_a_nombre = ?, asignado_en = IF(? IS NULL, NULL, NOW())
      WHERE id_caso = ?`,
    {
      replacements: [asignado_a_id, asignado_a_nombre, asignado_a_id, caso.id_caso],
      type: db.QueryTypes.UPDATE,
    },
  );
  return casoAbiertoDe(id_usuario);
}

async function cerrarCaso({ id_usuario, estado, motivo, cerrado_por }) {
  if (!ESTADOS_CASO.includes(estado) || estado === 'abierto') {
    throw new Error('Estado de cierre inválido');
  }
  const caso = await casoAbiertoDe(id_usuario);
  if (!caso) throw new Error('El cliente no tiene un caso abierto');
  await db.query(
    `UPDATE recuperacion_casos_chat_center
        SET estado = ?, cerrado_en = NOW(), cerrado_por = ?, cierre_motivo = ?, estado_final = 'manual'
      WHERE id_caso = ?`,
    { replacements: [estado, cerrado_por, motivo || null, caso.id_caso], type: db.QueryTypes.UPDATE },
  );
  return { ...caso, estado, cerrado_por, cierre_motivo: motivo || null };
}

async function historialCasos(id_usuario) {
  await ensureTablas();
  return db.query(
    `SELECT * FROM recuperacion_casos_chat_center WHERE id_usuario = ? ORDER BY id_caso DESC LIMIT 20`,
    { replacements: [id_usuario], type: db.QueryTypes.SELECT },
  );
}

// ── Resultados ──────────────────────────────────────────────────────────
async function resultados({ dias = 30 }) {
  await ensureTablas();
  const d = Math.min(Math.max(Number(dias) || 30, 7), 365);

  const [totales, porAsesorCasos, porAsesorSeg, serie, motivos, resultadosSeg, recientes, porCohorte] =
    await Promise.all([
      db.query(
        `SELECT estado, COUNT(*) AS n, COALESCE(SUM(monto_plan), 0) AS monto,
                SUM(estado_final = 'pago') AS pagaron,
                SUM(estado_final = 'prueba') AS a_prueba
           FROM recuperacion_casos_chat_center
          WHERE estado = 'abierto' OR cerrado_en >= DATE_SUB(NOW(), INTERVAL :d DAY)
          GROUP BY estado`,
        { replacements: { d }, type: db.QueryTypes.SELECT },
      ),
      db.query(
        `SELECT asignado_a_id, asignado_a_nombre,
                SUM(estado = 'abierto') AS abiertos,
                SUM(estado = 'recuperado' AND cerrado_en >= DATE_SUB(NOW(), INTERVAL :d DAY)) AS recuperados,
                SUM(estado = 'perdido'    AND cerrado_en >= DATE_SUB(NOW(), INTERVAL :d DAY)) AS perdidos,
                SUM(estado = 'descartado' AND cerrado_en >= DATE_SUB(NOW(), INTERVAL :d DAY)) AS descartados,
                COALESCE(SUM(CASE WHEN estado = 'recuperado' AND cerrado_en >= DATE_SUB(NOW(), INTERVAL :d DAY)
                                  THEN monto_plan END), 0) AS monto_recuperado
           FROM recuperacion_casos_chat_center
          GROUP BY asignado_a_id, asignado_a_nombre`,
        { replacements: { d }, type: db.QueryTypes.SELECT },
      ),
      db.query(
        `SELECT ejecutado_por_id, ejecutado_por_nombre, COUNT(*) AS seguimientos,
                COUNT(DISTINCT id_usuario) AS clientes_contactados,
                SUM(resultado IN ('contactado_exitoso','interesado','retenido','convertido','promesa_pago','pago_confirmado')) AS conversaciones,
                SUM(resultado = 'no_contesto') AS no_contesto,
                SUM(resultado = 'promesa_pago') AS promesas,
                SUM(resultado IN ('retenido','convertido','pago_confirmado')) AS exitos
           FROM seguimiento_clientes_chat_center
          WHERE fecha_seguimiento >= DATE_SUB(NOW(), INTERVAL :d DAY)
          GROUP BY ejecutado_por_id, ejecutado_por_nombre`,
        { replacements: { d }, type: db.QueryTypes.SELECT },
      ),
      db.query(
        `SELECT YEARWEEK(cerrado_en, 3) AS semana, MIN(DATE(cerrado_en)) AS desde,
                SUM(estado = 'recuperado') AS recuperados,
                SUM(estado = 'perdido') AS perdidos,
                COALESCE(SUM(CASE WHEN estado = 'recuperado' THEN monto_plan END), 0) AS monto_recuperado
           FROM recuperacion_casos_chat_center
          WHERE cerrado_en >= DATE_SUB(NOW(), INTERVAL 84 DAY)
          GROUP BY semana ORDER BY semana`,
        { type: db.QueryTypes.SELECT },
      ),
      db.query(
        `SELECT motivo_cancelacion AS motivo, COUNT(*) AS n
           FROM seguimiento_clientes_chat_center
          WHERE motivo_cancelacion IS NOT NULL AND TRIM(motivo_cancelacion) <> ''
            AND fecha_seguimiento >= DATE_SUB(NOW(), INTERVAL :d DAY)
          GROUP BY motivo_cancelacion ORDER BY n DESC LIMIT 10`,
        { replacements: { d }, type: db.QueryTypes.SELECT },
      ),
      db.query(
        `SELECT resultado, COUNT(*) AS n
           FROM seguimiento_clientes_chat_center
          WHERE fecha_seguimiento >= DATE_SUB(NOW(), INTERVAL :d DAY)
          GROUP BY resultado ORDER BY n DESC`,
        { replacements: { d }, type: db.QueryTypes.SELECT },
      ),
      db.query(
        `SELECT c.id_caso, c.id_usuario, c.cohorte, c.estado, c.monto_plan, c.asignado_a_nombre,
                c.asignado_en, c.abierto_en, c.cerrado_en, c.cerrado_por, c.cierre_motivo, c.estado_final,
                u.nombre AS empresa, u.email_propietario AS email,
                (SELECT COUNT(*) FROM seguimiento_clientes_chat_center s
                  WHERE s.id_usuario = c.id_usuario AND s.fecha_seguimiento >= c.abierto_en) AS seguimientos_caso,
                (SELECT COUNT(*) FROM recuperacion_automatizacion_envios e
                  WHERE e.id_usuario = c.id_usuario AND e.estado = 'enviado') AS automatizaciones_enviadas
           FROM recuperacion_casos_chat_center c
           JOIN usuarios_chat_center u ON u.id_usuario = c.id_usuario
          WHERE c.estado <> 'abierto' AND c.cerrado_en >= DATE_SUB(NOW(), INTERVAL :d DAY)
          ORDER BY c.cerrado_en DESC LIMIT 100`,
        { replacements: { d }, type: db.QueryTypes.SELECT },
      ),
      // Por situación de entrada: cuántos de los que estaban en prueba o sin
      // tarjeta llegaron a pagar, cuántos empezaron la prueba, etc.
      db.query(
        `SELECT cohorte,
                SUM(estado = 'abierto') AS abiertos,
                SUM(estado = 'recuperado' AND cerrado_en >= DATE_SUB(NOW(), INTERVAL :d DAY)) AS recuperados,
                SUM(estado = 'perdido'    AND cerrado_en >= DATE_SUB(NOW(), INTERVAL :d DAY)) AS perdidos,
                SUM(estado_final = 'pago'   AND cerrado_en >= DATE_SUB(NOW(), INTERVAL :d DAY)) AS pagaron,
                SUM(estado_final = 'prueba' AND cerrado_en >= DATE_SUB(NOW(), INTERVAL :d DAY)) AS a_prueba,
                COALESCE(SUM(CASE WHEN estado = 'recuperado' AND cerrado_en >= DATE_SUB(NOW(), INTERVAL :d DAY)
                                  THEN monto_plan END), 0) AS monto_recuperado
           FROM recuperacion_casos_chat_center
          GROUP BY cohorte`,
        { replacements: { d }, type: db.QueryTypes.SELECT },
      ),
    ]);

  const tot = {
    abierto: 0, recuperado: 0, perdido: 0, descartado: 0,
    monto_recuperado: 0, monto_perdido: 0, pagaron: 0, a_prueba: 0,
  };
  for (const t of totales) {
    tot[t.estado] = Number(t.n);
    tot.pagaron += Number(t.pagaron || 0);
    tot.a_prueba += Number(t.a_prueba || 0);
    if (t.estado === 'recuperado') tot.monto_recuperado = Number(t.monto);
    if (t.estado === 'perdido') tot.monto_perdido = Number(t.monto);
  }
  const cerrados = tot.recuperado + tot.perdido;

  // Une casos y seguimientos por asesor (id del subusuario). "Sin asignar"
  // agrupa los casos que nadie tomó.
  const asesores = new Map();
  const get = (id, nombre) => {
    const k = id == null ? 'sin_asignar' : String(id);
    if (!asesores.has(k)) {
      asesores.set(k, {
        id_sub_usuario: id ?? null,
        nombre: id == null ? 'Sin asignar' : nombre || `Subusuario ${id}`,
        abiertos: 0, recuperados: 0, perdidos: 0, descartados: 0, monto_recuperado: 0,
        seguimientos: 0, clientes_contactados: 0, conversaciones: 0, no_contesto: 0, promesas: 0, exitos: 0,
      });
    }
    return asesores.get(k);
  };
  for (const a of porAsesorCasos) {
    const x = get(a.asignado_a_id, a.asignado_a_nombre);
    x.abiertos += Number(a.abiertos);
    x.recuperados += Number(a.recuperados);
    x.perdidos += Number(a.perdidos);
    x.descartados += Number(a.descartados);
    x.monto_recuperado += Number(a.monto_recuperado);
  }
  for (const s of porAsesorSeg) {
    if (s.ejecutado_por_id == null) continue;
    const x = get(s.ejecutado_por_id, s.ejecutado_por_nombre);
    x.seguimientos += Number(s.seguimientos);
    x.clientes_contactados += Number(s.clientes_contactados);
    x.conversaciones += Number(s.conversaciones);
    x.no_contesto += Number(s.no_contesto);
    x.promesas += Number(s.promesas);
    x.exitos += Number(s.exitos);
  }

  return {
    dias: d,
    totales: {
      ...tot,
      tasa_recuperacion: cerrados ? Math.round((tot.recuperado / cerrados) * 1000) / 10 : null,
    },
    asesores: [...asesores.values()].sort((a, b) => b.recuperados - a.recuperados || b.seguimientos - a.seguimientos),
    serie: serie.map((s) => ({
      semana: s.desde,
      recuperados: Number(s.recuperados),
      perdidos: Number(s.perdidos),
      monto_recuperado: Number(s.monto_recuperado),
    })),
    motivos: motivos.map((m) => ({ motivo: m.motivo, n: Number(m.n) })),
    resultados: resultadosSeg.map((r) => ({ resultado: r.resultado || 'sin_resultado', n: Number(r.n) })),
    por_cohorte: porCohorte
      .map((c) => ({
        cohorte: c.cohorte,
        label: COHORTES[c.cohorte]?.label || c.cohorte,
        abiertos: Number(c.abiertos),
        recuperados: Number(c.recuperados),
        perdidos: Number(c.perdidos),
        pagaron: Number(c.pagaron),
        a_prueba: Number(c.a_prueba),
        monto_recuperado: Number(c.monto_recuperado),
      }))
      .sort((a, b) => (COHORTES[a.cohorte]?.prioridad || 99) - (COHORTES[b.cohorte]?.prioridad || 99)),
    recientes,
  };
}

// ── Asesores (lista que administra el super admin) ──────────────────────
async function listarAsesores() {
  await ensureTablas();
  const elegidos = await db.query(
    `SELECT a.id, a.id_sub_usuario, a.activo, a.created_at,
            COALESCE(s.email, a.email) AS email,
            COALESCE(s.nombre_encargado, a.nombre) AS nombre,
            s.rol, s.id_usuario, u.nombre AS cuenta
       FROM recuperacion_asesores_chat_center a
       LEFT JOIN sub_usuarios_chat_center s ON s.id_sub_usuario = a.id_sub_usuario
       LEFT JOIN usuarios_chat_center u ON u.id_usuario = s.id_usuario
      ORDER BY a.activo DESC, nombre`,
    { type: db.QueryTypes.SELECT },
  );
  const internos = await db.query(
    `SELECT s.id_sub_usuario, s.email, s.nombre_encargado AS nombre, s.rol, u.nombre AS cuenta
       FROM sub_usuarios_chat_center s
       JOIN usuarios_chat_center u ON u.id_usuario = s.id_usuario
      WHERE s.rol IN ('super_administrador','gestor_clientes')
      ORDER BY s.rol, nombre`,
    { type: db.QueryTypes.SELECT },
  );
  return { elegidos, internos };
}

async function agregarAsesor({ email, agregado_por }) {
  await ensureTablas();
  const correo = String(email || '').trim().toLowerCase();
  if (!correo) throw new Error('Falta el correo del subusuario');
  const subs = await db.query(
    `SELECT s.id_sub_usuario, s.email, s.nombre_encargado, s.rol, u.nombre AS cuenta
       FROM sub_usuarios_chat_center s
       JOIN usuarios_chat_center u ON u.id_usuario = s.id_usuario
      WHERE LOWER(s.email) = ? OR LOWER(s.usuario) = ?
      ORDER BY s.id_sub_usuario`,
    { replacements: [correo, correo], type: db.QueryTypes.SELECT },
  );
  if (!subs.length) throw new Error(`No hay ningún subusuario con el correo ${correo}`);
  const agregados = [];
  for (const s of subs) {
    await db.query(
      `INSERT INTO recuperacion_asesores_chat_center (id_sub_usuario, email, nombre, activo, agregado_por)
       VALUES (?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE activo = 1, email = VALUES(email), nombre = VALUES(nombre)`,
      { replacements: [s.id_sub_usuario, s.email, s.nombre_encargado, agregado_por], type: db.QueryTypes.INSERT },
    );
    agregados.push(s);
  }
  return agregados;
}

async function cambiarAsesor({ id_sub_usuario, activo }) {
  await ensureTablas();
  await db.query(
    `UPDATE recuperacion_asesores_chat_center SET activo = ? WHERE id_sub_usuario = ?`,
    { replacements: [activo ? 1 : 0, id_sub_usuario], type: db.QueryTypes.UPDATE },
  );
}

async function quitarAsesor({ id_sub_usuario }) {
  await ensureTablas();
  await db.query(
    `DELETE FROM recuperacion_asesores_chat_center WHERE id_sub_usuario = ?`,
    { replacements: [id_sub_usuario], type: db.QueryTypes.DELETE },
  );
}

// Asesores a los que se puede asignar un caso: los elegidos activos + internos.
async function asignables() {
  const { elegidos, internos } = await listarAsesores();
  const out = new Map();
  for (const a of elegidos) if (a.activo && a.id_sub_usuario) out.set(a.id_sub_usuario, { id_sub_usuario: a.id_sub_usuario, nombre: a.nombre, email: a.email });
  for (const i of internos) out.set(i.id_sub_usuario, { id_sub_usuario: i.id_sub_usuario, nombre: i.nombre, email: i.email });
  return [...out.values()].sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
}

// Ficha del cliente para el drawer (sin pasar por admin_usuarios, que exige
// gestor_clientes).
async function fichaCliente(id_usuario, { id_sub_usuario = null } = {}) {
  const rows = await db.query(
    `SELECT u.id_usuario, u.nombre AS empresa, u.email_propietario AS email,
            u.whatsapp_lead, u.whatsapp_lead_pais, u.id_plan, p.nombre_plan, p.precio_plan,
            u.estado, u.stripe_subscription_status AS stripe_status, u.stripe_subscription_id,
            u.id_costumer, u.cancel_at_period_end, u.cancel_at, u.fecha_inicio, u.fecha_renovacion,
            u.trial_end, u.canceled_at, u.created_at AS registrado_en, u.permanente, u.tipo_plan,
            u.periodo_pago,
            (SELECT COUNT(*) FROM configuraciones c WHERE c.id_usuario = u.id_usuario AND c.suspendido = 0) AS conexiones_activas,
            (SELECT c.telefono FROM configuraciones c WHERE c.id_usuario = u.id_usuario AND c.suspendido = 0 ORDER BY c.id LIMIT 1) AS telefono_conexion,
            (SELECT c.nombre_configuracion FROM configuraciones c WHERE c.id_usuario = u.id_usuario AND c.suspendido = 0 ORDER BY c.id LIMIT 1) AS nombre_conexion,
            (SELECT COUNT(*) FROM sub_usuarios_chat_center s WHERE s.id_usuario = u.id_usuario) AS subusuarios
       FROM usuarios_chat_center u
       LEFT JOIN planes_chat_center p ON p.id_plan = u.id_plan
      WHERE u.id_usuario = ? LIMIT 1`,
    { replacements: [id_usuario], type: db.QueryTypes.SELECT },
  );
  const u = rows[0];
  if (!u) return null;
  const tel = telefonoDe(u);
  const [casos, conversacion_expertos] = await Promise.all([
    historialCasos(id_usuario),
    conversacionExpertos(tel.digits, { id_sub_usuario }),
  ]);
  return {
    ...u,
    precio_plan: u.precio_plan != null ? Number(u.precio_plan) : null,
    whatsapp: tel.display,
    whatsapp_digits: tel.digits,
    whatsapp_url: tel.url,
    telefono_fuente: tel.fuente,
    conexion_nombre: tel.conexion_nombre,
    casos,
    conversacion_expertos,
  };
}

/**
 * Crea (o encuentra) al cliente como contacto en la conexión de Expertos y
 * devuelve su id para abrir /abrir-chat/<conexión>/<id>. Mismo camino que el
 * "+" del chat (agregarNumeroChat): ensureUnifiedClient dedupe por los últimos
 * 9 dígitos y, si el contacto no tiene encargado, se lo queda el asesor.
 */
async function abrirChatExpertos({ id_usuario, sessionUser }) {
  const exp = await conexionExpertos(sessionUser.id_usuario);
  if (!exp.disponible) throw new Error(exp.motivo);

  const [r] = await db.query(
    `SELECT u.nombre AS empresa, u.whatsapp_lead, u.whatsapp_lead_pais,
            (SELECT c.telefono FROM configuraciones c WHERE c.id_usuario = u.id_usuario AND c.suspendido = 0 ORDER BY c.id LIMIT 1) AS telefono_conexion,
            (SELECT c.nombre_configuracion FROM configuraciones c WHERE c.id_usuario = u.id_usuario AND c.suspendido = 0 ORDER BY c.id LIMIT 1) AS nombre_conexion
       FROM usuarios_chat_center u WHERE u.id_usuario = ? LIMIT 1`,
    { replacements: [id_usuario], type: db.QueryTypes.SELECT },
  );
  if (!r) throw new Error('Cliente no encontrado');
  const tel = telefonoDe(r);
  if (!tel.digits) throw new Error('El cliente no tiene ningún número de WhatsApp registrado');

  const cliente = await ensureUnifiedClient({
    id_configuracion: exp.id_configuracion,
    id_usuario_dueno: exp.id_usuario,
    source: 'wa',
    business_phone_id: exp.id_telefono,
    phone: tel.digits,
    nombre_cliente: String(r.empresa || '').trim(),
    apellido_cliente: '',
    motivo: 'recuperacion_abrir_chat',
    permiso_round_robin: 0,
  });
  if (!cliente?.id) throw new Error('No se pudo crear el contacto en la conexión de Expertos');

  // El chat de otro asesor no se abre desde aquí: se pide la transferencia.
  const enc = cliente.id_encargado ? Number(cliente.id_encargado) : null;
  if (enc && enc !== Number(sessionUser.id_sub_usuario) && !ROLES_VEN_TODO.includes(sessionUser.rol)) {
    const [s] = await db.query(
      `SELECT nombre_encargado, usuario FROM sub_usuarios_chat_center WHERE id_sub_usuario = ? LIMIT 1`,
      { replacements: [enc], type: db.QueryTypes.SELECT },
    );
    const nombre = (s?.nombre_encargado || s?.usuario || 'otro asesor').trim();
    const e = new Error(`Este chat lo atiende ${nombre}. Pídele que te lo transfiera para poder abrirlo.`);
    e.code = 'CHAT_DE_OTRO';
    throw e;
  }

  if (!cliente.id_encargado && sessionUser.id_sub_usuario) {
    await db.query(
      `UPDATE clientes_chat_center SET id_encargado = ?, chat_cerrado = 0 WHERE id = ?`,
      { replacements: [sessionUser.id_sub_usuario, cliente.id], type: db.QueryTypes.UPDATE },
    );
  }
  // El embudo cachea quién tiene cada chat: que al volver ya lo vea como suyo.
  invalidarCacheEmbudo('chats');
  // El front deja estos datos en localStorage antes de abrir /chat/<id>: el
  // chat lee la conexión de ahí (id, tipo, plataforma) y la cabecera muestra
  // nombre_configuracion (sin él cae en un nombre de relleno).
  return {
    id_cliente: cliente.id,
    id_configuracion: exp.id_configuracion,
    nombre_configuracion: exp.nombre,
    tipo_configuracion: exp.tipo_configuracion,
    id_plataforma: exp.id_plataforma,
    telefono: tel.digits,
    fuente: tel.fuente,
  };
}

module.exports = {
  COHORTES,
  embudo,
  actividadAsesores,
  buscarCasos,
  clientesEnRiesgo,
  sincronizarCasosGlobal,
  situacionDeUsuario,
  abrirChatExpertos,
  invalidarCacheEmbudo,
  conexionExpertos,
  chatsExpertos,
  cuentasActivasPorNumero,
  COHORTES_SALIDA,
  asignarCaso,
  cerrarCaso,
  abrirCasoSiFalta,
  historialCasos,
  resultados,
  listarAsesores,
  agregarAsesor,
  cambiarAsesor,
  quitarAsesor,
  asignables,
  fichaCliente,
  telefonoDe,
};
