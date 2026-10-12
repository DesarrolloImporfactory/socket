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
           (SELECT c.telefono FROM configuraciones c
             WHERE c.id_usuario = u.id_usuario AND c.suspendido = 0
             ORDER BY c.id LIMIT 1) AS telefono_conexion,
           (SELECT c.nombre_configuracion FROM configuraciones c
             WHERE c.id_usuario = u.id_usuario AND c.suspendido = 0
             ORDER BY c.id LIMIT 1) AS nombre_conexion,
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

async function casosAbiertos() {
  const rows = await db.query(
    `SELECT * FROM recuperacion_casos_chat_center WHERE estado = 'abierto'`,
    { type: db.QueryTypes.SELECT },
  );
  return new Map(rows.map((r) => [r.id_usuario, r]));
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
    const values = nuevos.map((f) => [f.id_usuario, f.cohorte, f.precio_plan ?? null]);
    await db.query(
      `INSERT INTO recuperacion_casos_chat_center (id_usuario, cohorte, monto_plan)
       VALUES ${values.map(() => '(?,?,?)').join(',')}`,
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

async function embudo({ id_sub_usuario, id_usuario }) {
  await ensureTablas();
  const expertos = await conexionExpertos(id_usuario);
  const base = await db.query(SQL_COHORTES, { type: db.QueryTypes.SELECT });
  const ids = base.map((r) => r.id_usuario);

  let abiertos = await casosAbiertos();
  abiertos = await sincronizarCasos(base, abiertos);
  const ultimos = await ultimosSeguimientos(ids);

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
    return {
      id_usuario: r.id_usuario,
      empresa: r.empresa,
      email: r.email,
      whatsapp: tel.display,
      whatsapp_digits: tel.digits,
      whatsapp_url: tel.url,
      telefono_fuente: tel.fuente,
      conexion_nombre: tel.conexion_nombre,
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
  let misCasos = 0;
  let sinAsignar = 0;
  let paraHoy = 0;
  let promesasVencidas = 0;
  for (const f of filas) {
    resumen[f.cohorte].n += 1;
    resumen[f.cohorte].monto += f.precio_plan || 0;
    if (!f.ultimo_seguimiento) sinContacto += 1;
    if (f.caso?.es_mio) misCasos += 1;
    if (f.caso && !f.caso.asignado_a_id) sinAsignar += 1;
    if (f.proximo_vencido || (f.proximo_contacto && new Date(f.proximo_contacto) <= new Date(hoy.getTime() + 86399000))) paraHoy += 1;
    if (f.promesa_pago && f.proximo_vencido) promesasVencidas += 1;
  }

  const r2 = (n) => Math.round(n * 100) / 100;
  return {
    generado: new Date().toISOString(),
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
      mis_casos: misCasos,
      sin_asignar: sinAsignar,
      para_hoy: paraHoy,
      promesas_vencidas: promesasVencidas,
    },
    filas,
  };
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
                c.abierto_en, c.cerrado_en, c.cerrado_por, c.cierre_motivo,
                u.nombre AS empresa, u.email_propietario AS email
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
async function fichaCliente(id_usuario) {
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
  const casos = await historialCasos(id_usuario);
  const tel = telefonoDe(u);
  return {
    ...u,
    precio_plan: u.precio_plan != null ? Number(u.precio_plan) : null,
    whatsapp: tel.display,
    whatsapp_digits: tel.digits,
    whatsapp_url: tel.url,
    telefono_fuente: tel.fuente,
    conexion_nombre: tel.conexion_nombre,
    casos,
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

  if (!cliente.id_encargado && sessionUser.id_sub_usuario) {
    await db.query(
      `UPDATE clientes_chat_center SET id_encargado = ?, chat_cerrado = 0 WHERE id = ?`,
      { replacements: [sessionUser.id_sub_usuario, cliente.id], type: db.QueryTypes.UPDATE },
    );
  }
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
  clientesEnRiesgo,
  sincronizarCasosGlobal,
  situacionDeUsuario,
  abrirChatExpertos,
  conexionExpertos,
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
};
