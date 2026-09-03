'use strict';

/**
 * API pública — mensajería para CRMs externos (Guardian y afines).
 *
 * Pedidos que la motivan (cliente Guardian, Colombia):
 *  1. Buscar la conversación por teléfono sin depender de un id sincronizado.
 *  2. Escribir (plantilla aprobada) a un número que NUNCA escribió.
 *  3. Que la transcripción de las notas de voz venga en la API.
 *  4. Plantillas con imagen en el header y link variable en el botón.
 *  5. Mandar foto/video a un chat abierto.
 *
 * Reglas de esta superficie (las mismas de public_config.controller):
 *  - La llave manda: todo acotado a req.id_configuracion. El tercero jamás
 *    elige la conexión, y solo puede enviar POR el WhatsApp de esa conexión —
 *    el costo, el número y la reputación ante Meta son del dueño de la llave.
 *  - Envíos solo con scope explícito 'mensajes:write'.
 *  - TODO envío queda en api_public_auditoria (quién, a qué número, qué
 *    plantilla) y en mensajes_clientes como cualquier mensaje del panel: el
 *    dueño lo ve en su chat, con el responsable "api:<nombre de la llave>".
 *  - Nada de texto libre arbitrario fuera de la ventana de 24h: fuera de
 *    ventana solo pasan plantillas aprobadas por Meta (la propia Meta lo
 *    rechazaría; acá se explica en vez de dejar un error críptico).
 */

const { db } = require('../database/config');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { auditar } = require('./public_config.controller');
const {
  buscarContactoWa,
  last9,
} = require('../utils/unified/dedupeContacto');
const { formatPhoneForWhatsApp } = require('../utils/phoneUtils');
const { estaDentroVentana24h } = require('../utils/encuestaBienvenida');
const {
  sendWhatsappMessageTemplateScheduled,
} = require('../services/whatsapp.service');
const ChatService = require('../services/chat.service');
const {
  enviarConsultaAPI,
} = require('../utils/webhook_whatsapp/enviar_consulta_socket');

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

/* Código de país por defecto según el país de la conexión: un CRM colombiano
   manda "3001234567" sin el 57 y Meta lo necesita internacional. */
const CC_POR_PAIS = { ec: '593', co: '57', mx: '52', gt: '502', pe: '51' };

async function paisDeLaConexion(id_configuracion) {
  const [row] = await db.query(
    `SELECT pais FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return CC_POR_PAIS[String(row?.pais || 'ec').toLowerCase()] || '593';
}

/* SSRF: la URL de un video se descarga DESDE ESTE SERVIDOR antes de subirla a
   Meta, así que una URL "http://localhost/..." leería servicios internos con
   la identidad del backend. Solo https hacia hosts públicos. */
function validarUrlMediaPublica(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    throw new AppError('url inválida.', 400);
  }
  if (u.protocol !== 'https:') {
    throw new AppError('url debe ser https (Meta no descarga http plano).', 400);
  }
  if (u.username || u.password) {
    throw new AppError('url no puede llevar credenciales.', 400);
  }
  const host = u.hostname.toLowerCase();
  const esPrivado =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (esPrivado) {
    throw new AppError('url apunta a una red privada; usa una URL pública.', 400);
  }
  return u.toString();
}

/* Contacto (fila de clientes_chat_center) con lo que un CRM necesita. */
async function leerContacto(id_configuracion, idContacto) {
  const [row] = await db.query(
    `SELECT id, nombre_cliente, apellido_cliente, celular_cliente,
            estado_contacto, bot_openia, chat_cerrado, id_encargado,
            created_at, ultimo_mensaje_at, ultimo_texto, ultimo_rol_mensaje
       FROM clientes_chat_center
      WHERE id = ? AND id_configuracion = ? AND deleted_at IS NULL
      LIMIT 1`,
    { replacements: [idContacto, id_configuracion], type: db.QueryTypes.SELECT },
  );
  return row || null;
}

async function formatearConversacion(id_configuracion, row) {
  return {
    chat_id: row.id,
    telefono: onlyDigits(row.celular_cliente),
    nombre: [row.nombre_cliente, row.apellido_cliente]
      .filter(Boolean)
      .join(' ')
      .trim(),
    columna_kanban: row.estado_contacto,
    bot_activo: Number(row.bot_openia) === 1,
    chat_cerrado: Number(row.chat_cerrado) === 1,
    creado_en: row.created_at,
    ultimo_mensaje_en: row.ultimo_mensaje_at,
    ultimo_mensaje_texto: row.ultimo_texto,
    ultimo_mensaje_de: row.ultimo_rol_mensaje == null
      ? null
      : Number(row.ultimo_rol_mensaje) === 0
        ? 'cliente'
        : 'negocio',
    /* Dentro de ventana => se puede mandar texto/foto/video libre; fuera,
       Meta solo acepta plantillas. Se responde acá para que el CRM no lo
       descubra con un error de Meta. */
    dentro_ventana_24h: await estaDentroVentana24h({
      idCliente: row.id,
      idConfiguracion: id_configuracion,
    }),
  };
}

/* ═══════════════════════════════════════════════════════════
   GET /conversaciones?telefono=573001234567   (scope read)
   ═══════════════════════════════════════════════════════════ */

exports.conversacionBuscar = catchAsync(async (req, res, next) => {
  const telefono = String(req.query?.telefono || '').trim();
  if (!telefono) return next(new AppError('telefono es requerido.', 400));
  const l9 = last9(telefono);
  if (l9.length < 8) {
    return next(new AppError('telefono inválido (mínimo 8 dígitos).', 400));
  }

  /* Por celular_last9 (columna generada + índice): encuentra el chat sin
     importar el formato guardado (0300..., 57300..., +57 300...). */
  const idContacto = await buscarContactoWa({ id_configuracion: req.id_configuracion, telefono });
  if (!idContacto) {
    return res.status(404).json({
      isSuccess: false,
      existe: false,
      mensaje:
        'Ese número no tiene chat en esta conexión. Para escribirle por primera vez usa POST /mensajes/plantilla: crea el chat y envía la plantilla en un solo paso.',
    });
  }

  const row = await leerContacto(req.id_configuracion, idContacto);
  return res.json({
    isSuccess: true,
    data: await formatearConversacion(req.id_configuracion, row),
  });
});

/* ═══════════════════════════════════════════════════════════
   GET /conversaciones/:id/mensajes   (scope read)
   Incluye la transcripción de las notas de voz: para tipo 'audio',
   texto_mensaje ES la transcripción (la escribe el webhook al recibirlo).
   ═══════════════════════════════════════════════════════════ */

exports.conversacionMensajes = catchAsync(async (req, res, next) => {
  const idContacto = Number(req.params.id);
  if (!idContacto) return next(new AppError('id de conversación inválido.', 400));

  const contacto = await leerContacto(req.id_configuracion, idContacto);
  if (!contacto) {
    return next(new AppError('Conversación no encontrada en esta conexión.', 404));
  }

  const limit = Math.min(Math.max(Number(req.query?.limit) || 50, 1), 200);
  const antesDeId = Number(req.query?.antes_de_id) || null;

  /* Lectura directa y SIN efectos: getChatsByClient (el del panel) marca los
     mensajes como vistos, y un CRM leyendo no debe apagar el contador del
     asesor. celular_recibe guarda el id del contacto (no un teléfono). */
  const rows = await db.query(
    `SELECT id, created_at, tipo_mensaje, rol_mensaje, responsable,
            texto_mensaje, ruta_archivo, id_wamid_mensaje, template_name,
            language_code, estado_meta, visto
       FROM mensajes_clientes
      WHERE id_configuracion = ? AND celular_recibe = ?
        AND deleted_at IS NULL ${antesDeId ? 'AND id < ?' : ''}
      ORDER BY id DESC
      LIMIT ?`,
    {
      replacements: antesDeId
        ? [req.id_configuracion, String(idContacto), antesDeId, limit]
        : [req.id_configuracion, String(idContacto), limit],
      type: db.QueryTypes.SELECT,
    },
  );

  const mensajes = rows.map((m) => {
    const base = {
      id: m.id,
      fecha: m.created_at,
      de: Number(m.rol_mensaje) === 0 ? 'cliente' : 'negocio',
      tipo: m.tipo_mensaje,
      texto: m.texto_mensaje || '',
      archivo_url: m.ruta_archivo || null,
      wamid: m.id_wamid_mensaje || null,
      responsable: m.responsable || null,
      estado_meta: m.estado_meta,
    };
    if (m.tipo_mensaje === 'template') {
      base.template_name = m.template_name || null;
      base.language_code = m.language_code || null;
    }
    if (m.tipo_mensaje === 'audio') {
      /* La transcripción se genera al recibir el audio SOLO si el bot está
         activo en ese chat; si viene vacía, el audio no fue transcrito. */
      base.transcripcion = m.texto_mensaje || null;
    }
    return base;
  });

  return res.json({
    isSuccess: true,
    data: {
      chat_id: idContacto,
      mensajes: mensajes.reverse(), // cronológico ascendente
      paginacion: {
        limit,
        // Cursor para la página anterior (mensajes más viejos)
        antes_de_id: rows.length === limit ? rows[rows.length - 1].id : null,
      },
    },
  });
});

/* ═══════════════════════════════════════════════════════════
   POST /mensajes/plantilla   (scope mensajes:write)
   Envía una plantilla aprobada por Meta. Si el número nunca escribió,
   CREA el chat (es el pedido nº2 de Guardian: alcanzar al que compró y
   jamás abrió WhatsApp). Soporta header con imagen y botón URL variable.
   ═══════════════════════════════════════════════════════════ */

exports.enviarPlantilla = catchAsync(async (req, res, next) => {
  const b = req.body || {};
  const nombre_template = String(b.nombre_template || b.template_name || '').trim();
  if (!/^[a-z0-9_]{1,60}$/.test(nombre_template)) {
    return next(new AppError('nombre_template inválido.', 400));
  }

  const cc = await paisDeLaConexion(req.id_configuracion);
  const telefono = formatPhoneForWhatsApp(String(b.telefono || ''), cc);
  if (!telefono || onlyDigits(telefono).length < 8) {
    return next(new AppError('telefono inválido (mínimo 8 dígitos).', 400));
  }

  const template_parameters = Array.isArray(b.template_parameters)
    ? b.template_parameters.map((p) => String(p ?? ''))
    : [];
  if (template_parameters.length > 30) {
    return next(new AppError('template_parameters: máximo 30 valores.', 400));
  }
  if (template_parameters.some((p) => p.length > 1024)) {
    return next(new AppError('template_parameters: cada valor máximo 1024 caracteres.', 400));
  }

  /* Header multimedia: URL pública que Meta descarga. Si no mandan
     header_format, el servicio usa el formato de la definición de la
     plantilla en Meta — que es lo correcto casi siempre. */
  let header_media_url = null;
  let header_format = null;
  if (b.header_media_url) {
    header_media_url = validarUrlMediaPublica(b.header_media_url);
  }
  if (b.header_format) {
    const hf = String(b.header_format).toLowerCase();
    if (!['text', 'image', 'video', 'document'].includes(hf)) {
      return next(
        new AppError('header_format inválido (text|image|video|document).', 400),
      );
    }
    header_format = hf;
  }

  const responsable = `api:${req.apiKey?.nombre || 'externo'}`.slice(0, 100);

  let resultado;
  try {
    /* Hace todo el trabajo pesado: resuelve la definición en Meta, cuenta los
       {{n}} del body, desborda los parámetros sobrantes a los botones URL
       dinámicos, resuelve el header (link directo o re-subida a media_id),
       CREA el contacto si no existe (celular_last9) y registra el mensaje. */
    resultado = await sendWhatsappMessageTemplateScheduled({
      telefono,
      telefono_configuracion: null,
      id_configuracion: req.id_configuracion,
      responsable,
      nombre_template,
      language_code: b.language_code ? String(b.language_code) : null,
      template_parameters,
      header_format,
      header_parameters: Array.isArray(b.header_parameters)
        ? b.header_parameters.map((p) => String(p ?? '').slice(0, 1024))
        : null,
      header_media_url,
      header_media_name: b.header_media_name ? String(b.header_media_name) : null,
    });
  } catch (e) {
    /* Meta rechazó (plantilla inexistente, parámetros de más/menos, header
       inválido…): 422 con el detalle real para que el CRM lo corrija. */
    await auditar(req, {
      recurso: `mensajes.plantilla.${onlyDigits(telefono)}`,
      accion: 'send_error',
      previo: null,
      nuevo: { nombre_template, error: e.message, meta: e.meta_error || null },
    });
    return next(
      new AppError(
        e.meta_error?.message
          ? `Meta rechazó el envío: ${e.meta_error.message}`
          : e.message,
        e.meta_status && e.meta_status >= 400 ? 422 : 502,
      ),
    );
  }

  const chatId = await buscarContactoWa({
    id_configuracion: req.id_configuracion,
    telefono,
  });

  /* Nombre opcional: solo rellena si el contacto está sin nombre — la llave
     no puede pisar lo que el asesor ya escribió. */
  if (chatId && (b.nombre || b.apellido)) {
    await db.query(
      `UPDATE clientes_chat_center
          SET nombre_cliente = IF(COALESCE(nombre_cliente,'') = '', ?, nombre_cliente),
              apellido_cliente = IF(COALESCE(apellido_cliente,'') = '', ?, apellido_cliente)
        WHERE id = ? AND id_configuracion = ?`,
      {
        replacements: [
          String(b.nombre || '').slice(0, 100),
          String(b.apellido || '').slice(0, 100),
          chatId,
          req.id_configuracion,
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
  }

  // Refresca el chat abierto en el panel (mismo round-trip que usa el webhook)
  if (chatId) {
    enviarConsultaAPI(req.id_configuracion, String(chatId)).catch(() => {});
  }

  await auditar(req, {
    recurso: `mensajes.plantilla.${onlyDigits(telefono)}`,
    accion: 'send',
    previo: null,
    nuevo: {
      nombre_template,
      language_code: resultado.language_code,
      parametros: template_parameters.length,
      header_media: !!header_media_url,
      wamid: resultado.wamid,
      chat_id: chatId,
    },
  });

  return res.json({
    isSuccess: true,
    data: {
      wamid: resultado.wamid,
      chat_id: chatId,
      telefono: onlyDigits(telefono),
      nombre_template,
      language_code: resultado.language_code,
    },
  });
});

/* ═══════════════════════════════════════════════════════════
   POST /mensajes/media   (scope mensajes:write)
   Foto o video a un chat DENTRO de la ventana de 24h (regla de Meta:
   fuera de ventana solo plantillas). Acepta chat_id o telefono.
   ═══════════════════════════════════════════════════════════ */

exports.enviarMedia = catchAsync(async (req, res, next) => {
  const b = req.body || {};
  const tipo = String(b.tipo || '').toLowerCase();
  if (!['image', 'video'].includes(tipo)) {
    return next(new AppError("tipo debe ser 'image' o 'video'.", 400));
  }
  const url = validarUrlMediaPublica(b.url);
  const caption = String(b.caption || '').slice(0, 1024);

  // Resolver el chat: por id o por teléfono (celular_last9)
  let chatId = Number(b.chat_id) || null;
  if (!chatId && b.telefono) {
    chatId = await buscarContactoWa({
      id_configuracion: req.id_configuracion,
      telefono: String(b.telefono),
    });
  }
  if (!chatId) {
    return next(
      new AppError(
        'Chat no encontrado. Para un número que nunca escribió, primero envía una plantilla (POST /mensajes/plantilla).',
        404,
      ),
    );
  }
  const contacto = await leerContacto(req.id_configuracion, chatId);
  if (!contacto) {
    return next(new AppError('Conversación no encontrada en esta conexión.', 404));
  }

  const dentroVentana = await estaDentroVentana24h({
    idCliente: chatId,
    idConfiguracion: req.id_configuracion,
  });
  if (!dentroVentana) {
    return next(
      new AppError(
        'Fuera de la ventana de 24h: Meta solo permite plantillas aprobadas hasta que el cliente vuelva a escribir. Usa POST /mensajes/plantilla.',
        422,
      ),
    );
  }

  const chatService = new ChatService();
  const dataAdmin = await chatService.getDataAdmin(req.id_configuracion);
  if (!dataAdmin?.id_telefono || !dataAdmin?.token) {
    return next(new AppError('La conexión no tiene credenciales de WhatsApp.', 409));
  }

  let respuesta;
  try {
    /* El mismo camino del panel: imagen va por link con caption; el video se
       descarga, convierte si hace falta y sube como media_id. Registra el
       mensaje en mensajes_clientes con el receptor correcto. */
    respuesta = await chatService.sendMessage({
      mensaje: caption,
      to: onlyDigits(contacto.celular_cliente),
      dataAdmin,
      tipo_mensaje: tipo,
      id_configuracion: req.id_configuracion,
      ruta_archivo: url,
      nombre_encargado: `api:${req.apiKey?.nombre || 'externo'}`.slice(0, 100),
    });
  } catch (e) {
    await auditar(req, {
      recurso: `mensajes.media.${chatId}`,
      accion: 'send_error',
      previo: null,
      nuevo: { tipo, url, error: e.message },
    });
    return next(
      new AppError(
        'Meta no aceptó el archivo. Verifica que la URL sea pública, el formato soportado (jpg/png; mp4 H.264+AAC) y el peso (imagen ≤5MB, video ≤16MB).',
        422,
      ),
    );
  }

  enviarConsultaAPI(req.id_configuracion, String(chatId)).catch(() => {});

  const wamid = respuesta?.messages?.[0]?.id || null;
  await auditar(req, {
    recurso: `mensajes.media.${chatId}`,
    accion: 'send',
    previo: null,
    nuevo: { tipo, url, caption: caption || null, wamid },
  });

  return res.json({
    isSuccess: true,
    data: { wamid, chat_id: chatId, tipo },
  });
});
