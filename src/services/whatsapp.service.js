const axios = require('axios');
const MensajesClientes = require('../models/mensaje_cliente.model');
const ClientesChatCenter = require('../models/clientes_chat_center.model');
const { db } = require('../database/config');
const {
  getConfigFromDB,
  onlyDigits,
} = require('../utils/whatsappTemplate.helpers');

/* ================================================================
   CACHE DE PLANTILLAS EN MEMORIA
   - Evita consultar Meta N veces por el mismo template
   - TTL configurable (default 30 min)
   - Key: `${waba_id}::${nombre_template}`
   ================================================================ */

const templateCache = new Map();
const TEMPLATE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos

function getTemplateCacheKey(waba_id, nombre_template) {
  return `${waba_id}::${nombre_template}`;
}

function getCachedTemplate(waba_id, nombre_template) {
  const key = getTemplateCacheKey(waba_id, nombre_template);
  const entry = templateCache.get(key);

  if (!entry) return null;

  // Expiró
  if (Date.now() - entry.cachedAt > TEMPLATE_CACHE_TTL_MS) {
    templateCache.delete(key);
    return null;
  }

  return entry.data; // { text, language, header }
}

function setCachedTemplate(waba_id, nombre_template, data) {
  const key = getTemplateCacheKey(waba_id, nombre_template);
  templateCache.set(key, { data, cachedAt: Date.now() });
}

/**
 * Limpia entradas expiradas del cache (llamar periódicamente si se desea)
 */
function pruneTemplateCache() {
  const now = Date.now();
  for (const [key, entry] of templateCache.entries()) {
    if (now - entry.cachedAt > TEMPLATE_CACHE_TTL_MS) {
      templateCache.delete(key);
    }
  }
}

/* ================================================================
   obtenerTextoPlantilla — CON CACHE
   ================================================================ */

const obtenerTextoPlantilla = async (nombre_template, accessToken, waba_id) => {
  // 1) Revisar cache primero
  const cached = getCachedTemplate(waba_id, nombre_template);
  if (cached) {
    console.log('💾 [obtenerTextoPlantilla] CACHE HIT', {
      nombre_template,
      waba_id,
    });
    return cached;
  }

  const startedAt = Date.now();

  try {
    console.log('🔎 [obtenerTextoPlantilla] CACHE MISS → consultando Meta', {
      nombre_template,
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

    // ── Cachear TODAS las plantillas que vinieron en la respuesta ──
    // Meta devuelve todas las plantillas del WABA en un solo GET,
    // así que aprovechamos para cachear todas de una vez.
    for (const tpl of data.data) {
      const body = tpl.components?.find((comp) => comp.type === 'BODY');
      if (!body?.text) continue;

      const headerComp = tpl.components?.find((comp) => comp.type === 'HEADER');
      let header = null;
      if (headerComp) {
        header = {
          format: headerComp.format || null,
          media_url: headerComp.example?.header_handle?.[0] || null,
        };
      }

      const tplData = {
        text: body.text,
        language: tpl.language || 'es',
        header,
      };

      setCachedTemplate(waba_id, tpl.name, tplData);
    }

    console.log('💾 [obtenerTextoPlantilla] Cacheadas', {
      count: data.data.length,
      waba_id,
    });

    // Ahora buscar la que necesitamos (ya está en cache)
    const result = getCachedTemplate(waba_id, nombre_template);

    if (!result) {
      console.error(
        `❌ [obtenerTextoPlantilla] No se encontró la plantilla: ${nombre_template}`,
      );
      return { text: null, language: null, header: null };
    }

    console.log('✅ [obtenerTextoPlantilla] plantilla resuelta', {
      nombre_template,
      language: result.language,
      headerFormat: result.header?.format || null,
      bodyPreview: String(result.text).slice(0, 120),
      ms: Date.now() - startedAt,
    });

    return result;
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

/* ================================================================
   PRE-FETCH MASIVO DE PLANTILLAS (para usar desde el cron)
   - Recibe un array de items pendientes
   - Agrupa por waba_id + nombre_template
   - Consulta Meta UNA SOLA VEZ por combinación única
   - Retorna cuántas plantillas se pre-cachearon
   ================================================================ */

async function prefetchTemplates(pendientes) {
  // Agrupar combinaciones únicas que NO estén en cache
  const needed = new Map(); // key → { waba_id, nombre_template, id_configuracion }

  for (const item of pendientes) {
    const waba_id = item.waba_id;
    const nombre_template = item.nombre_template;

    if (!waba_id || !nombre_template) continue;

    const cached = getCachedTemplate(waba_id, nombre_template);
    if (cached) continue; // ya está en cache

    const key = `${waba_id}::${nombre_template}`;
    if (!needed.has(key)) {
      needed.set(key, {
        waba_id,
        nombre_template,
        id_configuracion: item.id_configuracion,
      });
    }
  }

  if (needed.size === 0) {
    console.log(
      '💾 [prefetchTemplates] Todas las plantillas ya están en cache',
    );
    return 0;
  }

  console.log(
    `🔄 [prefetchTemplates] Pre-fetching ${needed.size} plantilla(s) únicas desde Meta`,
  );

  let fetched = 0;

  for (const [, info] of needed) {
    try {
      const cfg = await getConfigFromDB(Number(info.id_configuracion));
      if (!cfg?.ACCESS_TOKEN || !cfg?.WABA_ID) {
        console.warn(
          `⚠️ [prefetchTemplates] Config inválida para id_configuracion=${info.id_configuracion}`,
        );
        continue;
      }

      // obtenerTextoPlantilla ya cachea TODAS las del WABA en un solo GET
      await obtenerTextoPlantilla(
        info.nombre_template,
        cfg.ACCESS_TOKEN,
        info.waba_id,
      );
      fetched++;

      // Pequeña pausa entre WABAs distintos para no saturar
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.error(
        `❌ [prefetchTemplates] Error pre-fetching ${info.nombre_template}:`,
        err.message,
      );
    }
  }

  return fetched;
}

/* ================================================================
   sendWhatsappMessage (sin cambios)
   ================================================================ */

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

/* ================================================================
   sendWhatsappMessageTemplate (envío manual, sin cambios)
   ================================================================ */

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

/* ================================================================
   sendWhatsappMessageTemplateScheduled (CRON)
   - Ahora usa cache, NO consulta Meta si ya está cacheado
   ================================================================ */

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
    id_configuracion,
    nombre_template,
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

  // 1) Config fresca desde BD
  const cfg = await getConfigFromDB(Number(id_configuracion));

  if (!telefono_configuracion) {
    telefono_configuracion = cfg.telefono;
  }

  if (!cfg)
    throw new Error('Configuración inválida/suspendida o no encontrada');

  const business_phone_id = cfg.PHONE_NUMBER_ID;
  const accessToken = cfg.ACCESS_TOKEN;
  const waba_id = cfg.WABA_ID;

  if (!business_phone_id || !accessToken || !waba_id) {
    throw new Error(
      'Configuración incompleta (PHONE_NUMBER_ID / ACCESS_TOKEN / WABA_ID)',
    );
  }

  // 2) Obtener plantilla — ahora usa CACHE automáticamente
  const {
    text: templateText,
    language: languageFromMeta,
    header: templateHeader,
  } = await obtenerTextoPlantilla(nombre_template, accessToken, waba_id);

  const resolvedHeaderFormat = header_format || templateHeader?.format || null;
  const resolvedHeaderMediaUrl =
    header_media_url || templateHeader?.media_url || null;

  const headerFormatNorm =
    String(resolvedHeaderFormat || '').toUpperCase() || null;
  const resolvedMediaUrl = resolvedHeaderMediaUrl;

  if (!templateText) {
    throw new Error('No se encontró el contenido de la plantilla en Meta');
  }

  // Validaciones de header
  if (
    headerFormatNorm === 'TEXT' &&
    header_parameters != null &&
    !Array.isArray(header_parameters)
  ) {
    throw new Error(
      'header_parameters debe ser un array cuando header_format=TEXT',
    );
  }

  if (
    ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormatNorm) &&
    !resolvedMediaUrl
  ) {
    throw new Error(
      `header_media_url es requerido cuando header_format=${headerFormatNorm}`,
    );
  }

  const LANGUAGE_CODE = language_code || languageFromMeta || 'es';

  // 3) Construir components
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

  // 4) Enviar a Meta
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

  const response = await axios.post(url, payload, {
    headers,
    timeout: 30000,
    validateStatus: () => true,
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

  const uid_whatsapp = telefonoLimpio;
  const wamid = response.data?.messages?.[0]?.id || null;

  // 5) Cliente destino
  let cliente = await ClientesChatCenter.findOne({
    where: { celular_cliente: telefonoLimpio, id_configuracion },
  });

  if (!cliente) {
    cliente = await ClientesChatCenter.create({
      id_configuracion,
      uid_cliente: business_phone_id,
      nombre_cliente: '',
      apellido_cliente: '',
      celular_cliente: telefonoLimpio,
    });
  }

  // 6) Cliente configuración
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
      }
    }
  }

  // 7) Trazabilidad
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

exports.prefetchTemplates = prefetchTemplates;
exports.pruneTemplateCache = pruneTemplateCache;
exports.obtenerTextoPlantilla = obtenerTextoPlantilla;
