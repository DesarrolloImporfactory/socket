const crypto = require('crypto');
const axios = require('axios');
const { db } = require('../database/config');
const { DateTime } = require('luxon');
const FormData = require('form-data');

const {
  getConfigFromDB,
  onlyDigits,
  parseMaybeJSON,
  parseArrayField,
  extractGraphBodyFromRequest,
  prepareHeaderAssetForScheduling,
  inferHeaderFormatFromMime,
  validateMetaMediaOrThrow,
  convertVideoForWhatsApp,
  uploadToUploader,
  uploadVideoToVideoAPI,
  uploadMediaToMeta,
  injectHeaderMediaId,
  extractBearerToken,
} = require('../utils/whatsappTemplate.helpers');

/**
 * ENVÍO INMEDIATO DE TEMPLATE MASIVO (1 destinatario por request)
 * Soporta:
 * - JSON normal
 * - multipart/form-data (header_file)
 * - header_default_asset
 *
 * Para VIDEO → sube a Video API (/Videos/*) en vez de S3.
 *         Para IMAGE / DOCUMENT → sigue usando S3 (uploadToUploader).
 */
exports.enviarTemplateMasivo = async (req, res) => {
  try {
    // 1) id_configuracion
    const id_configuracion = req.body?.id_configuracion;

    // 2) graphBody puede venir:
    // - JSON normal: req.body.body (cuando no hay archivo)
    // - multipart: req.body.body_json (string)
    let graphBody = null;

    try {
      graphBody = extractGraphBodyFromRequest(req);
    } catch (e) {
      return res.status(e.statusCode || 400).json({
        success: false,
        message: e.message || 'body_json inválido (JSON mal formado)',
      });
    }

    // Fallbacks
    const to = req.body?.to ?? graphBody?.to;
    const template_name = req.body?.template_name ?? graphBody?.template?.name;
    const language_code =
      req.body?.language_code ?? graphBody?.template?.language?.code ?? 'es';
    const componentsFromReq =
      req.body?.components ?? graphBody?.template?.components;

    const faltan = [];
    if (!id_configuracion) faltan.push('id_configuracion');
    if (!to) faltan.push('to');
    if (!template_name) faltan.push('template_name');

    if (faltan.length) {
      return res.status(400).json({
        success: false,
        message: `Faltan campos: ${faltan.join(', ')}`,
      });
    }

    const cfg = await getConfigFromDB(Number(id_configuracion));
    if (!cfg) {
      return res.status(200).json({
        success: false,
        message: 'Configuración inválida o sin token/phone_number_id',
      });
    }

    const toClean = onlyDigits(to);
    if (!toClean || toClean.length < 8) {
      return res
        .status(200)
        .json({ success: false, message: 'Número destino inválido' });
    }

    // ===== construir payload base =====
    let payload;

    if (graphBody) {
      payload = {
        messaging_product: graphBody.messaging_product || 'whatsapp',
        to: toClean,
        type: graphBody.type || 'template',
        template: {
          ...(graphBody.template || {}),
          name: template_name,
          language: { code: language_code || 'es' },
        },
      };

      // si no hay components, deje el body estándar
      if (
        !Array.isArray(payload.template.components) ||
        !payload.template.components.length
      ) {
        payload.template.components = [{ type: 'body', parameters: [] }];
      }
    } else {
      payload = {
        messaging_product: 'whatsapp',
        to: toClean,
        type: 'template',
        template: {
          name: template_name,
          language: { code: language_code || 'es' },
          components: Array.isArray(componentsFromReq)
            ? componentsFromReq
            : [{ type: 'body', parameters: [] }],
        },
      };
    }

    // ===== 2) Si vino archivo, validar + subir histórico + subir a Meta + inject header =====
    let header_format = req.body?.header_format ?? null;

    let fileUrl = null; // URL histórico (S3 o Video API stream_url)
    let meta_media_id = null; // mediaId de Meta
    let processedBuffer = null;
    let processedMimetype = null;
    let processedFilename = null;
    let fmt = null;
    let videoApiResult = null; // datos de Video API si aplica

    const headerDefaultAssetRaw = req.body?.header_default_asset;

    let header_default_asset = null;
    if (headerDefaultAssetRaw) {
      if (typeof headerDefaultAssetRaw === 'object') {
        header_default_asset = headerDefaultAssetRaw;
      } else if (typeof headerDefaultAssetRaw === 'string') {
        try {
          header_default_asset = JSON.parse(headerDefaultAssetRaw);
        } catch (_) {
          header_default_asset = null;
        }
      }
    }

    if (req.file) {
      if (!header_format) {
        header_format = inferHeaderFormatFromMime(req.file.mimetype);
      }

      fmt = String(header_format || '').toUpperCase();

      if (!['IMAGE', 'VIDEO', 'DOCUMENT'].includes(fmt)) {
        return res.status(400).json({
          success: false,
          message:
            'Vino header_file pero header_format no es válido para HEADER (IMAGE|VIDEO|DOCUMENT)',
        });
      }

      // 2.1) Validar límites Meta
      try {
        validateMetaMediaOrThrow({ file: req.file, format: fmt });
      } catch (err) {
        return res.status(err.statusCode || 400).json({
          success: false,
          step: 'validate_media',
          code: err.code || null,
          message: err.message || 'Archivo inválido',
        });
      }

      // 2.1.1) Convertir video si aplica
      processedBuffer = req.file.buffer;
      processedMimetype = req.file.mimetype;
      processedFilename = req.file.originalname;

      if (fmt === 'VIDEO') {
        const videoOriginalSizeMB = req.file.buffer.length / (1024 * 1024);
        console.log(
          `[VIDEO] Iniciando conversión. Tamaño original: ${videoOriginalSizeMB.toFixed(2)} MB`,
        );
        try {
          processedBuffer = await convertVideoForWhatsApp(
            req.file.buffer,
            req.file.originalname,
          );
          processedMimetype = 'video/mp4';
          processedFilename = req.file.originalname.replace(/\.[^.]+$/, '.mp4');

          console.log(
            '[VIDEO] Conversión exitosa. Nuevo tamaño:',
            (processedBuffer.length / (1024 * 1024)).toFixed(2),
            'MB',
          );
        } catch (convErr) {
          if (convErr.isOversized || videoOriginalSizeMB > 15) {
            const msg = convErr.isOversized
              ? convErr.message
              : `El video pesa ${videoOriginalSizeMB.toFixed(2)}MB y no se pudo comprimir por debajo de 15MB. Enviá un video más corto o de menor resolución.`;
            console.error('[VIDEO] Video demasiado pesado:', msg);
            return res
              .status(400)
              .json({ success: false, step: 'convert_video', message: msg });
          }
          console.warn(
            '[VIDEO] No se pudo convertir. Usando original:',
            convErr.message,
          );
        }
      }

      // 2.2) Subir histórico: VIDEO → Video API | IMAGE/DOCUMENT → S3
      if (fmt === 'VIDEO') {
        // ── VIDEO → Video API chunked ──
        const jwtToken = extractBearerToken(req);

        if (!jwtToken) {
          return res.status(401).json({
            success: false,
            step: 'upload_video_api',
            message: 'Se requiere JWT para subir video a la Video API.',
          });
        }

        try {
          videoApiResult = await uploadVideoToVideoAPI({
            buffer: processedBuffer,
            originalname: processedFilename,
            mimetype: processedMimetype,
            jwtToken,
          });

          fileUrl = videoApiResult.fileUrl; // stream_url
        } catch (err) {
          return res.status(err.statusCode || 502).json({
            success: false,
            step: 'upload_video_api',
            code: err.code || null,
            message: err.message || 'No se pudo subir video a la Video API',
          });
        }
      } else {
        // ── IMAGE / DOCUMENT → S3 como antes ──
        const folder =
          fmt === 'IMAGE'
            ? 'whatsapp/templates/header/images'
            : 'whatsapp/templates/header/documents';

        try {
          const upHist = await uploadToUploader({
            buffer: processedBuffer,
            originalname: processedFilename,
            mimetype: processedMimetype,
            folder,
          });

          fileUrl = upHist?.fileUrl || null;
        } catch (err) {
          return res.status(err.statusCode || 502).json({
            success: false,
            step: 'upload_history_s3',
            message: err.message || 'No se pudo subir a histórico (S3)',
            raw: err.raw || null,
          });
        }
      }

      // 2.3) Subir a Meta para obtener media_id (esto NO cambia — Meta siempre necesita su propio upload)
      const upMeta = await uploadMediaToMeta(
        {
          ACCESS_TOKEN: cfg.ACCESS_TOKEN,
          PHONE_NUMBER_ID: cfg.PHONE_NUMBER_ID,
        },
        {
          buffer: processedBuffer,
          mimetype: processedMimetype,
          originalname: processedFilename,
        },
      );

      if (!upMeta.ok) {
        return res.status(200).json({
          success: false,
          step: 'upload_media_meta',
          meta_status: upMeta.meta_status,
          error: upMeta.error,
          fileUrl,
        });
      }

      meta_media_id = upMeta.mediaId;

      // 2.3.1) Para videos: dar tiempo y verificar estado
      if (fmt === 'VIDEO') {
        console.log(
          '[VIDEO] Esperando procesamiento de Meta (mediaId:',
          meta_media_id,
          ')...',
        );

        await new Promise((resolve) => setTimeout(resolve, 2000));

        try {
          const mediaCheckUrl = `https://graph.facebook.com/v22.0/${meta_media_id}`;
          const mediaCheck = await axios.get(mediaCheckUrl, {
            headers: { Authorization: `Bearer ${cfg.ACCESS_TOKEN}` },
            timeout: 10000,
            validateStatus: () => true,
          });

          console.log('[VIDEO] Estado del media:', {
            status: mediaCheck.status,
            data: mediaCheck.data,
          });

          if (mediaCheck.status !== 200) {
            console.warn(
              '[VIDEO] Advertencia: No se pudo verificar el estado del media',
            );
          }
        } catch (checkErr) {
          console.warn(
            '[VIDEO] Advertencia al verificar media:',
            checkErr.message,
          );
        }
      }

      // 2.4) Inyectar mediaId en HEADER
      const comps = Array.isArray(payload.template.components)
        ? payload.template.components
        : [];

      payload.template.components = injectHeaderMediaId(
        comps,
        fmt,
        meta_media_id,
      );
    } else if (
      header_default_asset?.enabled === true &&
      header_default_asset?.url &&
      ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(
        String(header_default_asset?.format || '').toUpperCase(),
      )
    ) {
      const fmtDefault = String(
        header_default_asset.format || '',
      ).toUpperCase();

      try {
        // 1) Descargar archivo desde URL predeterminada
        const rawDefaultUrl = String(header_default_asset.url || '').trim();
        const decodedDefaultUrl = rawDefaultUrl
          .replace(/&amp;/g, '&')
          .replace(/&#38;/g, '&');

        console.log('[DEFAULT_HEADER] raw URL:', rawDefaultUrl);
        console.log('[DEFAULT_HEADER] decoded URL:', decodedDefaultUrl);

        const dl = await axios.get(decodedDefaultUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
          validateStatus: () => true,
        });

        if (dl.status < 200 || dl.status >= 300 || !dl.data) {
          return res.status(200).json({
            success: false,
            step: 'download_default_header_asset',
            message:
              'No se pudo descargar el adjunto predeterminado del template',
            http_status: dl.status,
            url: decodedDefaultUrl,
            raw_url: rawDefaultUrl,
          });
        }

        const downloadedBuffer = Buffer.from(dl.data);

        const responseMime = String(dl.headers?.['content-type'] || '')
          .split(';')[0]
          .trim();

        let defaultMime = responseMime;
        if (!defaultMime) {
          if (fmtDefault === 'IMAGE') defaultMime = 'image/jpeg';
          if (fmtDefault === 'VIDEO') defaultMime = 'video/mp4';
          if (fmtDefault === 'DOCUMENT') defaultMime = 'application/pdf';
        }

        const extByFmt =
          fmtDefault === 'IMAGE'
            ? 'jpg'
            : fmtDefault === 'VIDEO'
              ? 'mp4'
              : 'pdf';

        const defaultFilename =
          (header_default_asset?.name &&
            String(header_default_asset.name).trim()) ||
          `template_header_default.${extByFmt}`;

        // 2) Validar límites
        try {
          validateMetaMediaOrThrow({
            file: {
              buffer: downloadedBuffer,
              mimetype: defaultMime,
              originalname: defaultFilename,
              size: downloadedBuffer.length,
            },
            format: fmtDefault,
          });
        } catch (err) {
          return res.status(err.statusCode || 400).json({
            success: false,
            step: 'validate_default_header_asset',
            code: err.code || null,
            message: err.message || 'Adjunto predeterminado inválido',
          });
        }

        // 3) Guardar histórico: VIDEO → Video API | IMAGE/DOCUMENT → S3
        if (fmtDefault === 'VIDEO') {
          // ── VIDEO → Video API chunked ──
          const jwtToken = extractBearerToken(req);

          if (!jwtToken) {
            return res.status(401).json({
              success: false,
              step: 'upload_video_api_default_asset',
              message: 'Se requiere JWT para subir video a la Video API.',
            });
          }

          try {
            videoApiResult = await uploadVideoToVideoAPI({
              buffer: downloadedBuffer,
              originalname: defaultFilename,
              mimetype: defaultMime,
              jwtToken,
            });

            fileUrl = videoApiResult.fileUrl;
          } catch (err) {
            return res.status(err.statusCode || 502).json({
              success: false,
              step: 'upload_video_api_default_asset',
              code: err.code || null,
              message:
                err.message ||
                'No se pudo subir video del default asset a la Video API',
            });
          }
        } else {
          // ── IMAGE / DOCUMENT → S3 como antes ──
          const folder =
            fmtDefault === 'IMAGE'
              ? 'whatsapp/templates/header/images'
              : 'whatsapp/templates/header/documents';

          try {
            const upHist = await uploadToUploader({
              buffer: downloadedBuffer,
              originalname: defaultFilename,
              mimetype: defaultMime,
              folder,
            });

            fileUrl = upHist?.fileUrl || decodedDefaultUrl || null;
          } catch (err) {
            return res.status(err.statusCode || 502).json({
              success: false,
              step: 'upload_history_s3_default_asset',
              message:
                err.message ||
                'No se pudo subir a histórico (S3) el asset predeterminado',
              raw: err.raw || null,
            });
          }
        }

        // 4) Subir a Meta y obtener media_id
        const upMeta = await uploadMediaToMeta(
          {
            ACCESS_TOKEN: cfg.ACCESS_TOKEN,
            PHONE_NUMBER_ID: cfg.PHONE_NUMBER_ID,
          },
          {
            buffer: downloadedBuffer,
            mimetype: defaultMime,
            originalname: defaultFilename,
          },
        );

        if (!upMeta.ok) {
          return res.status(200).json({
            success: false,
            step: 'upload_media_meta_default_asset',
            meta_status: upMeta.meta_status,
            error: upMeta.error,
            fileUrl,
          });
        }

        meta_media_id = upMeta.mediaId;
        fmt = fmtDefault;

        // 5) Inyectar HEADER media
        const comps = Array.isArray(payload.template.components)
          ? payload.template.components
          : [];

        payload.template.components = injectHeaderMediaId(
          comps,
          fmtDefault,
          meta_media_id,
        );
      } catch (err) {
        return res.status(500).json({
          success: false,
          step: 'process_default_header_asset',
          message: 'Error procesando adjunto predeterminado del template',
          error: err.message,
        });
      }
    }

    // ===== 3) Enviar template a Meta =====
    console.log(
      '[SEND_TEMPLATE] Enviando a:',
      to,
      'Template:',
      template_name,
      'MediaId:',
      meta_media_id || 'N/A',
    );

    const ax = axios.create({
      headers: {
        Authorization: `Bearer ${cfg.ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
      validateStatus: () => true,
    });

    const url = `https://graph.facebook.com/v22.0/${cfg.PHONE_NUMBER_ID}/messages`;
    const resp = await ax.post(url, payload);

    console.log('[SEND_TEMPLATE] Respuesta de Meta:', {
      status: resp.status,
      data: resp.data,
    });

    if (resp.status < 200 || resp.status >= 300) {
      return res.status(200).json({
        success: false,
        meta_status: resp.status,
        error: resp.data,
        message: 'Meta rechazó el envío',
        sent_payload: payload,
        fileUrl,
        meta_media_id,
      });
    }

    const wamid = resp.data?.messages?.[0]?.id || null;
    console.log('[SEND_TEMPLATE] Enviado exitosamente. WAMID:', wamid);

    return res.json({
      success: true,
      wamid,
      data: resp.data,
      fileUrl,
      meta_media_id,
      video_api: videoApiResult
        ? {
            video_id: videoApiResult.video_id,
            stream_url: videoApiResult.stream_url,
          }
        : null,
      file_info: req.file
        ? {
            name: processedFilename || req.file.originalname,
            mime: processedMimetype || req.file.mimetype,
            size: processedBuffer ? processedBuffer.length : req.file.size,
            header_format: String(header_format || '').toUpperCase(),
            converted: fmt === 'VIDEO' && processedBuffer !== req.file.buffer,
          }
        : null,
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: 'Error interno enviando template',
      error: e.message,
    });
  }
};

exports.programarTemplateMasivo = async (req, res) => {
  const t = await db.transaction();

  try {
    // ==========================================
    // 1) Parseo flexible (JSON o multipart)
    // ==========================================
    const graphBody = extractGraphBodyFromRequest(req);

    let selected = req.body?.selected ?? [];
    if (!Array.isArray(selected)) {
      const parsedSelected = parseMaybeJSON(selected, []);
      selected = Array.isArray(parsedSelected) ? parsedSelected : [];
    }

    const id_configuracion = Number(req.body?.id_configuracion || 0) || null;
    const id_usuario =
      req.body?.id_usuario != null && req.body?.id_usuario !== ''
        ? Number(req.body.id_usuario)
        : null;

    let telefono_configuracion = req.body?.telefono_configuracion || null;
    let business_phone_id = req.body?.business_phone_id || null;
    let waba_id = req.body?.waba_id || null;

    let nombre_template =
      req.body?.nombre_template ??
      req.body?.template_name ??
      graphBody?.template?.name ??
      null;

    let language_code =
      req.body?.language_code ?? graphBody?.template?.language?.code ?? 'es';

    let template_parameters = parseArrayField(
      req.body?.template_parameters,
      [],
    );
    let header_parameters = parseArrayField(req.body?.header_parameters, null);

    let header_format = req.body?.header_format || null;
    let header_media_url = req.body?.header_media_url || null;
    let header_media_name = req.body?.header_media_name || null;

    const fecha_programada = req.body?.fecha_programada || null;
    const timezone = req.body?.timezone || 'America/Guayaquil';

    const meta = parseMaybeJSON(req.body?.meta, null);

    // ==========================================
    // 2) Validaciones mínimas
    // ==========================================
    if (!Array.isArray(selected) || !selected.length) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'Debe seleccionar al menos un cliente.',
      });
    }

    if (!id_configuracion) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'Falta id_configuracion.',
      });
    }

    if (!nombre_template) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'Debe indicar el nombre del template.',
      });
    }

    if (!fecha_programada) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'Debe indicar fecha y hora programada.',
      });
    }

    // ==========================================
    // 2.1) Validar timezone + convertir fecha local => UTC (Luxon)
    // ==========================================
    const tz = String(timezone || 'America/Guayaquil').trim();

    const dtLocal = DateTime.fromSQL(String(fecha_programada), { zone: tz });

    if (!dtLocal.isValid) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'fecha_programada o timezone no es válido.',
        error: dtLocal.invalidExplanation || dtLocal.invalidReason || null,
      });
    }

    const fecha_programada_utc = dtLocal
      .toUTC()
      .toFormat('yyyy-LL-dd HH:mm:ss');

    // ==========================================
    // 3) Obtener config real desde BD (preferido)
    // ==========================================
    const cfg = await getConfigFromDB(id_configuracion);
    if (!cfg) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'Configuración inválida o suspendida.',
      });
    }

    waba_id = cfg.WABA_ID || waba_id;
    business_phone_id = cfg.PHONE_NUMBER_ID || business_phone_id;

    if (!business_phone_id || !waba_id || !cfg.ACCESS_TOKEN) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'La configuración no tiene credenciales completas (WABA / token / phone_number_id).',
      });
    }

    // ==========================================
    // 4) Extraer placeholders automáticamente desde graphBody
    // ==========================================
    if (
      graphBody?.template?.components &&
      Array.isArray(graphBody.template.components)
    ) {
      const comps = graphBody.template.components;

      if (!template_parameters.length) {
        const bodyComp = comps.find((c) => c?.type === 'body');
        if (bodyComp?.parameters && Array.isArray(bodyComp.parameters)) {
          template_parameters = bodyComp.parameters.map((p) => {
            if (p?.type === 'text') return p.text ?? '';
            return p?.text ?? p?.value ?? '';
          });
        }
      }

      if (header_parameters == null) {
        const headerComp = comps.find((c) => c?.type === 'header');
        if (headerComp?.parameters && Array.isArray(headerComp.parameters)) {
          const first = headerComp.parameters[0];
          if (first?.type === 'text') {
            header_parameters = headerComp.parameters.map((p) => p?.text ?? '');
          }
        }
      }
    }

    if (!Array.isArray(template_parameters)) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'template_parameters debe ser un array.',
      });
    }

    if (header_parameters != null && !Array.isArray(header_parameters)) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'header_parameters debe ser array o null.',
      });
    }

    // ==========================================
    // 5) Procesar header media para PROGRAMACIÓN
    //    VIDEO → Video API | IMAGE/DOCUMENT → S3
    // ==========================================
    let scheduledHeaderInfo = {
      header_format: header_format || null,
      header_media_url: header_media_url || null,
      header_media_name: header_media_name || null,
      file_info: null,
    };

    if (req.file || req.body?.header_default_asset) {
      try {
        const prepared = await prepareHeaderAssetForScheduling({
          req,
          preferVideoConversion: true,
          jwtToken: extractBearerToken(req), // ← pasa el JWT para Video API
        });

        scheduledHeaderInfo = {
          header_format: prepared.header_format ?? header_format ?? null,
          header_media_url:
            prepared.header_media_url ?? header_media_url ?? null,
          header_media_name:
            prepared.header_media_name ?? header_media_name ?? null,
          file_info: prepared.file_info ?? null,
        };
      } catch (err) {
        await t.rollback();
        return res.status(err.statusCode || 400).json({
          ok: false,
          msg: 'Error procesando el header del template para programación.',
          step: err.code || 'prepare_header_for_schedule',
          error: err.message,
          extra: err.extra || null,
        });
      }
    } else {
      if (header_format) {
        scheduledHeaderInfo.header_format = String(header_format).toUpperCase();
      }
    }

    if (scheduledHeaderInfo.header_format) {
      scheduledHeaderInfo.header_format = String(
        scheduledHeaderInfo.header_format,
      ).toUpperCase();
    }

    if (
      ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(
        String(scheduledHeaderInfo.header_format || '').toUpperCase(),
      ) &&
      !scheduledHeaderInfo.header_media_url
    ) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'Header media requiere header_media_url (archivo/manual/default asset).',
      });
    }

    if (
      String(scheduledHeaderInfo.header_format || '').toUpperCase() ===
        'TEXT' &&
      (!Array.isArray(header_parameters) || !header_parameters.length)
    ) {
      header_parameters = Array.isArray(header_parameters)
        ? header_parameters
        : [];
    }

    // ==========================================
    // 6) Obtener clientes seleccionados válidos
    // ==========================================
    const selectedIds = selected
      .map((x) => Number(x))
      .filter((x) => Number.isInteger(x) && x > 0);

    if (!selectedIds.length) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'La selección de clientes no contiene IDs válidos.',
      });
    }

    const placeholders = selectedIds.map(() => '?').join(',');

    const clientes = await db.query(
      `
      SELECT 
        id,
        celular_cliente
      FROM clientes_chat_center
      WHERE id_configuracion = ?
        AND id IN (${placeholders})
      `,
      {
        replacements: [id_configuracion, ...selectedIds],
        type: db.QueryTypes.SELECT,
        transaction: t,
      },
    );

    if (!clientes.length) {
      await t.rollback();
      return res.status(404).json({
        ok: false,
        msg: 'No se encontraron clientes válidos para programar.',
      });
    }

    const clientesValidos = clientes
      .map((c) => ({
        id: c.id,
        telefono: onlyDigits(c.celular_cliente || ''),
      }))
      .filter((c) => c.telefono && c.telefono.length >= 8);

    if (!clientesValidos.length) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'Los clientes seleccionados no tienen teléfonos válidos.',
      });
    }

    // ==========================================
    // 7) Generar lote e insertar programados
    // ==========================================
    const uuid_lote = crypto.randomUUID
      ? crypto.randomUUID()
      : `lote_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    const rows = clientesValidos.map((c) => ({
      uuid_lote,
      id_configuracion,
      id_usuario,
      id_cliente_chat_center: c.id,
      telefono: c.telefono,
      telefono_configuracion: telefono_configuracion || null,
      business_phone_id: business_phone_id || null,
      waba_id: waba_id || null,
      nombre_template: nombre_template,
      language_code: language_code || 'es',
      template_parameters_json: JSON.stringify(template_parameters || []),
      header_format: scheduledHeaderInfo.header_format || null,
      header_parameters_json: Array.isArray(header_parameters)
        ? JSON.stringify(header_parameters)
        : null,
      header_media_url: scheduledHeaderInfo.header_media_url || null,
      header_media_name: scheduledHeaderInfo.header_media_name || null,
      fecha_programada: dtLocal.toFormat('yyyy-LL-dd HH:mm:ss'),
      fecha_programada_utc,
      timezone: tz,
      meta_json: meta ? JSON.stringify(meta) : null,
    }));

    const insertColumns = [
      'uuid_lote',
      'id_configuracion',
      'id_usuario',
      'id_cliente_chat_center',
      'telefono',
      'telefono_configuracion',
      'business_phone_id',
      'waba_id',
      'nombre_template',
      'language_code',
      'template_parameters_json',
      'header_format',
      'header_parameters_json',
      'header_media_url',
      'header_media_name',
      'fecha_programada',
      'fecha_programada_utc',
      'timezone',
      'meta_json',
    ];

    const valuesSql = rows
      .map(() => `(${insertColumns.map(() => '?').join(',')})`)
      .join(',');

    const flatValues = rows.flatMap((r) => [
      r.uuid_lote,
      r.id_configuracion,
      r.id_usuario,
      r.id_cliente_chat_center,
      r.telefono,
      r.telefono_configuracion,
      r.business_phone_id,
      r.waba_id,
      r.nombre_template,
      r.language_code,
      r.template_parameters_json,
      r.header_format,
      r.header_parameters_json,
      r.header_media_url,
      r.header_media_name,
      r.fecha_programada,
      r.fecha_programada_utc,
      r.timezone,
      r.meta_json,
    ]);

    await db.query(
      `
      INSERT INTO template_envios_programados (
        ${insertColumns.join(', ')}
      ) VALUES ${valuesSql}
      `,
      {
        replacements: flatValues,
        type: db.QueryTypes.INSERT,
        transaction: t,
      },
    );

    await t.commit();

    // ==========================================
    // 8) Emitir evento socket en tiempo real
    // ==========================================
    try {
      const io = global.io;

      if (io) {
        const nowIso = new Date().toISOString();

        for (const r of rows) {
          const room = `chat_programados:${Number(r.id_configuracion)}:${Number(r.id_cliente_chat_center)}`;

          io.to(room).emit('PROGRAMADO_ESTADO', {
            id: null,
            ui_key: `${r.uuid_lote}:${r.id_cliente_chat_center}:${r.telefono}:${r.fecha_programada}`,
            uuid_lote: r.uuid_lote,

            id_configuracion: Number(r.id_configuracion),
            id_usuario: r.id_usuario != null ? Number(r.id_usuario) : null,
            id_cliente_chat_center: Number(r.id_cliente_chat_center),

            telefono: r.telefono,
            telefono_configuracion: r.telefono_configuracion,
            business_phone_id: r.business_phone_id,
            waba_id: r.waba_id,

            nombre_template: r.nombre_template,
            language_code: r.language_code,

            template_parameters_json: (() => {
              try {
                return JSON.parse(r.template_parameters_json || '[]');
              } catch {
                return [];
              }
            })(),

            header_format: r.header_format || null,

            header_parameters_json: (() => {
              try {
                return r.header_parameters_json
                  ? JSON.parse(r.header_parameters_json)
                  : null;
              } catch {
                return null;
              }
            })(),

            header_media_url: r.header_media_url || null,
            header_media_name: r.header_media_name || null,

            fecha_programada: r.fecha_programada,
            fecha_programada_utc: r.fecha_programada_utc,
            timezone: r.timezone,

            estado: 'pendiente',
            intentos: 0,
            max_intentos: 3,
            error_message: null,

            meta_json: (() => {
              try {
                return r.meta_json ? JSON.parse(r.meta_json) : null;
              } catch {
                return null;
              }
            })(),

            id_wamid_mensaje: null,
            enviado_en: null,

            creado_en: nowIso,
            actualizado_en: nowIso,

            source: 'programacion_creada',
          });
        }
      }
    } catch (emitErr) {
      console.warn('⚠️ Error emitiendo PROGRAMADO_ESTADO:', emitErr.message);
    }

    return res.json({
      ok: true,
      msg: 'Envío programado correctamente.',
      data: {
        uuid_lote,
        total_solicitados: selectedIds.length,
        total_programados: rows.length,
        total_descartados: selectedIds.length - rows.length,
        nombre_template,
        language_code,
        fecha_programada: dtLocal.toFormat('yyyy-LL-dd HH:mm:ss'),
        fecha_programada_utc,
        timezone: tz,
        header: {
          header_format: scheduledHeaderInfo.header_format || null,
          header_media_url: scheduledHeaderInfo.header_media_url || null,
          header_media_name: scheduledHeaderInfo.header_media_name || null,
          file_info: scheduledHeaderInfo.file_info || null,
        },
      },
    });
  } catch (error) {
    await t.rollback();
    console.error('❌ programarTemplateMasivo:', error);

    return res.status(500).json({
      ok: false,
      msg: 'Error al programar el envío masivo.',
      error: error.message,
    });
  }
};

exports.listarProgramadosPorChat = async (req, res) => {
  try {
    const id_configuracion = Number(req.query?.id_configuracion || 0) || null;
    const id_cliente_chat_center =
      Number(req.query?.id_cliente_chat_center || 0) || null;

    const limit = Math.min(Number(req.query?.limit || 50) || 50, 200);

    if (!id_configuracion || !id_cliente_chat_center) {
      return res.status(400).json({
        ok: false,
        msg: 'Faltan parámetros: id_configuracion, id_cliente_chat_center',
      });
    }

    const rows = await db.query(
      `
      SELECT
        id,
        uuid_lote,
        id_configuracion,
        id_usuario,
        id_cliente_chat_center,
        telefono,
        telefono_configuracion,
        business_phone_id,
        waba_id,
        nombre_template,
        language_code,
        template_parameters_json,
        header_format,
        header_parameters_json,
        header_media_url,
        header_media_name,
        fecha_programada,
        fecha_programada_utc,
        timezone,
        estado,
        intentos,
        max_intentos,
        error_message,
        meta_json,
        id_wamid_mensaje,
        enviado_en,
        creado_en,
        actualizado_en
      FROM template_envios_programados
      WHERE id_configuracion = ?
        AND id_cliente_chat_center = ?
      ORDER BY creado_en DESC
      LIMIT ?
      `,
      {
        replacements: [id_configuracion, id_cliente_chat_center, limit],
        type: db.QueryTypes.SELECT,
      },
    );

    const data = rows.map((r) => ({
      ...r,
      template_parameters_json: parseMaybeJSON(r.template_parameters_json, []),
      header_parameters_json: parseMaybeJSON(r.header_parameters_json, null),
      meta_json: parseMaybeJSON(r.meta_json, null),
    }));

    return res.json({
      ok: true,
      data: data.reverse(), // opcional: dejar ascendente para render timeline
    });
  } catch (error) {
    console.error('❌ listarProgramadosPorChat:', error);
    return res.status(500).json({
      ok: false,
      msg: 'Error al listar mensajes programados del chat.',
      error: error.message,
    });
  }
};

exports.listarProgramadosPorConfig = async (req, res) => {
  try {
    const id_configuracion = Number(req.query?.id_configuracion || 0) || null;
    const limit = Math.min(Number(req.query?.limit || 10) || 10, 100); // lotes por página
    const page = Math.max(Number(req.query?.page || 1) || 1, 1);
    const offset = (page - 1) * limit;

    if (!id_configuracion) {
      return res.status(400).json({
        ok: false,
        msg: 'Faltan parámetros: id_configuracion',
      });
    }

    // 1) Contar total de lotes distintos
    const [countRow] = await db.query(
      `
      SELECT COUNT(DISTINCT uuid_lote) AS total_lotes
      FROM template_envios_programados
      WHERE id_configuracion = ?
      `,
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      },
    );

    const totalLotes = countRow?.total_lotes || 0;
    const totalPages = Math.ceil(totalLotes / limit);

    // 2) Obtener los uuid_lote de la página actual (paginación por lote)
    const lotesPage = await db.query(
      `
      SELECT uuid_lote
      FROM template_envios_programados
      WHERE id_configuracion = ?
      GROUP BY uuid_lote
      ORDER BY MAX(creado_en) DESC
      LIMIT ? OFFSET ?
      `,
      {
        replacements: [id_configuracion, limit, offset],
        type: db.QueryTypes.SELECT,
      },
    );

    if (lotesPage.length === 0) {
      return res.json({
        ok: true,
        data: [],
        pagination: { page, limit, totalLotes, totalPages },
      });
    }

    const uuids = lotesPage.map((r) => r.uuid_lote);

    // 3) Traer TODOS los registros de esos lotes
    const rows = await db.query(
      `
      SELECT
        tep.id,
        tep.uuid_lote,
        tep.id_configuracion,
        tep.id_usuario,
        tep.id_cliente_chat_center,
        tep.telefono,
        tep.telefono_configuracion,
        tep.business_phone_id,
        tep.waba_id,
        tep.nombre_template,
        tep.language_code,
        tep.template_parameters_json,
        tep.header_format,
        tep.header_parameters_json,
        tep.header_media_url,
        tep.header_media_name,
        tep.fecha_programada,
        tep.fecha_programada_utc,
        tep.timezone,
        tep.estado,
        tep.intentos,
        tep.max_intentos,
        tep.error_message,
        tep.meta_json,
        tep.id_wamid_mensaje,
        tep.enviado_en,
        tep.creado_en,
        tep.actualizado_en,

        ccc.nombre_cliente,
        ccc.apellido_cliente,
        ccc.email_cliente

      FROM template_envios_programados tep
      LEFT JOIN clientes_chat_center ccc
        ON ccc.id = tep.id_cliente_chat_center

      WHERE tep.uuid_lote IN (?)
      ORDER BY tep.creado_en DESC
      `,
      {
        replacements: [uuids],
        type: db.QueryTypes.SELECT,
      },
    );

    const data = rows.map((r) => ({
      ...r,
      template_parameters_json: parseMaybeJSON(r.template_parameters_json, []),
      header_parameters_json: parseMaybeJSON(r.header_parameters_json, null),
      meta_json: parseMaybeJSON(r.meta_json, null),
    }));

    return res.json({
      ok: true,
      data,
      pagination: {
        page,
        limit,
        totalLotes,
        totalPages,
      },
    });
  } catch (error) {
    console.error('❌ listarProgramadosPorConfig:', error);
    return res.status(500).json({
      ok: false,
      msg: 'Error al listar mensajes programados.',
      error: error.message,
    });
  }
};

exports.enviarVideoWhatsappFile = async (req, res) => {
  const { jwt_servidor, wa_token, phone_number_id } = req.body;

  if (!req.file || !wa_token || !phone_number_id) {
    return res.status(400).json({
      status: 400,
      message: 'Faltan campos: file, wa_token, phone_number_id',
    });
  }

  try {
    console.log(
      '[WA_VIDEO] Recibido file:',
      req.file.originalname,
      req.file.mimetype,
      req.file.size,
    );

    // Buffer del archivo recibido
    const videoBuffer = req.file.buffer;

    // Convertir a H.264/AAC compatible con WhatsApp
    const videoOriginalSizeMB = videoBuffer.length / (1024 * 1024);
    console.log(
      `[WA_VIDEO] Tamaño original: ${videoOriginalSizeMB.toFixed(2)} MB`,
    );
    let convertedBuffer = videoBuffer;
    try {
      console.log('[WA_VIDEO] Convirtiendo video...');
      convertedBuffer = await convertVideoForWhatsApp(
        videoBuffer,
        req.file.originalname,
      );
      console.log(
        '[WA_VIDEO] Conversión OK. Tamaño:',
        (convertedBuffer.length / (1024 * 1024)).toFixed(2),
        'MB',
      );
    } catch (convErr) {
      if (convErr.isOversized || videoOriginalSizeMB > 15) {
        const msg = convErr.isOversized
          ? convErr.message
          : `El video pesa ${videoOriginalSizeMB.toFixed(2)}MB y no se pudo comprimir por debajo de 15MB. Enviá un video más corto o de menor resolución.`;
        console.error('[WA_VIDEO] Video demasiado pesado:', msg);
        return res.status(400).json({ status: 400, message: msg });
      }
      console.warn(
        '[WA_VIDEO] Conversión fallida, usando original:',
        convErr.message,
      );
    }

    // Subir a WhatsApp
    console.log('[WA_VIDEO] Subiendo a WhatsApp...');
    const uploadForm = new FormData();
    uploadForm.append('file', convertedBuffer, {
      filename: 'video.mp4',
      contentType: 'video/mp4',
    });
    uploadForm.append('type', 'video/mp4');
    uploadForm.append('messaging_product', 'whatsapp');

    const uploadResponse = await axios.post(
      `https://graph.facebook.com/v19.0/${phone_number_id}/media`,
      uploadForm,
      {
        headers: {
          Authorization: `Bearer ${wa_token}`,
          ...uploadForm.getHeaders(),
        },
        timeout: 120000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      },
    );

    const media_id = uploadResponse.data?.id;
    if (!media_id) throw new Error('WhatsApp no retornó media_id');

    console.log('[WA_VIDEO] ✅ media_id:', media_id);
    return res.json({ status: 200, media_id });
  } catch (err) {
    console.error('[WA_VIDEO] Error:', err?.response?.data || err.message);
    return res.status(500).json({
      status: 500,
      message: err?.response?.data?.error?.message || err.message,
    });
  }
};
