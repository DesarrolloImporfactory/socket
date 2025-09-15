const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const { db } = require('../database/config');
const axios = require('axios');
const OpenaiAssistants = require('../models/openai_assistants.model');
const {
  obtenerDatosClienteParaAssistant,
  informacionProductos,
  informacionProductosVinculado,
} = require('../utils/datosClienteAssistant');

exports.datosCliente = catchAsync(async (req, res, next) => {
  const { id_plataforma, telefono } = req.body;

  try {
    const datosCliente = await obtenerDatosClienteParaAssistant(
      id_plataforma,
      telefono
    );

    res.status(200).json({
      status: '200',
      data: datosCliente,
    });
  } catch (error) {
    return next(
      new AppError('Error al obtener datos del cliente para el assistant', 500)
    );
  }
});

exports.mensaje_assistant = catchAsync(async (req, res, next) => {
  const {
    mensaje,
    id_thread,
    id_plataforma,
    id_configuracion,
    telefono,
    api_key_openai,
    business_phone_id,
    accessToken,
  } = req.body;

  const assistants = await db.query(
    `SELECT assistant_id, tipo, productos, tiempo_remarketing, tomar_productos FROM openai_assistants WHERE id_configuracion = ? AND activo = 1`,
    {
      replacements: [id_configuracion],
      type: db.QueryTypes.SELECT,
    }
  );

  if (!assistants || assistants.length === 0) {
    res.status(400).json({
      status: 400,
      error: 'No se encontró un assistant válido para este contexto',
    });
  }

  let bloqueInfo = '';
  let tipoInfo = null;

  if (id_plataforma) {
    const datosCliente = await obtenerDatosClienteParaAssistant(
      id_plataforma,
      telefono
    );
    bloqueInfo = datosCliente.bloque || '';
    tipoInfo = datosCliente.tipo || null;
  }

  let assistant_id = null;
  let tipo_asistente = '';
  let tiempo_remarketing = null;

  if (tipoInfo === 'datos_guia') {
    const logistic = assistants.find(
      (a) => a.tipo.toLowerCase() === 'logistico'
    );
    assistant_id = logistic?.assistant_id;
    tipo_asistente = 'IA_logistica';
  } else if (tipoInfo === 'datos_pedido') {
    const sales = assistants.find((a) => a.tipo.toLowerCase() === 'ventas');
    assistant_id = sales?.assistant_id;

    tiempo_remarketing = sales?.tiempo_remarketing;
    tipo_asistente = 'IA_ventas';

    if (sales?.productos && Array.isArray(sales.productos)) {
      /* console.log('productos: ' + sales.productos); */

      if (sales?.tomar_productos == 'imporsuit') {
        bloqueInfo += await informacionProductosVinculado(sales.productos);
      } else {
        bloqueInfo += await informacionProductos(sales.productos);
      }
    }
  } else {
    const sales = assistants.find((a) => a.tipo.toLowerCase() === 'ventas');
    assistant_id = sales?.assistant_id;

    tiempo_remarketing = sales?.tiempo_remarketing;
    tipo_asistente = 'IA_ventas';

    if (sales?.productos && Array.isArray(sales.productos)) {
      /* console.log('productos: ' + sales.productos); */

      if (sales?.tomar_productos == 'imporsuit') {
        bloqueInfo += await informacionProductosVinculado(sales.productos);
      } else {
        bloqueInfo += await informacionProductos(sales.productos);
      }
    }
  }

  if (!assistant_id) {
    res.status(400).json({
      status: 400,
      error: 'No se encontró un assistant válido para este contexto',
    });
  }

  const headers = {
    Authorization: `Bearer ${api_key_openai}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };

  // Enviar contexto
  if (bloqueInfo) {
    await axios.post(
      `https://api.openai.com/v1/threads/${id_thread}/messages`,
      {
        role: 'user',
        content: `🧾 Información del cliente para usar como contexto:\n\n${bloqueInfo}`,
      },
      { headers }
    );
  }

  // Enviar mensaje del usuario
  await axios.post(
    `https://api.openai.com/v1/threads/${id_thread}/messages`,
    {
      role: 'user',
      content: mensaje,
    },
    { headers }
  );

  // Ejecutar assistant
  const run = await axios.post(
    `https://api.openai.com/v1/threads/${id_thread}/runs`,
    {
      assistant_id,
      max_completion_tokens: 200,
    },
    { headers }
  );

  const run_id = run.data.id;
  if (!run_id) {
    res.status(400).json({
      status: 400,
      error: 'No se pudo ejecutar el assistant.',
    });
  }

  // Esperar respuesta
  let status = 'queued';
  let intentos = 0;

  while (status !== 'completed' && status !== 'failed' && intentos < 20) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    intentos++;

    const statusRes = await axios.get(
      `https://api.openai.com/v1/threads/${id_thread}/runs/${run_id}`,
      { headers }
    );

    status = statusRes.data.status;
  }

  if (status === 'failed') {
    return res.status(400).json({
      status: 400,
      error: 'Falló la ejecución del assistant.',
    });
  }

  // Obtener respuesta final
  const messagesRes = await axios.get(
    `https://api.openai.com/v1/threads/${id_thread}/messages`,
    { headers }
  );

  const mensajes = messagesRes.data.data || [];
  const respuesta = mensajes
    .reverse()
    .find((msg) => msg.role === 'assistant' && msg.run_id === run_id)
    ?.content[0]?.text?.value;

  if (tiempo_remarketing && tiempo_remarketing > 0) {
    const tiempoDisparo = new Date(
      Date.now() + tiempo_remarketing * 60 * 60 * 1000
    );

    let existe = false;

    // 1. Buscar si ya existe un registro con mismo telefono, id_configuracion y mismo día de tiempo_disparo
    const rows = await db.query(
      `
    SELECT tiempo_disparo 
    FROM remarketing_pendientes 
    WHERE telefono = ? 
      AND id_configuracion = ?
      AND DATE(tiempo_disparo) = DATE(?)
    LIMIT 1
    `,
      {
        replacements: [telefono, id_configuracion, tiempoDisparo],
        type: db.QueryTypes.SELECT,
      }
    );

    // 2. Si ya existe, no insertamos
    if (rows.length > 0) {
      /* console.log(
        'Ya existe un remarketing para este día, no se inserta nada.'
      ); */
      existe = true;
    }

    // 3. Insertar si no existe
    if (!existe) {
      // 3. Insertar si no existe
      await db.query(
        `INSERT INTO remarketing_pendientes 
    (telefono, id_configuracion, business_phone_id, access_token, openai_token, assistant_id, mensaje, tipo_asistente, tiempo_disparo, id_thread) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        {
          replacements: [
            telefono,
            id_configuracion,
            business_phone_id,
            accessToken,
            api_key_openai,
            assistant_id,
            respuesta,
            tipo_asistente,
            tiempoDisparo,
            id_thread,
          ],
          type: db.QueryTypes.INSERT,
        }
      );
    }
  }

  res.status(200).json({
    status: 200,
    respuesta: respuesta || 'No se obtuvo respuesta del assistant.',
    tipo_asistente: tipo_asistente,
    bloqueInfo: bloqueInfo,
  });
});

/* Informacion de asistentes */
exports.info_asistentes = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;

  try {
    const [configuracion] = await db.query(
      'SELECT api_key_openai FROM configuraciones WHERE id = ?',
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      }
    );

    let api_key_openai = null;

    if (!configuracion) {
      return next(
        new AppError('No se encontró configuración para la plataforma', 400)
      );
    }

    api_key_openai = configuracion.api_key_openai;

    // Traer ambos tipos de asistentes
    const asistentes = await db.query(
      'SELECT * FROM openai_assistants WHERE id_configuracion = ? AND tipo IN ("logistico", "ventas")',
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      }
    );

    let logistico = null;
    let ventas = null;

    asistentes.forEach((asistente) => {
      if (asistente.tipo === 'logistico') {
        logistico = {
          id: asistente.id,
          nombre_bot: asistente.nombre_bot,
          assistant_id: asistente.assistant_id,
          activo: asistente.activo,
          prompt: asistente.prompt,
        };
      } else if (asistente.tipo === 'ventas') {
        ventas = {
          id: asistente.id,
          nombre_bot: asistente.nombre_bot,
          assistant_id: asistente.assistant_id,
          activo: asistente.activo,
          prompt: asistente.prompt,
          productos: asistente.productos,
          tomar_productos: asistente.tomar_productos,
          tiempo_remarketing: asistente.tiempo_remarketing,
        };
      }
    });

    return res.status(200).json({
      status: 200,
      data: {
        api_key_openai,
        logistico: logistico || {},
        ventas: ventas || {},
      },
    });
  } catch (error) {
    console.error('Error al buscar info_asistentes:', error);
    return res.status(500).json({
      status: 500,
      title: 'Error',
      message: 'Ocurrió un error al al buscar info_asistentes',
    });
  }
});

exports.actualizar_api_key_openai = catchAsync(async (req, res, next) => {
  const { id_configuracion, api_key } = req.body;

  try {
    const [result] = await db.query(
      `UPDATE configuraciones SET api_key_openai = ? WHERE id = ?`,
      {
        replacements: [api_key, id_configuracion],
        type: db.QueryTypes.UPDATE,
      }
    );

    res.status(200).json({
      status: '200',
      message: 'api key actualizado correctamente',
    });
  } catch (error) {
    return next(new AppError('Error al actualizar api_key_openai', 500));
  }
});

exports.actualizar_ia_logisctica = catchAsync(async (req, res, next) => {
  const { id_configuracion, nombre_bot, assistant_id, activo } = req.body;

  try {
    const [existe] = await db.query(
      `SELECT id FROM openai_assistants WHERE id_configuracion = ? AND tipo = "logistico"`,
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      }
    );

    if (existe) {
      // Ya existe, entonces actualiza
      await db.query(
        `UPDATE openai_assistants SET nombre_bot = ?, assistant_id = ?, activo = ? 
         WHERE id_configuracion = ? AND tipo = "logistico"`,
        {
          replacements: [nombre_bot, assistant_id, activo, id_configuracion],
          type: db.QueryTypes.UPDATE,
        }
      );
    } else {
      // No existe, entonces inserta
      await db.query(
        `INSERT INTO openai_assistants (id_configuracion, tipo, nombre_bot, assistant_id, activo) 
         VALUES (?, "logistico", ?, ?, ?)`,
        {
          replacements: [id_configuracion, nombre_bot, assistant_id, activo],
          type: db.QueryTypes.INSERT,
        }
      );
    }

    res.status(200).json({
      status: '200',
      message: 'Asistente logístico actualizado correctamente',
    });
  } catch (error) {
    console.error(error);
    return next(new AppError('Error al actualizar asistente logístico', 500));
  }
});

exports.actualizar_ia_ventas = catchAsync(async (req, res, next) => {
  const {
    id_configuracion,
    nombre_bot,
    assistant_id,
    activo,
    productos,
    tiempo_remarketing,
    tomar_productos,
  } = req.body;

  try {
    const productosJSON = JSON.stringify(productos);
    const [existe] = await db.query(
      `SELECT id FROM openai_assistants WHERE id_configuracion = ? AND tipo = "ventas"`,
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      }
    );

    /* hacer promt productos */
    let bloqueProductos = '';
    if (tomar_productos == 'imporsuit') {
      for (const id of productos) {
        const sqlProducto = `
          SELECT 
            p.nombre_producto AS nombre_producto,
            p.descripcion_producto AS descripcion_producto,
            ib.pvp AS precio_producto,
            p.image_path AS image_path,
            l.nombre_linea AS nombre_categoria
          FROM inventario_bodegas ib
          INNER JOIN productos p ON ib.id_producto = p.id_producto 
          INNER JOIN lineas l ON l.id_linea = p.id_linea_producto
          WHERE ib.id_inventario = ?
          LIMIT 1
        `;

        const [infoProducto] = await db.query(sqlProducto, {
          replacements: [id],
          type: db.QueryTypes.SELECT,
        });

        if (infoProducto) {
          bloqueProductos += `🛒 Producto: ${infoProducto.nombre_producto}\n`;
          bloqueProductos += `📃 Descripción: ${infoProducto.descripcion_producto}\n`;
          bloqueProductos += ` Precio: ${infoProducto.precio_producto}\n`;
          /* bloqueProductos += `🖼️ Imagen: ${infoProducto.image_path}\n\n`; */ // esta forma la incluye la url de la imagen como texto solido
          bloqueProductos += `[producto_imagen_url]: ${infoProducto.image_path}\n\n`; //esta forma sirve como recurso para el asistente (no visible para el cliente en el bloque)
          bloqueProductos += ` Categoría: ${infoProducto.nombre_categoria}\n`;
          bloqueProductos += `\n`;
        }
      }
    } else if (tomar_productos == 'chat_center') {
      for (const id of productos) {
        const sqlProducto = `
          SELECT 
            pc.nombre AS nombre_producto,
            pc.descripcion AS descripcion_producto,
            pc.tipo AS tipo,
            pc.precio AS precio_producto,
            pc.imagen_url AS image_path,
            pc.video_url AS video_path,
            cc.nombre AS nombre_categoria
          FROM productos_chat_center pc
          INNER JOIN categorias_chat_center cc ON cc.id = pc.id_categoria
          WHERE pc.id = ?
          LIMIT 1
        `;

        const [infoProducto] = await db.query(sqlProducto, {
          replacements: [id],
          type: db.QueryTypes.SELECT,
        });

        if (infoProducto) {
          bloqueProductos += `🛒 Producto: ${infoProducto.nombre_producto}\n`;
          bloqueProductos += `📃 Descripción: ${infoProducto.descripcion_producto}\n`;
          bloqueProductos += ` Precio: ${infoProducto.precio_producto}\n`;
          /* bloqueProductos += `🖼️ Imagen: ${infoProducto.image_path}\n\n`; */ // esta forma la incluye la url de la imagen como texto solido
          bloqueProductos += `[producto_imagen_url]: ${infoProducto.image_path}\n\n`; //esta forma sirve como recurso para el asistente (no visible para el cliente en el bloque)
          bloqueProductos += `[producto_video_url]: ${infoProducto.video_path}\n\n`; //esta forma sirve como recurso para el asistente (no visible para el cliente en el bloque)
          bloqueProductos += ` tipo: ${infoProducto.tipo}\n`;
          bloqueProductos += ` Categoría: ${infoProducto.nombre_categoria}\n`;
          bloqueProductos += `\n`;
        }
      }
    }

    /* hacer promt productos */

    if (existe) {
      // Ya existe, entonces actualiza
      await db.query(
        `UPDATE openai_assistants SET nombre_bot = ?, assistant_id = ?, activo = ?, productos = ?, bloque_productos = ?, tiempo_remarketing = ?
        , tomar_productos = ? 
         WHERE id_configuracion = ? AND tipo = "ventas"`,
        {
          replacements: [
            nombre_bot,
            assistant_id,
            activo,
            productosJSON,
            bloqueProductos,
            tiempo_remarketing,
            tomar_productos,
            id_configuracion,
          ],
          type: db.QueryTypes.UPDATE,
        }
      );
    } else {
      // No existe, entonces inserta
      await db.query(
        `INSERT INTO openai_assistants (id_configuracion, tipo, nombre_bot, assistant_id, activo, productos, bloque_productos = ?, tiempo_remarketing, tomar_productos) 
         VALUES (?, "ventas", ?, ?, ?, ?, ?, ?, ?)`,
        {
          replacements: [
            id_configuracion,
            nombre_bot,
            assistant_id,
            activo,
            productosJSON,
            bloqueProductos,
            tiempo_remarketing,
            tomar_productos,
          ],
          type: db.QueryTypes.INSERT,
        }
      );
    }

    res.status(200).json({
      status: '200',
      message: 'Asistente ventas actualizado correctamente',
    });
  } catch (error) {
    console.error(error);
    return next(new AppError('Error al actualizar asistente ventas', 500));
  }
});
