const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const EnlacesPago = require('../models/enlaces_pago.model');
const Configuraciones = require('../models/configuraciones.model');
const pagos = require('../services/pagos_stripe.service');

/**
 * Enlaces de pago desde el chat ("+" → Crear enlace de pago).
 * La lógica vive en services/pagos_stripe.service.js; aquí solo se valida
 * la propiedad de la configuración y se arma la respuesta.
 */

async function assertConfigBelongsToOwner(req, id_configuracion) {
  const cfg = await Configuraciones.findOne({
    where: { id: id_configuracion, id_usuario: req.sessionUser.id_usuario },
  });
  if (!cfg) {
    throw new AppError(
      'Configuración no válida o no pertenece a esta cuenta',
      403,
    );
  }
  return cfg;
}

const errorDe = (e) =>
  e instanceof pagos.EnlacePagoError
    ? new AppError(e.message, e.statusCode || 400)
    : new AppError(
        /No such|Invalid|permission/i.test(String(e?.message || ''))
          ? `Stripe respondió: ${e.message}`
          : e?.message || 'No se pudo crear el enlace de pago',
        400,
      );

/**
 * POST /  { id_configuracion, id_cliente, monto, moneda?, concepto,
 *           mensaje?, enviar? (default true), dias_vencimiento? }
 * Crea la factura y, salvo enviar=false, la manda por WhatsApp al contacto.
 */
exports.crear = catchAsync(async (req, res, next) => {
  const {
    id_configuracion,
    id_cliente,
    monto,
    moneda,
    concepto,
    mensaje,
    enviar = true,
    dias_vencimiento,
  } = req.body || {};

  if (!id_configuracion || !id_cliente) {
    return next(
      new AppError('id_configuracion e id_cliente son requeridos', 400),
    );
  }

  let creado;
  try {
    creado = await pagos.crearEnlacePago({
      id_configuracion: Number(id_configuracion),
      id_cliente: Number(id_cliente),
      monto,
      moneda,
      concepto,
      origen: 'asesor',
      id_sub_usuario: req.sessionUser?.id_sub_usuario || null,
      dias_vencimiento,
    });
  } catch (e) {
    console.log('[enlaces_pago] crear falló:', e?.message);
    return next(errorDe(e));
  }

  let envio = null;
  let errorEnvio = null;
  if (enviar !== false && enviar !== 'false') {
    try {
      envio = await pagos.enviarEnlacePorWhatsapp({
        enlace: creado.enlace,
        contacto: creado.contacto,
        mensaje,
        responsable: req.sessionUser?.nombre_encargado || null,
      });
    } catch (e) {
      // La factura ya existe y es válida: se devuelve igual con el aviso, para
      // que el asesor la mande a mano (p. ej. fuera de la ventana de 24 h).
      console.log('[enlaces_pago] envío por WhatsApp falló:', e?.message);
      errorEnvio =
        'El enlace se creó pero no se pudo enviar por WhatsApp. Si el cliente no escribió en las últimas 24 h, envíaselo con una plantilla o cópialo.';
    }
  }

  return res.status(201).json({
    isSuccess: true,
    data: creado.enlace,
    enviado: !!envio,
    texto: envio?.texto || null,
    aviso: errorEnvio,
  });
});

/**
 * GET /historial?id_configuracion&estado&desde&hasta&q&page&limit
 * Historial de TODOS los cobros de la cuenta (pestaña "Cobros" de
 * Integraciones → Stripe): con contacto, asesor que lo envió y totales por
 * estado. Refresca los pendientes recientes antes de responder.
 */
exports.historial = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(req.query.id_configuracion || 0);
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const estado = ['pendiente', 'pagado', 'anulado'].includes(req.query.estado)
    ? req.query.estado
    : null;
  const desde = req.query.desde ? String(req.query.desde).slice(0, 10) : null;
  const hasta = req.query.hasta ? String(req.query.hasta).slice(0, 10) : null;
  const q = String(req.query.q || '')
    .trim()
    .slice(0, 60);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const page = Math.max(1, Number(req.query.page) || 1);
  const offset = (page - 1) * limit;

  try {
    await pagos.sincronizarPendientes({
      id_configuracion,
      minutos: 0.5,
      limite: 100,
    });
  } catch (e) {
    console.log('[enlaces_pago] sync en historial falló:', e?.message);
  }

  const { db } = require('../database/config');
  const where = ['e.id_configuracion = :id_configuracion'];
  const repl = { id_configuracion, limit, offset };
  if (estado) {
    where.push('e.estado = :estado');
    repl.estado = estado;
  }
  if (desde) {
    where.push('e.created_at >= :desde');
    repl.desde = `${desde} 00:00:00`;
  }
  if (hasta) {
    where.push('e.created_at <= :hasta');
    repl.hasta = `${hasta} 23:59:59`;
  }
  if (q) {
    where.push(
      `(c.nombre_cliente LIKE :q OR c.apellido_cliente LIKE :q OR c.celular_cliente LIKE :q OR e.concepto LIKE :q OR s.nombre_encargado LIKE :q)`,
    );
    repl.q = `%${q}%`;
  }
  const W = where.join(' AND ');
  const JOINS = `
    FROM enlaces_pago e
    LEFT JOIN clientes_chat_center c ON c.id = e.id_cliente_chat_center
    LEFT JOIN sub_usuarios_chat_center s ON s.id_sub_usuario = e.id_sub_usuario`;

  const rows = await db.query(
    `SELECT e.id, e.created_at, e.monto, e.moneda, e.concepto, e.estado,
            e.pagado_at, e.anulado_at, e.url_pago, e.url_pdf, e.origen,
            e.id_cliente_chat_center,
            c.nombre_cliente, c.apellido_cliente, c.celular_cliente,
            s.nombre_encargado AS asesor
     ${JOINS}
     WHERE ${W}
     ORDER BY e.id DESC
     LIMIT :limit OFFSET :offset`,
    { replacements: repl, type: db.QueryTypes.SELECT },
  );

  // Totales del mismo filtro (sin paginar) para las tarjetas de arriba.
  const [tot] = await db.query(
    `SELECT COUNT(*) AS total,
            SUM(e.estado = 'pagado') AS pagados,
            SUM(e.estado = 'pendiente') AS pendientes,
            SUM(e.estado = 'anulado') AS anulados,
            SUM(CASE WHEN e.estado = 'pagado' THEN e.monto ELSE 0 END) AS monto_pagado,
            SUM(CASE WHEN e.estado = 'pendiente' THEN e.monto ELSE 0 END) AS monto_pendiente,
            COUNT(DISTINCT e.id_sub_usuario) AS asesores
     ${JOINS}
     WHERE ${W}`,
    { replacements: repl, type: db.QueryTypes.SELECT },
  );

  return res.json({
    isSuccess: true,
    data: rows,
    page,
    limit,
    totales: {
      total: Number(tot?.total || 0),
      pagados: Number(tot?.pagados || 0),
      pendientes: Number(tot?.pendientes || 0),
      anulados: Number(tot?.anulados || 0),
      monto_pagado: Number(tot?.monto_pagado || 0),
      monto_pendiente: Number(tot?.monto_pendiente || 0),
      asesores: Number(tot?.asesores || 0),
    },
  });
});

/**
 * GET /?id_configuracion&id_cliente — enlaces del contacto. Antes de listar
 * refresca los pendientes de ese contacto (con candado de 2 min por fila).
 */
exports.listar = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(req.query.id_configuracion || 0);
  const id_cliente = Number(req.query.id_cliente || 0);
  if (!id_configuracion || !id_cliente) {
    return next(
      new AppError('id_configuracion e id_cliente son requeridos', 400),
    );
  }
  try {
    // Candado corto (30 s): el chat abierto vuelve a pedir la lista cada 30 s
    // mientras haya un cobro pendiente, y el pago suele llegar a los minutos
    // de enviar el enlace.
    await pagos.sincronizarPendientes({
      id_configuracion,
      id_cliente,
      minutos: 0.5,
      limite: 30,
    });
  } catch (e) {
    console.log('[enlaces_pago] sync al listar falló:', e?.message);
  }
  const rows = await pagos.listarPorCliente(id_configuracion, id_cliente);
  return res.json({ isSuccess: true, data: rows });
});

/** POST /:id/refrescar — consulta Stripe ahora mismo. */
exports.refrescar = catchAsync(async (req, res, next) => {
  const row = await EnlacesPago.findByPk(req.params.id);
  if (!row) return next(new AppError('Enlace no encontrado', 404));
  await assertConfigBelongsToOwner(req, row.id_configuracion);
  const actualizado = await pagos.refrescarEstado(row);
  return res.json({ isSuccess: true, data: actualizado });
});

/** POST /:id/anular — anula la factura en Stripe (no se puede pagar más). */
exports.anular = catchAsync(async (req, res, next) => {
  const row = await EnlacesPago.findByPk(req.params.id);
  if (!row) return next(new AppError('Enlace no encontrado', 404));
  await assertConfigBelongsToOwner(req, row.id_configuracion);
  try {
    const actualizado = await pagos.anularEnlace(row);
    return res.json({ isSuccess: true, data: actualizado });
  } catch (e) {
    return next(errorDe(e));
  }
});
