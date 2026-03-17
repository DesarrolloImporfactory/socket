const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const ExcelJS = require('exceljs');
const { db } = require('../database/config');

exports.validarConexionUsuario = catchAsync(async (req, res, next) => {
  const { id_usuario, id_configuracion } = req.body;

  const configuraciones = await db.query(
    'SELECT id_usuario FROM configuraciones WHERE id = ? AND suspendido = 0',
    {
      replacements: [id_configuracion],
      type: db.QueryTypes.SELECT,
    },
  );

  if (!configuraciones || configuraciones.length === 0) {
    return next(
      new AppError(
        'No se encontró una configuración con este id_configuracion: ' +
          id_configuracion,
        400,
      ),
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
    'SELECT template_generar_guia FROM configuraciones WHERE id_plataforma = ? AND suspendido = 0',
    {
      replacements: [id_plataforma],
      type: db.QueryTypes.SELECT,
    },
  );
  if (configuraciones.length === 0) {
    return next(
      new AppError(
        'No se encontro una plataforma con dicho ID_PLATAFORMA',
        400,
      ),
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
        c.tipo_configuracion,
        c.sincronizo_coexistencia,

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
      { replacements: [id_usuario] },
    );

    return res.json({ status: 'success', data: rows });
  } catch (e) {
    console.error('listar_conexiones:', e);
    return res.status(500).json({ status: 'error', message: 'Error interno' });
  }
});

exports.listarConexionesSubUser = catchAsync(async (req, res) => {
  const { id_usuario, id_sub_usuario } = req.body;

  if (!id_usuario) {
    return res
      .status(400)
      .json({ status: 'error', message: 'Falta id_usuario' });
  }

  // Si no mandan subusuario, se asume "dueño" o modo legacy (devuelve todo del usuario)
  // (si usted quiere exigirlo, cambie esto a 400)
  let esAdmin = true;

  if (id_sub_usuario) {
    const subRow = await db.query(
      `
      SELECT rol
      FROM sub_usuarios_chat_center
      WHERE id_sub_usuario = ?
        AND id_usuario = ?
      LIMIT 1
      `,
      {
        replacements: [id_sub_usuario, id_usuario],
        type: db.QueryTypes.SELECT,
      },
    );

    const rol = subRow?.[0]?.rol || null;

    if (!rol) {
      return res.status(403).json({
        status: 'error',
        message: 'Subusuario inválido o no pertenece al usuario.',
      });
    }

    esAdmin = rol === 'administrador' || rol === 'super_administrador';
  }

  const [rows] = await db.query(
    `
    SELECT
      c.id,
      c.id_plataforma,
      c.nombre_configuracion,
      c.telefono,
      c.id_telefono,
      c.id_whatsapp,
      c.webhook_url,
      c.metodo_pago,
      c.suspendido,
      c.tipo_configuracion,
      c.sincronizo_coexistencia,

      CASE
        WHEN COALESCE(c.id_telefono,'') <> '' AND COALESCE(c.id_whatsapp,'') <> '' THEN 1
        ELSE 0
      END AS conectado,

      EXISTS (
        SELECT 1
        FROM messenger_pages mp
        WHERE mp.id_configuracion = c.id
          AND mp.subscribed = 1
          AND mp.status = 'active'
      ) AS messenger_conectado,

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

      EXISTS (
        SELECT 1
        FROM instagram_pages ip
        WHERE ip.id_configuracion = c.id
          AND ip.subscribed = 1
          AND ip.status = 'active'
      ) AS instagram_conectado,

      EXISTS (
        SELECT 1
        FROM tiktok_devs_connections tdc
        WHERE tdc.id_configuracion = c.id
      ) AS tiktok_conectado

    FROM configuraciones c
    WHERE c.id_usuario = ?
      AND c.suspendido = 0
      AND (
        ? = 1
        OR EXISTS (
          SELECT 1
          FROM departamentos_chat_center dcc
          INNER JOIN sub_usuarios_departamento sud
            ON sud.id_departamento = dcc.id_departamento
          WHERE dcc.id_configuracion = c.id
            AND sud.id_sub_usuario = ?
        )
      )
    ORDER BY c.id DESC
    `,
    {
      replacements: [
        id_usuario,
        esAdmin ? 1 : 0,
        id_sub_usuario || 0, // si no viene, da igual porque esAdmin=true
      ],
    },
  );

  return res.json({ status: 'success', data: rows });
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
        ) AS tiktok_conectado,

        /* Contador de conversaciones */
        (
          SELECT count(*)
          FROM clientes_chat_center ccc
          WHERE ccc.id_configuracion = c.id AND ccc.celular_cliente <> c.telefono
        ) AS cantidad_conversaciones

      FROM configuraciones c
      WHERE c.suspendido = 0
      ORDER BY cantidad_conversaciones DESC
      `,
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
    },
  );
  if (!configuraciones || configuraciones.length === 0) {
    return next(
      new AppError('No se encontro configuracion: ' + id_usuario, 400),
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
    'SELECT id, id_usuario FROM configuraciones WHERE id = ? AND suspendido = 0',
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
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
    { replacements: [setSusp, setSusp, id_configuracion] },
  );

  return res.status(200).json({
    status: 200,
    message: setSusp ? 'Configuración suspendida' : 'Configuración reactivada',
    data: { id_configuracion, suspendido: !!setSusp },
  });
});

exports.exportarMensajesXLSX = catchAsync(async (req, res, next) => {
  const { id_configuracion, fecha_inicio, fecha_fin } = req.body;

  // --- Construir query con filtros opcionales de fecha ---
  const replacements = [id_configuracion];
  let whereFechas = '';

  if (fecha_inicio) {
    whereFechas += ' AND mc.created_at >= ?';
    replacements.push(fecha_inicio);
  }
  if (fecha_fin) {
    whereFechas += ' AND mc.created_at <= ?';
    const fin = fecha_fin.length === 10 ? `${fecha_fin} 23:59:59` : fecha_fin;
    replacements.push(fin);
  }

  const sql = `
    SELECT
      mc.id                       AS id_mensaje,
      mc.source                   AS canal,
      mc.tipo_mensaje,
      CASE mc.rol_mensaje
         WHEN 0 THEN 'Cliente'
         WHEN 1 THEN 'Propietario'
         WHEN 3 THEN 'Notificacion (transferencia)'
         ELSE CONCAT('Otro (', mc.rol_mensaje, ')')
      END                         AS rol_mensaje,
      mc.texto_mensaje,
      mc.ruta_archivo,
      mc.template_name,
      mc.created_at               AS fecha_mensaje,
      mc.id_cliente               AS id_emisor,
      emisor.nombre_cliente       AS nombre_emisor,
      emisor.celular_cliente      AS celular_emisor,
      emisor.source               AS canal_emisor,
      mc.celular_recibe           AS id_receptor,
      receptor.nombre_cliente     AS nombre_receptor,
      receptor.celular_cliente    AS celular_receptor,
      conf.nombre_configuracion   AS nombre_conexion,
      conf.telefono               AS telefono_conexion
    FROM mensajes_clientes mc
    LEFT JOIN clientes_chat_center emisor   ON emisor.id = mc.id_cliente
    LEFT JOIN clientes_chat_center receptor ON receptor.id = mc.celular_recibe
    LEFT JOIN configuraciones conf          ON conf.id = mc.id_configuracion
    WHERE mc.id_configuracion = ?
      AND mc.deleted_at IS NULL
      ${whereFechas}
    ORDER BY mc.created_at DESC
  `;

  // --- Headers HTTP para descarga ---
  const nombreArchivo = `mensajes_config_${id_configuracion}_${Date.now()}.xlsx`;
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${nombreArchivo}"`,
  );

  // --- ExcelJS en modo STREAMING (no acumula en memoria) ---
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: res,
    useStyles: true,
  });

  const sheet = workbook.addWorksheet('Mensajes');

  // Definir columnas con ancho y encabezado
  sheet.columns = [
    { header: 'ID Mensaje', key: 'id_mensaje', width: 12 },
    { header: 'Canal', key: 'canal', width: 8 },
    { header: 'Tipo Mensaje', key: 'tipo_mensaje', width: 14 },
    { header: 'Rol', key: 'rol_mensaje', width: 16 },
    { header: 'Texto Mensaje', key: 'texto_mensaje', width: 50 },
    { header: 'Archivo', key: 'ruta_archivo', width: 40 },
    { header: 'Template', key: 'template_name', width: 20 },
    { header: 'Fecha Mensaje', key: 'fecha_mensaje', width: 20 },
    { header: 'ID Emisor', key: 'id_emisor', width: 12 },
    { header: 'Nombre Emisor', key: 'nombre_emisor', width: 28 },
    { header: 'Celular Emisor', key: 'celular_emisor', width: 16 },
    { header: 'Canal Emisor', key: 'canal_emisor', width: 10 },
    { header: 'ID Receptor', key: 'id_receptor', width: 12 },
    { header: 'Nombre Receptor', key: 'nombre_receptor', width: 28 },
    { header: 'Celular Receptor', key: 'celular_receptor', width: 16 },
    { header: 'Nombre Conexión', key: 'nombre_conexion', width: 30 },
    { header: 'Teléfono Conexión', key: 'telefono_conexion', width: 16 },
  ];

  // Estilo del encabezado
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF171931' }, // tu dark navy
    };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FF4F46E5' } },
    };
  });
  sheet.getRow(1).height = 28;

  // Commit del encabezado (lo envía al stream)
  sheet.getRow(1).commit();

  // --- Streaming por chunks ---
  const CHUNK_SIZE = 5000;
  let offset = 0;
  let hayMas = true;
  let filaNum = 2; // la 1 es el encabezado

  while (hayMas) {
    const [rows] = await db.query(
      `${sql} LIMIT ${CHUNK_SIZE} OFFSET ${offset}`,
      { replacements },
    );

    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      const fila = sheet.addRow({
        id_mensaje: row.id_mensaje,
        canal: row.canal,
        tipo_mensaje: row.tipo_mensaje,
        rol_mensaje: row.rol_mensaje,
        texto_mensaje: row.texto_mensaje || '',
        ruta_archivo: row.ruta_archivo || '',
        template_name: row.template_name || '',
        fecha_mensaje: row.fecha_mensaje,
        id_emisor: row.id_emisor,
        nombre_emisor: row.nombre_emisor || '',
        celular_emisor: row.celular_emisor || '',
        canal_emisor: row.canal_emisor || '',
        id_receptor: row.id_receptor,
        nombre_receptor: row.nombre_receptor || '',
        celular_receptor: row.celular_receptor || '',
        nombre_conexion: row.nombre_conexion || '',
        telefono_conexion: row.telefono_conexion || '',
      });

      // Zebra striping sutil
      if (filaNum % 2 === 0) {
        fila.eachCell((cell) => {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF8FAFC' }, // slate-50
          };
        });
      }

      fila.commit(); // ← CLAVE: libera la fila de memoria
      filaNum++;
    }

    offset += CHUNK_SIZE;
    if (rows.length < CHUNK_SIZE) hayMas = false;
  }

  // Finalizar y cerrar el stream
  sheet.commit();
  await workbook.commit();
});
