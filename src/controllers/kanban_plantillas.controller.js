const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');

const { getConfigFromDB } = require('../utils/whatsappTemplate.helpers');
const {
  syncCatalogoTodasColumnasConfig,
} = require('../services/syncCatalogoKanbanColumna.service');

const {
  compilarPromptFinal,
  validarPersonalizacion,
} = require('../utils/promptCompiler');

const axios = require('axios');

// ──────────────────────────────────────────────────────────────
// CONSTANTES
// ──────────────────────────────────────────────────────────────

// IDs de configuraciones que pueden ver plantillas internas/de pruebas.
// Para escalar más adelante: reemplazar con un campo en BD o un flag de
// "rol: superadmin" en la tabla configuraciones.
const CONFIGS_INTERNAS = [312];

// Nombre identificador de plantillas internas (no visibles para clientes).
// Cualquier plantilla con este string en su nombre se filtra del listado
// público.
const PLANTILLA_INTERNA_TAG = 'PRUEBAS DANIEL';

// ── Plantillas hardcodeadas ───────────────────────────────────
const PLANTILLAS = {};

// ── GET plantillas disponibles ────────────────────────────────
exports.listar = catchAsync(async (req, res) => {
  const lista = Object.entries(PLANTILLAS).map(([key, p]) => ({
    key,
    nombre: p.nombre,
    descripcion: p.descripcion,
    total_columnas: p.columnas.length,
    columnas_ia: p.columnas.filter((c) => c.activa_ia).length,
  }));
  return res.json({ success: true, data: lista });
});

// ── POST aplicar plantilla ─────────────────────────────────────
exports.aplicar = catchAsync(async (req, res, next) => {
  const { id_configuracion, plantilla_key, empresa } = req.body;

  if (!id_configuracion || !plantilla_key || !empresa) {
    return next(new AppError('Faltan campos obligatorios', 400));
  }

  const [configRow] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  const api_key_openai = configRow?.api_key_openai || null;

  if (!api_key_openai) {
    return next(new AppError('No hay API key de OpenAI configurada', 400));
  }

  const plantilla = PLANTILLAS[plantilla_key];
  if (!plantilla) return next(new AppError('Plantilla no encontrada', 404));

  const prompts = getPrompts(empresa);
  const headers = {
    Authorization: `Bearer ${api_key_openai}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };

  const resultado = [];

  for (const col of plantilla.columnas) {
    let assistant_id = null;
    if (col.prompt_key && prompts[col.prompt_key] && api_key_openai) {
      try {
        const aRes = await axios.post(
          'https://api.openai.com/v1/assistants',
          {
            name: `${col.nombre} - ${empresa}`,
            instructions: prompts[col.prompt_key],
            model: col.modelo || 'gpt-4o-mini',
            tools: [{ type: 'file_search' }],
          },
          { headers },
        );
        assistant_id = aRes.data?.id || null;
      } catch (err) {
        console.error(
          `Error creando asistente para ${col.nombre}:`,
          err.message,
        );
      }
    }

    const [insertResult] = await db.query(
      `INSERT INTO kanban_columnas
       (id_configuracion, nombre, estado_db, color_fondo, color_texto,
        icono, orden, activo, es_estado_final, activa_ia, max_tokens,
        assistant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_configuracion,
          col.nombre,
          col.estado_db,
          col.color_fondo,
          col.color_texto,
          col.icono,
          col.orden,
          col.activo,
          col.es_estado_final,
          col.activa_ia,
          col.max_tokens,
          assistant_id,
        ],
        type: db.QueryTypes.INSERT,
      },
    );

    const id_columna = insertResult;

    for (const accion of col.acciones) {
      await db.query(
        `INSERT INTO kanban_acciones
         (id_kanban_columna, id_configuracion, tipo_accion, config, activo, orden)
         VALUES (?, ?, ?, ?, 1, ?)`,
        {
          replacements: [
            id_columna,
            id_configuracion,
            accion.tipo_accion,
            JSON.stringify(accion.config),
            accion.orden,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
    }

    resultado.push({
      columna: col.nombre,
      estado_db: col.estado_db,
      assistant_id,
      acciones: col.acciones.length,
    });
  }

  await db.query(
    `UPDATE configuraciones SET tipo_configuracion = 'kanban' WHERE id = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.UPDATE },
  );

  return res.json({
    success: true,
    message: `Plantilla "${plantilla.nombre}" aplicada correctamente`,
    data: resultado,
  });
});

exports.reiniciar = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));

  const [config] = await db.query(
    `SELECT kanban_global_id FROM configuraciones WHERE id = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  const id_plantilla = config?.kanban_global_id;

  const columnas = await db.query(
    `SELECT id FROM kanban_columnas WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (columnas.length) {
    const ids = columnas.map((c) => c.id);

    await db.query(
      `DELETE FROM kanban_acciones WHERE id_kanban_columna IN (${ids.join(',')})`,
      { type: db.QueryTypes.DELETE },
    );
  }

  await db.query(`DELETE FROM kanban_columnas WHERE id_configuracion = ?`, {
    replacements: [id_configuracion],
    type: db.QueryTypes.DELETE,
  });

  await db.query(
    `DELETE FROM configuracion_remarketing WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.DELETE },
  );

  await db.query(
    `UPDATE configuraciones 
     SET kanban_global_activo = 0, kanban_global_id = NULL
     WHERE id = ?`,
    { replacements: [id_configuracion] },
  );

  if (id_plantilla) {
    await db.query(
      `INSERT INTO configuraciones_kanban_global_log
     (id_configuracion, id_plantilla, accion, detalle)
     VALUES (?, ?, 'eliminado', ?)`,
      {
        replacements: [
          id_configuracion,
          id_plantilla,
          JSON.stringify({
            motivo: 'reinicio_manual',
            columnas_eliminadas: columnas.length,
          }),
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  }
  return res.json({
    success: true,
    message: 'Configuración reiniciada',
  });
});

// ── Guardar plantilla del cliente ─────────────────────────────
exports.guardarCliente = catchAsync(async (req, res, next) => {
  const { id_configuracion, nombre, descripcion } = req.body;
  if (!id_configuracion || !nombre)
    return next(new AppError('Faltan campos obligatorios', 400));

  const columnas = await db.query(
    `SELECT id, nombre, estado_db, color_fondo, color_texto, icono,
          orden, activo, es_estado_final, activa_ia, max_tokens,
          instrucciones, modelo
   FROM kanban_columnas
   WHERE id_configuracion = ? AND activo = 1
   ORDER BY orden ASC`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (!columnas.length)
    return next(new AppError('No hay columnas para guardar', 400));

  const ids = columnas.map((c) => c.id);
  const acciones = await db.query(
    `SELECT id_kanban_columna, tipo_accion, config, orden
     FROM kanban_acciones
     WHERE id_kanban_columna IN (${ids.join(',')}) AND activo = 1
     ORDER BY orden ASC`,
    { type: db.QueryTypes.SELECT },
  );

  const data = {
    columnas: columnas.map((col) => ({
      nombre: col.nombre,
      estado_db: col.estado_db,
      color_fondo: col.color_fondo,
      color_texto: col.color_texto,
      icono: col.icono,
      orden: col.orden,
      activo: col.activo,
      es_estado_final: col.es_estado_final,
      activa_ia: col.activa_ia,
      max_tokens: col.max_tokens,
      instrucciones: col.instrucciones || null,
      modelo: col.modelo || 'gpt-4o-mini',
      acciones: acciones
        .filter((a) => a.id_kanban_columna === col.id)
        .map((a) => ({
          tipo_accion: a.tipo_accion,
          config:
            typeof a.config === 'string' ? JSON.parse(a.config) : a.config,
          orden: a.orden,
        })),
    })),
  };

  await db.query(
    `INSERT INTO kanban_plantillas_guardadas
     (id_configuracion, nombre, descripcion, data)
     VALUES (?, ?, ?, ?)`,
    {
      replacements: [
        id_configuracion,
        nombre.trim(),
        descripcion?.trim() || null,
        JSON.stringify(data),
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  return res.json({ success: true, message: 'Plantilla guardada' });
});

// ── Listar plantillas guardadas del cliente ───────────────────
exports.listarCliente = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));

  const plantillas = await db.query(
    `SELECT id, nombre, descripcion, created_at, data,
          JSON_LENGTH(JSON_EXTRACT(data, '$.columnas')) AS total_columnas
   FROM kanban_plantillas_guardadas
   WHERE id_configuracion = ?
   ORDER BY created_at DESC`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  return res.json({
    success: true,
    data: plantillas.map((p) => {
      const parsed = typeof p.data === 'string' ? JSON.parse(p.data) : p.data;
      const total_prompts = (parsed?.columnas || []).filter(
        (c) => c.instrucciones,
      ).length;
      return {
        ...p,
        data: undefined,
        total_columnas: p.total_columnas,
        total_prompts,
      };
    }),
  });
});

// ── Aplicar plantilla guardada ────────────────────────────────
exports.aplicarCliente = catchAsync(async (req, res, next) => {
  const { id_configuracion, id_plantilla } = req.body;
  if (!id_configuracion || !id_plantilla)
    return next(new AppError('Faltan campos obligatorios', 400));

  const [plantilla] = await db.query(
    `SELECT data FROM kanban_plantillas_guardadas WHERE id = ? LIMIT 1`,
    { replacements: [id_plantilla], type: db.QueryTypes.SELECT },
  );
  if (!plantilla) return next(new AppError('Plantilla no encontrada', 404));

  const [configRow] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const api_key_openai = configRow?.api_key_openai || null;

  const headers = api_key_openai
    ? {
        Authorization: `Bearer ${api_key_openai}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2',
      }
    : null;

  const { columnas } =
    typeof plantilla.data === 'string'
      ? JSON.parse(plantilla.data)
      : plantilla.data;

  const resultado = [];

  for (const col of columnas) {
    const [existente] = await db.query(
      `SELECT id FROM kanban_columnas 
     WHERE id_configuracion = ? AND estado_db = ? LIMIT 1`,
      {
        replacements: [id_configuracion, col.estado_db],
        type: db.QueryTypes.SELECT,
      },
    );

    if (existente) {
      resultado.push({
        columna: col.nombre,
        estado_db: col.estado_db,
        assistant_id: null,
        omitida: true,
      });
      continue;
    }

    let assistant_id = null;
    if (col.instrucciones && headers) {
      try {
        const aRes = await axios.post(
          'https://api.openai.com/v1/assistants',
          {
            name: col.nombre,
            instructions: col.instrucciones,
            model: col.modelo || 'gpt-4o-mini',
            tools: [{ type: 'file_search' }],
          },
          { headers },
        );
        assistant_id = aRes.data?.id || null;
      } catch (err) {
        console.error(`Error creando asistente ${col.nombre}:`, err.message);
      }
    }

    const [insertResult] = await db.query(
      `INSERT INTO kanban_columnas
     (id_configuracion, nombre, estado_db, color_fondo, color_texto,
      icono, orden, activo, es_estado_final, activa_ia, max_tokens,
      instrucciones, modelo, assistant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_configuracion,
          col.nombre,
          col.estado_db,
          col.color_fondo,
          col.color_texto,
          col.icono,
          col.orden,
          col.activo,
          col.es_estado_final,
          col.activa_ia,
          col.max_tokens,
          col.instrucciones || null,
          col.modelo || 'gpt-4o-mini',
          assistant_id,
        ],
        type: db.QueryTypes.INSERT,
      },
    );

    for (const accion of col.acciones || []) {
      await db.query(
        `INSERT INTO kanban_acciones
       (id_kanban_columna, id_configuracion, tipo_accion, config, activo, orden)
       VALUES (?, ?, ?, ?, 1, ?)`,
        {
          replacements: [
            insertResult,
            id_configuracion,
            accion.tipo_accion,
            JSON.stringify(accion.config),
            accion.orden,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
    }

    resultado.push({
      columna: col.nombre,
      estado_db: col.estado_db,
      assistant_id,
    });
  }

  return res.json({ success: true, data: resultado });
});

// ── Eliminar plantilla guardada ───────────────────────────────
exports.eliminarCliente = catchAsync(async (req, res, next) => {
  const { id, id_configuracion } = req.body;
  if (!id || !id_configuracion) return next(new AppError('Faltan campos', 400));

  await db.query(
    `DELETE FROM kanban_plantillas_guardadas WHERE id = ? AND id_configuracion = ?`,
    { replacements: [id, id_configuracion], type: db.QueryTypes.DELETE },
  );

  return res.json({ success: true });
});

/* seccion de plantillas globales */
// ── Guardar plantilla global (solo superadmin) ─────────────
exports.guardarGlobal = catchAsync(async (req, res, next) => {
  const { id_configuracion, nombre, descripcion, icono, color } = req.body;
  if (!id_configuracion || !nombre)
    return next(new AppError('Faltan campos obligatorios', 400));

  const columnas = await db.query(
    `SELECT id, nombre, estado_db, color_fondo, color_texto, icono,
          orden, activo, es_estado_final, es_principal, es_dropi_principal, activa_ia, max_tokens,
          instrucciones, modelo
   FROM kanban_columnas
   WHERE id_configuracion = ? AND activo = 1
   ORDER BY orden ASC`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (!columnas.length)
    return next(new AppError('No hay columnas para guardar', 400));

  const ids = columnas.map((c) => c.id);
  const acciones = await db.query(
    `SELECT id_kanban_columna, tipo_accion, config, orden
     FROM kanban_acciones
     WHERE id_kanban_columna IN (${ids.join(',')}) AND activo = 1
     ORDER BY orden ASC`,
    { type: db.QueryTypes.SELECT },
  );

  const data = {
    columnas: columnas.map((col) => ({
      nombre: col.nombre,
      estado_db: col.estado_db,
      color_fondo: col.color_fondo,
      color_texto: col.color_texto,
      icono: col.icono,
      orden: col.orden,
      activo: col.activo,
      es_estado_final: col.es_estado_final,
      es_principal: col.es_principal || 0,
      es_dropi_principal: col.es_dropi_principal || 0,
      activa_ia: col.activa_ia,
      max_tokens: col.max_tokens,
      instrucciones: col.instrucciones || null,
      modelo: col.modelo || 'gpt-4o-mini',
      acciones: acciones
        .filter((a) => a.id_kanban_columna === col.id)
        .map((a) => ({
          tipo_accion: a.tipo_accion,
          config:
            typeof a.config === 'string' ? JSON.parse(a.config) : a.config,
          orden: a.orden,
        })),
    })),
  };

  await db.query(
    `INSERT INTO kanban_plantillas_globales
     (nombre, descripcion, icono, color, data, creado_por)
     VALUES (?, ?, ?, ?, ?, ?)`,
    {
      replacements: [
        nombre.trim(),
        descripcion?.trim() || null,
        icono || 'bx bx-layout',
        color || '#6366f1',
        JSON.stringify(data),
        id_configuracion,
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  return res.json({ success: true, message: 'Plantilla global guardada' });
});

// ── Listar plantillas globales ─────────────────────────────
// ═══ FILTRO DEFENSIVO: las plantillas con tag interno (PLANTILLA_INTERNA_TAG)
// solo se devuelven a configs internas (CONFIGS_INTERNAS).
// ═══
exports.listarGlobales = catchAsync(async (req, res) => {
  const { id_configuracion } = req.body || {};
  const esConfigInterna = CONFIGS_INTERNAS.includes(Number(id_configuracion));

  // Si la config es interna, no excluye nada. Si no, excluye plantillas internas.
  const whereExtra = esConfigInterna
    ? ''
    : `AND nombre NOT LIKE '%${PLANTILLA_INTERNA_TAG}%'`;

  const plantillas = await db.query(
    `SELECT id, nombre, descripcion, icono, color, created_at,
            JSON_LENGTH(JSON_EXTRACT(data, '$.columnas')) AS total_columnas,
            data
     FROM kanban_plantillas_globales
     WHERE activo = 1
       ${whereExtra}
     ORDER BY created_at DESC`,
    { type: db.QueryTypes.SELECT },
  );

  const resultado = plantillas.map((p) => {
    const parsed = typeof p.data === 'string' ? JSON.parse(p.data) : p.data;
    const cols = parsed?.columnas || [];

    const columnas_ia = cols.filter((c) => c.activa_ia).length;

    const columnasPreview = cols
      .slice()
      .sort((a, b) => (a.orden || 0) - (b.orden || 0))
      .map((c) => ({
        nombre: c.nombre,
        estado_db: c.estado_db,
        color_fondo: c.color_fondo,
        color_texto: c.color_texto,
        icono: c.icono,
        orden: c.orden,
        activa_ia: !!c.activa_ia,
        es_estado_final: !!c.es_estado_final,
      }));

    return {
      id: p.id,
      nombre: p.nombre,
      descripcion: p.descripcion,
      icono: p.icono,
      color: p.color,
      created_at: p.created_at,
      total_columnas: p.total_columnas,
      columnas_ia,
      columnas: columnasPreview,
      tipo: 'global',
    };
  });

  return res.json({ success: true, data: resultado });
});

const mediaCache = new Map();

async function getBufferFromUrl(url) {
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 15000,
  });
  return Buffer.from(resp.data);
}

function getMimeType(format) {
  if (format === 'VIDEO') return 'video/mp4';
  if (format === 'IMAGE') return 'image/jpeg';
  if (format === 'DOCUMENT') return 'application/pdf';
  return 'application/octet-stream';
}

const FB_APP_ID = process.env.FB_APP_ID;

async function uploadResumableAndGetHandle({
  accessToken,
  fileBuffer,
  mimeType,
  fileName,
}) {
  if (!FB_APP_ID) {
    throw new Error('Falta FB_APP_ID');
  }

  const ax = axios.create({
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 30000,
    validateStatus: () => true,
  });

  const startUrl = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${FB_APP_ID}/uploads`;
  const startResp = await ax.post(startUrl, null, {
    params: {
      file_length: fileBuffer.length,
      file_type: mimeType,
      file_name: fileName,
    },
  });

  if (startResp.status < 200 || startResp.status >= 300) {
    throw new Error(
      `No se pudo iniciar upload session: ${startResp.status} ${JSON.stringify(startResp.data)}`,
    );
  }

  const uploadSessionId = startResp.data?.id;
  if (!uploadSessionId) {
    throw new Error(`Upload session sin id: ${JSON.stringify(startResp.data)}`);
  }

  const uploadUrl = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${uploadSessionId}`;
  const uploadResp = await axios.post(uploadUrl, fileBuffer, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      file_offset: '0',
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (uploadResp.status < 200 || uploadResp.status >= 300) {
    throw new Error(
      `No se pudo subir archivo: ${uploadResp.status} ${JSON.stringify(uploadResp.data)}`,
    );
  }

  const handle = uploadResp.data?.h;
  if (!handle) {
    throw new Error(
      `Respuesta sin handle (h): ${JSON.stringify(uploadResp.data)}`,
    );
  }

  return handle;
}

async function prepareComponentsWithHandles(components, ACCESS_TOKEN) {
  const newComponents = [];

  for (const comp of components) {
    if (
      comp?.type === 'HEADER' &&
      ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(comp?.format) &&
      comp?.example?.header_handle?.[0]
    ) {
      const url = comp.example.header_handle[0];

      try {
        let handle;

        if (mediaCache.has(url)) {
          handle = mediaCache.get(url);
        } else {
          const buffer = await getBufferFromUrl(url);

          handle = await uploadResumableAndGetHandle({
            accessToken: ACCESS_TOKEN,
            fileBuffer: buffer,
            mimeType: getMimeType(comp.format),
            fileName: `file.${getMimeType(comp.format).split('/')[1]}`,
          });

          mediaCache.set(url, handle);
        }

        newComponents.push({
          ...comp,
          example: { header_handle: [handle] },
        });
      } catch (err) {
        throw new Error(`MEDIA_ERROR: ${url}`);
      }
    } else {
      newComponents.push(comp);
    }
  }

  return newComponents;
}

// ── Helpers internos ( solo retornan data) ──
async function _crearTemplatesMeta(id_configuracion) {
  const wabaConfig = await getConfigFromDB(id_configuracion);
  if (!wabaConfig?.WABA_ID || !wabaConfig?.ACCESS_TOKEN)
    return [{ status: 'skipped', mensaje: 'Sin config WABA' }];

  const { WABA_ID, ACCESS_TOKEN } = wabaConfig;

  let existentes = [];
  try {
    const { data } = await axios.get(
      `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${WABA_ID}/message_templates?access_token=${ACCESS_TOKEN}&limit=200`,
    );
    existentes = (data.data || []).map((p) => p.name);
  } catch (e) {
    console.error('Error listando templates:', e.message);
  }

  const resultados = [];

  for (const tpl of KANBAN_TEMPLATES_META) {
    if (existentes.includes(tpl.name)) {
      resultados.push({ nombre: tpl.name, status: 'omitido' });
      continue;
    }

    try {
      let componentsPrepared;

      try {
        componentsPrepared = await prepareComponentsWithHandles(
          tpl.components,
          ACCESS_TOKEN,
        );
      } catch (mediaError) {
        resultados.push({
          nombre: tpl.name,
          status: 'error_media',
          error: mediaError.message,
        });
        continue;
      }

      const payload = {
        name: tpl.name,
        language: tpl.language,
        category: tpl.category,
        components: componentsPrepared,
      };

      const r = await axios.post(
        `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${WABA_ID}/message_templates`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );

      resultados.push({
        nombre: tpl.name,
        status: 'success',
        id: r.data?.id,
      });
    } catch (err) {
      resultados.push({
        nombre: tpl.name,
        status: 'error',
        error: err.response?.data?.error?.message || err.message,
      });
    }
  }
  return resultados;
}

async function _crearRespuestasRapidas(id_configuracion) {
  let existentes = [];
  try {
    const rows = await db.query(
      `SELECT atajo FROM templates_chat_center WHERE id_configuracion = ?`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    existentes = rows.map((r) => r.atajo);
  } catch (e) {
    console.error('Error consultando existentes:', e.message);
  }

  const resultados = [];
  for (const rr of KANBAN_RESPUESTAS_RAPIDAS) {
    if (existentes.includes(rr.atajo)) {
      resultados.push({ atajo: rr.atajo, status: 'omitido' });
      continue;
    }
    try {
      const [insertId] = await db.query(
        `INSERT INTO templates_chat_center
         (atajo, mensaje, id_configuracion, tipo_mensaje, ruta_archivo, mime_type, file_name)
         VALUES (?, ?, ?, 'text', NULL, NULL, NULL)`,
        {
          replacements: [rr.atajo, rr.mensaje, id_configuracion],
          type: db.QueryTypes.INSERT,
        },
      );
      resultados.push({ atajo: rr.atajo, status: 'success', insertId });
    } catch (err) {
      resultados.push({ atajo: rr.atajo, status: 'error', error: err.message });
    }
  }
  return resultados;
}

// ── Helper: extraer body_text de un template del catálogo ──
function _getBodyTextFromKanbanTemplate(templateName) {
  const tpl = KANBAN_TEMPLATES_META.find((t) => t.name === templateName);
  if (!tpl) return null;
  const body = tpl.components.find((c) => c.type === 'BODY');
  return body?.text || null;
}

// ── Configuración por defecto de dropi_plantillas_config || Espejo exacto del setup necesario dropshipping───────
const DROPI_CONFIG_POR_DEFECTO = [
  {
    estado_dropi: 'PENDIENTE CONFIRMACION',
    nombre_template: 'confirmacion_pedido_k1',
    columna_destino: null,
    activo: 1,
    usar_respuesta_rapida: 1,
    mensaje_rapido: null,
    parametros: {
      body: ['nombre', 'costo', 'contenido', 'nombre', 'telefono', 'direccion'],
      buttons: [],
    },
  },
  {
    estado_dropi: 'PENDIENTE',
    nombre_template: 'antes_generar_guia_k1',
    columna_destino: 'generar_guia',
    activo: 1,
    usar_respuesta_rapida: 1,
    mensaje_rapido:
      'Perfecto, en este momento procedemos con su despacho, en un momento le comparto su guía de envío. 😊\nCualquier duda que tenga estoy para ayudarle 📦',
    parametros: null,
  },
  {
    estado_dropi: 'GUIA GENERADA',
    nombre_template: 'guia_generada_k1',
    columna_destino: 'guia_generada',
    activo: 1,
    usar_respuesta_rapida: 0,
    mensaje_rapido: null,
    parametros: {
      body: [],
      buttons: [
        { index: 0, variable: 'guia_pdf' },
        { index: 1, variable: 'numero_guia' },
      ],
    },
  },
  {
    estado_dropi: 'EN TRANSITO',
    nombre_template: 'zona_entrega_k1',
    columna_destino: 'en_transito',
    activo: 1,
    usar_respuesta_rapida: 0,
    mensaje_rapido: null,
    parametros: {
      body: ['ciudad', 'direccion', 'costo', 'tracking'],
      buttons: [],
    },
  },
  {
    estado_dropi: 'RETIRO EN AGENCIA',
    nombre_template: 'retiro_agencia_k1',
    columna_destino: 'retiro_agencia',
    activo: 1,
    usar_respuesta_rapida: 0,
    mensaje_rapido: null,
    parametros: { body: ['direccion'], buttons: [] },
  },
  {
    estado_dropi: 'NOVEDAD',
    nombre_template: 'novedadk2',
    columna_destino: 'novedad',
    activo: 1,
    usar_respuesta_rapida: 0,
    mensaje_rapido: null,
    parametros: null,
  },
];

// ── Aplicar config dropi por defecto (UPSERT — siempre sobreescribe) ──
async function _aplicarConfigDropiPorDefecto(id_configuracion) {
  const resultados = [];

  for (const cfg of DROPI_CONFIG_POR_DEFECTO) {
    try {
      const body_text =
        cfg.body_text ||
        _getBodyTextFromKanbanTemplate(cfg.nombre_template) ||
        null;

      const [existe] = await db.query(
        `SELECT id FROM dropi_plantillas_config
         WHERE id_configuracion = ? AND estado_dropi = ? LIMIT 1`,
        {
          replacements: [id_configuracion, cfg.estado_dropi],
          type: db.QueryTypes.SELECT,
        },
      );

      if (existe) {
        await db.query(
          `UPDATE dropi_plantillas_config
           SET nombre_template = ?,
               columna_destino = ?,
               language_code = 'es',
               activo = ?,
               mensaje_rapido = ?,
               usar_respuesta_rapida = ?,
               parametros_json = ?,
               body_text = ?,
               updated_at = NOW()
           WHERE id = ?`,
          {
            replacements: [
              cfg.nombre_template,
              cfg.columna_destino || null,
              cfg.activo,
              cfg.mensaje_rapido,
              cfg.usar_respuesta_rapida,
              cfg.parametros ? JSON.stringify(cfg.parametros) : null,
              body_text,
              existe.id,
            ],
            type: db.QueryTypes.UPDATE,
          },
        );

        resultados.push({
          estado: cfg.estado_dropi,
          template: cfg.nombre_template,
          columna_destino: cfg.columna_destino || null,
          status: 'actualizado',
        });
      } else {
        await db.query(
          `INSERT INTO dropi_plantillas_config
           (id_configuracion, estado_dropi, nombre_template, columna_destino, language_code,
            activo, mensaje_rapido, usar_respuesta_rapida, parametros_json, body_text)
           VALUES (?, ?, ?, ?, 'es', ?, ?, ?, ?, ?)`,
          {
            replacements: [
              id_configuracion,
              cfg.estado_dropi,
              cfg.nombre_template,
              cfg.columna_destino || null,
              cfg.activo,
              cfg.mensaje_rapido,
              cfg.usar_respuesta_rapida,
              cfg.parametros ? JSON.stringify(cfg.parametros) : null,
              body_text,
            ],
            type: db.QueryTypes.INSERT,
          },
        );

        resultados.push({
          estado: cfg.estado_dropi,
          template: cfg.nombre_template,
          columna_destino: cfg.columna_destino || null,
          status: 'creado',
        });
      }
    } catch (err) {
      resultados.push({
        estado: cfg.estado_dropi,
        status: 'error',
        error: err.message,
      });
    }
  }

  return resultados;
}

// ── Validar que el API key de OpenAI esté activo ───────────────
async function validarApiKeyOpenAI(apiKey) {
  try {
    await axios.get('https://api.openai.com/v1/models', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 8000,
    });
    return { valido: true };
  } catch (err) {
    const status = err?.response?.status;
    const mensaje = err?.response?.data?.error?.message || err.message;

    if (status === 401)
      return {
        valido: false,
        razon: 'API key inválida o expirada',
        detalle: mensaje,
      };
    if (status === 429)
      return {
        valido: false,
        razon: 'Límite de uso de OpenAI alcanzado',
        detalle: mensaje,
      };
    if (status === 403)
      return {
        valido: false,
        razon: 'API key sin permisos suficientes',
        detalle: mensaje,
      };

    return {
      valido: false,
      razon: 'No se pudo conectar con OpenAI',
      detalle: mensaje,
    };
  }
}

// ──────────────────────────────────────────────────────────────
// APLICAR PLANTILLA GLOBAL
// ──────────────────────────────────────────────────────────────
// Crea las columnas, asistentes, templates Meta, respuestas rápidas
// y config Dropi para un cliente, partiendo de una plantilla global.
//
// IMPORTANTE — Aislamiento por cliente:
//   - Cada cliente tiene su propio set de columnas (id_configuracion).
//   - Cada assistant_id pertenece a la API key del cliente.
//   - El snapshot del prompt se guarda por columna del cliente.
//   - NUNCA se modifica la plantilla global desde aquí.
//   - NUNCA se afecta a otros clientes.
//
// Cascada para nombre de tienda:
//   1. Body request `empresa` (lo que escribió el cliente en el modal)
//   2. configuraciones.nombre_empresa (fallback automático)
//   3. null → compilador usa default huérfano "nuestra tienda"
// ──────────────────────────────────────────────────────────────
exports.aplicarGlobal = catchAsync(async (req, res, next) => {
  const { id_configuracion, id_plantilla, empresa } = req.body;
  if (!id_configuracion || !id_plantilla)
    return next(new AppError('Faltan campos obligatorios', 400));

  const [plantilla] = await db.query(
    `SELECT data FROM kanban_plantillas_globales WHERE id = ? AND activo = 1 LIMIT 1`,
    { replacements: [id_plantilla], type: db.QueryTypes.SELECT },
  );
  if (!plantilla) return next(new AppError('Plantilla no encontrada', 404));

  // ═══ Cargar API key + nombre_empresa para fallback ═══
  const [configRow] = await db.query(
    `SELECT api_key_openai, nombre_empresa FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const api_key_openai = configRow?.api_key_openai || null;
  const nombreEmpresaConfig = configRow?.nombre_empresa || null;

  if (!api_key_openai) {
    return next(
      new AppError(
        'No hay API key de OpenAI configurada. Por favor ingresa una antes de aplicar la plantilla.',
        400,
      ),
    );
  }

  const validacion = await validarApiKeyOpenAI(api_key_openai);
  if (!validacion.valido) {
    return next(
      new AppError(
        `API key de OpenAI no válida: ${validacion.razon}. No se creó ninguna columna ni asistente.`,
        400,
      ),
    );
  }

  const headers = {
    Authorization: `Bearer ${api_key_openai}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };

  const { columnas } =
    typeof plantilla.data === 'string'
      ? JSON.parse(plantilla.data)
      : plantilla.data;

  // ═══ Cascada para nombre de tienda ═══
  const nombreTiendaResuelto =
    (empresa && empresa.trim()) || nombreEmpresaConfig || null;

  const personalizacionInicial = nombreTiendaResuelto
    ? { nombre_tienda: nombreTiendaResuelto }
    : {};

  console.log(
    `[aplicarGlobal] config=${id_configuracion} plantilla=${id_plantilla} ` +
      `nombre_tienda="${nombreTiendaResuelto || '(default huérfano)'}"`,
  );

  const resultado = [];

  for (const col of columnas) {
    let assistant_id = null;

    // Compilamos el prompt si la columna tiene instrucciones (placeholders)
    const promptCompilado = col.instrucciones
      ? compilarPromptFinal(col.instrucciones, personalizacionInicial)
      : null;

    if (promptCompilado && headers) {
      try {
        const aRes = await axios.post(
          'https://api.openai.com/v1/assistants',
          {
            name: nombreTiendaResuelto
              ? `${col.nombre} - ${nombreTiendaResuelto}`
              : col.nombre,
            instructions: promptCompilado,
            model: col.modelo || 'gpt-4o-mini',
            tools: [{ type: 'file_search' }],
          },
          { headers },
        );
        assistant_id = aRes.data?.id || null;
      } catch (err) {
        console.error(`Error creando asistente ${col.nombre}:`, err.message);
      }
    }

    const [insertResult] = await db.query(
      `INSERT INTO kanban_columnas
   (id_configuracion, nombre, estado_db, color_fondo, color_texto,
    icono, orden, activo, es_estado_final, es_principal, es_dropi_principal, activa_ia, max_tokens,
    instrucciones, modelo, assistant_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_configuracion,
          col.nombre,
          col.estado_db,
          col.color_fondo,
          col.color_texto,
          col.icono,
          col.orden,
          col.activo,
          col.es_estado_final,
          col.es_principal || 0,
          col.es_dropi_principal || 0,
          col.activa_ia,
          col.max_tokens,
          promptCompilado || null,
          col.modelo || 'gpt-4o-mini',
          assistant_id,
        ],
        type: db.QueryTypes.INSERT,
      },
    );

    for (const accion of col.acciones || []) {
      await db.query(
        `INSERT INTO kanban_acciones
         (id_kanban_columna, id_configuracion, tipo_accion, config, activo, orden)
         VALUES (?, ?, ?, ?, 1, ?)`,
        {
          replacements: [
            insertResult,
            id_configuracion,
            accion.tipo_accion,
            JSON.stringify(accion.config),
            accion.orden,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
    }

    // ═══ Guardar personalización inicial + snapshot del prompt CRUDO ═══
    // - Se guarda SIEMPRE que la columna tenga instrucciones, incluso si
    //   el assistant_id no se creó (para preservar trazabilidad).
    // - El snapshot guarda el prompt CRUDO con placeholders (col.instrucciones),
    //   NO el compilado. Esto permite re-personalizar limpio en el futuro.
    if (col.instrucciones) {
      try {
        await db.query(
          `INSERT INTO kanban_columnas_personalizaciones
           (id_kanban_columna, id_configuracion, nombre_tienda, prompt_base_snapshot)
           VALUES (?, ?, ?, ?)`,
          {
            replacements: [
              insertResult,
              id_configuracion,
              nombreTiendaResuelto,
              col.instrucciones, // ← prompt CRUDO con placeholders
            ],
            type: db.QueryTypes.INSERT,
          },
        );
      } catch (err) {
        console.error(
          `Error guardando personalización inicial columna ${col.nombre}:`,
          err.message,
        );
      }
    }

    resultado.push({
      columna: col.nombre,
      estado_db: col.estado_db,
      assistant_id,
    });
  }

  await db.query(
    `UPDATE configuraciones SET tipo_configuracion = 'kanban' WHERE id = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.UPDATE },
  );

  const resultadoTemplates = await _crearTemplatesMeta(id_configuracion);
  const resultadoRapidas = await _crearRespuestasRapidas(id_configuracion);
  const resultadoDropiConfig =
    await _aplicarConfigDropiPorDefecto(id_configuracion);

  await db.query(
    `UPDATE configuraciones 
   SET kanban_global_activo = 1, kanban_global_id = ?
   WHERE id = ?`,
    { replacements: [id_plantilla, id_configuracion] },
  );

  await db.query(
    `INSERT INTO configuraciones_kanban_global_log
   (id_configuracion, id_plantilla, accion, detalle)
   VALUES (?, ?, 'aplicado', ?)`,
    {
      replacements: [
        id_configuracion,
        id_plantilla,
        JSON.stringify({
          columnas: resultado,
          templates_meta: resultadoTemplates,
          respuestas_rapidas: resultadoRapidas,
          dropi_config: resultadoDropiConfig,
        }),
      ],
    },
  );

  syncCatalogoTodasColumnasConfig(id_configuracion, {
    logger: async (...args) => console.log('[sync-catalogo]', ...args),
  }).catch((err) =>
    console.error('[sync-catalogo] Error en sync automático:', err.message),
  );

  return res.json({
    success: true,
    data: {
      columnas: resultado,
      templates_meta: resultadoTemplates,
      respuestas_rapidas: resultadoRapidas,
      dropi_config: resultadoDropiConfig,
    },
  });
});

// ── Eliminar plantilla global ──────────────────────────────
exports.eliminarGlobal = catchAsync(async (req, res, next) => {
  const { id } = req.body;
  if (!id) return next(new AppError('Falta id', 400));

  await db.query(
    `UPDATE kanban_plantillas_globales SET activo = 0 WHERE id = ?`,
    { replacements: [id], type: db.QueryTypes.UPDATE },
  );

  return res.json({ success: true });
});
/* seccion de plantillas globales */

const KANBAN_TEMPLATES_META = [
  {
    name: 'remarketing_k1',
    language: 'es',
    category: 'MARKETING',
    components: [
      {
        type: 'HEADER',
        format: 'VIDEO',
        example: {
          header_handle: [
            'https://new.imporsuitpro.com/Videos/stream/3619a3291e1ccfe2388174618b50b550',
          ],
        },
      },
      {
        type: 'BODY',
        text: 'Tu pedido ya está listo para salir. Compárteme tu ubicación para coordinar el envío de inmediato.',
      },
    ],
  },
  {
    name: 'remarketing_k2',
    language: 'es',
    category: 'MARKETING',
    components: [
      {
        type: 'HEADER',
        format: 'VIDEO',
        example: {
          header_handle: [
            'https://new.imporsuitpro.com/Videos/stream/58b0a69a64359e85d12dd722f27f7afe',
          ],
        },
      },
      {
        type: 'BODY',
        text: 'Tu pedido está listo y tenemos cupos de envío GRATIS disponibles por poco tiempo.\nRecuerda, el pago lo realizas directamente al transportista al momento de la entrega.',
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Quiero envío hoy' },
          { type: 'QUICK_REPLY', text: 'Tengo una consulta' },
        ],
      },
    ],
  },
  {
    name: 'remarketing_k3',
    language: 'es',
    category: 'MARKETING',
    components: [
      {
        type: 'HEADER',
        format: 'IMAGE',
        example: {
          header_handle: [
            'https://imp-datas.s3.amazonaws.com/images/2026-04-07T21-27-32-154Z-534427295_813699714500800_6839605187360868450_n.png',
          ],
        },
      },
      {
        type: 'BODY',
        text: 'Se aplicó un ajuste especial del 10% a tu pedido. Envíame tu ubicación para coordinar el despacho.',
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Quiero mi descuento' },
          { type: 'QUICK_REPLY', text: 'Enviar ubicación' },
        ],
      },
    ],
  },
  {
    name: 'antes_generar_guia_k1',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Perfecto, en este momento procedemos con su despacho, en un momento le comparto su guía de envío. 😊\nCualquier duda que tenga estoy para ayudarle 📦',
      },
    ],
  },
  {
    name: 'guia_generada_k1',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'La guía de envío de tu pedido ha sido generada. El tiempo estimado de entrega es de 2 a 3 días hábiles.',
      },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: 'Descargar Guía',
            url: 'https://d39ru7awumhhs2.cloudfront.net/{{1}}',
            example: [
              'https://d39ru7awumhhs2.cloudfront.net/guias/ejemplo.pdf',
            ],
          },
          {
            type: 'URL',
            text: 'Seguimiento del pedido',
            url: 'https://chat.imporfactory.app/api/v1/kanban_plantillas/t/{{1}}',
            example: [
              'https://chat.imporfactory.app/api/v1/kanban_plantillas/t/LC123456',
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'novedad_k1',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Te comento que se ha gestionado un nuevo intento de entrega con la transportadora. Por favor, estar atento para que puedas recibir tu pedido sin inconvenientes.',
      },
    ],
  },
  {
    name: 'novedadk2',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Estimado cliente, le recordamos que al seleccionar pago contraentrega, usted se comprometió a recibir y pagar el pedido, conforme a la ley 67 del 2022 de Comercio Electrónico.\n\nEl costo del envío ya fue asumido por nuestra empresa.\nNecesitamos programar un nuevo intento de entrega lo antes posible por favor.\n\nEs importante contar con su disponibilidad para evitar cancelación del pedido y posibles restricciones en futuras compras.',
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Confirmo recepción' },
          { type: 'QUICK_REPLY', text: 'Reprogramar entrega' },
        ],
      },
    ],
  },
  {
    name: 'retiro_agencia_k1',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'HEADER',
        format: 'TEXT',
        text: 'AVISO IMPORTANTE',
      },
      {
        type: 'BODY',
        text: 'Estimado Cliente:\nServientrega le notifica que su pedido esta listo para ser retirado en agencia: {{1}}\nPor favor acercarse lo más pronto posible.',
        example: { body_text: [['Agencia Norte Quito']] },
      },
    ],
  },
  {
    name: 'confirmacion_pedido_k1',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Hola {{1}}, Acabo de recibir tu pedido de compra por el valor de ${{2}}\nQuiero confirmar tus datos de envío:\n\n✅Producto: {{3}}\n👤Nombre: {{4}}\n📱Teléfono: {{5}}\n📍Dirección: {{6}}\n\nPor favor, selecciona *CONFIRMAR PEDIDO* si tus datos son correctos ✅, o *ACTUALIZAR INFORMACIÓN* para corregirlos antes de proceder con el envío de tu producto. 🚚',
        example: {
          body_text: [
            [
              'Daniel',
              '35.00',
              'Audífonos Bluetooth',
              'Daniel Bonilla',
              '0987654321',
              'Av. Simón Bolívar y Mariscal Sucre',
            ],
          ],
        },
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'CONFIRMAR PEDIDO' },
          { type: 'QUICK_REPLY', text: 'ACTUALIZAR INFORMACIÓN' },
        ],
      },
    ],
  },
  {
    name: 'zona_entrega_k1',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'HEADER',
        format: 'TEXT',
        text: 'Llego el día de entrega',
      },
      {
        type: 'BODY',
        text: 'Hoy tu pedido ha llegado 📦✅ a {{1}} y está próximo a ser entregado en {{2}}, en el horario de 9 am a 6 pm. ¡Te recordamos tener el valor total de {{3}} en efectivo! Agradecemos estar atento a las llamadas del courier 🚚 Revisa el estado de tu guía aquí {{4}} 😊.',
        example: {
          body_text: [
            [
              'Quito',
              'Av. Amazonas 123',
              '$20.00',
              'https://fenixoper.laarcourier.com/Tracking/Guiacompleta.aspx?guia=LC123',
            ],
          ],
        },
      },
    ],
  },
];

// ── Respuestas rápidas para Kanban ───────────────────────────
const KANBAN_RESPUESTAS_RAPIDAS = [
  {
    atajo: 'orden_aprobada',
    mensaje:
      'Tu orden ya ha sido aprobada correctamente.\nEstamos a la espera de que la transportadora genere la guía de envío. 📦 Apenas esté disponible, te la compartiré de inmediato para que puedas hacer el seguimiento.',
  },
  {
    atajo: 'agradecimiento',
    mensaje:
      'Muchas gracias por confiar en nosotros y bienvenid@ a la familia 🙌🛍 espero disfrutes de nuestros productos.',
  },
  {
    atajo: 'pago_contraentrega',
    mensaje:
      'El pago es CONTRA-ENTREGA 💵, es decir, que vas a pagar tu pedido en efectivo cuando el transportista te lo entregue.',
  },
  {
    atajo: 'genera_preguntas',
    mensaje:
      '¿Tienes alguna pregunta específica sobre el producto? 🤔\nEstoy aquí para proporcionarte más información y aclarar cualquier duda que puedas tener. 😊',
  },
  {
    atajo: 'despedida',
    mensaje:
      'Agradezco tu tiempo y consideración. 🙌\nEspero con ansias tu respuesta y la oportunidad de brindarte una solución de calidad. ¡Que tengas un maravilloso día! ✨',
  },
  {
    atajo: 'ubicacion_incorrecta',
    mensaje:
      'Genial, en este momento procedo con el empaque de su pedido. 📦\nPor favor si me ayuda con la ubicación por Google Maps 📍 para que el transportista llegue con facilidad.',
  },
  {
    atajo: 'antes_generar_guia',
    mensaje:
      'Perfecto, en este momento procedemos con su despacho, en un momento le comparto su guía de envío. 😊\nCualquier duda que tenga estoy para ayudarle 📦',
  },
];

exports.crearTemplatesMeta = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));
  const data = await _crearTemplatesMeta(id_configuracion);
  return res.json({ success: true, data });
});

exports.crearRespuestasRapidas = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));
  const data = await _crearRespuestasRapidas(id_configuracion);
  return res.json({ success: true, data });
});

exports.trackingRedirect = (req, res) => {
  const g = String(req.params.guide || '').trim();
  if (!g) return res.status(400).send('Guía requerida');

  const upper = g.toUpperCase();
  let url;

  if (
    upper.startsWith('LC') ||
    upper.startsWith('IMP') ||
    upper.startsWith('MKP')
  )
    url = `https://fenixoper.laarcourier.com/Tracking/Guiacompleta.aspx?guia=${encodeURIComponent(g)}`;
  else if (upper.startsWith('D0') || upper.startsWith('I0'))
    url = `https://ec.gintracom.site/web/site/tracking?guia=${encodeURIComponent(g)}`;
  else if (upper.startsWith('V'))
    url = `https://tracking.veloces.app/tracking-client/${encodeURIComponent(g)}`;
  else if (upper.startsWith('WYB'))
    url = `https://app.urbano.com.ec/plugin/etracking/etracking/?guia=${encodeURIComponent(g)}`;
  else
    url = `https://www.servientrega.com.ec/Tracking/?guia=${encodeURIComponent(g)}&tipo=GUIA`;

  return res.redirect(url);
};

// ──────────────────────────────────────────────────────────────
// Helpers para personalizaciones
// ──────────────────────────────────────────────────────────────

async function _getPromptBaseDeGlobal(id_plantilla, nombreColumna) {
  const [plantilla] = await db.query(
    `SELECT data FROM kanban_plantillas_globales WHERE id = ? AND activo = 1 LIMIT 1`,
    { replacements: [id_plantilla], type: db.QueryTypes.SELECT },
  );
  if (!plantilla) return null;

  const data =
    typeof plantilla.data === 'string'
      ? JSON.parse(plantilla.data)
      : plantilla.data;

  const colPlantilla = (data?.columnas || []).find(
    (c) => c.nombre === nombreColumna,
  );
  return colPlantilla?.instrucciones || null;
}

async function _getColumnasIADelCliente(id_configuracion) {
  return db.query(
    `SELECT kc.id, kc.nombre, kc.assistant_id, kc.estado_db
     FROM kanban_columnas kc
     WHERE kc.id_configuracion = ?
       AND kc.activo = 1
       AND kc.activa_ia = 1
       AND kc.assistant_id IS NOT NULL`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
}

// ──────────────────────────────────────────────────────────────
// GET — Obtener personalización actual de una columna
// POST /kanban_plantillas/personalizacion_obtener
// ──────────────────────────────────────────────────────────────
exports.personalizacionObtener = catchAsync(async (req, res, next) => {
  const { id_kanban_columna } = req.body;
  if (!id_kanban_columna)
    return next(new AppError('Falta id_kanban_columna', 400));

  const [col] = await db.query(
    `SELECT kc.id, kc.id_configuracion, kc.nombre, kc.assistant_id,
            kc.activa_ia, kc.modelo, kc.max_tokens,
            c.kanban_global_id
     FROM kanban_columnas kc
     JOIN configuraciones c ON c.id = kc.id_configuracion
     WHERE kc.id = ? LIMIT 1`,
    { replacements: [id_kanban_columna], type: db.QueryTypes.SELECT },
  );

  if (!col) return next(new AppError('Columna no encontrada', 404));

  const [perso] = await db.query(
    `SELECT nombre_tienda, nombre_asistente_publico,
            instrucciones_extra, info_envio,
            productos_destacados, tono_personalizado,
            updated_at
     FROM kanban_columnas_personalizaciones
     WHERE id_kanban_columna = ? LIMIT 1`,
    { replacements: [id_kanban_columna], type: db.QueryTypes.SELECT },
  );

  return res.json({
    success: true,
    data: {
      columna: {
        id: col.id,
        nombre: col.nombre,
        assistant_id: col.assistant_id,
        activa_ia: !!col.activa_ia,
        tiene_plantilla_global: !!col.kanban_global_id,
      },
      personalizacion: perso || {
        nombre_tienda: null,
        nombre_asistente_publico: null,
        instrucciones_extra: null,
        info_envio: null,
        productos_destacados: null,
        tono_personalizado: null,
        updated_at: null,
      },
    },
  });
});

// ──────────────────────────────────────────────────────────────
// PREVIEW — Compila sin guardar para que el cliente vea el resultado
// POST /kanban_plantillas/personalizacion_preview
// Usa snapshot guardado primero, fallback a plantilla global.
// ──────────────────────────────────────────────────────────────
exports.personalizacionPreview = catchAsync(async (req, res, next) => {
  const { id_kanban_columna, personalizacion = {} } = req.body;
  if (!id_kanban_columna)
    return next(new AppError('Falta id_kanban_columna', 400));

  const validacion = validarPersonalizacion(personalizacion);
  if (!validacion.valido) {
    return next(
      new AppError(
        `Personalización inválida: ${validacion.errores.join(', ')}`,
        400,
      ),
    );
  }

  const [col] = await db.query(
    `SELECT kc.nombre, c.kanban_global_id
     FROM kanban_columnas kc
     JOIN configuraciones c ON c.id = kc.id_configuracion
     WHERE kc.id = ? LIMIT 1`,
    { replacements: [id_kanban_columna], type: db.QueryTypes.SELECT },
  );

  if (!col) return next(new AppError('Columna no encontrada', 404));
  if (!col.kanban_global_id)
    return next(
      new AppError('Esta configuración no usa plantilla global', 400),
    );

  // Prioridad: snapshot guardado > plantilla global
  const [persoSnap] = await db.query(
    `SELECT prompt_base_snapshot
     FROM kanban_columnas_personalizaciones
     WHERE id_kanban_columna = ? LIMIT 1`,
    { replacements: [id_kanban_columna], type: db.QueryTypes.SELECT },
  );

  let promptBase = persoSnap?.prompt_base_snapshot || null;

  if (!promptBase) {
    promptBase = await _getPromptBaseDeGlobal(col.kanban_global_id, col.nombre);
  }

  if (!promptBase)
    return next(
      new AppError(
        `No hay prompt base disponible para la columna "${col.nombre}"`,
        400,
      ),
    );

  const promptCompilado = compilarPromptFinal(promptBase, personalizacion);

  return res.json({
    success: true,
    data: {
      prompt_base_length: promptBase.length,
      prompt_compilado: promptCompilado,
      prompt_compilado_length: promptCompilado.length,
      diferencia: promptCompilado.length - promptBase.length,
    },
  });
});

// ──────────────────────────────────────────────────────────────
// ACTUALIZAR — Re-compila + actualiza assistant en OpenAI + guarda BD
// POST /kanban_plantillas/personalizacion_actualizar
//
// IMPORTANTE — Aislamiento por cliente:
//   - Solo afecta a las columnas IA del cliente actual (id_configuracion).
//   - Cada llamada actualiza solo los assistants del cliente (su API key).
//   - El snapshot del prompt NO se sobrescribe: queda fijo desde el
//     momento en que se aplicó la plantilla. Esto garantiza que futuras
//     personalizaciones siempre partan del mismo prompt base.
//
// Sincronización entre columnas IA del MISMO cliente:
//   - Campos GLOBALES (nombre_tienda, nombre_asistente_publico, info_envio,
//     productos_destacados, tono_personalizado) se aplican a TODAS las
//     columnas IA del cliente.
//   - Campo ESPECÍFICO (instrucciones_extra) se aplica SOLO a la columna
//     que el cliente está editando.
// ──────────────────────────────────────────────────────────────
exports.personalizacionActualizar = catchAsync(async (req, res, next) => {
  const { id_kanban_columna, personalizacion = {} } = req.body;
  if (!id_kanban_columna)
    return next(new AppError('Falta id_kanban_columna', 400));

  // 1. Validar personalización
  const validacion = validarPersonalizacion(personalizacion);
  if (!validacion.valido) {
    return next(
      new AppError(
        `Personalización inválida: ${validacion.errores.join(', ')}`,
        400,
      ),
    );
  }

  // 2. Cargar columna que el cliente está editando
  const [colActual] = await db.query(
    `SELECT kc.id, kc.id_configuracion, kc.nombre, kc.assistant_id,
            c.kanban_global_id, c.api_key_openai
     FROM kanban_columnas kc
     JOIN configuraciones c ON c.id = kc.id_configuracion
     WHERE kc.id = ? LIMIT 1`,
    { replacements: [id_kanban_columna], type: db.QueryTypes.SELECT },
  );

  if (!colActual) return next(new AppError('Columna no encontrada', 404));
  if (!colActual.kanban_global_id)
    return next(
      new AppError('Esta configuración no usa plantilla global', 400),
    );
  if (!colActual.api_key_openai)
    return next(
      new AppError(
        'No hay API key de OpenAI configurada en esta configuración',
        400,
      ),
    );

  const id_configuracion = colActual.id_configuracion;
  const id_plantilla = colActual.kanban_global_id;

  // 3. Obtener TODAS las columnas IA del cliente
  const columnasIA = await _getColumnasIADelCliente(id_configuracion);

  if (!columnasIA.length) {
    return next(
      new AppError('No hay columnas IA activas en esta configuración', 400),
    );
  }

  // 4. Separar campos globales vs específicos
  const camposGlobales = {
    nombre_tienda: personalizacion.nombre_tienda ?? null,
    nombre_asistente_publico: personalizacion.nombre_asistente_publico ?? null,
    info_envio: personalizacion.info_envio ?? null,
    productos_destacados: personalizacion.productos_destacados ?? null,
    tono_personalizado: personalizacion.tono_personalizado ?? null,
  };
  const instruccionesExtraActual = personalizacion.instrucciones_extra ?? null;

  // 5. Headers OpenAI (con la API key del CLIENTE, aislado de otros)
  const headers = {
    Authorization: `Bearer ${colActual.api_key_openai}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };

  // 6. Procesar cada columna IA del cliente
  const resultados = await Promise.all(
    columnasIA.map(async (col) => {
      try {
        // Cargar snapshot + instrucciones_extra en UN solo query
        const [persoExistente] = await db.query(
          `SELECT prompt_base_snapshot, instrucciones_extra
           FROM kanban_columnas_personalizaciones
           WHERE id_kanban_columna = ? LIMIT 1`,
          { replacements: [col.id], type: db.QueryTypes.SELECT },
        );

        // 6.1) Obtener prompt base (snapshot > plantilla global)
        let promptBase = persoExistente?.prompt_base_snapshot || null;

        if (!promptBase) {
          promptBase = await _getPromptBaseDeGlobal(id_plantilla, col.nombre);
        }

        if (!promptBase) {
          return {
            id_kanban_columna: col.id,
            nombre: col.nombre,
            status: 'omitida',
            motivo: 'Sin prompt en plantilla ni snapshot',
          };
        }

        // 6.2) Resolver instrucciones_extra de ESTA columna
        // Si es la columna que el cliente edita, usa el del request.
        // Si es otra columna IA, mantiene su valor previo.
        const instruccionesExtraDeEstaColumna =
          col.id === id_kanban_columna
            ? instruccionesExtraActual
            : (persoExistente?.instrucciones_extra ?? null);

        // 6.3) Compilar
        const promptCompilado = compilarPromptFinal(promptBase, {
          ...camposGlobales,
          instrucciones_extra: instruccionesExtraDeEstaColumna,
        });

        // 6.4) Actualizar assistant en OpenAI (de ESTE cliente solamente)
        await axios.post(
          `https://api.openai.com/v1/assistants/${col.assistant_id}`,
          { instructions: promptCompilado },
          { headers, timeout: 15000 },
        );

        // 6.5) Actualizar kanban_columnas.instrucciones del cliente
        await db.query(
          `UPDATE kanban_columnas SET instrucciones = ? WHERE id = ?`,
          {
            replacements: [promptCompilado, col.id],
            type: db.QueryTypes.UPDATE,
          },
        );

        // 6.6) Upsert en kanban_columnas_personalizaciones
        // IMPORTANTE: NO sobrescribimos prompt_base_snapshot.
        // El snapshot fue guardado al aplicar plantilla y queremos
        // preservarlo para futuras compilaciones.
        await db.query(
          `INSERT INTO kanban_columnas_personalizaciones
           (id_kanban_columna, id_configuracion,
            nombre_tienda, nombre_asistente_publico,
            instrucciones_extra, info_envio,
            productos_destacados, tono_personalizado,
            prompt_base_snapshot)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             nombre_tienda = VALUES(nombre_tienda),
             nombre_asistente_publico = VALUES(nombre_asistente_publico),
             instrucciones_extra = VALUES(instrucciones_extra),
             info_envio = VALUES(info_envio),
             productos_destacados = VALUES(productos_destacados),
             tono_personalizado = VALUES(tono_personalizado)`,
          {
            replacements: [
              col.id,
              id_configuracion,
              camposGlobales.nombre_tienda,
              camposGlobales.nombre_asistente_publico,
              instruccionesExtraDeEstaColumna,
              camposGlobales.info_envio,
              camposGlobales.productos_destacados,
              camposGlobales.tono_personalizado,
              promptBase, // snapshot solo se usa en INSERT, no en UPDATE
            ],
          },
        );

        return {
          id_kanban_columna: col.id,
          nombre: col.nombre,
          assistant_id: col.assistant_id,
          status: 'ok',
          prompt_length: promptCompilado.length,
        };
      } catch (err) {
        const mensaje = err?.response?.data?.error?.message || err.message;
        console.error(
          `[personalizacion] Error en columna ${col.nombre}: ${mensaje}`,
        );
        return {
          id_kanban_columna: col.id,
          nombre: col.nombre,
          assistant_id: col.assistant_id,
          status: 'error',
          error: mensaje,
        };
      }
    }),
  );

  const exitos = resultados.filter((r) => r.status === 'ok').length;
  const errores = resultados.filter((r) => r.status === 'error').length;

  return res.json({
    success: errores === 0,
    message:
      errores === 0
        ? `Personalización aplicada a ${exitos} columna(s) IA`
        : `Aplicada parcialmente: ${exitos} ok, ${errores} con error`,
    data: {
      total_columnas: columnasIA.length,
      exitos,
      errores,
      resultados,
    },
  });
});
