const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const { db } = require('../database/config');

exports.validarConexionUsuario = catchAsync(async (req, res, next) => {
  const { id_usuario, id_configuracion } = req.body;

  const configuraciones = await db.query(
    'SELECT id_usuario FROM configuraciones WHERE id = ?',
    {
      replacements: [id_configuracion],
      type: db.QueryTypes.SELECT,
    }
  );

  if (!configuraciones || configuraciones.length === 0) {
    return next(
      new AppError(
        'No se encontró una configuración con este id_configuracion: ' +
          id_configuracion,
        400
      )
    );
  }

  const idUsuarioConfiguracion = configuraciones[0].id_usuario;

  console.log('id_usuario: ' + id_usuario);
  console.log('configuraciones.id_usuario: ' + idUsuarioConfiguracion);

  if (id_usuario != idUsuarioConfiguracion) {
    return res.status(200).json({
      status: 'success',
      coincidencia: false,
    });
  }

  return res.status(200).json({
    status: 'success',
    coincidencia: true,
  });
});

exports.obtener_template_transportadora = catchAsync(async (req, res, next) => {
  const { id_plataforma } = req.body;

  const [configuraciones] = await db.query(
    'SELECT template_generar_guia FROM configuraciones WHERE id_plataforma = ?',
    {
      replacements: [id_plataforma],
      type: db.QueryTypes.SELECT,
    }
  );
  if (configuraciones.length === 0) {
    return next(
      new AppError('No se encontro una plataforma con dicho ID_PLATAFORMA', 400)
    );
  }

  const template_generar_guia = configuraciones.template_generar_guia;

  res.status(200).json({
    status: 'success',
    data: {
      template: template_generar_guia,
    },
  });
});

exports.listarConexiones = catchAsync(async (req, res, next) => {
  const { id_usuario } = req.body;
  if (!id_usuario) {
    return res
      .status(400)
      .json({ status: 'error', message: 'Falta id_usuario' });
  }

  try {
    const [rows] = await db.query(
      `
      SELECT
        c.id,
        c.id_plataforma,
        c.nombre_configuracion,
        c.telefono,
        c.id_telefono,       -- PHONE_NUMBER_ID (WPP)
        c.id_whatsapp,       -- WABA_ID        (WPP)
        c.webhook_url,
        c.metodo_pago,
        c.suspendido,
        CASE
          WHEN COALESCE(c.id_telefono,'') <> '' AND COALESCE(c.id_whatsapp,'') <> '' THEN 1
          ELSE 0
        END AS conectado,

        /* === Estado de Messenger con su tabla messenger_pages === */
        EXISTS (
          SELECT 1
          FROM messenger_pages mp
          WHERE mp.id_configuracion = c.id
            AND mp.subscribed = 1
            AND mp.status = 'active'
        ) AS messenger_conectado,

        /* Opcional: nombre e id de la última página conectada (para tooltip/pill) */
        (
          SELECT mp.page_name
          FROM messenger_pages mp
          WHERE mp.id_configuracion = c.id
            AND mp.subscribed = 1
            AND mp.status = 'active'
          ORDER BY mp.id_messenger_page DESC
          LIMIT 1
        ) AS messenger_page_name,

        (
          SELECT mp.page_id
          FROM messenger_pages mp
          WHERE mp.id_configuracion = c.id
            AND mp.subscribed = 1
            AND mp.status = 'active'
          ORDER BY mp.id_messenger_page DESC
          LIMIT 1
        ) AS messenger_page_id,

        /* Instagram: solo estado */
        EXISTS (
          SELECT 1
          FROM instagram_pages ip
          WHERE ip.id_configuracion = c.id
            AND ip.subscribed = 1
            AND ip.status = 'active'
        ) AS instagram_conectado,

        /* TikTok Developers (Login Kit): solo estado */
        EXISTS (
          SELECT 1
          FROM tiktok_devs_connections tdc
          WHERE tdc.id_configuracion = c.id
        ) AS tiktok_conectado

      FROM configuraciones c
      WHERE c.id_usuario = ?
        AND c.suspendido = 0
      ORDER BY c.id DESC
      `,
      { replacements: [id_usuario] }
    );

    return res.json({ status: 'success', data: rows });
  } catch (e) {
    console.error('listar_conexiones:', e);
    return res.status(500).json({ status: 'error', message: 'Error interno' });
  }
});

exports.listarAdminConexiones = catchAsync(async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `
      SELECT
        c.id,
        c.id_plataforma,
        c.nombre_configuracion,
        c.telefono,
        c.id_telefono,       -- PHONE_NUMBER_ID (WPP)
        c.id_whatsapp,       -- WABA_ID        (WPP)
        c.webhook_url,
        c.metodo_pago,
        c.suspendido,
        CASE
          WHEN COALESCE(c.id_telefono,'') <> '' AND COALESCE(c.id_whatsapp,'') <> '' THEN 1
          ELSE 0
        END AS conectado,

        /* === Estado de Messenger con su tabla messenger_pages === */
        EXISTS (
          SELECT 1
          FROM messenger_pages mp
          WHERE mp.id_configuracion = c.id
            AND mp.subscribed = 1
            AND mp.status = 'active'
        ) AS messenger_conectado,

        /* Opcional: nombre e id de la última página conectada (para tooltip/pill) */
        (
          SELECT mp.page_name
          FROM messenger_pages mp
          WHERE mp.id_configuracion = c.id
            AND mp.subscribed = 1
            AND mp.status = 'active'
          ORDER BY mp.id_messenger_page DESC
          LIMIT 1
        ) AS messenger_page_name,

        (
          SELECT mp.page_id
          FROM messenger_pages mp
          WHERE mp.id_configuracion = c.id
            AND mp.subscribed = 1
            AND mp.status = 'active'
          ORDER BY mp.id_messenger_page DESC
          LIMIT 1
        ) AS messenger_page_id,

        /* Instagram: solo estado */
        EXISTS (
          SELECT 1
          FROM instagram_pages ip
          WHERE ip.id_configuracion = c.id
            AND ip.subscribed = 1
            AND ip.status = 'active'
        ) AS instagram_conectado,

        /* TikTok Developers (Login Kit): solo estado */
        EXISTS (
          SELECT 1
          FROM tiktok_devs_connections tdc
          WHERE tdc.id_configuracion = c.id
        ) AS tiktok_conectado

      FROM configuraciones c
      WHERE c.suspendido = 0
      ORDER BY c.id DESC
      `
    );

    return res.json({ status: 'success', data: rows });
  } catch (e) {
    console.error('listar_admin_conexiones:', e);
    return res.status(500).json({ status: 'error', message: 'Error interno' });
  }
});

exports.listarConfiguraciones = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;

  const configuraciones = await db.query(
    'SELECT id, id_plataforma, nombre_configuracion, telefono, webhook_url, metodo_pago, suspendido, CASE WHEN id_telefono IS NOT NULL AND id_whatsapp IS NOT NULL AND token IS NOT NULL THEN 1 ELSE 0 END AS conectado FROM configuraciones WHERE id = ? AND suspendido = 0',
    {
      replacements: [id_configuracion],
      type: db.QueryTypes.SELECT,
    }
  );
  if (!configuraciones || configuraciones.length === 0) {
    return next(
      new AppError('No se encontro configuracion: ' + id_usuario, 400)
    );
  }

  res.status(200).json({
    status: 'success',
    data: configuraciones,
  });
});

exports.agregarConfiguracion = catchAsync(async (req, res, next) => {
  const { nombre_configuracion, telefono, id_usuario } = req.body;

  if (!nombre_configuracion || !telefono || !id_usuario) {
    return res.status(400).json({
      status: 400,
      message: 'Faltan campos obligatorios para agregar configuración.',
    });
  }

  try {
    // Generar clave única
    const key_imporsuit = generarClaveUnica();

    // Insertar en `configuraciones`
    const insertSql = `
      INSERT INTO configuraciones
        (id_usuario, nombre_configuracion, telefono, key_imporsuit, created_at)
      VALUES (?, ?, ?, ?, NOW())
    `;
    const [insertResult] = await db.query(insertSql, {
      replacements: [id_usuario, nombre_configuracion, telefono, key_imporsuit],
    });

    return res.status(200).json({
      status: 200,
      message: 'Configuración agregada correctamente.',
      id_configuracion: insertResult.insertId,
      nombre_configuracion, // Este valor puede ser útil si lo necesitas más adelante
    });
  } catch (error) {
    console.error('Error al agregar configuración:', error);
    return res.status(500).json({
      status: 500,
      message: 'Hubo un problema al agregar la configuración.',
    });
  }
});

function generarClaveUnica() {
  // Aquí un ejemplo con currentTime + random:
  const randomStr = Math.random().toString(36).substring(2, 8);
  return `key_${Date.now()}_${randomStr}`;
}

exports.toggleSuspension = catchAsync(async (req, res, next) => {
  const { id_usuario, id_configuracion, suspendido } = req.body;

  if (
    typeof id_usuario === 'undefined' ||
    typeof id_configuracion === 'undefined' ||
    typeof suspendido === 'undefined'
  ) {
    return res.status(400).json({
      status: 400,
      message: 'id_usuario, id_configuracion y suspendido son obligatorios',
    });
  }

  // 1) Validar pertenencia de la config al usuario
  const rows = await db.query(
    'SELECT id, id_usuario FROM configuraciones WHERE id = ?',
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT }
  );
  if (!rows || rows.length === 0) {
    return res.status(404).json({
      status: 404,
      message: `No existe configuración con id ${id_configuracion}`,
    });
  }
  if (Number(rows[0].id_usuario) !== Number(id_usuario)) {
    return res.status(403).json({
      status: 403,
      message: 'La configuración no pertenece a este usuario',
    });
  }

  // 2) Actualizar estado
  const setSusp = suspendido ? 1 : 0;
  await db.query(
    `UPDATE configuraciones
       SET suspendido = ?,
           suspended_at = CASE WHEN ? = 1 THEN NOW() ELSE NULL END,
           updated_at = NOW()
     WHERE id = ?`,
    { replacements: [setSusp, setSusp, id_configuracion] }
  );

  return res.status(200).json({
    status: 200,
    message: setSusp ? 'Configuración suspendida' : 'Configuración reactivada',
    data: { id_configuracion, suspendido: !!setSusp },
  });
});
