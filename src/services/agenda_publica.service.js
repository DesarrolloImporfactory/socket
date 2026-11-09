'use strict';

/* ════════════════════════════════════════════════════════════════════════
   Agenda pública (/agendar y /agendar/:slug) — reservas en línea para
   cualquier cuenta que use el calendario.

   POR QUÉ EXISTE

   Hasta el 2026-11-04 «Agendar implementación gratis» (modal de arranque) y
   «Agendar demo» (/home) abrían un Calendly conectado a un Google Calendar
   ajeno al sistema. Problemas: mucha gente agendaba y no entraba (nadie le
   recordaba nada por WhatsApp), el dueño tenía que vivir en ese Google
   Calendar, y el asesor copiaba a mano cada reunión a su agenda de ImporChat
   para que le saliera en pantalla.

   Ese mismo día se abrió para TODAS las cuentas: cada negocio que vende
   servicios tiene su enlace (/agendar/<slug>) y configura su agenda desde
   Calendario → Agenda pública (horario, duración, días, quién atiende,
   lugar o videollamada). La agenda «principal» (agenda_publica_config.
   principal = 1, hoy la 265 «Soporte Importaciones Expertos») es la que
   abren el modal de arranque y /home; /agendar sin slug cae ahí.

   La reserva cae DIRECTO en la agenda de ImporChat de la cuenta
   (calendars.account_id = id_configuracion), asignada a un asesor:

     · Google: el evento se crea en el Google Calendar que ESE asesor tiene
       vinculado a esa agenda (users_google_accounts), con Meet (si la agenda
       es por videollamada) y con invitación por correo a quien reservó
       (sendUpdates = 'all').
     · WhatsApp: confirmación inmediata con la plantilla de la cuenta
       (plantilla_confirmacion, opcional) y el recordatorio del cron de
       siempre (cron/aviso_calendarios.js); para eso la cita lleva al cliente
       como invitado con su teléfono.
     · Contacto: la persona queda creada en clientes_chat_center de la
       cuenta, con su asesor como encargado, para que pueda escribirle.

   REPARTO. Quiénes reciben reservas lo decide la cuenta
   (agenda_publica_asesores). Para cada hueco libre se elige al asesor con
   menos reservas en los últimos 30 días; en empate, el que lleva más tiempo
   sin recibir una. Un hueco se ofrece si al menos un asesor activo está libre.

   QUÉ CUENTA COMO OCUPADO para un asesor: una cita suya en la agenda
   (assigned_user_id), un evento que entró desde SU Google (google_events_links
   guarda quién lo importó), un 'Bloqueado' sin encargado (cierra la agenda a
   todos) y una cita sin encargado que nadie importó de Google (no se sabe de
   quién es: no se encima).

   HORARIO. Los huecos van de hora_inicio a hora_fin en la zona de la cuenta
   y el último empieza de modo que TERMINE a hora_fin: con 08:00–17:00 y 60
   min el último es a las 16:00. Nadie agenda a la hora en que el equipo ya
   se fue.
   ════════════════════════════════════════════════════════════════════════ */

const moment = require('moment-timezone');
const { db } = require('../database/config');
const AppError = require('../utils/appError');
const servicioAppointments = require('./appointments.service');
const { getActiveLink, importChanges } = require('../utils/googleSync');
const { permisoCalendario, olvidarPermiso } = require('../utils/googlePermiso');
const axios = require('axios');
const { obtenerOCrearContactoWa } = require('../utils/unified/dedupeContacto');
const { normalizarTelefonoPublico } = require('../utils/telefonoPublico');

/* Valores por defecto de una agenda nueva. La principal (265/32) se sembró
   el 2026-11-04 con estos mismos y luego se ajustó desde el admin. */
const CONFIG_INICIAL = {
  activo: 0,
  duracion_min: 60,
  hora_inicio: '08:00',
  hora_fin: '17:00',
  dias: '1,2,3,4,5',
  anticipacion_horas: 3,
  dias_adelante: 14,
  /* Pausa diaria (almuerzo) con margen: ninguna cita empieza ni termina
     entre pausa_inicio − margen y pausa_fin + margen. Nació con Juan (Soporte
     Expertos, 09-11-2026): sale a almorzar 12:30–13:30 y quiere 15 min antes
     para dejar los chats resueltos y 15 min después para retomarlos sin una
     reunión esperando. null = sin pausa. */
  pausa_inicio: null,
  pausa_fin: null,
  pausa_margen_min: 0,
  time_zone: 'America/Guayaquil',
  titulo: 'Cita',
  descripcion: null,
  lugar: null, // null = videollamada por Google Meet
  plantilla_confirmacion: null,
  google_link_id: null, // cuenta de Google de la agenda (users_google_accounts.id)
  /* Apariencia de /agendar/<slug>. La página sale azul oscuro con acento
     cyan (ImporChat); cada negocio pone su fondo, su acento y una insignia
     corta en la cabecera (donde la principal muestra el sello de Meta). */
  insignia: null, // «Agencia certificada», «Atención 24/7»… null = sin insignia
  color_fondo: null, // #rrggbb; null = azul oscuro
  color_acento: null, // #rrggbb; null = cyan
};
const PRINCIPAL_INICIAL = {
  id_configuracion: 265,
  calendar_id: 32,
  slug: 'imporchat',
  activo: 1,
  titulo: 'Implementación de ImporChat',
  descripcion:
    'Conectamos tu WhatsApp con la API oficial, activamos tu agente de IA y lo probamos con un chat real. Una hora por videollamada.',
  plantilla_confirmacion: 'reunion_agendada_imporchat',
};
const ASESOR_INICIAL = 2474; // Juan Garzón

const ORIGENES = new Set(['modal', 'home', 'enlace']);
const ESTADOS_OCUPAN = ['Agendado', 'Confirmado', 'Bloqueado'];
const DIAS_VENTANA_MAX = 60;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RE_SLUG = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;
const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const RE_COLOR = /^#[0-9a-f]{6}$/;

/* "#1E90FF" → "#1e90ff"; "#fff" se expande; cualquier otra cosa → null. */
function colorHex(v) {
  let s = String(v || '')
    .trim()
    .toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + [...s.slice(1)].map((c) => c + c).join('');
  return RE_COLOR.test(s) ? s : null;
}

/* AppError solo lleva mensaje y status; el `code` lo reenvía el manejador
   global y el front lo usa para saber si tiene que recargar los huecos. */
function fallo(mensaje, status, code) {
  const e = new AppError(mensaje, status);
  if (code) e.code = code;
  return e;
}

/* ═══════════════════ Tablas ═══════════════════ */

let tablasListas = false;
async function ensureTablas() {
  if (tablasListas) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS agenda_publica_config (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      activo TINYINT NOT NULL DEFAULT 1,
      id_configuracion INT NOT NULL,
      slug VARCHAR(80) NULL,
      principal TINYINT NOT NULL DEFAULT 0,
      calendar_id BIGINT UNSIGNED NOT NULL,
      duracion_min SMALLINT NOT NULL DEFAULT 60,
      hora_inicio VARCHAR(5) NOT NULL DEFAULT '08:00',
      hora_fin VARCHAR(5) NOT NULL DEFAULT '17:00',
      dias VARCHAR(20) NOT NULL DEFAULT '1,2,3,4,5',
      anticipacion_horas SMALLINT NOT NULL DEFAULT 3,
      dias_adelante SMALLINT NOT NULL DEFAULT 14,
      time_zone VARCHAR(64) NOT NULL DEFAULT 'America/Guayaquil',
      titulo VARCHAR(120) NOT NULL DEFAULT 'Cita',
      descripcion TEXT NULL,
      lugar VARCHAR(200) NULL,
      insignia VARCHAR(60) NULL,
      color_fondo VARCHAR(7) NULL,
      color_acento VARCHAR(7) NULL,
      pausa_inicio VARCHAR(5) NULL,
      pausa_fin VARCHAR(5) NULL,
      pausa_margen_min SMALLINT NOT NULL DEFAULT 0,
      plantilla_confirmacion VARCHAR(100) NULL,
      google_link_id INT NULL,
      actualizado_por INT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY ux_configuracion (id_configuracion),
      UNIQUE KEY ux_slug (slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS agenda_publica_asesores (
      id INT AUTO_INCREMENT PRIMARY KEY,
      id_configuracion INT NOT NULL DEFAULT 0,
      id_sub_usuario INT NOT NULL,
      activo TINYINT NOT NULL DEFAULT 1,
      orden INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY ux_cfg_sub (id_configuracion, id_sub_usuario)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS agenda_publica_reservas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      id_configuracion INT NOT NULL DEFAULT 0,
      appointment_id BIGINT UNSIGNED NULL,
      id_sub_usuario INT NOT NULL,
      nombre VARCHAR(120) NOT NULL,
      email VARCHAR(160) NOT NULL,
      telefono VARCHAR(20) NOT NULL,
      origen VARCHAR(20) NOT NULL DEFAULT 'enlace',
      id_usuario_cuenta INT NULL,
      id_cliente INT NULL,
      start_utc DATETIME NOT NULL,
      end_utc DATETIME NOT NULL,
      meeting_url VARCHAR(255) NULL,
      tz_cliente VARCHAR(64) NULL,
      google_ok TINYINT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_asesor_fecha (id_sub_usuario, created_at),
      KEY idx_inicio (start_utc),
      KEY idx_cfg_inicio (id_configuracion, start_utc),
      KEY idx_cuenta (id_usuario_cuenta),
      KEY idx_telefono (telefono)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  /* Columnas que llegaron después de crear la tabla (2026-11-04, apariencia):
     en una BD donde ya existía se añaden aquí, igual que el CREATE IF NOT
     EXISTS de arriba, para no depender de correr el .sql a mano. */
  const columnas = await db.query(`SHOW COLUMNS FROM agenda_publica_config`, {
    type: db.QueryTypes.SELECT,
  });
  const tiene = new Set(columnas.map((c) => c.Field));
  const faltan = [
    ['insignia', 'VARCHAR(60) NULL AFTER lugar'],
    ['color_fondo', 'VARCHAR(7) NULL AFTER insignia'],
    ['color_acento', 'VARCHAR(7) NULL AFTER color_fondo'],
    // 2026-11-09, pausa de almuerzo con margen.
    ['pausa_inicio', 'VARCHAR(5) NULL AFTER color_acento'],
    ['pausa_fin', 'VARCHAR(5) NULL AFTER pausa_inicio'],
    ['pausa_margen_min', 'SMALLINT NOT NULL DEFAULT 0 AFTER pausa_fin'],
  ].filter(([col]) => !tiene.has(col));
  if (faltan.length) {
    await db.query(
      `ALTER TABLE agenda_publica_config ${faltan
        .map(([col, def]) => `ADD COLUMN ${col} ${def}`)
        .join(', ')}`,
    );
  }
  /* Siembra de la principal, solo si no hay ninguna marcada. */
  await db.query(
    `INSERT INTO agenda_publica_config
       (activo, id_configuracion, slug, principal, calendar_id, duracion_min, hora_inicio,
        hora_fin, dias, anticipacion_horas, dias_adelante, time_zone, titulo, descripcion,
        plantilla_confirmacion)
     SELECT ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM DUAL
      WHERE NOT EXISTS (SELECT 1 FROM agenda_publica_config WHERE principal = 1)`,
    {
      replacements: [
        PRINCIPAL_INICIAL.activo,
        PRINCIPAL_INICIAL.id_configuracion,
        PRINCIPAL_INICIAL.slug,
        PRINCIPAL_INICIAL.calendar_id,
        CONFIG_INICIAL.duracion_min,
        CONFIG_INICIAL.hora_inicio,
        CONFIG_INICIAL.hora_fin,
        CONFIG_INICIAL.dias,
        CONFIG_INICIAL.anticipacion_horas,
        CONFIG_INICIAL.dias_adelante,
        CONFIG_INICIAL.time_zone,
        PRINCIPAL_INICIAL.titulo,
        PRINCIPAL_INICIAL.descripcion,
        PRINCIPAL_INICIAL.plantilla_confirmacion,
      ],
      type: db.QueryTypes.INSERT,
    },
  );
  await db.query(
    `INSERT IGNORE INTO agenda_publica_asesores (id_configuracion, id_sub_usuario, activo, orden)
     SELECT ?, ?, 1, 0 FROM DUAL
      WHERE NOT EXISTS (SELECT 1 FROM agenda_publica_asesores WHERE id_configuracion = ?)`,
    {
      replacements: [PRINCIPAL_INICIAL.id_configuracion, ASESOR_INICIAL, PRINCIPAL_INICIAL.id_configuracion],
      type: db.QueryTypes.INSERT,
    },
  );
  tablasListas = true;
}

/* ═══════════════════ Configuración ═══════════════════ */

function normalizar(row) {
  const cfg = { ...CONFIG_INICIAL, ...(row || {}) };
  cfg.activo = Number(cfg.activo) ? 1 : 0;
  cfg.principal = Number(cfg.principal) ? 1 : 0;
  cfg.id_configuracion = Number(cfg.id_configuracion) || null;
  cfg.calendar_id = Number(cfg.calendar_id) || null;
  cfg.duracion_min = Math.max(10, Number(cfg.duracion_min) || 60);
  cfg.anticipacion_horas = Math.max(0, Number(cfg.anticipacion_horas) || 0);
  cfg.dias_adelante = Math.min(
    DIAS_VENTANA_MAX,
    Math.max(1, Number(cfg.dias_adelante) || 14),
  );
  cfg.diasSet = new Set(
    String(cfg.dias || '')
      .split(',')
      .map((d) => Number(String(d).trim()))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
  );
  if (!moment.tz.zone(cfg.time_zone)) cfg.time_zone = CONFIG_INICIAL.time_zone;
  cfg.lugar = cfg.lugar ? String(cfg.lugar) : null;
  cfg.plantilla_confirmacion = cfg.plantilla_confirmacion || null;
  cfg.google_link_id = Number(cfg.google_link_id) || null;
  cfg.insignia = String(cfg.insignia || '').trim().slice(0, 60) || null;
  cfg.color_fondo = colorHex(cfg.color_fondo);
  cfg.color_acento = colorHex(cfg.color_acento);
  cfg.pausa_inicio = HORA_RE.test(String(cfg.pausa_inicio || '')) ? cfg.pausa_inicio : null;
  cfg.pausa_fin = HORA_RE.test(String(cfg.pausa_fin || '')) ? cfg.pausa_fin : null;
  if (!cfg.pausa_inicio || !cfg.pausa_fin || cfg.pausa_fin <= cfg.pausa_inicio) {
    cfg.pausa_inicio = null;
    cfg.pausa_fin = null;
  }
  cfg.pausa_margen_min = Math.min(120, Math.max(0, Number(cfg.pausa_margen_min) || 0));
  cfg.guardada = !!row && !row.__nueva;
  return cfg;
}

/* "12:30" → 750. */
function aMinutos(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

/* Rango bloqueado del día en minutos [desde, hasta), ya con el margen a cada
   lado, o null si la agenda no tiene pausa. */
function bloqueoPausa(cfg) {
  if (!cfg.pausa_inicio || !cfg.pausa_fin) return null;
  const margen = Number(cfg.pausa_margen_min) || 0;
  return {
    desde: aMinutos(cfg.pausa_inicio) - margen,
    hasta: aMinutos(cfg.pausa_fin) + margen,
  };
}

/* "Mariachi Sol de México" → "mariachi-sol-de-mexico". */
function slugify(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function slugLibre(slug, id_configuracion) {
  const [row] = await db.query(
    `SELECT id_configuracion FROM agenda_publica_config WHERE slug = ? LIMIT 1`,
    { replacements: [slug], type: db.QueryTypes.SELECT },
  );
  return !row || Number(row.id_configuracion) === Number(id_configuracion);
}

/* Slug sugerido para una cuenta que todavía no guardó su agenda: el nombre
   del negocio; si ya lo usa otra, con el id al final. */
async function slugSugerido(id_configuracion, nombre) {
  const base = slugify(nombre) || `agenda-${id_configuracion}`;
  if (await slugLibre(base, id_configuracion)) return base;
  return `${base}-${id_configuracion}`.slice(0, 80);
}

async function configPrincipal() {
  await ensureTablas();
  const [row] = await db.query(
    `SELECT * FROM agenda_publica_config WHERE principal = 1 ORDER BY id ASC LIMIT 1`,
    { type: db.QueryTypes.SELECT },
  );
  return row ? normalizar(row) : null;
}

async function configPorSlug(slug) {
  await ensureTablas();
  const s = String(slug || '').trim().toLowerCase();
  if (!s) return configPrincipal();
  const [row] = await db.query(
    `SELECT * FROM agenda_publica_config WHERE slug = ? LIMIT 1`,
    { replacements: [s], type: db.QueryTypes.SELECT },
  );
  return row ? normalizar(row) : null;
}

/* La agenda de una cuenta. Si todavía no guardó nada, devuelve una propuesta
   (apagada, con su calendario activo y un slug sugerido) para que el panel
   la muestre y el primer «Guardar» la cree. */
async function configDeCuenta(id_configuracion) {
  await ensureTablas();
  const id = Number(id_configuracion);
  if (!id) throw new AppError('id_configuracion es requerido', 400);
  const [row] = await db.query(
    `SELECT * FROM agenda_publica_config WHERE id_configuracion = ? LIMIT 1`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );
  if (row) return normalizar(row);

  const [cuenta] = await db.query(
    `SELECT id, nombre_configuracion FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );
  if (!cuenta) throw new AppError('La cuenta no existe', 404);
  const [cal] = await db.query(
    `SELECT id FROM calendars WHERE account_id = ? AND is_active = 1 ORDER BY id ASC LIMIT 1`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );
  return normalizar({
    id_configuracion: id,
    calendar_id: cal?.id || null,
    slug: await slugSugerido(id, cuenta.nombre_configuracion),
    titulo: `Cita con ${String(cuenta.nombre_configuracion || '').trim() || 'nosotros'}`.slice(0, 120),
    activo: 0,
    principal: 0,
    __nueva: true,
  });
}

async function guardarConfig(id_configuracion, datos = {}, actualizado_por = null) {
  const actual = await configDeCuenta(id_configuracion);
  const n = { ...actual };

  if (datos.activo !== undefined) n.activo = datos.activo ? 1 : 0;
  if (datos.duracion_min !== undefined) {
    const d = Number(datos.duracion_min);
    if (!Number.isInteger(d) || d < 10 || d > 240)
      throw new AppError('La duración debe estar entre 10 y 240 minutos', 400);
    n.duracion_min = d;
  }
  for (const campo of ['hora_inicio', 'hora_fin']) {
    if (datos[campo] !== undefined) {
      const v = String(datos[campo]).trim();
      if (!HORA_RE.test(v))
        throw new AppError(`${campo} debe tener formato HH:MM`, 400);
      n[campo] = v;
    }
  }
  if (n.hora_fin <= n.hora_inicio)
    throw new AppError('La hora de cierre debe ser mayor a la de apertura', 400);
  {
    const [hi, mi] = n.hora_inicio.split(':').map(Number);
    const [hf, mf] = n.hora_fin.split(':').map(Number);
    if (hf * 60 + mf - (hi * 60 + mi) < n.duracion_min)
      throw new AppError('Entre apertura y cierre no cabe ni una cita de esa duración', 400);
  }
  /* Pausa: las dos horas o ninguna; dentro del horario; margen 0–120. */
  for (const campo of ['pausa_inicio', 'pausa_fin']) {
    if (datos[campo] !== undefined) {
      const v = String(datos[campo] || '').trim();
      if (v && !HORA_RE.test(v))
        throw new AppError(`${campo === 'pausa_inicio' ? 'El inicio' : 'El fin'} de la pausa debe tener formato HH:MM`, 400);
      n[campo] = v || null;
    }
  }
  if (datos.pausa_margen_min !== undefined) {
    const m = Number(datos.pausa_margen_min);
    if (!Number.isInteger(m) || m < 0 || m > 120)
      throw new AppError('El margen de la pausa debe estar entre 0 y 120 minutos', 400);
    n.pausa_margen_min = m;
  }
  if (!!n.pausa_inicio !== !!n.pausa_fin)
    throw new AppError('La pausa necesita hora de inicio y de fin (o ninguna de las dos)', 400);
  if (n.pausa_inicio) {
    if (n.pausa_fin <= n.pausa_inicio)
      throw new AppError('El fin de la pausa debe ser mayor a su inicio', 400);
    if (n.pausa_inicio < n.hora_inicio || n.pausa_fin > n.hora_fin)
      throw new AppError('La pausa debe quedar dentro del horario de atención', 400);
  }
  if (datos.dias !== undefined) {
    const lista = (Array.isArray(datos.dias) ? datos.dias : String(datos.dias).split(','))
      .map((d) => Number(String(d).trim()))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (!lista.length) throw new AppError('Elige al menos un día', 400);
    n.dias = [...new Set(lista)].sort().join(',');
  }
  if (datos.anticipacion_horas !== undefined) {
    const a = Number(datos.anticipacion_horas);
    if (!Number.isFinite(a) || a < 0 || a > 168)
      throw new AppError('La anticipación debe estar entre 0 y 168 horas', 400);
    n.anticipacion_horas = a;
  }
  if (datos.dias_adelante !== undefined) {
    const d = Number(datos.dias_adelante);
    if (!Number.isInteger(d) || d < 1 || d > DIAS_VENTANA_MAX)
      throw new AppError(`Días hacia adelante: entre 1 y ${DIAS_VENTANA_MAX}`, 400);
    n.dias_adelante = d;
  }
  if (datos.time_zone !== undefined) {
    if (!moment.tz.zone(String(datos.time_zone)))
      throw new AppError('Zona horaria inválida', 400);
    n.time_zone = String(datos.time_zone);
  }
  if (datos.titulo !== undefined) {
    const t = String(datos.titulo).trim().slice(0, 120);
    if (!t) throw new AppError('El título no puede quedar vacío', 400);
    n.titulo = t;
  }
  if (datos.descripcion !== undefined) {
    n.descripcion = String(datos.descripcion || '').trim().slice(0, 1000) || null;
  }
  if (datos.lugar !== undefined) {
    n.lugar = String(datos.lugar || '').trim().slice(0, 200) || null;
  }
  if (datos.plantilla_confirmacion !== undefined) {
    const p = String(datos.plantilla_confirmacion || '').trim().slice(0, 100);
    if (p && !/^[a-z0-9_]+$/.test(p))
      throw new AppError('El nombre de la plantilla solo lleva minúsculas, números y guion bajo', 400);
    n.plantilla_confirmacion = p || null;
  }
  if (datos.google_link_id !== undefined) {
    n.google_link_id = Number(datos.google_link_id) || null;
  }
  if (datos.insignia !== undefined) {
    n.insignia = String(datos.insignia || '').trim().slice(0, 60) || null;
  }
  for (const campo of ['color_fondo', 'color_acento']) {
    if (datos[campo] === undefined) continue;
    const crudo = String(datos[campo] || '').trim();
    const hex = colorHex(crudo);
    if (crudo && !hex)
      throw new AppError(
        `El ${campo === 'color_fondo' ? 'color de fondo' : 'color de acento'} debe ser un hexadecimal como #1E90FF`,
        400,
      );
    n[campo] = hex;
  }
  if (datos.slug !== undefined) {
    const s = String(datos.slug || '').trim().toLowerCase();
    if (!RE_SLUG.test(s))
      throw new AppError('El enlace solo lleva letras minúsculas, números y guiones (3 a 60 caracteres)', 400);
    if (!(await slugLibre(s, n.id_configuracion)))
      throw new AppError('Ese enlace ya lo usa otra cuenta, elige otro', 409);
    n.slug = s;
  }
  if (!n.slug) n.slug = await slugSugerido(n.id_configuracion, '');
  /* El calendario debe ser de la misma cuenta: cambiarlo mueve todas las
     reservas nuevas, así que se valida fuerte. */
  if (datos.calendar_id !== undefined) {
    const calendar_id = Number(datos.calendar_id);
    const [cal] = await db.query(
      `SELECT id, account_id FROM calendars WHERE id = ? AND is_active = 1 LIMIT 1`,
      { replacements: [calendar_id], type: db.QueryTypes.SELECT },
    );
    if (!cal) throw new AppError('La agenda no existe o está inactiva', 400);
    if (Number(cal.account_id) !== Number(n.id_configuracion))
      throw new AppError('Ese calendario no pertenece a esta cuenta', 400);
    n.calendar_id = calendar_id;
  }
  if (!n.calendar_id) throw new AppError('La cuenta no tiene un calendario activo', 400);

  await db.query(
    `INSERT INTO agenda_publica_config
       (activo, id_configuracion, slug, principal, calendar_id, duracion_min, hora_inicio,
        hora_fin, dias, anticipacion_horas, dias_adelante, time_zone, titulo, descripcion,
        lugar, insignia, color_fondo, color_acento, pausa_inicio, pausa_fin, pausa_margen_min,
        plantilla_confirmacion, google_link_id, actualizado_por)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       activo = VALUES(activo), slug = VALUES(slug), calendar_id = VALUES(calendar_id),
       duracion_min = VALUES(duracion_min), hora_inicio = VALUES(hora_inicio),
       hora_fin = VALUES(hora_fin), dias = VALUES(dias),
       anticipacion_horas = VALUES(anticipacion_horas), dias_adelante = VALUES(dias_adelante),
       time_zone = VALUES(time_zone), titulo = VALUES(titulo), descripcion = VALUES(descripcion),
       lugar = VALUES(lugar), insignia = VALUES(insignia), color_fondo = VALUES(color_fondo),
       color_acento = VALUES(color_acento), pausa_inicio = VALUES(pausa_inicio),
       pausa_fin = VALUES(pausa_fin), pausa_margen_min = VALUES(pausa_margen_min),
       plantilla_confirmacion = VALUES(plantilla_confirmacion),
       google_link_id = VALUES(google_link_id), actualizado_por = VALUES(actualizado_por)`,
    {
      replacements: [
        n.activo,
        n.id_configuracion,
        n.slug,
        n.principal,
        n.calendar_id,
        n.duracion_min,
        n.hora_inicio,
        n.hora_fin,
        n.dias,
        n.anticipacion_horas,
        n.dias_adelante,
        n.time_zone,
        n.titulo,
        n.descripcion,
        n.lugar,
        n.insignia,
        n.color_fondo,
        n.color_acento,
        n.pausa_inicio,
        n.pausa_fin,
        n.pausa_margen_min,
        n.plantilla_confirmacion,
        n.google_link_id,
        actualizado_por,
      ],
      type: db.QueryTypes.INSERT,
    },
  );
  return configDeCuenta(n.id_configuracion);
}

/* ═══════════════════ Asesores ═══════════════════ */

/* Los que reciben reservas hoy: activos en la lista y no suspendidos. */
async function asesoresActivos(cfg) {
  await ensureTablas();
  return db.query(
    `SELECT a.id_sub_usuario, a.orden, s.nombre_encargado AS nombre
       FROM agenda_publica_asesores a
       JOIN sub_usuarios_chat_center s ON s.id_sub_usuario = a.id_sub_usuario
      WHERE a.id_configuracion = ? AND a.activo = 1 AND COALESCE(s.suspendido, 0) = 0
      ORDER BY a.orden ASC, a.id ASC`,
    { replacements: [cfg.id_configuracion], type: db.QueryTypes.SELECT },
  );
}

/* Quién puede entrar a la lista: cualquier sub-usuario de la cuenta dueña de
   la agenda, con su vínculo de Google EN ESA agenda (es lo que decide si la
   reserva le llega al calendario). */
async function candidatos(cfg) {
  return db.query(
    `SELECT s.id_sub_usuario, s.nombre_encargado AS nombre, s.usuario, s.rol,
            s.email, COALESCE(s.suspendido, 0) AS suspendido,
            g.google_email,
            (g.id IS NOT NULL AND g.refresh_token IS NOT NULL) AS google_vinculado,
            a.activo AS en_lista, a.orden
       FROM sub_usuarios_chat_center s
       JOIN configuraciones c ON c.id_usuario = s.id_usuario
       LEFT JOIN users_google_accounts g
              ON g.id_sub_usuario = s.id_sub_usuario AND g.calendar_id = ? AND g.is_active = 1
       LEFT JOIN agenda_publica_asesores a
              ON a.id_sub_usuario = s.id_sub_usuario AND a.id_configuracion = ?
      WHERE c.id = ?
      ORDER BY (a.activo IS NULL) ASC, a.orden ASC, s.nombre_encargado ASC`,
    {
      replacements: [cfg.calendar_id, cfg.id_configuracion, cfg.id_configuracion],
      type: db.QueryTypes.SELECT,
    },
  );
}

async function guardarAsesores(id_configuracion, lista = []) {
  const cfg = await configDeCuenta(id_configuracion);
  if (!Array.isArray(lista)) throw new AppError('Se espera una lista', 400);

  const validos = await db.query(
    `SELECT s.id_sub_usuario FROM sub_usuarios_chat_center s
       JOIN configuraciones c ON c.id_usuario = s.id_usuario
      WHERE c.id = ?`,
    { replacements: [cfg.id_configuracion], type: db.QueryTypes.SELECT },
  );
  const permitidos = new Set(validos.map((v) => Number(v.id_sub_usuario)));

  for (const [i, item] of lista.entries()) {
    const id = Number(item?.id_sub_usuario);
    if (!permitidos.has(id))
      throw new AppError(`El sub-usuario ${id} no pertenece a esta cuenta`, 400);
    await db.query(
      `INSERT INTO agenda_publica_asesores (id_configuracion, id_sub_usuario, activo, orden)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE activo = VALUES(activo), orden = VALUES(orden)`,
      {
        replacements: [
          cfg.id_configuracion,
          id,
          item?.activo ? 1 : 0,
          Number.isInteger(item?.orden) ? item.orden : i,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  }
  return asesoresActivos(cfg);
}

/* ═══════════════════ Google: traer lo nuevo antes de ofrecer huecos ═══════════════════ */

const ultimoPull = new Map(); // linkId → ms
const PULL_CADA_MS = 2 * 60 * 1000;
const PULL_TIMEOUT_MS = 6000;

async function sincronizarGoogle(cfg, asesores) {
  const vistos = new Set();
  const tareas = [];
  const links = [];
  const agenda = await vinculoAgenda(cfg);
  if (agenda) links.push(agenda);
  for (const a of asesores) {
    try {
      links.push(await getActiveLink(a.id_sub_usuario, cfg.calendar_id));
    } catch (_) {
      /* sin vínculo */
    }
  }
  for (const link of links) {
    if (!link?.id || vistos.has(link.id)) continue;
    vistos.add(link.id);
    const hace = Date.now() - (ultimoPull.get(link.id) || 0);
    if (hace < PULL_CADA_MS) continue;
    ultimoPull.set(link.id, Date.now());
    /* El pull sigue solo si tarda: la página no puede quedarse esperando a
       Google. Lo que no alcanzó a entrar se verá en la siguiente consulta. */
    const p = importChanges({ linkId: link.id, reset: false }).catch((e) =>
      console.warn('[agenda_publica] pull Google falló:', e?.message || e),
    );
    tareas.push(
      Promise.race([p, new Promise((r) => setTimeout(r, PULL_TIMEOUT_MS))]),
    );
  }
  await Promise.all(tareas);
}

/* ═══════════════════ Ocupación y huecos ═══════════════════ */

/* Las fechas salen formateadas en SQL (DATE_FORMAT) y no como Date: la
   conexión está en -05:00 y mysql2 reinterpretaría el DATETIME que en
   realidad es UTC, corriendo todo cinco horas. Mismo criterio que
   appointments.service (compara con strings UTC). */
async function ocupaciones(cfg, desdeUtc, hastaUtc) {
  const rows = await db.query(
    `SELECT ap.id, ap.assigned_user_id, ap.status,
            DATE_FORMAT(ap.start_utc, '%Y-%m-%dT%H:%i:%sZ') AS inicio,
            DATE_FORMAT(ap.end_utc, '%Y-%m-%dT%H:%i:%sZ') AS fin,
            (SELECT gl.id_sub_usuario FROM google_events_links gl
              WHERE gl.appointment_id = ap.id AND gl.is_deleted = 0 LIMIT 1) AS google_sub
       FROM appointments ap
      WHERE ap.calendar_id = :calendar_id
        AND ap.status IN (:estados)
        AND ap.start_utc < :hasta AND ap.end_utc > :desde`,
    {
      replacements: {
        calendar_id: cfg.calendar_id,
        estados: ESTADOS_OCUPAN,
        hasta: hastaUtc.format('YYYY-MM-DD HH:mm:ss'),
        desde: desdeUtc.format('YYYY-MM-DD HH:mm:ss'),
      },
      type: db.QueryTypes.SELECT,
    },
  );

  return rows.map((r) => ({
    ...r,
    inicio: moment.utc(r.inicio),
    fin: moment.utc(r.fin),
    assigned_user_id: r.assigned_user_id == null ? null : Number(r.assigned_user_id),
    google_sub: r.google_sub == null ? null : Number(r.google_sub),
  }));
}

function ocupaA(asesorId, o, asesoresSet = null) {
  if (o.assigned_user_id != null) return o.assigned_user_id === asesorId;
  if (o.status === 'Bloqueado') return true; // cierre general de la agenda
  if (o.google_sub == null) return true; // sin dueño conocido: no encimar
  /* Lo importó alguien que no atiende (la cuenta de Google de la agenda, un
     admin): es la agenda compartida, ocupa a todos. */
  if (asesoresSet && !asesoresSet.has(o.google_sub)) return true;
  return o.google_sub === asesorId;
}

/* Huecos de hora_inicio a hora_fin; el último TERMINA a hora_fin (nadie
   agenda cuando el equipo ya cerró). Si la agenda tiene pausa, se saltan los
   huecos que pisan el bloque pausa ± margen: con 08:00–17:00, citas de 60 min
   y pausa 12:30–13:30 con 15 min, el bloque es 12:15–13:45 y caen las de
   12:00 y 13:00; la primera de la tarde es a las 14:00. La rejilla no se
   mueve, así las horas siguen siendo las de siempre. */
function generarHuecos(cfg) {
  const tz = cfg.time_zone;
  const ahora = moment();
  const minimo = ahora.clone().add(cfg.anticipacion_horas, 'hours');
  const [hi, mi] = cfg.hora_inicio.split(':').map(Number);
  const [hf, mf] = cfg.hora_fin.split(':').map(Number);
  const pausa = bloqueoPausa(cfg);
  const huecos = [];

  for (let d = 0; d <= cfg.dias_adelante; d++) {
    const dia = moment.tz(tz).add(d, 'days');
    if (!cfg.diasSet.has(dia.day())) continue;
    let cursor = dia.clone().hour(hi).minute(mi).second(0).millisecond(0);
    const tope = dia.clone().hour(hf).minute(mf).second(0).millisecond(0);
    while (cursor.clone().add(cfg.duracion_min, 'minutes').isSameOrBefore(tope)) {
      const fin = cursor.clone().add(cfg.duracion_min, 'minutes');
      const minIni = cursor.hour() * 60 + cursor.minute();
      const pisaPausa = pausa && minIni < pausa.hasta && minIni + cfg.duracion_min > pausa.desde;
      if (cursor.isSameOrAfter(minimo) && !pisaPausa) {
        huecos.push({ inicio: cursor.clone().utc(), fin: fin.utc() });
      }
      cursor = fin.clone().tz(tz);
    }
  }
  return huecos;
}

/* Lo que la página pública necesita saber de la agenda además de los huecos. */
async function fichaPublica(cfg) {
  const [cuenta] = await db.query(
    `SELECT nombre_configuracion FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [cfg.id_configuracion], type: db.QueryTypes.SELECT },
  );
  return {
    slug: cfg.slug,
    principal: !!cfg.principal,
    negocio: cuenta?.nombre_configuracion || null,
    time_zone: cfg.time_zone,
    duracion_min: cfg.duracion_min,
    titulo: cfg.titulo,
    descripcion: cfg.descripcion,
    lugar: cfg.lugar,
    insignia: cfg.insignia,
    color_fondo: cfg.color_fondo,
    color_acento: cfg.color_acento,
    dias_adelante: cfg.dias_adelante,
  };
}

/* Huecos con quién está libre en cada uno. Es el corazón de la agenda: lo
   usan la página pública (para pintar) y la reserva (para validar). */
/* previa: el panel muestra la página aunque la agenda esté apagada o sin
   equipo (se pintan los huecos del horario, nadie los atiende). Reservar
   sigue cerrado porque reservar() no pasa previa. */
async function huecosConLibres(cfg, { sincronizar = true, previa = false } = {}) {
  const base = { ...(await fichaPublica(cfg)), activo: !!cfg.activo, previa: !!previa };
  if (!cfg.calendar_id) return { ...base, activo: false, motivo: 'desactivada', huecos: [], cfg };
  if (!cfg.activo && !previa) return { ...base, activo: false, motivo: 'desactivada', huecos: [], cfg };

  const asesores = await asesoresActivos(cfg);
  if (!asesores.length && !previa) return { ...base, activo: false, motivo: 'sin_asesores', huecos: [], cfg };

  if (sincronizar && asesores.length) await sincronizarGoogle(cfg, asesores);

  const huecos = generarHuecos(cfg);
  if (!huecos.length) return { ...base, huecos: [], cfg, asesores };

  if (!asesores.length) {
    return { ...base, activo: true, cfg, asesores, huecos: huecos.map((h) => ({ ...h, libres: [] })) };
  }

  const ocup = await ocupaciones(cfg, huecos[0].inicio, huecos[huecos.length - 1].fin);
  const asesoresSet = new Set(asesores.map((a) => Number(a.id_sub_usuario)));

  const conLibres = huecos.map((h) => {
    const enRango = ocup.filter((o) => o.inicio.isBefore(h.fin) && o.fin.isAfter(h.inicio));
    const libres = asesores.filter(
      (a) => !enRango.some((o) => ocupaA(Number(a.id_sub_usuario), o, asesoresSet)),
    );
    return { inicio: h.inicio, fin: h.fin, libres };
  });

  return { ...base, activo: true, cfg, asesores, huecos: conLibres.filter((h) => h.libres.length) };
}

/* Lo que ve la página pública: huecos en ISO (UTC); el navegador los pinta en
   la zona del visitante. Sin slug → la agenda principal. */
async function disponibilidad({ slug, previa = false } = {}) {
  const cfg = await configPorSlug(slug);
  if (!cfg) throw new AppError('Esta agenda no existe', 404);
  const r = await huecosConLibres(cfg, { previa });
  const { cfg: _c, asesores: _a, ...resto } = r;
  return {
    ...resto,
    motivo: r.motivo || null,
    huecos: r.huecos.map((h) => ({
      inicio: h.inicio.toISOString(),
      fin: h.fin.toISOString(),
      libres: h.libres.length,
    })),
  };
}

/* ═══════════════════ Reparto ═══════════════════ */

async function elegirAsesor(libres, id_configuracion) {
  if (libres.length === 1) return libres[0];
  const stats = await db.query(
    `SELECT id_sub_usuario, COUNT(*) AS n, MAX(created_at) AS ultima
       FROM agenda_publica_reservas
      WHERE id_configuracion = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY id_sub_usuario`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const porId = new Map(stats.map((s) => [Number(s.id_sub_usuario), s]));
  const orden = [...libres].sort((a, b) => {
    const sa = porId.get(Number(a.id_sub_usuario));
    const sb = porId.get(Number(b.id_sub_usuario));
    const na = Number(sa?.n || 0);
    const nb = Number(sb?.n || 0);
    if (na !== nb) return na - nb;
    const ua = sa?.ultima ? new Date(sa.ultima).getTime() : 0;
    const ub = sb?.ultima ? new Date(sb.ultima).getTime() : 0;
    if (ua !== ub) return ua - ub;
    return (a.orden ?? 0) - (b.orden ?? 0);
  });
  return orden[0];
}

/* ═══════════════════ Reservar ═══════════════════ */

function limpiarTexto(s, max) {
  return String(s ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

function formatoCliente(inicioUtc, tz) {
  const zona = moment.tz.zone(tz) ? tz : 'America/Guayaquil';
  const m = moment.utc(inicioUtc).tz(zona);
  return `${m.locale('es').format('dddd D [de] MMMM, HH:mm')} (${zona})`;
}

/* "Ciudad de México", "Guayaquil": lo último de la zona IANA, legible. */
function nombreZona(tz) {
  return String(tz || '').split('/').pop().replace(/_/g, ' ') || 'Ecuador';
}

/* Confirmación inmediata por WhatsApp con la plantilla de la cuenta
   (agenda_publica_config.plantilla_confirmacion). Debe ser una plantilla
   aprobada en Meta con cinco variables: nombre, fecha, hora, lugar o enlace,
   asesor. La principal usa reunion_agendada_imporchat (WABA de la 265,
   creada el 2026-11-04). Sin plantilla no se manda nada y la reserva sigue
   igual: el correo de Google y el recordatorio del cron no dependen de esto. */
async function confirmarPorWhatsapp({ cfg, cuenta, telefono, nombre, inicioUtc, tz, meetingUrl, asesor }) {
  if (!cfg.plantilla_confirmacion) return { ok: false, error: 'sin plantilla de confirmación' };
  if (!cuenta?.token || !cuenta?.id_telefono || !cuenta?.id_whatsapp) {
    return { ok: false, error: 'la cuenta no tiene WhatsApp conectado' };
  }
  const zona = moment.tz.zone(tz) ? tz : 'America/Guayaquil';
  const m = moment.utc(inicioUtc).tz(zona).locale('es');
  const { sendWhatsappMessageTemplate } = require('./whatsapp.service');
  try {
    const r = await sendWhatsappMessageTemplate({
      telefono,
      telefono_configuracion: cuenta.telefono,
      business_phone_id: cuenta.id_telefono,
      waba_id: cuenta.id_whatsapp,
      accessToken: cuenta.token,
      id_configuracion: cuenta.id,
      responsable: 'Agenda pública',
      nombre_template: cfg.plantilla_confirmacion,
      template_parameters: [
        nombre.split(/\s+/)[0] || nombre,
        m.format('dddd D [de] MMMM'),
        `${m.format('HH:mm')} (hora de ${nombreZona(zona)})`,
        cfg.lugar || meetingUrl || 'te lo enviamos por aquí antes de la reunión',
        asesor || 'nuestro equipo',
      ],
    });
    if (r && r.success === false) return { ok: false, error: r.error };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.response?.data?.error?.message || e?.message || String(e) };
  }
}

async function reservar(input = {}) {
  const nombre = limpiarTexto(input.nombre, 120);
  const email = limpiarTexto(input.email, 160).toLowerCase();
  const telefono = normalizarTelefonoPublico(input.codigo_pais, input.telefono);
  const nota = limpiarTexto(input.nota, 300);
  const tzCliente = moment.tz.zone(String(input.tz_cliente || '')) ? String(input.tz_cliente) : null;

  if (nombre.length < 2) throw fallo('Escribe tu nombre', 400, 'DATO_INVALIDO');
  if (!RE_EMAIL.test(email)) throw fallo('Escribe un correo válido', 400, 'DATO_INVALIDO');
  if (!telefono) throw fallo('Escribe un WhatsApp válido con su código de país', 400, 'DATO_INVALIDO');
  const inicio = moment.utc(input.inicio, moment.ISO_8601, true);
  if (!inicio.isValid()) throw fallo('Elige un horario', 400, 'DATO_INVALIDO');

  const cfg = await configPorSlug(input.slug);
  if (!cfg) throw new AppError('Esta agenda no existe', 404);

  /* Modal y /home solo aplican a la agenda principal; en las demás todo
     entra por el enlace del negocio y no hay cuenta de ImporChat detrás. */
  const origen = cfg.principal && ORIGENES.has(String(input.origen)) ? String(input.origen) : 'enlace';
  const idCuenta = cfg.principal ? Number(input.id_usuario_cuenta) || null : null;

  const r = await huecosConLibres(cfg);
  if (!r.activo) throw new AppError('La agenda no está disponible por ahora', 409);

  const hueco = r.huecos.find((h) => h.inicio.valueOf() === inicio.valueOf());
  if (!hueco) throw fallo('Ese horario ya no está disponible. Elige otro.', 409, 'HUECO_OCUPADO');

  /* Una persona, una reunión pendiente por agenda. Si vuelve a reservar
     (recargó, no recibió el correo) se le devuelve la que ya tiene en vez de
     ocupar dos cupos. */
  const [previa] = await db.query(
    `SELECT r.id, r.id_sub_usuario, r.meeting_url,
            DATE_FORMAT(r.start_utc, '%Y-%m-%dT%H:%i:%sZ') AS inicio,
            DATE_FORMAT(r.end_utc, '%Y-%m-%dT%H:%i:%sZ') AS fin,
            s.nombre_encargado AS asesor
       FROM agenda_publica_reservas r
       JOIN appointments ap ON ap.id = r.appointment_id
       LEFT JOIN sub_usuarios_chat_center s ON s.id_sub_usuario = r.id_sub_usuario
      WHERE r.id_configuracion = ? AND (r.telefono = ? OR r.email = ?)
        AND ap.status IN ('Agendado', 'Confirmado')
        AND ap.start_utc > UTC_TIMESTAMP()
      ORDER BY ap.start_utc ASC LIMIT 1`,
    { replacements: [cfg.id_configuracion, telefono, email], type: db.QueryTypes.SELECT },
  );
  if (previa) {
    return {
      ok: true,
      repetida: true,
      cita: {
        inicio: previa.inicio,
        fin: previa.fin,
        meeting_url: previa.meeting_url || null,
        lugar: cfg.lugar,
        asesor: previa.asesor || null,
        cuando: formatoCliente(previa.inicio, tzCliente || cfg.time_zone),
      },
    };
  }

  const asesor = await elegirAsesor(hueco.libres, cfg.id_configuracion);

  const [cuenta] = await db.query(
    `SELECT id, id_usuario, id_telefono, id_whatsapp, token, telefono, nombre_configuracion
       FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [cfg.id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!cuenta) throw new AppError('La cuenta de la agenda no existe', 500);

  const descripcion = [
    `Reserva desde la agenda pública (${origen}).`,
    `Nombre: ${nombre}`,
    `Correo: ${email}`,
    `WhatsApp: +${telefono}`,
    tzCliente ? `Zona horaria del cliente: ${tzCliente}` : null,
    nota ? `Nota: ${nota}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const presencial = !!cfg.lugar;

  /* Con cuenta de Google propia de la agenda, el evento sale de ahí y el
     asesor entra como invitado (le llega la invitación a su correo). */
  const linkAgenda = await vinculoAgenda(cfg);
  const invitees = [{ name: nombre, email, phone: telefono }];
  if (linkAgenda) {
    const [asesorRow] = await db.query(
      `SELECT email FROM sub_usuarios_chat_center WHERE id_sub_usuario = ? LIMIT 1`,
      { replacements: [Number(asesor.id_sub_usuario)], type: db.QueryTypes.SELECT },
    );
    const correoAsesor = String(asesorRow?.email || '').trim().toLowerCase();
    const correoAgenda = String(linkAgenda.google_email || '').toLowerCase();
    if (RE_EMAIL.test(correoAsesor) && correoAsesor !== email && correoAsesor !== correoAgenda) {
      invitees.push({ name: asesor.nombre || null, email: correoAsesor, phone: null });
    }
  }

  let cita;
  try {
    cita = await servicioAppointments.createAppointment(
      {
        calendar_id: cfg.calendar_id,
        title: `${cfg.titulo} - ${nombre}`,
        description: descripcion,
        status: 'Agendado',
        assigned_user_id: Number(asesor.id_sub_usuario),
        created_by_user_id: Number(cuenta.id_usuario),
        start: hueco.inicio.toISOString(),
        end: hueco.fin.toISOString(),
        booked_tz: cfg.time_zone,
        location_text: presencial ? cfg.lugar : 'Videollamada por Google Meet',
        meeting_url: null,
        create_meet: !presencial,
        notificar_invitados: true,
        google_sub_usuario: linkAgenda ? Number(linkAgenda.id_sub_usuario) : null,
        invitees,
      },
      Number(cuenta.id_usuario),
    );
  } catch (e) {
    if (e?.statusCode === 409)
      throw fallo('Ese horario se acaba de ocupar. Elige otro.', 409, 'HUECO_OCUPADO');
    throw e;
  }

  await cita.reload().catch(() => {});
  const googleOk = cita.last_sync_error ? 0 : cita.meeting_url || presencial ? 1 : null;

  /* Contacto interno en la cuenta: así el asesor lo tiene en su bandeja antes
     de la cita y el recordatorio del cron le llega por el WhatsApp de esa
     cuenta. El encargado solo se pone si no tenía. */
  let idCliente = null;
  try {
    idCliente = await obtenerOCrearContactoWa({
      id_configuracion: cfg.id_configuracion,
      telefono,
      uid_cliente: cuenta.id_telefono || null,
      nombre_cliente: nombre,
    });
    if (idCliente) {
      await db.query(
        `UPDATE clientes_chat_center
            SET email_cliente = IF(COALESCE(email_cliente, '') = '', ?, email_cliente),
                nombre_cliente = IF(COALESCE(nombre_cliente, '') = '', ?, nombre_cliente),
                id_encargado = COALESCE(id_encargado, ?),
                updated_at = NOW()
          WHERE id = ?`,
        {
          replacements: [email, nombre, Number(asesor.id_sub_usuario), idCliente],
          type: db.QueryTypes.UPDATE,
        },
      );
    }
  } catch (e) {
    console.warn('[agenda_publica] no se pudo crear el contacto:', e?.message || e);
  }

  await db.query(
    `INSERT INTO agenda_publica_reservas
       (id_configuracion, appointment_id, id_sub_usuario, nombre, email, telefono, origen,
        id_usuario_cuenta, id_cliente, start_utc, end_utc, meeting_url, tz_cliente, google_ok)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    {
      replacements: [
        cfg.id_configuracion,
        cita.id,
        Number(asesor.id_sub_usuario),
        nombre,
        email,
        telefono,
        origen,
        idCuenta,
        idCliente,
        hueco.inicio.format('YYYY-MM-DD HH:mm:ss'),
        hueco.fin.format('YYYY-MM-DD HH:mm:ss'),
        cita.meeting_url || null,
        tzCliente,
        googleOk,
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  /* Si vino del modal de arranque, la cuenta ya tiene su reunión: el modal
     no vuelve a salir hasta el día siguiente de la cita. */
  if (idCuenta) {
    try {
      const { marcarReservaHecha } = require('./onboarding.service');
      await marcarReservaHecha(idCuenta, hueco.fin.clone().add(1, 'day').toDate());
    } catch (e) {
      console.warn('[agenda_publica] no se pudo marcar el onboarding:', e?.message || e);
    }
  }

  const wa = await confirmarPorWhatsapp({
    cfg,
    cuenta,
    telefono,
    nombre,
    inicioUtc: hueco.inicio,
    tz: tzCliente || cfg.time_zone,
    meetingUrl: cita.meeting_url || null,
    asesor: asesor.nombre || null,
  });
  if (!wa.ok) console.warn('[agenda_publica] confirmación WhatsApp no salió:', wa.error);

  console.log(
    `[agenda_publica] reserva ${cfg.slug}: ${nombre} (${origen}) → ${asesor.nombre} el ${hueco.inicio.format()} · google=${googleOk} · whatsapp=${wa.ok ? 1 : 0}`,
  );

  return {
    ok: true,
    repetida: false,
    cita: {
      id: cita.id,
      inicio: hueco.inicio.toISOString(),
      fin: hueco.fin.toISOString(),
      meeting_url: cita.meeting_url || null,
      lugar: cfg.lugar,
      asesor: asesor.nombre || null,
      correo_enviado: googleOk === 1 && !cita.last_sync_error,
      whatsapp_enviado: wa.ok,
      cuando: formatoCliente(hueco.inicio, tzCliente || cfg.time_zone),
    },
  };
}

/* ¿La cuenta (id_usuario) tiene una reunión pendiente reservada por acá? Lo
   usa el modal de arranque para no insistir a quien ya agendó. */
async function reservaPendienteDeCuenta(id_usuario) {
  await ensureTablas();
  const [row] = await db.query(
    `SELECT r.id, DATE_FORMAT(r.start_utc, '%Y-%m-%dT%H:%i:%sZ') AS inicio
       FROM agenda_publica_reservas r
       JOIN appointments ap ON ap.id = r.appointment_id
      WHERE r.id_usuario_cuenta = ?
        AND ap.status IN ('Agendado', 'Confirmado')
        AND ap.start_utc > UTC_TIMESTAMP()
      ORDER BY ap.start_utc ASC LIMIT 1`,
    { replacements: [id_usuario], type: db.QueryTypes.SELECT },
  );
  return row || null;
}

/* ═══════════════════ Panel de la cuenta ═══════════════════ */

/* ═══════════════════ Cuenta de Google de la agenda ═══════════════════ */

/* La agenda puede tener SU cuenta de Google (p. ej. «comercial» de
   ImporChat, la que antes usaba Calendly): el evento y la invitación por
   correo salen siempre de ahí, atienda quien atienda, y lo que ya existe en
   ese Google Calendar se trae al calendario de ImporChat. Es un vínculo de
   users_google_accounts en el calendario de la agenda, elegido por el admin;
   el dueño del vínculo es quien lo conectó. */
async function vinculoAgenda(cfg) {
  if (!cfg.google_link_id) return null;
  const [link] = await db.query(
    `SELECT * FROM users_google_accounts
      WHERE id = ? AND calendar_id = ? AND is_active = 1 AND refresh_token IS NOT NULL
      LIMIT 1`,
    { replacements: [cfg.google_link_id, cfg.calendar_id], type: db.QueryTypes.SELECT },
  );
  return link || null;
}

/* Vínculos de Google que hay en el calendario de la agenda (para elegir). */
async function vinculosDelCalendario(cfg) {
  if (!cfg.calendar_id) return [];
  return db.query(
    `SELECT g.id, g.id_sub_usuario, g.google_email, (g.sync_token IS NOT NULL) AS sincronizado,
            s.nombre_encargado AS propietario
       FROM users_google_accounts g
       LEFT JOIN sub_usuarios_chat_center s ON s.id_sub_usuario = g.id_sub_usuario
      WHERE g.calendar_id = ? AND g.is_active = 1 AND g.refresh_token IS NOT NULL
      ORDER BY g.google_email ASC, g.id DESC`,
    { replacements: [cfg.calendar_id], type: db.QueryTypes.SELECT },
  );
}

/* Elegir la cuenta de Google de la agenda: un vínculo del calendario
   (link_id) o el del sub-usuario que llama (el que acaba de conectar desde
   el panel). Se exige el permiso de calendario, si no el evento nunca sale. */
async function usarGoogle(id_configuracion, { link_id = null, id_sub_usuario = null } = {}) {
  const cfg = await configDeCuenta(id_configuracion);
  if (!cfg.calendar_id) throw new AppError('La cuenta no tiene calendario activo', 400);
  const porId = !!link_id;
  const valor = porId ? Number(link_id) : Number(id_sub_usuario);
  if (!valor) throw new AppError('Falta el vínculo de Google', 400);
  const [link] = await db.query(
    `SELECT g.* FROM users_google_accounts g
      WHERE g.${porId ? 'id' : 'id_sub_usuario'} = ? AND g.calendar_id = ?
        AND g.is_active = 1 AND g.refresh_token IS NOT NULL
      ORDER BY g.id DESC LIMIT 1`,
    { replacements: [valor, cfg.calendar_id], type: db.QueryTypes.SELECT },
  );
  if (!link) {
    throw new AppError(
      porId
        ? 'Ese vínculo de Google no está en el calendario de la agenda'
        : 'Primero conecta tu Google Calendar en este calendario',
      404,
    );
  }
  olvidarPermiso(link.id);
  const permiso = await permisoCalendario(link);
  if (permiso === false) {
    throw new AppError(
      `La cuenta ${link.google_email} se conectó sin el permiso de calendario. Vuelve a conectarla aceptando todos los permisos.`,
      400,
    );
  }
  await guardarConfig(cfg.id_configuracion, { google_link_id: link.id });
  return link;
}

async function quitarGoogle(id_configuracion) {
  const cfg = await configDeCuenta(id_configuracion);
  await guardarConfig(cfg.id_configuracion, { google_link_id: null });
}

/* Trae al calendario de ImporChat lo que ya hay en el Google de la agenda
   (reset: últimos 90 días y todo lo futuro). Lo que entra queda sin
   encargado; la agenda pública lo trata como ocupado para todos. */
async function importarGoogle(id_configuracion) {
  const cfg = await configDeCuenta(id_configuracion);
  const link = await vinculoAgenda(cfg);
  if (!link) throw new AppError('La agenda no tiene cuenta de Google', 400);
  const contar = async () => {
    const [r] = await db.query(
      `SELECT COUNT(*) AS n FROM google_events_links WHERE id_sub_usuario = ? AND is_deleted = 0`,
      { replacements: [link.id_sub_usuario], type: db.QueryTypes.SELECT },
    );
    return Number(r?.n || 0);
  };
  const antes = await contar();
  const r = await importChanges({ linkId: link.id, reset: true });
  if (!r?.ok) {
    const detalle = r?.error?.error?.message || r?.error?.message || r?.error || r?.reason || 'sin detalle';
    throw new AppError(`Google no respondió: ${detalle}`, 502);
  }
  ultimoPull.set(link.id, Date.now());
  const despues = await contar();
  const [futuras] = await db.query(
    `SELECT COUNT(*) AS n FROM google_events_links gl
       JOIN appointments ap ON ap.id = gl.appointment_id
      WHERE gl.id_sub_usuario = ? AND gl.is_deleted = 0 AND ap.calendar_id = ?
        AND ap.start_utc > UTC_TIMESTAMP() AND ap.status <> 'Cancelado'`,
    { replacements: [link.id_sub_usuario, cfg.calendar_id], type: db.QueryTypes.SELECT },
  );
  return {
    nuevas: Math.max(0, despues - antes),
    total: despues,
    futuras: Number(futuras?.n || 0),
    google_email: link.google_email,
  };
}

/* Plantillas de Meta de la cuenta que sirven para confirmar: cuerpo de texto
   sin cabecera multimedia. Van todas (aprobadas y pendientes) con su texto
   para la vista previa; las de 5 variables son las que calzan con lo que se
   manda (nombre, fecha, hora, lugar o enlace, asesor). */
async function plantillasDisponibles(id_configuracion) {
  const [cuenta] = await db.query(
    `SELECT id_whatsapp, token FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!cuenta?.id_whatsapp || !cuenta?.token) return { estado: 'SIN_WHATSAPP', plantillas: [] };
  try {
    const { data } = await axios.get(
      `https://graph.facebook.com/${process.env.GRAPH_VERSION || 'v22.0'}/${cuenta.id_whatsapp}/message_templates`,
      {
        headers: { Authorization: `Bearer ${cuenta.token}` },
        params: { fields: 'name,status,category,language,components', limit: 200 },
        timeout: 15000,
      },
    );
    const plantillas = [];
    for (const t of data?.data || []) {
      const comps = Array.isArray(t.components) ? t.components : [];
      const body = comps.find((c) => c.type === 'BODY');
      const header = comps.find((c) => c.type === 'HEADER');
      if (!body?.text) continue;
      if (header && header.format && header.format !== 'TEXT') continue;
      const vars = new Set((body.text.match(/\{\{(\d+)\}\}/g) || []).map((v) => v.replace(/\D/g, '')));
      plantillas.push({
        name: t.name,
        status: t.status,
        category: t.category,
        language: t.language,
        body: body.text,
        header: header?.text || null,
        footer: comps.find((c) => c.type === 'FOOTER')?.text || null,
        variables: vars.size,
        compatible: vars.size === 5,
      });
    }
    plantillas.sort((a, b) => Number(b.compatible) - Number(a.compatible) || a.name.localeCompare(b.name));
    return { estado: 'OK', plantillas };
  } catch (e) {
    const code = e?.response?.data?.error?.code;
    return {
      estado: code === 190 ? 'TOKEN_INVALIDO' : 'ERROR',
      plantillas: [],
      error: e?.response?.data?.error?.message || e.message,
    };
  }
}

async function resumen(id_configuracion, { sesionSub = null } = {}) {
  const cfg = await configDeCuenta(id_configuracion);
  const id = cfg.id_configuracion;
  const [listaCruda, ultimas, totales, calendarios, cuenta] = await Promise.all([
    cfg.calendar_id ? candidatos(cfg) : [],
    db.query(
      `SELECT r.id, r.nombre, r.email, r.telefono, r.origen, r.id_sub_usuario,
              s.nombre_encargado AS asesor, r.meeting_url, r.google_ok, r.tz_cliente,
              r.id_usuario_cuenta, r.created_at,
              DATE_FORMAT(r.start_utc, '%Y-%m-%dT%H:%i:%sZ') AS inicio,
              ap.status
         FROM agenda_publica_reservas r
         LEFT JOIN appointments ap ON ap.id = r.appointment_id
         LEFT JOIN sub_usuarios_chat_center s ON s.id_sub_usuario = r.id_sub_usuario
        WHERE r.id_configuracion = ?
        ORDER BY r.id DESC LIMIT 60`,
      { replacements: [id], type: db.QueryTypes.SELECT },
    ),
    db.query(
      `SELECT r.id_sub_usuario,
              SUM(r.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS ultimos_30d,
              SUM(ap.start_utc > UTC_TIMESTAMP() AND ap.status IN ('Agendado','Confirmado')) AS proximas,
              SUM(ap.status = 'Cancelado') AS canceladas,
              SUM(ap.status = 'Completado') AS completadas
         FROM agenda_publica_reservas r
         LEFT JOIN appointments ap ON ap.id = r.appointment_id
        WHERE r.id_configuracion = ?
        GROUP BY r.id_sub_usuario`,
      { replacements: [id], type: db.QueryTypes.SELECT },
    ),
    db.query(
      `SELECT id, name FROM calendars WHERE account_id = ? AND is_active = 1 ORDER BY id ASC`,
      { replacements: [id], type: db.QueryTypes.SELECT },
    ),
    db
      .query(
        `SELECT nombre_configuracion, template_notificar_calendario, recordatorios_cita,
                (id_telefono IS NOT NULL AND id_telefono <> '') AS whatsapp
           FROM configuraciones WHERE id = ? LIMIT 1`,
        { replacements: [id], type: db.QueryTypes.SELECT },
      )
      .then((r) => r[0] || null),
  ]);
  const statsPor = new Map(totales.map((t) => [Number(t.id_sub_usuario), t]));

  /* El permiso de calendario solo se consulta para los que están en la lista
     (son pocos); para el resto basta con saber si tienen vínculo. */
  const lista = await Promise.all(
    listaCruda.map(async (a) => {
      if (a.en_lista == null || !Number(a.google_vinculado)) return { ...a, google_calendario: null };
      const link = await db
        .query(
          `SELECT * FROM users_google_accounts
            WHERE id_sub_usuario = ? AND calendar_id = ? AND is_active = 1 LIMIT 1`,
          { replacements: [a.id_sub_usuario, cfg.calendar_id], type: db.QueryTypes.SELECT },
        )
        .then((r) => r[0])
        .catch(() => null);
      return { ...a, google_calendario: await permisoCalendario(link) };
    }),
  );

  /* Cuenta de Google de la agenda y las que podrían serlo. */
  const vinculo = await vinculoAgenda(cfg);
  const opciones = await vinculosDelCalendario(cfg);
  const google = {
    vinculo: vinculo
      ? {
          id: vinculo.id,
          email: vinculo.google_email,
          propietario: opciones.find((o) => Number(o.id) === Number(vinculo.id))?.propietario || null,
          permiso_calendario: await permisoCalendario(vinculo),
          sincronizado: !!vinculo.sync_token,
        }
      : null,
    opciones: opciones.map((o) => ({
      id: o.id,
      email: o.google_email,
      propietario: o.propietario,
      id_sub_usuario: o.id_sub_usuario,
    })),
    mio: opciones.find((o) => Number(o.id_sub_usuario) === Number(sesionSub))?.id || null,
  };

  const { diasSet, guardada, __nueva, ...config } = cfg;
  return {
    config,
    google,
    nueva: !guardada,
    cuenta: {
      id: id,
      nombre: cuenta?.nombre_configuracion || null,
      agenda: calendarios.find((c) => Number(c.id) === Number(cfg.calendar_id))?.name || null,
      whatsapp: !!Number(cuenta?.whatsapp),
      recordatorio_plantilla: cuenta?.template_notificar_calendario || null,
      recordatorio_horas: cuenta?.recordatorios_cita || null,
    },
    calendarios,
    asesores: lista.map((a) => ({
      ...a,
      google_vinculado: !!Number(a.google_vinculado),
      en_lista: a.en_lista == null ? null : Number(a.en_lista),
      suspendido: Number(a.suspendido) ? 1 : 0,
      stats: {
        ultimos_30d: Number(statsPor.get(Number(a.id_sub_usuario))?.ultimos_30d || 0),
        proximas: Number(statsPor.get(Number(a.id_sub_usuario))?.proximas || 0),
        canceladas: Number(statsPor.get(Number(a.id_sub_usuario))?.canceladas || 0),
        completadas: Number(statsPor.get(Number(a.id_sub_usuario))?.completadas || 0),
      },
    })),
    reservas: ultimas,
  };
}

module.exports = {
  CONFIG_INICIAL,
  ensureTablas,
  configPrincipal,
  configPorSlug,
  configDeCuenta,
  guardarConfig,
  guardarAsesores,
  asesoresActivos,
  disponibilidad,
  reservar,
  reservaPendienteDeCuenta,
  resumen,
  slugify,
  usarGoogle,
  quitarGoogle,
  importarGoogle,
  plantillasDisponibles,
  // expuestos para pruebas
  generarHuecos,
  ocupaA,
  elegirAsesor,
};
