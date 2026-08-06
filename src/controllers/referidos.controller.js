'use strict';

/**
 * controllers/referidos.controller.js
 *
 * Capa HTTP del programa de referidos. Toda la lógica de dinero vive en
 * `services/referidos.service.js`; aquí solo se resuelve quién pregunta y se
 * traduce el resultado.
 *
 * NOTA SOBRE LA IDENTIDAD
 * `req.sessionUser` es un SUBusuario. Las comisiones son de la CUENTA, no del
 * colaborador que abrió la sesión, así que todo se resuelve por
 * `sessionUser.id_usuario`. Un subusuario administrador ve el saldo de la
 * cuenta a la que pertenece, que es el comportamiento correcto: la cuenta es la
 * que paga y la que cobra.
 */

const axios = require('axios');
const FormData = require('form-data');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const referidosService = require('../services/referidos.service');
const { PAGO_PREFS } = require('../config/referidos.config');

const cuentaDe = (req) => {
  const id = Number(req.sessionUser?.id_usuario);
  if (!id) throw new AppError('No se pudo resolver tu cuenta', 401);
  return id;
};

/**
 * GET /api/v1/referidos/validar/:codigo — público.
 * Lo usa la pantalla de registro para confirmar el enlace y poder decir
 * "te invitó Fulano". Devuelve 200 con `valido:false` en vez de 404: un código
 * viejo no debe pintar un error rojo en medio de un formulario de registro.
 */
exports.validarCodigo = catchAsync(async (req, res) => {
  const info = await referidosService.infoPublicaPorCodigo(req.params.codigo);
  return res.status(200).json({
    status: 'success',
    valido: Boolean(info),
    data: info || null,
  });
});

/** GET /api/v1/referidos/mi-programa */
exports.miPrograma = catchAsync(async (req, res) => {
  const data = await referidosService.resumen(cuentaDe(req));
  return res.status(200).json({ status: 'success', data });
});

/** POST /api/v1/referidos/aplicar-credito */
exports.aplicarCredito = catchAsync(async (req, res) => {
  const r = await referidosService.aplicarCredito(cuentaDe(req));
  if (!r.ok) {
    return res
      .status(400)
      .json({ status: 'fail', code: r.code, message: r.message });
  }
  /* Se nombra la factura concreta cuando se conoce: "tu próxima factura" es
     justo lo que el usuario no sabe verificar, y de ahí sale la sospecha de que
     el crédito no se aplicó. */
  const f = r.proxima_factura;
  const cuando = f?.fecha
    ? ` Tu factura del ${f.fecha} pasa de $${(f.total_cent / 100).toFixed(2)} a $${(f.a_pagar_con_saldo_cent / 100).toFixed(2)}.`
    : ' Se descontarán de tu próxima factura.';

  return res.status(200).json({
    status: 'success',
    message: `Se aplicaron $${(r.monto_cent / 100).toFixed(2)} a tu cuenta.${cuando}`,
    data: r,
  });
});

/** POST /api/v1/referidos/solicitar-transferencia */
exports.solicitarTransferencia = catchAsync(async (req, res) => {
  const { datos_pago } = req.body || {};
  if (!datos_pago || String(datos_pago).trim().length < 10) {
    return res.status(400).json({
      status: 'fail',
      message: 'Indica banco, tipo de cuenta, número y cédula del titular.',
    });
  }

  const r = await referidosService.solicitarTransferencia(
    cuentaDe(req),
    datos_pago,
  );
  if (!r.ok) {
    return res
      .status(400)
      .json({ status: 'fail', code: r.code, message: r.message });
  }
  return res.status(200).json({
    status: 'success',
    message: 'Solicitud registrada. La revisamos y te transferimos.',
    data: r,
  });
});

/** POST /api/v1/referidos/preferencia */
exports.guardarPreferencia = catchAsync(async (req, res) => {
  const pref = String(req.body?.preferencia || '').trim();
  if (!PAGO_PREFS.has(pref)) {
    return res
      .status(400)
      .json({ status: 'fail', message: 'Preferencia inválida' });
  }
  await referidosService.guardarPreferenciaPago(cuentaDe(req), pref);
  return res.status(200).json({ status: 'success' });
});

// ═══════════════════════════════════════════════════════════════
// Administración (super admin)
// ═══════════════════════════════════════════════════════════════

/**
 * Sube el comprobante al uploader compartido —el mismo de los adjuntos del
 * chat— y devuelve su URL.
 *
 * Devuelve null si falla, y el caller decide: perder el archivo es molesto,
 * pero bloquear el registro del pago porque el uploader está caído sería peor.
 * El dinero ya salió del banco para cuando alguien pulsa este botón.
 */
const subirComprobante = async (file) => {
  if (!file?.buffer?.length) return null;
  try {
    const nombre = String(file.originalname || 'comprobante').replace(
      /[^\w.\-() ]+/g,
      '_',
    );
    const form = new FormData();
    form.append('file', file.buffer, {
      filename: `referidos/comprobantes/${Date.now()}-${nombre}`,
      contentType: file.mimetype || 'application/octet-stream',
    });

    const resp = await axios.post(
      'https://uploader.imporfactory.app/api/files/upload',
      form,
      { headers: form.getHeaders(), timeout: 30000, validateStatus: () => true },
    );

    if (resp.status >= 200 && resp.status < 300 && resp.data?.data?.url) {
      return resp.data.data.url;
    }
    console.log('[referidos] uploader rechazó el comprobante:', resp.status);
    return null;
  } catch (e) {
    console.log('[referidos] subirComprobante falló:', e?.message);
    return null;
  }
};

/** GET /api/v1/referidos/admin/solicitudes?estado= */
exports.listarSolicitudes = catchAsync(async (req, res) => {
  const data = await referidosService.listarSolicitudes(
    req.query?.estado || null,
  );
  return res.status(200).json({ status: 'success', data });
});

/** GET /api/v1/referidos/admin/solicitudes/:id */
exports.detalleSolicitud = catchAsync(async (req, res) => {
  const data = await referidosService.detalleSolicitud(Number(req.params.id));
  if (!data) throw new AppError('Solicitud no encontrada', 404);
  return res.status(200).json({ status: 'success', data });
});

/**
 * POST /api/v1/referidos/admin/solicitudes/:id
 * multipart/form-data — el campo `comprobante` es opcional.
 */
exports.resolverSolicitud = catchAsync(async (req, res) => {
  const { accion, referencia, nota } = req.body || {};
  if (!['pagar', 'rechazar'].includes(accion)) {
    return res
      .status(400)
      .json({ status: 'fail', message: 'Acción inválida (pagar | rechazar)' });
  }

  const comprobante_url =
    accion === 'pagar' ? await subirComprobante(req.file) : null;

  const r = await referidosService.resolverSolicitud({
    id_pago: Number(req.params.id),
    accion,
    referencia,
    nota,
    comprobante_url,
    id_sub_usuario_admin: req.sessionUser?.id_sub_usuario || null,
  });
  if (!r.ok) {
    return res
      .status(400)
      .json({ status: 'fail', code: r.code, message: r.message });
  }
  /* `comprobante_subido` en false con archivo adjunto significa que el uploader
     falló: el pago quedó registrado igual y el front avisa para reintentar la
     subida, en vez de dar por hecho que el comprobante está guardado. */
  return res.status(200).json({
    status: 'success',
    comprobante_subido: Boolean(comprobante_url),
    comprobante_url,
  });
});
