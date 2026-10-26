const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');
const svc = require('../services/recuperacion.service');
const { resolverAcceso } = require('../middlewares/requireRecuperacion.middleware');

const nombreDe = (req) =>
  req.sessionUser?.nombre_encargado || req.sessionUser?.usuario || req.sessionUser?.email || null;

/** GET /recuperacion/acceso — ¿se pinta "Recuperación de clientes" en el menú? Nunca da 403. */
exports.acceso = catchAsync(async (req, res) => {
  let a = null;
  try {
    a = await resolverAcceso(req.sessionUser);
  } catch (e) {
    if (e?.original?.code !== 'ER_NO_SUCH_TABLE') throw e;
    const rol = req.sessionUser?.rol || null;
    const interno = ['super_administrador', 'gestor_clientes'].includes(rol);
    a = { acceso: interno, es_super: rol === 'super_administrador', puede_asignar: interno, puede_gestionar_asesores: rol === 'super_administrador' };
  }
  res.json({
    status: 'success',
    data: {
      acceso: !!a?.acceso,
      es_super: !!a?.es_super,
      puede_asignar: !!a?.puede_asignar,
      puede_gestionar_asesores: !!a?.puede_gestionar_asesores,
      id_sub_usuario: req.sessionUser?.id_sub_usuario || null,
      nombre: nombreDe(req),
    },
  });
});

/** GET /recuperacion/embudo — cohortes, KPIs y la lista de clientes en riesgo. */
exports.embudo = catchAsync(async (req, res) => {
  const data = await svc.embudo({
    id_sub_usuario: req.sessionUser.id_sub_usuario,
    id_usuario: req.sessionUser.id_usuario,
    rol: req.sessionUser.rol,
  });
  const asignables = req.recuperacion?.puede_asignar ? await svc.asignables() : [];
  res.json({ status: 'success', data: { ...data, asignables, permisos: req.recuperacion } });
});

/** GET /recuperacion/cliente/:id_usuario — ficha + casos (el historial de seguimientos va por /seguimientos). */
exports.cliente = catchAsync(async (req, res, next) => {
  const id_usuario = Number(req.params.id_usuario);
  if (!id_usuario) return next(new AppError('id_usuario requerido', 400));
  const ficha = await svc.fichaCliente(id_usuario);
  if (!ficha) return next(new AppError('Cliente no encontrado', 404));
  res.json({ status: 'success', data: ficha });
});

/**
 * GET /recuperacion/casos/buscar?q= — clientes por empresa/correo/WhatsApp con
 * su último caso, abierto o CERRADO. El embudo solo lista abiertos: así el
 * asesor ve qué pasó con quien ya canceló sin tener que ir a Resultados.
 */
exports.buscar = catchAsync(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json({ status: 'success', data: [] });
  res.json({ status: 'success', data: await svc.buscarCasos(q) });
});

/**
 * POST /recuperacion/casos/:id_usuario/asignar  body: { id_sub_usuario? }
 * Sin body: "tomar" el caso (me lo asigno). Con id_sub_usuario: reasignar
 * (solo quien puede asignar). id_sub_usuario = null → liberar.
 */
exports.asignar = catchAsync(async (req, res, next) => {
  const id_usuario = Number(req.params.id_usuario);
  if (!id_usuario) return next(new AppError('id_usuario requerido', 400));

  const yo = req.sessionUser.id_sub_usuario;
  let destino = yo;
  let nombre = nombreDe(req);
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'id_sub_usuario')) {
    if (!req.recuperacion?.puede_asignar) {
      return next(new AppError('Solo un administrador puede reasignar casos', 403));
    }
    destino = req.body.id_sub_usuario == null ? null : Number(req.body.id_sub_usuario);
    nombre = null;
    if (destino) {
      const [s] = await db.query(
        `SELECT nombre_encargado, usuario, email FROM sub_usuarios_chat_center WHERE id_sub_usuario = ? LIMIT 1`,
        { replacements: [destino], type: db.QueryTypes.SELECT },
      );
      if (!s) return next(new AppError('Subusuario no encontrado', 404));
      nombre = s.nombre_encargado || s.usuario || s.email;
    }
  }
  const caso = await svc.asignarCaso({ id_usuario, asignado_a_id: destino, asignado_a_nombre: nombre });
  res.json({ status: 'success', data: caso });
});

/** POST /recuperacion/casos/:id_usuario/cerrar  body: { estado: recuperado|perdido|descartado, motivo? } */
exports.cerrar = catchAsync(async (req, res, next) => {
  const id_usuario = Number(req.params.id_usuario);
  if (!id_usuario) return next(new AppError('id_usuario requerido', 400));
  const { estado, motivo } = req.body || {};
  try {
    const caso = await svc.cerrarCaso({
      id_usuario,
      estado,
      motivo: motivo ? String(motivo).slice(0, 255) : null,
      cerrado_por: nombreDe(req),
    });
    res.json({ status: 'success', data: caso });
  } catch (e) {
    return next(new AppError(e.message, 400));
  }
});

/** POST /recuperacion/casos/:id_usuario/abrir — reabrir / abrir a mano un caso. */
exports.abrir = catchAsync(async (req, res, next) => {
  const id_usuario = Number(req.params.id_usuario);
  if (!id_usuario) return next(new AppError('id_usuario requerido', 400));
  const caso = await svc.abrirCasoSiFalta(id_usuario, 'manual');
  res.json({ status: 'success', data: caso });
});

/**
 * POST /recuperacion/casos/:id_usuario/abrir-chat-expertos
 * Crea/encuentra al cliente como contacto en la conexión de Expertos y
 * devuelve { id_cliente, id_configuracion } para abrir /abrir-chat/:linea/:id.
 */
exports.abrirChatExpertos = catchAsync(async (req, res, next) => {
  const id_usuario = Number(req.params.id_usuario);
  if (!id_usuario) return next(new AppError('id_usuario requerido', 400));
  try {
    const data = await svc.abrirChatExpertos({ id_usuario, sessionUser: req.sessionUser });
    res.json({ status: 'success', data });
  } catch (e) {
    return next(new AppError(e.message, e.code === 'CHAT_DE_OTRO' ? 409 : 400));
  }
});

/* ── Automatizaciones (secuencias de plantillas desde Expertos) ── */
const autoSvc = require('../services/recuperacion_automatizaciones.service');

/** GET /recuperacion/automatizaciones — secuencias, pasos y métricas (30 días). */
exports.listarAutomatizaciones = catchAsync(async (req, res) => {
  await autoSvc.sincronizarAhora().catch((e) => console.warn('[recup-auto] sync al listar:', e?.message));
  const [lista, expertos] = await Promise.all([
    autoSvc.listar(),
    svc.conexionExpertos(req.sessionUser.id_usuario),
  ]);
  res.json({
    status: 'success',
    data: {
      automatizaciones: lista,
      variables: autoSvc.VARIABLES,
      min_dias_entre_mensajes: autoSvc.MIN_DIAS_ENTRE_MENSAJES,
      expertos: { id_configuracion: expertos.id_configuracion, nombre: expertos.nombre, telefono: expertos.telefono },
      permisos: req.recuperacion,
    },
  });
});

/** PATCH /recuperacion/automatizaciones/:id — activar, fecha de inicio, tope, etc. (admins) */
exports.actualizarAutomatizacion = catchAsync(async (req, res, next) => {
  if (!req.recuperacion?.puede_asignar) return next(new AppError('Solo un administrador configura las automatizaciones', 403));
  const id = Number(req.params.id);
  if (!id) return next(new AppError('id requerido', 400));
  await autoSvc.actualizar(id, req.body || {}, nombreDe(req));
  res.json({ status: 'success' });
});

/** PATCH /recuperacion/automatizaciones/pasos/:id — plantilla, parámetros, espera (admins) */
exports.actualizarPasoAutomatizacion = catchAsync(async (req, res, next) => {
  if (!req.recuperacion?.puede_asignar) return next(new AppError('Solo un administrador configura las automatizaciones', 403));
  const id = Number(req.params.id);
  if (!id) return next(new AppError('id requerido', 400));
  await autoSvc.actualizarPaso(id, req.body || {});
  res.json({ status: 'success' });
});

/** POST /recuperacion/automatizaciones/crear-plantillas — crea en Meta las que falten (super admin) */
exports.crearPlantillasAutomatizacion = catchAsync(async (req, res, next) => {
  if (!req.recuperacion?.puede_gestionar_asesores) return next(new AppError('Solo el super administrador crea plantillas en Meta', 403));
  try {
    const data = await autoSvc.crearPlantillasEnMeta();
    res.json({ status: 'success', data });
  } catch (e) {
    return next(new AppError(e.message, 400));
  }
});

/** GET /recuperacion/automatizaciones/envios?id=&limit= — bitácora */
exports.enviosAutomatizacion = catchAsync(async (req, res) => {
  const data = await autoSvc.envios({
    id_automatizacion: Number(req.query.id) || null,
    estado: req.query.estado || null,
    limit: req.query.limit,
  });
  res.json({ status: 'success', data });
});

/** GET /recuperacion/automatizaciones/:id/simular — qué enviaría ahora, sin enviar */
exports.simularAutomatizacion = catchAsync(async (req, res) => {
  const data = await autoSvc.simular({ id_automatizacion: Number(req.params.id) });
  res.json({ status: 'success', data });
});

/**
 * POST /recuperacion/automatizaciones/:id/enviar-ahora
 * body: { id_paso, id_usuarios?: [] }  Envío manual: un paso concreto a los
 * clientes elegidos (o a toda la cohorte), saltando las esperas pero no el
 * "ya respondió", la cola, el paso ya recibido ni el tope diario. Lo puede
 * usar cualquier asesor.
 */
exports.enviarAhoraAutomatizacion = catchAsync(async (req, res, next) => {
  const id = Number(req.params.id);
  const id_paso = Number(req.body?.id_paso);
  if (!id || !id_paso) return next(new AppError('id y id_paso requeridos', 400));
  const ids = Array.isArray(req.body?.id_usuarios) ? req.body.id_usuarios.map(Number).filter(Boolean) : null;
  const r = await autoSvc.conCandado(
    () =>
      autoSvc.correr({
        soloAuto: id,
        forzar: true,
        pasoForzado: id_paso,
        idsUsuarios: ids,
        origen: `manual:${nombreDe(req) || req.sessionUser.id_sub_usuario}`,
      }),
    { esperaSeg: 5 },
  );
  if (r?.ocupado) return next(new AppError('Ya hay un envío de recuperación en curso. Intenta en un par de minutos.', 409));
  if (r?.error) return next(new AppError(r.error, 400));
  res.json({ status: 'success', data: r.resumen?.[0] || null });
});

/** GET /recuperacion/resultados?dias=30 */
exports.resultados = catchAsync(async (req, res) => {
  const data = await svc.resultados({ dias: req.query.dias });
  res.json({ status: 'success', data });
});

/** GET /recuperacion/asesores — solo super admin */
exports.listarAsesores = catchAsync(async (req, res, next) => {
  if (!req.recuperacion?.puede_gestionar_asesores) {
    return next(new AppError('Solo el super administrador gestiona los asesores', 403));
  }
  res.json({ status: 'success', data: await svc.listarAsesores() });
});

/** POST /recuperacion/asesores  body: { email } */
exports.agregarAsesor = catchAsync(async (req, res, next) => {
  if (!req.recuperacion?.puede_gestionar_asesores) {
    return next(new AppError('Solo el super administrador gestiona los asesores', 403));
  }
  try {
    const agregados = await svc.agregarAsesor({
      email: req.body?.email,
      agregado_por: req.sessionUser.id_sub_usuario,
    });
    res.json({ status: 'success', data: agregados });
  } catch (e) {
    return next(new AppError(e.message, 400));
  }
});

/** PATCH /recuperacion/asesores/:id_sub_usuario  body: { activo } */
exports.cambiarAsesor = catchAsync(async (req, res, next) => {
  if (!req.recuperacion?.puede_gestionar_asesores) {
    return next(new AppError('Solo el super administrador gestiona los asesores', 403));
  }
  const id = Number(req.params.id_sub_usuario);
  if (!id) return next(new AppError('id_sub_usuario requerido', 400));
  await svc.cambiarAsesor({ id_sub_usuario: id, activo: !!req.body?.activo });
  res.json({ status: 'success' });
});

/** DELETE /recuperacion/asesores/:id_sub_usuario */
exports.quitarAsesor = catchAsync(async (req, res, next) => {
  if (!req.recuperacion?.puede_gestionar_asesores) {
    return next(new AppError('Solo el super administrador gestiona los asesores', 403));
  }
  const id = Number(req.params.id_sub_usuario);
  if (!id) return next(new AppError('id_sub_usuario requerido', 400));
  await svc.quitarAsesor({ id_sub_usuario: id });
  res.json({ status: 'success' });
});

// ── Pagos manuales (transferencia / efectivo) — solo super admin ─────────
// El dinero entra fuera de Stripe; aquí se deja constancia con comprobante y,
// si corresponde, se salda la factura abierta en Stripe para que deje de
// reintentar la tarjeta. Ver services/pagos_manuales.service.js.
const pagosSvc = require('../services/pagos_manuales.service');
const { subirComprobante } = require('../utils/subirComprobante');

const soloSuper = (req, next) => {
  if (!req.recuperacion?.es_super) {
    next(new AppError('Solo el super administrador registra pagos manuales', 403));
    return false;
  }
  return true;
};

/** GET /recuperacion/pagos-manuales — últimos pagos registrados en todas las cuentas. */
exports.listarPagosManuales = catchAsync(async (req, res, next) => {
  if (!soloSuper(req, next)) return;
  res.json({ status: 'success', data: await pagosSvc.listarRecientes({ limit: req.query.limit }) });
});

/** GET /recuperacion/pagos-manuales/rebotados[?fresh=1] — a quién le rebotó el cobro en Stripe (en vivo). */
exports.cobrosRebotados = catchAsync(async (req, res, next) => {
  if (!soloSuper(req, next)) return;
  try {
    const data = await pagosSvc.cobrosRebotados({ fresh: req.query.fresh === '1' });
    res.json({ status: 'success', data });
  } catch (e) {
    return next(new AppError(`Stripe no respondió: ${e.message}`, 502));
  }
});

/** GET /recuperacion/cliente/:id_usuario/pagos-manuales — suscripción, facturas saldables y pagos del cliente. */
exports.panelPagosManuales = catchAsync(async (req, res, next) => {
  if (!soloSuper(req, next)) return;
  const id_usuario = Number(req.params.id_usuario);
  if (!id_usuario) return next(new AppError('id_usuario requerido', 400));
  const data = await pagosSvc.panelCliente(id_usuario);
  if (!data) return next(new AppError('Cliente no encontrado', 404));
  res.json({ status: 'success', data });
});

/**
 * POST /recuperacion/cliente/:id_usuario/pagos-manuales  (multipart, `comprobante` opcional)
 * body: monto, moneda?, metodo?, referencia?, fecha_pago?, nota?,
 *       stripe_invoice_id? (factura a saldar fuera de banda),
 *       anular_invoice_ids? ("in_a,in_b": otras facturas abiertas que se anulan),
 *       acceso_hasta? (fecha hasta la que queda el acceso cuando no hay factura)
 */
exports.registrarPagoManual = catchAsync(async (req, res, next) => {
  if (!soloSuper(req, next)) return;
  const id_usuario = Number(req.params.id_usuario);
  if (!id_usuario) return next(new AppError('id_usuario requerido', 400));
  const b = req.body || {};

  const comprobante_url = await subirComprobante(req.file, 'pagos_manuales/comprobantes');

  try {
    const r = await pagosSvc.registrar({
      id_usuario,
      monto: b.monto,
      moneda: b.moneda || 'usd',
      metodo: b.metodo || 'transferencia',
      referencia: b.referencia || null,
      fecha_pago: b.fecha_pago || null,
      nota: b.nota || null,
      comprobante_url,
      stripe_invoice_id: b.stripe_invoice_id || null,
      // multipart: llega como "in_a,in_b"
      anular_invoice_ids: String(b.anular_invoice_ids || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      acceso_hasta: b.acceso_hasta || null,
      admin: { id_sub_usuario: req.sessionUser.id_sub_usuario, nombre: nombreDe(req) },
    });
    /* `comprobante_subido` en false con archivo adjunto = el uploader falló:
       el pago quedó registrado igual y el front avisa. */
    res.json({
      status: 'success',
      data: r,
      comprobante_subido: Boolean(comprobante_url),
      comprobante_url,
    });
  } catch (e) {
    return next(new AppError(e.message, e.status || 500));
  }
});
