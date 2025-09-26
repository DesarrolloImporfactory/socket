const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const { db } = require('../database/config');
const Configuraciones = require('../models/configuraciones.model');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');

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

router.post('/configuraciones/listar_conexiones', async (req, res) => {
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
        id,
        id_plataforma,
        nombre_configuracion,
        telefono,
        id_telefono,        
        id_whatsapp,        
        webhook_url,
        metodo_pago,
        suspendido,
        CASE
          WHEN COALESCE(id_telefono,'') <> '' AND COALESCE(id_whatsapp,'') <> '' THEN 1
          ELSE 0
        END AS conectado
      FROM configuraciones
      WHERE id_usuario = ?
        AND suspendido = 0
      ORDER BY id DESC
      `,
      { replacements: [id_usuario] }
    );

    return res.json({ status: 'success', data: rows });
  } catch (e) {
    console.error('listar_conexiones:', e);
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
