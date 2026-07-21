/* ═══════════════════════════════════════════════════════════
   Cartera Imporchat — panel derecho del chat (solo soporte)

   Los asesores de soporte (configuraciones 251 y 265) atienden a gente que YA
   es usuaria de Imporchat, pero al abrir el chat no saben si detrás de ese
   número hay una cuenta real ni si esa cuenta está moviendo algo. Este módulo
   resuelve, desde el teléfono/correo con el que la persona escribe, la cuenta
   Imporchat que le corresponde, lista sus conexiones y devuelve los KPIs de
   cada una (los mismos que la API pública /resumen, sin duplicar cálculos).

   Búsqueda en cascada — la primera que acierta gana:
     1. teléfono → usuarios_chat_center.whatsapp_lead  (el personal del registro)
     2. teléfono → configuraciones.telefono            (escribió desde su conexión)
     3. email    → usuarios_chat_center.email_propietario
     4. email    → sub_usuarios_chat_center.email      (escribió un colaborador)

   Si nada coincide devolvemos encontrado:false para que el asesor sepa que hay
   que actualizar los datos del contacto, no que el cliente no existe.
   ═══════════════════════════════════════════════════════════ */
const { db } = require('../database/config');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { _internal: dropi } = require('./dropi_integrations.controller');
const { _internal: publicApi } = require('./public_api.controller');

/* Configuraciones de soporte donde se habilita la sección. Agregar ids acá
   es lo único que hace falta para extenderla a otra conexión. */
const CONFIGS_SOPORTE = [251, 265];

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/* Solo dígitos; nos quedamos con los últimos 9 porque los teléfonos viven con
   y sin código de país según de dónde vengan (593… vs 09…). */
const digitos = (v) => String(v || '').replace(/\D/g, '');
const cola = (v, n = 9) => digitos(v).slice(-n);

/* Números de relleno (0000000000, 1111111111…) hacen match con cualquiera por
   la comparación de cola: no vale la pena ni consultarlos. */
const telefonoUtil = (tel9) =>
  tel9.length >= 8 && new Set(tel9).size >= 4;

/* El asesor debe pertenecer a la cuenta dueña de una configuración de soporte.
   No basta con estar logueado: esto expone datos de OTROS clientes. */
async function exigirSoporte(req) {
  const ownerId = Number(req.sessionUser?.id_usuario);
  if (!ownerId) throw new AppError('No autenticado o sesión inválida', 401);

  const [row] = await db.query(
    `SELECT id FROM configuraciones
      WHERE id_usuario = :owner AND id IN (:configs) LIMIT 1`,
    {
      replacements: { owner: ownerId, configs: CONFIGS_SOPORTE },
      type: db.QueryTypes.SELECT,
    },
  );
  if (!row)
    throw new AppError(
      'Esta sección solo está disponible para las conexiones de soporte.',
      403,
    );
}

/* Ficha de la cuenta + sus conexiones. Es lo que el asesor ve de un vistazo. */
async function armarCuenta(id_usuario, coincidencia, detalle) {
  const [usuario] = await db.query(
    `SELECT u.id_usuario, u.nombre, u.email_propietario, u.whatsapp_lead,
            u.whatsapp_lead_pais, u.id_plan, u.estado, u.tipo_plan,
            u.fecha_inicio, u.fecha_renovacion, u.created_at,
            p.nombre_plan, p.precio_plan
       FROM usuarios_chat_center u
       LEFT JOIN planes_chat_center p ON p.id_plan = u.id_plan
      WHERE u.id_usuario = :id`,
    { replacements: { id: id_usuario }, type: db.QueryTypes.SELECT },
  );
  if (!usuario) return null;

  const conexiones = await db.query(
    `SELECT id, nombre_configuracion, telefono, tipo_configuracion,
            suspendido, wa_status, created_at
       FROM configuraciones
      WHERE id_usuario = :id
      ORDER BY suspendido ASC, id ASC`,
    { replacements: { id: id_usuario }, type: db.QueryTypes.SELECT },
  );

  return {
    coincidencia, // por dónde lo encontramos
    detalle, // el valor que hizo match, para que el asesor lo vea
    usuario: {
      id_usuario: Number(usuario.id_usuario),
      nombre: usuario.nombre || '',
      email: usuario.email_propietario || '',
      whatsapp_lead: usuario.whatsapp_lead
        ? `${usuario.whatsapp_lead_pais || ''}${usuario.whatsapp_lead}`
        : '',
      id_plan: usuario.id_plan ?? null,
      // El plan puede estar borrado del catálogo o ser null (cuenta sin plan):
      // en ese caso el front muestra "Sin plan", nunca un id suelto.
      nombre_plan: usuario.nombre_plan || null,
      precio_plan:
        usuario.precio_plan == null ? null : Number(usuario.precio_plan),
      tipo_plan: usuario.tipo_plan || null,
      estado: usuario.estado || '',
      fecha_inicio: usuario.fecha_inicio,
      fecha_renovacion: usuario.fecha_renovacion,
      registrado_en: usuario.created_at,
    },
    conexiones: conexiones.map((c) => ({
      id_configuracion: Number(c.id),
      nombre: c.nombre_configuracion || '',
      telefono: c.telefono || '',
      tipo: c.tipo_configuracion || '',
      suspendido: Number(c.suspendido || 0) === 1,
      wa_status: c.wa_status || null,
      creada_en: c.created_at,
    })),
  };
}

// ── GET /imporchat-cartera/buscar?telefono=&email= ─────────
exports.buscar = catchAsync(async (req, res, next) => {
  await exigirSoporte(req);

  const telefono = String(req.query.telefono || '').trim();
  const email = String(req.query.email || '')
    .trim()
    .toLowerCase();
  if (!telefono && !email)
    return next(new AppError('Envía al menos telefono o email.', 400));

  const tel9 = cola(telefono);

  // 1) teléfono personal del registro
  if (telefonoUtil(tel9)) {
    const [row] = await db.query(
      `SELECT id_usuario FROM usuarios_chat_center
        WHERE whatsapp_lead IS NOT NULL AND whatsapp_lead <> ''
          AND RIGHT(REPLACE(REPLACE(REPLACE(whatsapp_lead,' ',''),'-',''),'+',''), 9) = :tel
        ORDER BY id_usuario DESC LIMIT 1`,
      { replacements: { tel: tel9 }, type: db.QueryTypes.SELECT },
    );
    if (row) {
      const data = await armarCuenta(
        row.id_usuario,
        'telefono_personal',
        telefono,
      );
      if (data) return res.json({ encontrado: true, ...data });
    }
  }

  // 2) escribió desde el número de una de sus conexiones
  if (telefonoUtil(tel9)) {
    const [row] = await db.query(
      `SELECT id_usuario, id FROM configuraciones
        WHERE telefono IS NOT NULL AND telefono <> ''
          AND RIGHT(telefono, 9) = :tel
        ORDER BY suspendido ASC, id DESC LIMIT 1`,
      { replacements: { tel: tel9 }, type: db.QueryTypes.SELECT },
    );
    if (row) {
      const data = await armarCuenta(
        row.id_usuario,
        'telefono_conexion',
        telefono,
      );
      if (data) return res.json({ encontrado: true, ...data });
    }
  }

  // 3) correo del dueño de la cuenta
  if (email) {
    const [row] = await db.query(
      `SELECT id_usuario FROM usuarios_chat_center
        WHERE LOWER(email_propietario) = :email LIMIT 1`,
      { replacements: { email }, type: db.QueryTypes.SELECT },
    );
    if (row) {
      const data = await armarCuenta(row.id_usuario, 'email_propietario', email);
      if (data) return res.json({ encontrado: true, ...data });
    }
  }

  // 4) correo de un colaborador (sub-usuario) de alguna cuenta
  if (email) {
    const [row] = await db.query(
      `SELECT id_usuario, nombre_encargado FROM sub_usuarios_chat_center
        WHERE LOWER(email) = :email LIMIT 1`,
      { replacements: { email }, type: db.QueryTypes.SELECT },
    );
    if (row) {
      const data = await armarCuenta(
        row.id_usuario,
        'email_subusuario',
        `${email}${row.nombre_encargado ? ` (${row.nombre_encargado})` : ''}`,
      );
      if (data) return res.json({ encontrado: true, ...data });
    }
  }

  return res.json({
    encontrado: false,
    buscado: { telefono: telefono || null, email: email || null },
  });
});

// ── GET /imporchat-cartera/resumen?id_configuracion=&from=&until= ──
// Mismos KPIs que la API pública, pero autenticado con la sesión del asesor
// (la API pública va por API key y esa key fija SU propia conexión, así que
// no sirve para leer la conexión de un tercero).
exports.resumen = catchAsync(async (req, res, next) => {
  await exigirSoporte(req);

  const id_configuracion = Number(req.query.id_configuracion);
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const hoy = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  let from = String(req.query.from || '').trim();
  let until = String(req.query.until || '').trim();
  if (!from || !until) {
    const desde = new Date(hoy);
    desde.setDate(desde.getDate() - 29);
    from = iso(desde);
    until = iso(hoy);
  }
  if (!YMD.test(from) || !YMD.test(until) || from > until)
    return next(new AppError('Rango inválido. Usa YYYY-MM-DD.', 400));

  const [cfg] = await db.query(
    `SELECT id, id_usuario, nombre_configuracion FROM configuraciones WHERE id = :id`,
    { replacements: { id: id_configuracion }, type: db.QueryTypes.SELECT },
  );
  if (!cfg) return next(new AppError('La conexión no existe.', 404));

  const d = await dropi.buildConnectionSummary({ id_configuracion, from, until });

  return res.json({
    conexion: {
      id_configuracion,
      nombre: cfg.nombre_configuracion || '',
      id_usuario: Number(cfg.id_usuario),
    },
    rango: { from, until },
    ...publicApi.formatearResumen(d),
  });
});

exports._internal = { CONFIGS_SOPORTE };
