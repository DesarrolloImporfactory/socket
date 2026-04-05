/**
 * encuestas.controller.js
 *
 * CRUD de encuestas + stats + respuestas
 * Para el frontend de configuración y visualización
 */

const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const crypto = require('crypto');

// ── Listar encuestas de una conexión ──
exports.listarPorConexion = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.query;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));

  const encuestas = await db.query(
    `
    SELECT e.id, e.tipo, e.nombre, e.descripcion, e.activa,
           e.cooldown_horas, e.delay_envio_minutos, e.mensaje_envio,
           e.url_encuesta_publica, e.umbral_escalacion,
           e.created_at,
           ec.id AS id_conexion, ec.activa AS conexion_activa,
           ec.auto_enviar_al_cerrar, ec.webhook_secret,
           (SELECT COUNT(*) FROM encuestas_respuestas er
            WHERE er.id_encuesta = e.id AND er.id_configuracion = :cfg) AS total_respuestas,
           (SELECT ROUND(AVG(er2.score), 1) FROM encuestas_respuestas er2
            WHERE er2.id_encuesta = e.id AND er2.id_configuracion = :cfg
              AND er2.score IS NOT NULL) AS promedio_score
    FROM encuestas_conexiones ec
    JOIN encuestas e ON e.id = ec.id_encuesta
    WHERE ec.id_configuracion = :cfg
      AND e.deleted_at IS NULL
    ORDER BY e.created_at DESC
  `,
    {
      replacements: { cfg: id_configuracion },
      type: QueryTypes.SELECT,
    },
  );

  return res.json({ success: true, data: encuestas });
});

// ── Stats detallados de una encuesta ──
exports.stats = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { id_configuracion } = req.query;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));

  // Stats generales
  const [general] = await db.query(
    `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN estado = 'respondida' THEN 1 ELSE 0 END) AS respondidas,
      SUM(CASE WHEN estado = 'enviada' THEN 1 ELSE 0 END) AS pendientes,
      SUM(CASE WHEN source = 'webhook' THEN 1 ELSE 0 END) AS por_webhook,
      SUM(CASE WHEN source = 'link' THEN 1 ELSE 0 END) AS por_link,
      ROUND(AVG(score), 1) AS promedio_score,
      SUM(CASE WHEN score >= 4 THEN 1 ELSE 0 END) AS promotores,
      SUM(CASE WHEN score = 3 THEN 1 ELSE 0 END) AS neutrales,
      SUM(CASE WHEN score <= 2 AND score IS NOT NULL THEN 1 ELSE 0 END) AS detractores,
      SUM(CASE WHEN escalado = 1 THEN 1 ELSE 0 END) AS escalados
    FROM encuestas_respuestas
    WHERE id_encuesta = :id AND id_configuracion = :cfg
  `,
    {
      replacements: { id, cfg: id_configuracion },
      type: QueryTypes.SELECT,
    },
  );

  // Stats por encargado
  const porEncargado = await db.query(
    `
    SELECT
      er.id_encargado,
      COALESCE(s.nombre_encargado, 'Sin asignar') AS nombre_encargado,
      COUNT(*) AS total,
      SUM(CASE WHEN er.estado = 'respondida' THEN 1 ELSE 0 END) AS respondidas,
      ROUND(AVG(er.score), 1) AS promedio
    FROM encuestas_respuestas er
    LEFT JOIN sub_usuarios_chat_center s ON s.id_sub_usuario = er.id_encargado
    WHERE er.id_encuesta = :id AND er.id_configuracion = :cfg
    GROUP BY er.id_encargado
    ORDER BY promedio DESC
  `,
    {
      replacements: { id, cfg: id_configuracion },
      type: QueryTypes.SELECT,
    },
  );

  // Últimos 7 días
  const porDia = await db.query(
    `
    SELECT
      DATE(created_at) AS fecha,
      COUNT(*) AS total,
      ROUND(AVG(score), 1) AS promedio
    FROM encuestas_respuestas
    WHERE id_encuesta = :id AND id_configuracion = :cfg
      AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    GROUP BY DATE(created_at)
    ORDER BY fecha DESC
  `,
    {
      replacements: { id, cfg: id_configuracion },
      type: QueryTypes.SELECT,
    },
  );

  return res.json({
    success: true,
    data: { general, porEncargado, porDia },
  });
});

// ── Listar respuestas paginadas ──
exports.listarRespuestas = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { id_configuracion } = req.query;
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)));
  const offset = (page - 1) * limit;

  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));

  const respuestas = await db.query(
    `
    SELECT
      er.id, er.source, er.score, er.estado, er.escalado,
      er.respuestas, er.datos_contacto, er.created_at,
      c.nombre_cliente, c.apellido_cliente, c.celular_cliente,
      COALESCE(s.nombre_encargado, 'Sin asignar') AS nombre_encargado
    FROM encuestas_respuestas er
    LEFT JOIN clientes_chat_center c ON c.id = er.id_cliente_chat_center
    LEFT JOIN sub_usuarios_chat_center s ON s.id_sub_usuario = er.id_encargado
    WHERE er.id_encuesta = :id AND er.id_configuracion = :cfg
    ORDER BY er.created_at DESC
    LIMIT :limit OFFSET :offset
  `,
    {
      replacements: { id, cfg: id_configuracion, limit, offset },
      type: QueryTypes.SELECT,
    },
  );

  const [{ total }] = await db.query(
    `
    SELECT COUNT(*) AS total FROM encuestas_respuestas
    WHERE id_encuesta = :id AND id_configuracion = :cfg
  `,
    {
      replacements: { id, cfg: id_configuracion },
      type: QueryTypes.SELECT,
    },
  );

  return res.json({
    success: true,
    data: respuestas,
    total: Number(total),
    page,
    limit,
  });
});

// ── Crear encuesta ──
exports.crear = catchAsync(async (req, res, next) => {
  const {
    id_configuracion,
    tipo,
    nombre,
    descripcion,
    preguntas,
    cooldown_horas,
    delay_envio_minutos,
    mensaje_envio,
    auto_enviar_al_cerrar,
    url_encuesta_publica,
    umbral_escalacion,
  } = req.body;

  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario) return next(new AppError('No autenticado', 401));
  if (!id_configuracion || !nombre || !tipo) {
    return next(new AppError('Faltan campos obligatorios', 400));
  }

  const preguntasJson =
    typeof preguntas === 'string' ? preguntas : JSON.stringify(preguntas || []);
  const webhookSecret =
    tipo === 'webhook_lead' ? crypto.randomBytes(16).toString('hex') : null;

  // Crear encuesta
  const [idEncuesta] = await db.query(
    `
    INSERT INTO encuestas
      (id_usuario, tipo, nombre, descripcion, preguntas, activa,
       cooldown_horas, delay_envio_minutos, mensaje_envio,
       url_encuesta_publica, umbral_escalacion)
    VALUES (:id_usuario, :tipo, :nombre, :desc, :preguntas, 1,
            :cooldown, :delay, :mensaje, :url, :umbral)
  `,
    {
      replacements: {
        id_usuario,
        tipo,
        nombre,
        desc: descripcion || null,
        preguntas: preguntasJson,
        cooldown: cooldown_horas ?? (tipo === 'satisfaccion' ? 24 : 0),
        delay: delay_envio_minutos ?? 0,
        mensaje: mensaje_envio || null,
        url: url_encuesta_publica || null,
        umbral: umbral_escalacion ?? 2,
      },
      type: QueryTypes.INSERT,
    },
  );

  // Vincular a conexión
  await db.query(
    `
    INSERT INTO encuestas_conexiones
      (id_encuesta, id_configuracion, activa, auto_enviar_al_cerrar, webhook_secret)
    VALUES (:enc, :cfg, 1, :auto, :secret)
  `,
    {
      replacements: {
        enc: idEncuesta,
        cfg: id_configuracion,
        auto: auto_enviar_al_cerrar ? 1 : 0,
        secret: webhookSecret,
      },
      type: QueryTypes.INSERT,
    },
  );

  return res.status(201).json({
    success: true,
    id_encuesta: idEncuesta,
    webhook_secret: webhookSecret,
  });
});

// ── Actualizar encuesta ──
exports.actualizar = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const {
    nombre,
    descripcion,
    activa,
    cooldown_horas,
    delay_envio_minutos,
    mensaje_envio,
    auto_enviar_al_cerrar,
    umbral_escalacion,
    id_configuracion,
  } = req.body;

  await db.query(
    `
    UPDATE encuestas SET
      nombre = COALESCE(:nombre, nombre),
      descripcion = COALESCE(:desc, descripcion),
      activa = COALESCE(:activa, activa),
      cooldown_horas = COALESCE(:cooldown, cooldown_horas),
      delay_envio_minutos = COALESCE(:delay, delay_envio_minutos),
      mensaje_envio = COALESCE(:mensaje, mensaje_envio),
      umbral_escalacion = COALESCE(:umbral, umbral_escalacion),
      updated_at = NOW()
    WHERE id = :id
  `,
    {
      replacements: {
        id,
        nombre: nombre ?? null,
        desc: descripcion ?? null,
        activa: activa ?? null,
        cooldown: cooldown_horas ?? null,
        delay: delay_envio_minutos ?? null,
        mensaje: mensaje_envio ?? null,
        umbral: umbral_escalacion ?? null,
      },
      type: QueryTypes.UPDATE,
    },
  );

  // Actualizar conexión si viene id_configuracion
  if (id_configuracion && auto_enviar_al_cerrar !== undefined) {
    await db.query(
      `
      UPDATE encuestas_conexiones SET
        auto_enviar_al_cerrar = :auto,
        updated_at = NOW()
      WHERE id_encuesta = :id AND id_configuracion = :cfg
    `,
      {
        replacements: {
          id,
          cfg: id_configuracion,
          auto: auto_enviar_al_cerrar ? 1 : 0,
        },
        type: QueryTypes.UPDATE,
      },
    );
  }

  return res.json({ success: true });
});

// ── Toggle activa/inactiva ──
exports.toggleActiva = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  await db.query(
    `
    UPDATE encuestas SET activa = NOT activa, updated_at = NOW() WHERE id = :id
  `,
    { replacements: { id }, type: QueryTypes.UPDATE },
  );

  const [enc] = await db.query(`SELECT activa FROM encuestas WHERE id = :id`, {
    replacements: { id },
    type: QueryTypes.SELECT,
  });

  return res.json({ success: true, activa: enc?.activa });
});

// ── Eliminar encuesta (soft-delete) ──
exports.eliminar = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  // Verificar que existe
  const [enc] = await db.query(
    `SELECT id FROM encuestas WHERE id = :id AND deleted_at IS NULL`,
    { replacements: { id }, type: QueryTypes.SELECT },
  );

  if (!enc) return next(new AppError('Encuesta no encontrada', 404));

  await db.query(
    `UPDATE encuestas SET activa = 0, deleted_at = NOW(), updated_at = NOW() WHERE id = :id`,
    { replacements: { id }, type: QueryTypes.UPDATE },
  );

  return res.json({ success: true, message: 'Encuesta eliminada' });
});
