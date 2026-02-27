const axios = require('axios');
const MensajesClientes = require('../models/mensaje_cliente.model');
const ClientesChatCenter = require('../models/clientes_chat_center.model');
const { db } = require('../database/config');
const {
  getConfigFromDB,
  onlyDigits,
} = require('../utils/whatsappTemplate.helpers');

exports.sendWhatsappMessage = async ({
  telefono,
  mensaje,
  business_phone_id,
  accessToken,
  id_configuracion,
  responsable,
}) => {
  const url = `https://graph.facebook.com/v20.0/${business_phone_id}/messages`;

  const data = {
    messaging_product: 'whatsapp',
    to: telefono,
    type: 'text',
    text: { body: mensaje },
  };

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const response = await axios.post(url, data, { headers });

  console.log('✅ Mensaje enviado:', response.data);

  const uid_whatsapp = telefono;
  const wamid = response.data?.messages?.[0]?.id || null;

  let cliente = await ClientesChatCenter.findOne({
    where: {
      celular_cliente: telefono,
      id_configuracion,
    },
  });

  if (!cliente) {
    cliente = await ClientesChatCenter.create({
      id_configuracion,
      uid_cliente: business_phone_id,
      nombre_cliente: '',
      apellido_cliente: '',
      celular_cliente: telefono,
    });
  }

  await MensajesClientes.create({
    id_configuracion,
    id_cliente: cliente.id,
    mid_mensaje: business_phone_id,
    tipo_mensaje: 'text',
    responsable,
    texto_mensaje: mensaje,
    ruta_archivo: null,
    rol_mensaje: 1,
    celular_recibe: cliente.id,
    uid_whatsapp,
    id_wamid_mensaje: wamid,
  });
};

exports.sendWhatsappMessageTemplate = async ({
  telefono,
  telefono_configuracion,
  business_phone_id,
  waba_id,
  accessToken,
  id_configuracion,
  responsable,
  nombre_template,
  template_parameters,
}) => {
  const { text: templateText, language: LANGUAGE_CODE } =
    await obtenerTextoPlantilla(nombre_template, accessToken, waba_id);

  if (!templateText) {
    console.error('No se pudo obtener el texto de la plantilla.');
    return {
      success: false,
      error: 'No se encontró el contenido de la plantilla',
    };
  }

  const url = `https://graph.facebook.com/v20.0/${business_phone_id}/messages`;

  if (!Array.isArray(template_parameters)) {
    throw new Error('template_parameters debe ser un array');
  }

  const components = template_parameters.map((param) => ({
    type: 'text',
    text: param,
  }));

  let ruta_archivo = {};
  template_parameters.forEach((param, index) => {
    ruta_archivo[index + 1] = param;
  });

  const data = {
    messaging_product: 'whatsapp',
    to: telefono,
    type: 'template',
    template: {
      name: nombre_template,
      language: { code: LANGUAGE_CODE },
      components: [{ type: 'body', parameters: components }],
    },
  };

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const response = await axios.post(url, data, { headers });

  console.log('✅ Mensaje de plantilla enviado:', response.data);

  const uid_whatsapp = telefono;
  const wamid = response.data?.messages?.[0]?.id || null;

  let cliente = await ClientesChatCenter.findOne({
    where: { celular_cliente: telefono, id_configuracion },
  });

  if (!cliente) {
    cliente = await ClientesChatCenter.create({
      id_configuracion,
      uid_cliente: business_phone_id,
      nombre_cliente: '',
      apellido_cliente: '',
      celular_cliente: telefono,
    });
  }

  let id_cliente_configuracion = '';

  const [clienteConfiguracionExistente] = await db.query(
    'SELECT id FROM clientes_chat_center WHERE celular_cliente = ? AND id_configuracion = ?',
    {
      replacements: [telefono_configuracion, id_configuracion],
      type: db.QueryTypes.SELECT,
    },
  );

  if (!clienteConfiguracionExistente) {
    console.log('error no existe el cliente de la configuracion');
  } else {
    id_cliente_configuracion = clienteConfiguracionExistente.id;
  }

  await MensajesClientes.create({
    id_configuracion,
    id_cliente: id_cliente_configuracion,
    mid_mensaje: business_phone_id,
    tipo_mensaje: 'template',
    rol_mensaje: 1,
    celular_recibe: cliente.id,
    responsable,
    texto_mensaje: templateText,
    ruta_archivo: JSON.stringify(ruta_archivo),
    visto: 1,
    uid_whatsapp,
    id_wamid_mensaje: wamid,
    template_name: templateText,
    language_code: LANGUAGE_CODE,
  });
};

const obtenerTextoPlantilla = async (templateName, accessToken, waba_id) => {
  const startedAt = Date.now();

  try {
    console.log('🔎 [obtenerTextoPlantilla] inicio', {
      templateName,
      waba_id,
      at: new Date().toISOString(),
    });

    const response = await axios.get(
      `https://graph.facebook.com/v22.0/${waba_id}/message_templates`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 20000,
        validateStatus: () => true,
      },
    );

    console.log('📥 [obtenerTextoPlantilla] respuesta Meta', {
      status: response.status,
      hasData: !!response.data,
      keys: response.data ? Object.keys(response.data) : [],
      ms: Date.now() - startedAt,
    });

    if (
      response.status < 200 ||
      response.status >= 300 ||
      response.data?.error
    ) {
      const metaErr =
        response.data?.error?.message ||
        response.data?.message ||
        `Meta HTTP ${response.status}`;
      const err = new Error(`[Meta Templates List] ${metaErr}`);
      err.meta_status = response.status;
      err.meta_error = response.data?.error || response.data || null;
      throw err;
    }

    const data = response.data;

    if (!data.data || !Array.isArray(data.data)) {
      console.error(
        '❌ [obtenerTextoPlantilla] No se encontraron plantillas en la API.',
      );
      return { text: null, language: null, header: null };
    }

    console.log('📚 [obtenerTextoPlantilla] plantillas recibidas', {
      count: data.data.length,
      templateName,
    });

    const plantilla = data.data.find((tpl) => tpl.name === templateName);

    if (!plantilla) {
      console.error(
        `❌ [obtenerTextoPlantilla] No se encontró la plantilla: ${templateName}`,
      );
      return { text: null, language: null, header: null };
    }

    const body = plantilla.components?.find((comp) => comp.type === 'BODY');

    if (!body || !body.text) {
      console.error(
        '❌ [obtenerTextoPlantilla] La plantilla no tiene BODY.text',
      );
      return { text: null, language: null, header: null };
    }

    const languageCode = plantilla.language || 'es';

    // ── Extraer header si existe ──
    const headerComp = plantilla.components?.find(
      (comp) => comp.type === 'HEADER',
    );
    let header = null;
    if (headerComp) {
      header = {
        format: headerComp.format || null, // 'VIDEO', 'IMAGE', 'DOCUMENT', 'TEXT'
        media_url: headerComp.example?.header_handle?.[0] || null,
      };
    }

    console.log('✅ [obtenerTextoPlantilla] plantilla resuelta', {
      templateName,
      languageCode,
      headerFormat: header?.format || null,
      hasHeaderMediaUrl: !!header?.media_url,
      bodyPreview: String(body.text).slice(0, 120),
      ms: Date.now() - startedAt,
    });

    return { text: body.text, language: languageCode, header };
  } catch (error) {
    console.error('❌ Error al obtener la plantilla:', {
      message: error.message,
      meta_status: error.meta_status || null,
      meta_error: error.meta_error || null,
      ms: Date.now() - startedAt,
    });
    return { text: null, language: null, header: null };
  }
};

/**
 * Envío de template para CRON programado.
 * - NO depende del access_token almacenado en template_envios_programados
 * - Toma credenciales frescas desde configuraciones (id_configuracion)
 * - Soporta header TEXT / IMAGE / VIDEO / DOCUMENT
 * - Auto-detecta header multimedia desde la definición de la plantilla en Meta
 */
exports.sendWhatsappMessageTemplateScheduled = async ({
  telefono,
  telefono_configuracion,
  id_configuracion,
  responsable = 'cron_template_programado',

  nombre_template,
  language_code = null,
  template_parameters = [],

  header_format = null,
  header_parameters = null,
  header_media_url = null,
  header_media_name = null,
}) => {
  const startedAt = Date.now();

  console.log('🚀 [CRON SEND] inicio', {
    telefono,
    telefono_configuracion,
    id_configuracion,
    responsable,
    nombre_template,
    language_code,
    header_format,
    has_header_media_url: !!header_media_url,
    at: new Date().toISOString(),
  });

  if (!id_configuracion) throw new Error('id_configuracion es requerido');
  if (!nombre_template) throw new Error('nombre_template es requerido');

  const telefonoLimpio = onlyDigits(telefono || '');
  if (!telefonoLimpio || telefonoLimpio.length < 8) {
    throw new Error('Teléfono destino inválido');
  }

  if (!Array.isArray(template_parameters)) {
    throw new Error('template_parameters debe ser un array');
  }

  // ── FIX: estas validaciones se mueven DESPUÉS de obtener la plantilla ──

  // 1) Config fresca desde BD
  console.log('🗄️ [CRON SEND] consultando configuración...');
  const cfg = await getConfigFromDB(Number(id_configuracion));

  if (!telefono_configuracion) {
    telefono_configuracion = cfg.telefono;
  }

  console.log('[CRON SEND] telefono_configuracion resuelta', {
    telefono_configuracion,
  });

  if (!cfg)
    throw new Error('Configuración inválida/suspendida o no encontrada');

  const business_phone_id = cfg.PHONE_NUMBER_ID;
  const accessToken = cfg.ACCESS_TOKEN;
  const waba_id = cfg.WABA_ID;

  console.log('✅ [CRON SEND] config cargada', {
    id_configuracion,
    hasPhoneId: !!business_phone_id,
    hasToken: !!accessToken,
    hasWaba: !!waba_id,
  });

  if (!business_phone_id || !accessToken || !waba_id) {
    throw new Error(
      'Configuración incompleta (PHONE_NUMBER_ID / ACCESS_TOKEN / WABA_ID)',
    );
  }

  // 2) Obtener texto, idioma y header de la plantilla desde Meta
  console.log('🔎 [CRON SEND] obteniendo texto plantilla en Meta', {
    nombre_template,
    waba_id,
  });

  const {
    text: templateText,
    language: languageFromMeta,
    header: templateHeader,
  } = await obtenerTextoPlantilla(nombre_template, accessToken, waba_id);

  // ── FIX 2: resolver header DESPUÉS de obtener la plantilla ──
  const resolvedHeaderFormat = header_format || templateHeader?.format || null;
  const resolvedHeaderMediaUrl =
    header_media_url || templateHeader?.media_url || null;

  // ── FIX 1: headerFormatNorm y resolvedMediaUrl declarados aquí, no antes ──
  const headerFormatNorm =
    String(resolvedHeaderFormat || '').toUpperCase() || null;
  const resolvedMediaUrl = resolvedHeaderMediaUrl;

  console.log('📄 [CRON SEND] resultado plantilla', {
    hasTemplateText: !!templateText,
    languageFromMeta,
    headerFormatNorm,
    hasResolvedMediaUrl: !!resolvedMediaUrl,
  });

  if (!templateText) {
    throw new Error('No se encontró el contenido de la plantilla en Meta');
  }

  // Validaciones de header DESPUÉS de resolver
  if (
    headerFormatNorm === 'TEXT' &&
    header_parameters != null &&
    !Array.isArray(header_parameters)
  ) {
    throw new Error(
      'header_parameters debe ser un array cuando header_format=TEXT',
    );
  }

  // ── FIX 3: usar resolvedMediaUrl en lugar de header_media_url ──
  if (
    ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormatNorm) &&
    !resolvedMediaUrl
  ) {
    throw new Error(
      `header_media_url es requerido cuando header_format=${headerFormatNorm}`,
    );
  }

  console.log('🧹 [CRON SEND] validaciones ok', {
    telefonoLimpio,
    bodyParamsCount: template_parameters.length,
    headerFormatNorm,
    headerParamsCount: Array.isArray(header_parameters)
      ? header_parameters.length
      : 0,
  });

  const LANGUAGE_CODE = language_code || languageFromMeta || 'es';

  // 3) Construir components dinámicamente
  const componentsPayload = [];

  if (headerFormatNorm === 'TEXT') {
    if (Array.isArray(header_parameters) && header_parameters.length > 0) {
      componentsPayload.push({
        type: 'header',
        parameters: header_parameters.map((param) => ({
          type: 'text',
          text: String(param ?? ''),
        })),
      });
    }
  }

  // ── FIX 3: usar resolvedMediaUrl ──
  if (
    ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormatNorm) &&
    resolvedMediaUrl
  ) {
    const mediaType =
      headerFormatNorm === 'IMAGE'
        ? 'image'
        : headerFormatNorm === 'VIDEO'
          ? 'video'
          : 'document';

    const mediaObj = { link: String(resolvedMediaUrl).trim() };

    if (mediaType === 'document' && header_media_name) {
      mediaObj.filename = String(header_media_name);
    }

    componentsPayload.push({
      type: 'header',
      parameters: [{ type: mediaType, [mediaType]: mediaObj }],
    });
  }

  if (template_parameters.length > 0) {
    componentsPayload.push({
      type: 'body',
      parameters: template_parameters.map((param) => ({
        type: 'text',
        text: String(param ?? ''),
      })),
    });
  }

  console.log(' [CRON SEND] components construidos', {
    componentsCount: componentsPayload.length,
    componentsTypes: componentsPayload.map((c) => c.type),
    LANGUAGE_CODE,
  });

  // 4) Payload a Meta
  const payload = {
    messaging_product: 'whatsapp',
    to: telefonoLimpio,
    type: 'template',
    template: {
      name: nombre_template,
      language: { code: LANGUAGE_CODE },
      components: componentsPayload,
    },
  };

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const url = `https://graph.facebook.com/v22.0/${business_phone_id}/messages`;

  console.log(' [CRON SEND] enviando a Meta', {
    url,
    to: telefonoLimpio,
    template: nombre_template,
    language: LANGUAGE_CODE,
    componentsCount: componentsPayload.length,
  });

  const response = await axios.post(url, payload, {
    headers,
    timeout: 30000,
    validateStatus: () => true,
  });

  console.log(' [CRON SEND] respuesta Meta', {
    status: response.status,
    data: response.data,
    ms: Date.now() - startedAt,
  });

  if (response.status < 200 || response.status >= 300 || response.data?.error) {
    const metaErr =
      response.data?.error?.message ||
      response.data?.message ||
      `Meta HTTP ${response.status}`;

    const error = new Error(`[Meta Template] ${metaErr}`);
    error.meta_status = response.status;
    error.meta_error = response.data?.error || response.data || null;
    error.meta_payload = payload;
    throw error;
  }

  console.log(' [CRON SEND] Template enviado a Meta OK');

  const uid_whatsapp = telefonoLimpio;
  const wamid = response.data?.messages?.[0]?.id || null;

  // 5) Buscar/crear cliente destino
  console.log('[CRON SEND] buscando/creando cliente destino...');
  let cliente = await ClientesChatCenter.findOne({
    where: { celular_cliente: telefonoLimpio, id_configuracion },
  });

  if (!cliente) {
    console.log('[CRON SEND] cliente destino no existe, creando...');
    cliente = await ClientesChatCenter.create({
      id_configuracion,
      uid_cliente: business_phone_id,
      nombre_cliente: '',
      apellido_cliente: '',
      celular_cliente: telefonoLimpio,
    });
  }

  // 6) Buscar cliente del número de configuración
  let id_cliente_configuracion = null;

  if (telefono_configuracion) {
    const telCfgLimpio = onlyDigits(telefono_configuracion);

    if (telCfgLimpio) {
      const [clienteConfiguracionExistente] = await db.query(
        `SELECT id FROM clientes_chat_center
         WHERE celular_cliente = ? AND id_configuracion = ?
         LIMIT 1`,
        {
          replacements: [telCfgLimpio, id_configuracion],
          type: db.QueryTypes.SELECT,
        },
      );

      if (clienteConfiguracionExistente?.id) {
        id_cliente_configuracion = clienteConfiguracionExistente.id;
      } else {
        console.warn(
          '[CRON TEMPLATE] No existe cliente_chat_center del número de configuración:',
          telefono_configuracion,
        );
      }
    }
  }

  // 7) Guardar trazabilidad local
  const ruta_archivo = {
    body_parameters: template_parameters || [],
    header: {
      format: headerFormatNorm || null,
      parameters: Array.isArray(header_parameters) ? header_parameters : null,
      media_url: resolvedMediaUrl || null,
      media_name: header_media_name || null,
    },
    source: 'cron_programado',
  };

  await MensajesClientes.create({
    id_configuracion,
    id_cliente: id_cliente_configuracion,
    mid_mensaje: business_phone_id,
    tipo_mensaje: 'template',
    rol_mensaje: 1,
    celular_recibe: cliente.id,
    responsable,
    texto_mensaje: templateText,
    ruta_archivo: JSON.stringify(ruta_archivo),
    visto: 1,
    uid_whatsapp,
    id_wamid_mensaje: wamid,
    template_name: nombre_template,
    language_code: LANGUAGE_CODE,
  });

  console.log('✅ [CRON SEND] fin ok', {
    telefono: telefonoLimpio,
    wamid,
    ms: Date.now() - startedAt,
  });

  return {
    success: true,
    wamid,
    language_code: LANGUAGE_CODE,
    template_text: templateText,
    response: response.data,
  };
};
