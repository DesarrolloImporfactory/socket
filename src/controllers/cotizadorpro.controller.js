const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const Clientes_chat_center = require('../models/clientes_chat_center.model');
const MensajesClientes = require('../models/mensaje_cliente.model');
const User = require('../models/user.model');
const Plaforma = require('../models/plataforma.model');
const { Op } = require('sequelize');
const {
  normalizePhoneNumber,
  generatePhoneVariations,
} = require('../utils/phoneUtils');
const UsuarioPlataforma = require('../models/usuario_plataforma.model');
const { db_2 } = require('../database/config');
const axios = require('axios');
const FormData = require('form-data');
const { promisify } = require('util');
const { exec } = require('child_process');
const execAsync = promisify(exec);
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { formatPhoneForWhatsApp } = require('../utils/phoneUtils');
const { text } = require('express');
const { language } = require('googleapis/build/src/apis/language');
const CotizadorproCotizaciones = require('../models/cotizadorpro/cotizadorpro_cotizaciones.model');
const { extraerTokenDeCabecera } = require('../utils/jwt');

// Helper: Formatear fecha a dd/mm/yyyy
const formatearFecha = (fecha) => {
  try {
    let date;

    // Si es un timestamp Unix (número o string numérico)
    if (!isNaN(fecha) && String(fecha).length === 10) {
      date = new Date(Number(fecha) * 1000);
    } else if (!isNaN(fecha) && String(fecha).length === 13) {
      date = new Date(Number(fecha));
    } else {
      // Intentar parsear como fecha
      date = new Date(fecha);
    }

    if (isNaN(date.getTime())) {
      return fecha; // Retornar original si no se puede parsear
    }

    const dia = String(date.getDate()).padStart(2, '0');
    const mes = String(date.getMonth() + 1).padStart(2, '0');
    const anio = date.getFullYear();

    return `${dia}/${mes}/${anio}`;
  } catch (error) {
    console.error('[FORMAT_FECHA] Error al formatear:', error);
    return fecha; // Retornar original si hay error
  }
};

// Constantes para Cotizador Pro
const COTIZADOR_CONFIG = {
  ID_CONFIGURACION: 265,
  ID_CLIENTE: 188243,
  UID_CLIENTE: process.env.CONFIGURACION_WS,
  RESPONSABLE: 'Automatizador | Cotizador Pro',
  BASE_URL: 'https://new.imporsuitpro.com/cotizadorpro',
};

// Helper: Crear plantilla de WhatsApp
// headerMedia: { type: 'video'|'image'|'audio'|'document', link?: string, id?: string } | null
const crearPlantillaWhatsApp = (
  celularFormateado,
  templateName,
  nombreCliente,
  idCotizacion,
  headerMedia = null,
) => {
  const components = [];

  // Header con media (video, imagen, audio, documento)
  if (headerMedia) {
    const mediaPayload = headerMedia.id
      ? { id: headerMedia.id }
      : { link: headerMedia.link };

    components.push({
      type: 'header',
      parameters: [
        {
          type: headerMedia.type,
          [headerMedia.type]: mediaPayload,
        },
      ],
    });
  }

  // Body: nombre del cliente (opcional — si es null no se mandan parámetros)
  if (nombreCliente) {
    components.push({
      type: 'body',
      parameters: [
        {
          type: 'text',
          text: nombreCliente,
        },
      ],
    });
  }

  // Botón URL con id_cotizacion
  components.push({
    type: 'button',
    sub_type: 'url',
    index: '0',
    parameters: [
      {
        type: 'text',
        text: idCotizacion,
      },
    ],
  });

  return {
    messaging_product: 'whatsapp',
    to: celularFormateado,
    type: 'template',
    template: {
      name: templateName,
      language: {
        code: 'es',
      },
      components,
    },
  };
};

// Helper: Enviar template de WhatsApp
const enviarTemplateWhatsApp = async (plantilla) => {
  const response = await axios.post(
    `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${process.env.CONFIGURACION_WS}/messages`,
    plantilla,
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.FB_PROVIDER_TOKEN}`,
      },
      params: { debug: 'all' },
      validateStatus: () => true, // no lanzar excepcion, manejar todos los status
    },
  );
  if (response.data.__debug) {
    console.log('[WA_TEMPLATE] Debug info de Meta:', JSON.stringify(response.data.__debug));
  }


  if (response.status < 200 || response.status >= 300) {
    console.error(
      '[WA_TEMPLATE] Error de Meta %d | template: %s | payload: %s | respuesta: %s',
      response.status,
      plantilla?.template?.name,
      JSON.stringify(plantilla, null, 2),
      JSON.stringify(response.data, null, 2),
    );
    const metaMsg =
      response.data?.error?.message || JSON.stringify(response.data);
    const err = new Error(`Meta ${response.status}: ${metaMsg}`);
    err.metaError = response.data?.error;
    err.statusCode = response.status;
    throw err;
  }

  return response.data;
};

// Helper: Crear mensaje en base de datos
const crearMensajeBD = async (
  idChat,
  celularFormateado,
  midMensaje,
  textoMensaje,
  rutaArchivo,
  templateName,
) => {
  return await MensajesClientes.create({
    id_configuracion: COTIZADOR_CONFIG.ID_CONFIGURACION,
    id_cliente: COTIZADOR_CONFIG.ID_CLIENTE,
    source: 'wa',
    mid_mensaje: COTIZADOR_CONFIG.UID_CLIENTE,
    tipo_mensaje: 'template',
    rol_mensaje: 1,
    celular_recibe: idChat.toString(),
    responsable: COTIZADOR_CONFIG.RESPONSABLE,
    uid_whatsapp: celularFormateado,
    id_wamid_mensaje: midMensaje,
    texto_mensaje: textoMensaje,
    ruta_archivo: rutaArchivo,
    visto: false,
    language: 'es',
    template_name: templateName,
  });
};

// Helper: Generar datos del mensaje
// headerMedia: { type, fileUrl?, id?, link? } | null — se almacena en ruta_archivo para el historial
const generarDatosMensaje = (
  templateName,
  nombreCliente,
  idCotizacion,
  headerMedia = null,
) => {
  const templates = {
    cotizacion_carga_enviadav2: {
      texto: `Hola Importador {{1}}, con gusto le envío la cotización que nos solicitó. 😊\nPor favor recuerde que, en la parte superior, encontrará los gastos referentes a su compra y, en la parte inferior, el detalle del precio al que llegarán sus productos al destino.`,
      url: `${COTIZADOR_CONFIG.BASE_URL}/visualizarCotizacion/${idCotizacion}`,
    },
    confirmacion_cotizacionv2: {
      texto: `Hola Importador {{1}}.\nPara continuar, por favor confirme la cotización haciendo clic en el botón ACEPTAR COTIZACIÓN.\n\nSi tiene algunas dudas estoy aqui para resolverlas. 😊`,
      url: `${COTIZADOR_CONFIG.BASE_URL}/aceptarCotizacion/${idCotizacion}`,
    },
    cotizacion_carga_enviada_pro: {
      texto: `🎉 ¡Hola {{1}}! Te comparto la cotización que nos solicitaste. 😊\nPor favor recuerda que, en la parte superior, encontrarás los gastos referentes a tu compra y en la parte inferior, el detalle del precio al que llegarán tus productos al destino.`,
      url: `${COTIZADOR_CONFIG.BASE_URL}/visualizarCotizacion/${idCotizacion}`,
    },
    confirmacion_cotizacion_pro: {
      texto: `👉 Para continuar, por favor confirma la aceptación de la cotización haciendo clic en el siguiente enlace.\n\nSi tienes alguna duda estoy aquí para ayudarte. 😊`,
      url: `${COTIZADOR_CONFIG.BASE_URL}/aceptarCotizacion/${idCotizacion}`,
    },
  };

  const template = templates[templateName];

  // placeholders: confirmacion_cotizacion_pro no lleva nombre (sin body con {{1}})
  const placeholders = nombreCliente
    ? { 1: nombreCliente, url_0_1: idCotizacion, url_full_0_1: template.url }
    : { url_0_1: idCotizacion, url_full_0_1: template.url };

  const rutaArchivo = JSON.stringify({
    placeholders,
    header: headerMedia
      ? {
          format: headerMedia.type.toUpperCase(),
          value: '',
          fileUrl: headerMedia.fileUrl || null,
          meta_media_id: headerMedia.id || null,
          mime: null,
          size: null,
        }
      : null,
    template_name: templateName,
    language: 'es',
  });

  return {
    texto: template.texto,
    rutaArchivo,
  };
};

// Helper: Convertir video a formato WhatsApp
const convertVideoForWhatsApp = async (
  fileBuffer,
  originalName,
  targetSizeMB = 15,
) => {
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `input-${Date.now()}-${originalName}`);
  const outputPath = path.join(tempDir, `output-${Date.now()}.mp4`);

  try {
    await fs.writeFile(inputPath, fileBuffer);

    try {
      await execAsync('ffmpeg -version');
    } catch (e) {
      console.warn(
        '[VIDEO_CONVERT] FFmpeg no disponible. Usando video original.',
      );
      throw new Error('FFmpeg no está instalado en el servidor');
    }

    // 1) Obtener duración con ffprobe para calcular bitrate dinámico
    let duration = 60; // fallback 60s
    try {
      const probe = await execAsync(
        `ffprobe -v error -select_streams v:0 -show_entries format=duration -of csv=p=0 "${inputPath}"`,
      );
      const parsed = parseFloat(probe.stdout.trim());
      if (parsed > 0) duration = parsed;
    } catch (_) {}

    // 2) Calcular bitrate dinámico según targetSizeMB
    const MAX_BYTES = targetSizeMB * 1024 * 1024;
    const AUDIO_KBPS = 96;
    const totalKbps = Math.floor((MAX_BYTES * 8) / duration / 1000);
    const videoKbps = Math.max(100, totalKbps - AUDIO_KBPS);

  

    // Helper interno: construye el comando ffmpeg con los parámetros dados
    // - Escala manteniendo aspect ratio al máximo maxW x maxH
    // - Redondea ancho/alto a número par (libx264 lo exige)
    const buildCmd = (vKbps, maxW, maxH, aKbps) =>
      [
        `ffmpeg -i "${inputPath}"`,
        `-f lavfi -i anullsrc=r=44100:cl=mono`,
        `-c:v libx264 -preset ultrafast`,
        `-vf "scale='min(${maxW},iw)':'min(${maxH},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2"`,
        `-b:v ${vKbps}k -maxrate ${Math.floor(vKbps * 1.5)}k -bufsize ${vKbps * 2}k`,
        `-filter_complex "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0[aout]"`,
        `-map 0:v -map "[aout]"`,
        `-c:a aac -b:a ${aKbps}k -ar 44100 -ac 1`,
        `-movflags +faststart -y "${outputPath}"`,
      ].join(' ');

    // 3) Intento 1 — 720p, bitrate calculado
    await execAsync(buildCmd(videoKbps, 1280, 720, AUDIO_KBPS), {
      maxBuffer: 50 * 1024 * 1024,
    });
    let statOut = await fs.stat(outputPath);
  
    // 4) Intento 2 — 480p, bitrate reducido al 55%, audio 64k
    if (statOut.size > MAX_BYTES) {
      const vKbps2 = Math.max(80, Math.floor(videoKbps * 0.55));
      console.warn(
        `[VIDEO_CONVERT] Supera límite → compresión agresiva 480p (${vKbps2}k)...`,
      );
      await execAsync(buildCmd(vKbps2, 854, 480, 64), {
        maxBuffer: 50 * 1024 * 1024,
      });
      statOut = await fs.stat(outputPath);
    
    }

    // 5) Intento 3 — 360p, bitrate mínimo, audio 48k
    if (statOut.size > MAX_BYTES) {
      const vKbps3 = Math.max(
        60,
        Math.floor(((MAX_BYTES * 8) / duration / 1000) * 0.8 - 48),
      );
      console.warn(
        `[VIDEO_CONVERT] Aún supera límite → compresión máxima 360p (${vKbps3}k)...`,
      );
      await execAsync(buildCmd(vKbps3, 640, 360, 48), {
        maxBuffer: 50 * 1024 * 1024,
      });
      statOut = await fs.stat(outputPath);
     
    }

    // 6) Si aún supera, lanzar error (no tiene sentido subir algo que Meta rechazará)
    if (statOut.size > MAX_BYTES) {
      const finalMB = (statOut.size / (1024 * 1024)).toFixed(2);
      const err = new Error(
        `El video pesa demasiado (${finalMB}MB) y no fue posible comprimirlo por debajo de ${targetSizeMB}MB. Enviá un video más corto o de menor resolución.`,
      );
      err.isOversized = true;
      throw err;
    }

    const convertedBuffer = await fs.readFile(outputPath);
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});

    return convertedBuffer;
  } catch (err) {
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});

    console.error('[VIDEO_CONVERT] Error:', err.message);
    throw err;
  }
};

// Helper: Subir video a Meta
const uploadVideoToMeta = async (fileBuffer, fileName) => {
  const mediaUrl = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${process.env.CONFIGURACION_WS}/media`;


  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'video/mp4');
  form.append('file', fileBuffer, {
    filename: fileName,
    contentType: 'video/mp4',
  });

  const mediaResp = await axios.post(mediaUrl, form, {
    headers: {
      Authorization: `Bearer ${process.env.FB_PROVIDER_TOKEN}`,
      ...form.getHeaders(),
    },
    params: { debug: 'all' },
    timeout: 60000,
    validateStatus: () => true,
  });

  if(mediaResp.data.__debug) {
    console.log('[UPLOAD_META] Debug info de Meta:', JSON.stringify(mediaResp.data.__debug));
  }

  if (
    mediaResp.status < 200 ||
    mediaResp.status >= 300 ||
    mediaResp.data?.error
  ) {
    console.error('[UPLOAD_META] Error:', mediaResp.data);
    throw new Error('Meta rechazó la subida de video');
  }

  const mediaId = mediaResp.data?.id;
  if (!mediaId) {
    console.error('[UPLOAD_META] Sin mediaId:', mediaResp.data);
    throw new Error('Respuesta de Meta sin mediaId');
  }

  return mediaId;
};

exports.obtenerCotizaciones = catchAsync(async (req, res, next) => {
  const { id_chat } = req.params;

  if (!id_chat) {
    return next(new AppError('id_chat es requerido', 400));
  }

  const cliente = await Clientes_chat_center.findOne({
    where: { id: id_chat },
  });

  if (!cliente) {
    return next(new AppError('Cliente no encontrado', 404));
  }

  const celular = cliente.celular_cliente;

  // Normalizar el número de teléfono
  const phoneInfo = normalizePhoneNumber(celular, '593'); // '593' es Ecuador por defecto

  // Generar variaciones del número para búsqueda flexible
  const phoneVariations = generatePhoneVariations(celular, '593');

  // Buscar plataformas usando las variaciones del número
  const plataforma = await Plaforma.findAll({
    where: {
      [Op.or]: phoneVariations.map((variation) => ({
        whatsapp: { [Op.like]: `%${variation}%` },
      })),
    },
    order: [['id_plataforma', 'ASC']],
  });

  // poner todos los id_plataforma en un array
  const plataformaIds = plataforma.map((p) => p.id_plataforma);

  const usuarioPlataformas = await UsuarioPlataforma.findAll({
    where: {
      id_plataforma: {
        [Op.in]: plataformaIds,
      },
    },
  });

  //poner todo los id_usuario en un array
  const usuarioIds = usuarioPlataformas.map((up) => up.id_usuario);

  //buscar cotizaciones de esos usuarios
  const cotizaciones = await db_2.query(
    `
        SELECT 
                    c.id_cotizacion,
                    c.fecha_creacion,
                    c.estado,
                    c.subestado,
                    c.fecha_recibida,
                    d.pais_origen,
                    d.pais_destino,
                    COUNT(pc.id_producto_cot) AS total_productos,
                    SUM(pc.cant) AS total_cantidad,
                    COUNT(DISTINCT pc.id_proveedor) AS total_proveedores,
                    u.nombre_users as cliente,
                    a.nombre_users as asesor
                FROM cotizadorpro_cotizaciones c
                LEFT JOIN cotizadorpro_detalle_cot d ON c.id_cotizacion = d.id_cotizacion
                LEFT JOIN cotizadorpro_productos_cot pc ON c.id_cotizacion = pc.id_cotizacion
                LEFT JOIN users u ON d.id_users = u.id_users
                LEFT JOIN users a ON c.id_asesor = a.id_users
                WHERE d.id_users IN (${usuarioIds.join(',')})
                GROUP BY c.id_cotizacion
                ORDER BY c.fecha_creacion DESC
        `,
    { type: db_2.QueryTypes.SELECT },
  );

  res.status(200).json({
    status: '200',
    title: 'Petición exitosa',
    message: 'Cotizaciones obtenidas correctamente',
    cotizaciones: cotizaciones ? cotizaciones : [],
  });
});

exports.enviarCotizacion = catchAsync(async (req, res, next) => {
  const token = extraerTokenDeCabecera(req);

  const { id_cotizacion } = req.body;


  if (!id_cotizacion) {
    return next(new AppError('id_cotizacion es requerido', 400));
  }

  // Obtener información de la cotización
  const resultado = await db_2.query(
    `
        SELECT 
            c.id_cotizacion,
            d.pais_origen,
            d.pais_destino,
            u.nombre_users AS cliente,
            p.whatsapp AS celular_cliente,
            p.email AS email_cliente
        FROM cotizadorpro_cotizaciones c
        JOIN cotizadorpro_detalle_cot d ON c.id_cotizacion = d.id_cotizacion
        JOIN users u ON d.id_users = u.id_users
        JOIN usuario_plataforma up ON u.id_users = up.id_usuario
        JOIN plataformas p ON up.id_plataforma = p.id_plataforma
        WHERE c.id_cotizacion = ?
    `,
    {
      replacements: [id_cotizacion],
      type: db_2.QueryTypes.SELECT,
    },
  );

  if (resultado.length === 0) {
    return next(new AppError('Cotización no encontrada', 404));
  }

  const cotizacionInfo = resultado[0];
  const celularFormateado = formatPhoneForWhatsApp(
    cotizacionInfo.celular_cliente,
    '593',
  );

  // Crear y enviar las dos plantillas de WhatsApp
  // plantilla1: descargar video predeterminado → convertir → subir a Meta → header con mediaId
  const VIDEO_DEFAULT_URL =
    'https://new.imporsuitpro.com/Videos/stream/e750c4d548eb6e828b2ece6bc0639649';

  let videoMediaId = null;
  try {
    const videoResp = await axios.get(VIDEO_DEFAULT_URL, {
      responseType: 'arraybuffer',
      timeout: 60000,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    let videoBuffer = Buffer.from(videoResp.data);
    const videoOriginalSizeMB = videoBuffer.length / (1024 * 1024);
  
    try {
      videoBuffer = await convertVideoForWhatsApp(
        videoBuffer,
        'cotizacion-header.mp4',
      );
    } catch (convErr) {
      if (convErr.isOversized || videoOriginalSizeMB > 15) {
        console.error(
          '[COTIZACION_VIDEO] Video demasiado pesado:',
          convErr.message,
        );
        throw convErr.isOversized
          ? convErr
          : new Error(
              `El video pesa ${videoOriginalSizeMB.toFixed(2)}MB y no se pudo comprimir por debajo de 15MB. Enviá un video más corto o de menor resolución.`,
            );
      }
      console.warn(
        '[COTIZACION_VIDEO] Conversión fallida, usando original:',
        convErr.message,
      );
    }

    videoMediaId = await uploadVideoToMeta(
      videoBuffer,
      'cotizacion-header.mp4',
    );
   
  } catch (videoErr) {
    console.error(
      '[COTIZACION_VIDEO] Error procesando video:',
      videoErr.message,
    );
    return next(
      new AppError('Error al preparar el video de la cotización', 500),
    );
  }

  const VIDEO_COTIZACION_HEADER = {
    type: 'video',
    id: videoMediaId,
    fileUrl: VIDEO_DEFAULT_URL,
  };

  const plantilla1 = crearPlantillaWhatsApp(
    celularFormateado,
    'cotizacion_carga_enviada_pro',
    cotizacionInfo.cliente,
    id_cotizacion,
    VIDEO_COTIZACION_HEADER,
  );

  const plantilla2 = crearPlantillaWhatsApp(
    celularFormateado,
    'confirmacion_cotizacion_pro',
    null, // sin body, solo botón
    id_cotizacion,
  );

  let response1;
  try {
    response1 = await enviarTemplateWhatsApp(plantilla1);
  } catch (p1Err) {
    console.error(
      '[COTIZACION_P1] Fallo:',
      p1Err.message,
      '| Meta error:',
      JSON.stringify(p1Err.metaError),
    );
    return next(
      new AppError(`Error plantilla cotizacion: ${p1Err.message}`, 500),
    );
  }

  // Esperar antes de enviar la segunda plantilla para garantizar el orden de entrega en WhatsApp
  await new Promise((resolve) => setTimeout(resolve, 2000));

  let response2;
  try {
    response2 = await enviarTemplateWhatsApp(plantilla2);
  } catch (p2Err) {
    console.error(
      '[COTIZACION_P2] Fallo:',
      p2Err.message,
      '| Meta error:',
      JSON.stringify(p2Err.metaError),
    );
    return next(
      new AppError(`Error plantilla confirmacion: ${p2Err.message}`, 500),
    );
  }

  // Extraer IDs de mensajes
  const midMensaje1 = response1?.messages?.[0]?.id || null;
  const midMensaje2 = response2?.messages?.[0]?.id || null;

  // Verificar si el primer mensaje fue aceptado
  if (
    !response1?.messages?.[0]?.message_status ||
    response1.messages[0].message_status !== 'accepted'
  ) {
    return next(new AppError('Error al enviar mensaje de WhatsApp', 500));
  }

  // Buscar o crear el chat
  let chatId = null;
  const foundChat = await Clientes_chat_center.findOne({
    where: {
      celular_cliente: {
        [Op.like]: `%${celularFormateado}%`,
      },
      id_configuracion: COTIZADOR_CONFIG.ID_CONFIGURACION,
    },
  });

  if (foundChat) {
    chatId = foundChat.id;
  } else {
    // Crear nuevo chat
    const nuevoChat = await Clientes_chat_center.create({
      id_configuracion: COTIZADOR_CONFIG.ID_CONFIGURACION,
      nombre_cliente: cotizacionInfo.cliente,
      celular_cliente: celularFormateado,
      uid_cliente: COTIZADOR_CONFIG.UID_CLIENTE,
      email_cliente: cotizacionInfo.email_cliente,
      estado_cliente: 1,
      chat_cerrado: false,
    });

    chatId = nuevoChat.id;
  }

  // Crear mensajes en la base de datos usando helpers
  const mensaje1Data = generarDatosMensaje(
    'cotizacion_carga_enviada_pro',
    cotizacionInfo.cliente,
    id_cotizacion,
    VIDEO_COTIZACION_HEADER,
  );

  const mensaje1 = await crearMensajeBD(
    chatId,
    celularFormateado,
    midMensaje1,
    mensaje1Data.texto,
    mensaje1Data.rutaArchivo,
    'cotizacion_carga_enviada_pro',
  );

  const mensaje2Data = generarDatosMensaje(
    'confirmacion_cotizacion_pro',
    cotizacionInfo.cliente,
    id_cotizacion,
  );

  const mensaje2 = await crearMensajeBD(
    chatId,
    celularFormateado,
    midMensaje2,
    mensaje2Data.texto,
    mensaje2Data.rutaArchivo,
    'confirmacion_cotizacion_pro',
  );

  // Actualizar estado de la cotización
  await db_2.query(
    `
        UPDATE cotizadorpro_cotizaciones 
        SET estado = 'generado'
        WHERE id_cotizacion = ?
    `,
    {
      replacements: [id_cotizacion],
      type: db_2.QueryTypes.UPDATE,
    },
  );

  res.status(200).json({
    status: 200,
    title: 'Petición exitosa',
    message: 'Cotización enviada correctamente',
    cotizacion: cotizacionInfo,
  });
});

exports.reenviarCotizacion = catchAsync(async (req, res, next) => {
  const token = extraerTokenDeCabecera(req);

  const { id_cotizacion } = req.body;

  if (!id_cotizacion) {
    return next(new AppError('id_cotizacion es requerido', 400));
  }

  const resultado = await db_2.query(
    `
        SELECT 
            c.id_cotizacion,
            d.pais_origen,
            d.pais_destino,
            u.nombre_users AS cliente,
            p.whatsapp AS celular_cliente,
            p.email AS email_cliente
        FROM cotizadorpro_cotizaciones c
        JOIN cotizadorpro_detalle_cot d ON c.id_cotizacion = d.id_cotizacion
        JOIN users u ON d.id_users = u.id_users
        JOIN usuario_plataforma up ON u.id_users = up.id_usuario
        JOIN plataformas p ON up.id_plataforma = p.id_plataforma
        WHERE c.id_cotizacion = ?
    `,
    {
      replacements: [id_cotizacion],
      type: db_2.QueryTypes.SELECT,
    },
  );

  if (resultado.length === 0) {
    return next(new AppError('Cotización no encontrada', 404));
  }

  const cotizacionInfo = resultado[0];
  const celularFormateado = formatPhoneForWhatsApp(
    cotizacionInfo.celular_cliente,
    '593',
  );

  const VIDEO_DEFAULT_URL =
    'https://new.imporsuitpro.com/Videos/stream/e750c4d548eb6e828b2ece6bc0639649';

  let videoMediaId = null;
  try {
    const videoResp = await axios.get(VIDEO_DEFAULT_URL, {
      responseType: 'arraybuffer',
      timeout: 60000,
      headers: { Authorization: `Bearer ${token}` },
    });
    let videoBuffer = Buffer.from(videoResp.data);
    const videoOriginalSizeMB = videoBuffer.length / (1024 * 1024);

    try {
      videoBuffer = await convertVideoForWhatsApp(
        videoBuffer,
        'cotizacion-header.mp4',
      );
    } catch (convErr) {
      if (convErr.isOversized || videoOriginalSizeMB > 15) {
        throw convErr.isOversized
          ? convErr
          : new Error(
              `El video pesa ${videoOriginalSizeMB.toFixed(2)}MB y no se pudo comprimir por debajo de 15MB.`,
            );
      }
      console.warn(
        '[REENVIO_VIDEO] Conversión fallida, usando original:',
        convErr.message,
      );
    }

    videoMediaId = await uploadVideoToMeta(
      videoBuffer,
      'cotizacion-header.mp4',
    );
  } catch (videoErr) {
    console.error('[REENVIO_VIDEO] Error procesando video:', videoErr.message);
    return next(
      new AppError('Error al preparar el video de la cotización', 500),
    );
  }

  const VIDEO_COTIZACION_HEADER = {
    type: 'video',
    id: videoMediaId,
    fileUrl: VIDEO_DEFAULT_URL,
  };

  const plantilla1 = crearPlantillaWhatsApp(
    celularFormateado,
    'cotizacion_carga_enviada_pro',
    cotizacionInfo.cliente,
    id_cotizacion,
    VIDEO_COTIZACION_HEADER,
  );

  const plantilla2 = crearPlantillaWhatsApp(
    celularFormateado,
    'confirmacion_cotizacion_pro',
    null,
    id_cotizacion,
  );

  let response1;
  try {
    response1 = await enviarTemplateWhatsApp(plantilla1);
  } catch (p1Err) {
    console.error('[REENVIO_P1] Fallo:', p1Err.message);
    return next(
      new AppError(`Error plantilla cotizacion: ${p1Err.message}`, 500),
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));

  let response2;
  try {
    response2 = await enviarTemplateWhatsApp(plantilla2);
  } catch (p2Err) {
    console.error('[REENVIO_P2] Fallo:', p2Err.message);
    return next(
      new AppError(`Error plantilla confirmacion: ${p2Err.message}`, 500),
    );
  }

  const midMensaje1 = response1?.messages?.[0]?.id || null;
  const midMensaje2 = response2?.messages?.[0]?.id || null;

  if (
    !response1?.messages?.[0]?.message_status ||
    response1.messages[0].message_status !== 'accepted'
  ) {
    return next(new AppError('Error al enviar mensaje de WhatsApp', 500));
  }

  let chatId = null;
  const foundChat = await Clientes_chat_center.findOne({
    where: {
      celular_cliente: { [Op.like]: `%${celularFormateado}%` },
      id_configuracion: COTIZADOR_CONFIG.ID_CONFIGURACION,
    },
  });

  if (foundChat) {
    chatId = foundChat.id;
  } else {
    const nuevoChat = await Clientes_chat_center.create({
      id_configuracion: COTIZADOR_CONFIG.ID_CONFIGURACION,
      nombre_cliente: cotizacionInfo.cliente,
      celular_cliente: celularFormateado,
      uid_cliente: COTIZADOR_CONFIG.UID_CLIENTE,
      email_cliente: cotizacionInfo.email_cliente,
      estado_cliente: 1,
      chat_cerrado: false,
    });
    chatId = nuevoChat.id;
  }

  const mensaje1Data = generarDatosMensaje(
    'cotizacion_carga_enviada_pro',
    cotizacionInfo.cliente,
    id_cotizacion,
    VIDEO_COTIZACION_HEADER,
  );

  await crearMensajeBD(
    chatId,
    celularFormateado,
    midMensaje1,
    mensaje1Data.texto,
    mensaje1Data.rutaArchivo,
    'cotizacion_carga_enviada_pro',
  );

  const mensaje2Data = generarDatosMensaje(
    'confirmacion_cotizacion_pro',
    cotizacionInfo.cliente,
    id_cotizacion,
  );

  await crearMensajeBD(
    chatId,
    celularFormateado,
    midMensaje2,
    mensaje2Data.texto,
    mensaje2Data.rutaArchivo,
    'confirmacion_cotizacion_pro',
  );

  res.status(200).json({
    status: 200,
    title: 'Petición exitosa',
    message: 'Cotización reenviada correctamente',
    cotizacion: cotizacionInfo,
  });
});

exports.enviarFechaEstimada = catchAsync(async (req, res, next) => {
  const { id_cotizacion, fecha_estimada } = req.body;

  if (!id_cotizacion) {
    return next(new AppError('id_cotizacion es requerido', 400));
  }

  if (!fecha_estimada) {
    return next(new AppError('fecha_estimada es requerida', 400));
  }

  // Obtener información del cliente desde la cotización
  const resultado = await db_2.query(
    `
    SELECT 
      u.nombre_users AS cliente,
      p.whatsapp AS celular_cliente,
      p.email AS email_cliente
    FROM cotizadorpro_cotizaciones c
    JOIN cotizadorpro_detalle_cot d ON c.id_cotizacion = d.id_cotizacion
    JOIN users u ON d.id_users = u.id_users
    JOIN usuario_plataforma up ON u.id_users = up.id_usuario
    JOIN plataformas p ON up.id_plataforma = p.id_plataforma
    WHERE c.id_cotizacion = ?
    LIMIT 1
    `,
    {
      replacements: [id_cotizacion],
      type: db_2.QueryTypes.SELECT,
    },
  );

  if (resultado.length === 0) {
    return next(new AppError('Cotización no encontrada', 404));
  }

  const clienteInfo = resultado[0];
  const celularFormateado = formatPhoneForWhatsApp(
    clienteInfo.celular_cliente,
    '593',
  );

  // Formatear la fecha a dd/mm/yyyy
  const fechaFormateada = formatearFecha(fecha_estimada);
  

  // Crear template con nombre y fecha
  const templateFecha = {
    messaging_product: 'whatsapp',
    to: celularFormateado,
    type: 'template',
    template: {
      name: 'fecha_de_llegada_a_bodega',
      language: {
        code: 'es',
      },
      components: [
        {
          type: 'body',
          parameters: [
            {
              type: 'text',
              text: clienteInfo.cliente,
            },
            {
              type: 'text',
              text: fechaFormateada,
            },
          ],
        },
      ],
    },
  };

  // Enviar template
  let response;
  try {
    response = await enviarTemplateWhatsApp(templateFecha);
  } catch (err) {
    console.error('[FECHA_EST] Error al enviar template:', err.message);
    return next(new AppError('Error al enviar mensaje de WhatsApp', 500));
  }

  const midMensaje = response?.messages?.[0]?.id || null;

  if (
    !response?.messages?.[0]?.message_status ||
    response.messages[0].message_status !== 'accepted'
  ) {
    return next(new AppError('WhatsApp no aceptó el mensaje', 500));
  }

  // Buscar o crear chat
  let chatId = null;
  const foundChat = await Clientes_chat_center.findOne({
    where: {
      celular_cliente: {
        [Op.like]: `%${celularFormateado}%`,
      },
      id_configuracion: COTIZADOR_CONFIG.ID_CONFIGURACION,
    },
  });

  if (foundChat) {
    chatId = foundChat.id;
  } else {
    const nuevoChat = await Clientes_chat_center.create({
      id_configuracion: COTIZADOR_CONFIG.ID_CONFIGURACION,
      nombre_cliente: clienteInfo.cliente,
      celular_cliente: celularFormateado,
      uid_cliente: COTIZADOR_CONFIG.UID_CLIENTE,
      email_cliente: clienteInfo.email_cliente,
      estado_cliente: 1,
      chat_cerrado: false,
    });
    chatId = nuevoChat.id;
  }

  // Registrar mensaje en BD
  const rutaArchivo = JSON.stringify({
    placeholders: {
      1: clienteInfo.cliente,
      2: fechaFormateada,
    },
    header: null,
    template_name: 'fecha_de_llegada_a_bodega',
    language: 'es',
    id_cotizacion: id_cotizacion,
  });

  const textoMensaje = `🎉 ¡Hola {{1}}! Según la actualización logística disponible, la fecha estimada de llegada de tu carga a nuestra bodega es: {{2}}
Al momento de la recepción, compartiremos un video de verificación.`;

  const mensajeRegistrado = await crearMensajeBD(
    chatId,
    celularFormateado,
    midMensaje,
    textoMensaje,
    rutaArchivo,
    'fecha_estimada_de_llegada',
  );

  res.status(200).json({
    status: 200,
    success: true,
    title: 'Fecha enviada',
    message: 'Fecha estimada enviada correctamente',
    data: {
      wamid: midMensaje,
      chatId: chatId,
      celular: celularFormateado,
      nombreCliente: clienteInfo.cliente,
      fecha_estimada: fecha_estimada,
      mensaje_id: mensajeRegistrado.id,
    },
  });
});

exports.enviarVideoCotizacion = catchAsync(async (req, res, next) => {
  const { telefono, video_url, id_cotizacion, drive_url } = req.body;

  if (!telefono) {
    return next(new AppError('telefono es requerido', 400));
  }

  if (!video_url) {
    return next(new AppError('video_url es requerido', 400));
  }

  if (!drive_url) {
    return next(new AppError('drive_url es requerido', 400));
  }

  // Formatear celular
  const celularFormateado = formatPhoneForWhatsApp(telefono, '593');

  // Obtener nombre del cliente si viene id_cotizacion
  let nombreCliente = 'Estimado cliente';
  if (id_cotizacion) {
    try {
      const resultado = await db_2.query(
        `
        SELECT u.nombre_users AS cliente
        FROM cotizadorpro_cotizaciones c
        JOIN cotizadorpro_detalle_cot d ON c.id_cotizacion = d.id_cotizacion
        JOIN users u ON d.id_users = u.id_users
        WHERE c.id_cotizacion = ?
        LIMIT 1
        `,
        {
          replacements: [id_cotizacion],
          type: db_2.QueryTypes.SELECT,
        },
      );

      if (resultado.length > 0) {
        nombreCliente = resultado[0].cliente;
      }
    } catch (err) {
      console.warn(
        '[VIDEO_COT] No se pudo obtener nombre del cliente:',
        err.message,
      );
    }
  }

  let videoBuffer;
  try {
    const videoResponse = await axios.get(video_url, {
      responseType: 'arraybuffer',
      timeout: 60000,
    });
    videoBuffer = Buffer.from(videoResponse.data);
  } catch (err) {
    console.error('[VIDEO_COT] Error al descargar video:', err.message);
    return next(new AppError('No se pudo descargar el video', 500));
  }

  let convertedBuffer = videoBuffer;
  let videoFileName = 'video.mp4';
  const videoSizeMB = videoBuffer.length / (1024 * 1024);

  try {
    convertedBuffer = await convertVideoForWhatsApp(
      videoBuffer,
      'cotizacion-video.mp4',
    );
    videoFileName = 'cotizacion-video-converted.mp4';
  } catch (convErr) {
    if (convErr.isOversized || videoSizeMB > 15) {
      const msg = convErr.isOversized
        ? convErr.message
        : `El video pesa ${videoSizeMB.toFixed(2)}MB y no se pudo comprimir por debajo de 15MB. Enviá un video más corto o de menor resolución.`;
      console.error('[VIDEO_COT] Video demasiado pesado:', msg);
      return next(new AppError(msg, 400));
    }
    console.warn(
      '[VIDEO_COT] No se pudo convertir. Usando original:',
      convErr.message,
    );
  }

  let mediaId;
  try {
    mediaId = await uploadVideoToMeta(convertedBuffer, videoFileName);
  } catch (uploadErr) {
    console.error('[VIDEO_COT] Error al subir a Meta:', uploadErr.message);
    return next(new AppError('Error al subir video a WhatsApp', 500));
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));

  // 5. Verificar estado del media
  try {
    const mediaCheckUrl = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${mediaId}`;
    const mediaCheck = await axios.get(mediaCheckUrl, {
      headers: { Authorization: `Bearer ${process.env.FB_PROVIDER_TOKEN}` },
      params: { debug: 'all' },
      timeout: 10000,
      validateStatus: () => true,
    });
  } catch (checkErr) {
    console.warn(
      '[VIDEO_COT] Advertencia al verificar media:',
      checkErr.message,
    );
  }

  const templateVideo = {
    messaging_product: 'whatsapp',
    to: celularFormateado,
    type: 'template',
    template: {
      name: 'productos_en_bodega_v2',
      language: {
        code: 'es',
      },
      components: [
        {
          type: 'header',
          parameters: [
            {
              type: 'video',
              video: {
                id: mediaId,
              },
            },
          ],
        },
        {
          type: 'body',
          parameters: [
            {
              type: 'text',
              text: nombreCliente,
            },
          ],
        },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [
            {
              type: 'text',
              text: drive_url,
            },
          ],
        },
      ],
    },
  };

  let response;
  try {
    response = await axios.post(
      `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${process.env.CONFIGURACION_WS}/messages`,
      templateVideo,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.FB_PROVIDER_TOKEN}`,
        },
        params: { debug: 'all' },
      },
    );

    if(response.data.__debug) {
      console.log('[VIDEO_COT] Debug info de Meta:', JSON.stringify(response.data.__debug));
    }
    
  } catch (sendErr) {
    console.error(
      '[VIDEO_COT] Error al enviar mensaje:',
      sendErr.response?.data || sendErr.message,
    );
    return next(new AppError('Error al enviar video por WhatsApp', 500));
  }

  const midMensaje = response.data?.messages?.[0]?.id || null;

  if (
    !response.data?.messages?.[0]?.message_status ||
    response.data.messages[0].message_status !== 'accepted'
  ) {
    //('[VIDEO_COT] Mensaje no aceptado:', response.data);
    return next(new AppError('WhatsApp no aceptó el mensaje', 500));
  }

  // 7. Buscar o crear chat
  let chatId = null;
  const foundChat = await Clientes_chat_center.findOne({
    where: {
      celular_cliente: {
        [Op.like]: `%${celularFormateado}%`,
      },
      id_configuracion: COTIZADOR_CONFIG.ID_CONFIGURACION,
    },
  });

  if (foundChat) {
    chatId = foundChat.id;
  } else {
    const nuevoChat = await Clientes_chat_center.create({
      id_configuracion: COTIZADOR_CONFIG.ID_CONFIGURACION,
      nombre_cliente: 'Cliente Cotizador Pro',
      celular_cliente: celularFormateado,
      uid_cliente: COTIZADOR_CONFIG.UID_CLIENTE,
      estado_cliente: 1,
      chat_cerrado: false,
    });

    chatId = nuevoChat.id;
  }

  // 8. Registrar mensaje en BD
  const rutaArchivo = JSON.stringify({
    placeholders: {
      1: nombreCliente,
    },
    header: {
      format: 'video',
      mediaId: mediaId,
      fileUrl: video_url,
    },
    template_name: 'productos_en_bodega_v2',
    language: 'es',
    id_cotizacion: id_cotizacion || null,
    converted: convertedBuffer !== videoBuffer,
  });

  const textoMensaje = `Estimado {{1}}, le informamos que su envío ya se encuentra en nuestras bodegas.

Adjuntamos evidencia para su validación. Si desea recibir más fotografías o detalles del paquete, por favor presione el siguiente botón.`;

  const mensajeRegistrado = await MensajesClientes.create({
    id_configuracion: COTIZADOR_CONFIG.ID_CONFIGURACION,
    id_cliente: COTIZADOR_CONFIG.ID_CLIENTE,
    source: 'wa',
    mid_mensaje: COTIZADOR_CONFIG.UID_CLIENTE,
    tipo_mensaje: 'template',
    rol_mensaje: 1,
    celular_recibe: chatId.toString(),
    responsable: COTIZADOR_CONFIG.RESPONSABLE,
    uid_whatsapp: celularFormateado,
    id_wamid_mensaje: midMensaje,
    texto_mensaje: textoMensaje,
    ruta_archivo: rutaArchivo,
    meta_media_id: mediaId,
    visto: false,
    language: 'es',
    template_name: 'productos_en_bodega_v2',
  });

  // Actualizar subestado
  const [rowsAffected] = await CotizadorproCotizaciones.update(
    { subestado: 'recibida', fecha_recibida: new Date() },
    { where: { id_cotizacion: id_cotizacion } },
  );


  // Verificar que se guardó correctamente
  const cotizacionActualizada = await CotizadorproCotizaciones.findOne({
    where: { id_cotizacion: id_cotizacion },
    attributes: ['id_cotizacion', 'subestado', 'fecha_recibida', 'estado'],
  });

  res.status(200).json({
    status: 200,
    success: true,
    title: 'Video enviado',
    message: 'Template con video enviado correctamente por WhatsApp',
    data: {
      wamid: midMensaje,
      mediaId: mediaId,
      chatId: chatId,
      celular: celularFormateado,
      nombreCliente: nombreCliente,
      templateName: 'productos_en_bodega_v2',
      converted: convertedBuffer !== videoBuffer,
    },
  });
});
