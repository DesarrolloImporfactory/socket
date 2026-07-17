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

// Catálogo Kanban (fuente única de verdad, compartida con el admin controller)
const {
  KANBAN_TEMPLATES_META,
  KANBAN_RESPUESTAS_RAPIDAS,
  DROPI_CONFIG_POR_DEFECTO,
  REMARKETING_POR_DEFECTO,
} = require('../utils/kanban_catalogo.data');

const {
  getTemplatesMetaMerged,
  getRespuestasRapidasMerged,
  getDropiConfigMerged,
  getRemarketingMerged,
  getTemplateLookups,
  remarketingKey,
} = require('../utils/kanban_catalogo.provider');

// ──────────────────────────────────────────────────────────────
// CONSTANTES
// ──────────────────────────────────────────────────────────────

// IDs de configuraciones que pueden ver plantillas internas/de pruebas.
const CONFIGS_INTERNAS = [277, 10];
// const CONFIGS_INTERNAS = [10];

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
    `DELETE FROM dropi_plantillas_config WHERE id_configuracion = ?`,
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
    `SELECT id, nombre, descripcion, icono, color, pais, paises, grupo, created_at,
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
      pais: p.pais || 'EC',
      paises: (p.paises || p.pais || 'EC')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
      grupo: p.grupo || null,
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

// ── _crearTemplatesMeta ─────────────────────────────────────────
async function _crearTemplatesMeta(id_configuracion, soloKeys = null) {
  const wabaConfig = await getConfigFromDB(id_configuracion);
  if (!wabaConfig?.WABA_ID || !wabaConfig?.ACCESS_TOKEN)
    return [{ status: 'skipped', mensaje: 'Sin config WABA' }];

  const { WABA_ID, ACCESS_TOKEN } = wabaConfig;

  const templates = await getTemplatesMetaMerged(); // ← fábrica + custom

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

  for (const tpl of templates) {
    // null = solo fábrica; custom es opt-in por tablero
    if (soloKeys) {
      if (!soloKeys.has(tpl.name)) continue;
    } else if (tpl._custom) {
      continue;
    }

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

      resultados.push({ nombre: tpl.name, status: 'success', id: r.data?.id });
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

// ── _crearRespuestasRapidas ─────────────────────────────────────
async function _crearRespuestasRapidas(id_configuracion, soloKeys = null) {
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

  const rapidas = await getRespuestasRapidasMerged();

  const resultados = [];
  for (const rr of rapidas) {
    // null = solo fábrica; custom es opt-in por tablero
    if (soloKeys) {
      if (!soloKeys.has(rr.atajo)) continue;
    } else if (rr._custom) {
      continue;
    }

    if (existentes.includes(rr.atajo)) {
      resultados.push({ atajo: rr.atajo, status: 'omitido' });
      continue;
    }
    try {
      const mensaje = rr.mensaje ?? null;
      const tipo_mensaje = rr.tipo_mensaje || 'text';
      const ruta_archivo = rr.ruta_archivo || null;
      const mime_type = rr.mime_type || null;
      const file_name = rr.file_name || null;

      const [insertId] = await db.query(
        `INSERT INTO templates_chat_center
         (atajo, mensaje, id_configuracion, tipo_mensaje, ruta_archivo, mime_type, file_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        {
          replacements: [
            rr.atajo,
            mensaje,
            id_configuracion,
            tipo_mensaje,
            ruta_archivo,
            mime_type,
            file_name,
          ],
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

// ── _aplicarConfigDropiPorDefecto ───────────────────────────────
async function _aplicarConfigDropiPorDefecto(
  id_configuracion,
  soloKeys = null,
) {
  const resultados = [];

  const [dropiCfgs, { bodyByName }] = await Promise.all([
    getDropiConfigMerged(),
    getTemplateLookups(),
  ]);

  for (const cfg of dropiCfgs) {
    // null = solo fábrica; custom es opt-in por tablero
    if (soloKeys) {
      if (!soloKeys.has(cfg.estado_dropi)) continue;
    } else if (cfg._custom) {
      continue;
    }

    try {
      const activo = cfg.activo == null ? 1 : cfg.activo;
      const mensaje_rapido = cfg.mensaje_rapido ?? null;
      const usar_respuesta_rapida = cfg.usar_respuesta_rapida ? 1 : 0;
      const columna_destino = cfg.columna_destino || null;
      const parametros_json = cfg.parametros
        ? JSON.stringify(cfg.parametros)
        : null;
      const body_text =
        cfg.body_text || bodyByName.get(cfg.nombre_template) || null;

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
           SET nombre_template = ?, columna_destino = ?, language_code = 'es',
               activo = ?, mensaje_rapido = ?, usar_respuesta_rapida = ?,
               parametros_json = ?, body_text = ?, updated_at = NOW()
           WHERE id = ?`,
          {
            replacements: [
              cfg.nombre_template,
              columna_destino,
              activo,
              mensaje_rapido,
              usar_respuesta_rapida,
              parametros_json,
              body_text,
              existe.id,
            ],
            type: db.QueryTypes.UPDATE,
          },
        );
        resultados.push({
          estado: cfg.estado_dropi,
          template: cfg.nombre_template,
          columna_destino,
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
              columna_destino,
              activo,
              mensaje_rapido,
              usar_respuesta_rapida,
              parametros_json,
              body_text,
            ],
            type: db.QueryTypes.INSERT,
          },
        );
        resultados.push({
          estado: cfg.estado_dropi,
          template: cfg.nombre_template,
          columna_destino,
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

async function _aplicarRemarketingPorDefecto(
  id_configuracion,
  soloKeys = null,
) {
  const resultados = [];

  const [grupos, { headerMediaByName }] = await Promise.all([
    getRemarketingMerged(),
    getTemplateLookups(),
  ]);

  const minutosDe = (s) =>
    s.tiempo_espera_minutos != null
      ? Number(s.tiempo_espera_minutos)
      : s.tiempo_espera_horas != null
        ? Number(s.tiempo_espera_horas) * 60
        : 60;

  for (const grupo of grupos) {
    const { estado_contacto, secuencias: secuenciasTodas } = grupo;

    // null = solo fábrica; custom es opt-in por tablero
    const seleccionadas = soloKeys
      ? secuenciasTodas.filter((s) =>
          soloKeys.has(remarketingKey(estado_contacto, s)),
        )
      : secuenciasTodas.filter((s) => !s._custom);

    if (!seleccionadas.length) continue;

    // Re-numerar por tiempo ascendente → secuencia 1,2,3… sin colisiones.
    const secuencias = [...seleccionadas]
      .sort((a, b) => minutosDe(a) - minutosDe(b))
      .map((s, i) => ({ ...s, secuencia: i + 1 }));

    try {
      await db.query(
        `DELETE FROM configuracion_remarketing
         WHERE id_configuracion = ? AND estado_contacto = ?`,
        {
          replacements: [id_configuracion, estado_contacto],
          type: db.QueryTypes.DELETE,
        },
      );
    } catch (err) {
      resultados.push({
        estado_contacto,
        status: 'error_limpieza',
        error: err.message,
      });
      continue;
    }

    for (const sec of secuencias) {
      try {
        const tiempo_espera_minutos = minutosDe(sec);

        // ⚠️ LEGACY HORAS — columna NOT NULL en proceso de eliminación.
        const tiempo_espera_horas = Math.max(
          1,
          Math.round(tiempo_espera_minutos / 60),
        );

        const secuencia = sec.secuencia; // ya re-numerada 1..N
        const language_code = sec.language_code || 'es';
        // Solo el ÚLTIMO remarketing mueve de columna; los intermedios se
        // quedan en su origen para no romper la cadena de secuencias.
        const esUltimo = secuencia === secuencias.length;
        const estado_destino = esUltimo
          ? sec.estado_destino || 'remarketing'
          : estado_contacto;
        const header_format = sec.header_format || null;
        const metodo_dentro_24h = sec.metodo_dentro_24h || 'ia';
        const prompt_ia =
          metodo_dentro_24h === 'ia' ? sec.prompt_ia || null : null;

        let id_template_rapido = null;
        let usar_respuesta_rapida = 0;

        if (
          metodo_dentro_24h === 'respuesta_rapida' &&
          sec.atajo_respuesta_rapida
        ) {
          const [rr] = await db.query(
            `SELECT id_template
               FROM templates_chat_center
              WHERE id_configuracion = ? AND atajo = ?
              LIMIT 1`,
            {
              replacements: [id_configuracion, sec.atajo_respuesta_rapida],
              type: db.QueryTypes.SELECT,
            },
          );
          if (rr?.id_template) {
            id_template_rapido = rr.id_template;
            usar_respuesta_rapida = 1;
          }
        }

        const nombre_template = sec.nombre_template || '';
        const header_media_url = nombre_template
          ? headerMediaByName.get(nombre_template) || null
          : null;

        await db.query(
          `INSERT INTO configuracion_remarketing
           (id_configuracion, estado_contacto, secuencia,
            tiempo_espera_horas, tiempo_espera_minutos, nombre_template, language_code,
            estado_destino, header_format, header_media_url,
            header_media_name, header_parameters,
            id_template_rapido, usar_respuesta_rapida,
            metodo_dentro_24h, prompt_ia, activo)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          {
            replacements: [
              id_configuracion,
              estado_contacto,
              secuencia,
              tiempo_espera_horas, // ⚠️ LEGACY HORAS
              tiempo_espera_minutos,
              nombre_template,
              language_code,
              estado_destino,
              header_format,
              header_media_url,
              null,
              null,
              id_template_rapido,
              usar_respuesta_rapida,
              metodo_dentro_24h,
              prompt_ia,
            ],
            type: db.QueryTypes.INSERT,
          },
        );

        resultados.push({
          estado_contacto,
          secuencia,
          minutos: tiempo_espera_minutos,
          template: nombre_template || '(sin plantilla · IA)',
          metodo: metodo_dentro_24h,
          rapida: id_template_rapido || null,
          custom: !!sec._custom,
          status: 'creado',
        });
      } catch (err) {
        resultados.push({
          estado_contacto,
          secuencia: sec.secuencia,
          status: 'error',
          error: err.message,
        });
      }
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

// ── Resuelve el bloque setup de una plantilla con defaults retrocompatibles ──
// Plantillas viejas SIN setup → todo true (comportamiento histórico).
function _resolverSetup(dataPlantilla) {
  const s = dataPlantilla?.setup || {};
  // Arrays de selección por ítem. null/undefined = "todos" (retrocompatible).
  const arr = (v) => (Array.isArray(v) ? v : null);
  return {
    // ── Master toggles por bloque ──
    templates_meta: s.templates_meta !== false,
    dropi_config: s.dropi_config !== false,
    remarketing: s.remarketing !== false,
    respuestas_rapidas: s.respuestas_rapidas !== false,
    // ── Selección granular por ítem (null = todos los del catálogo) ──
    templates_meta_items: arr(s.templates_meta_items),
    respuestas_rapidas_items: arr(s.respuestas_rapidas_items),
    remarketing_items: arr(s.remarketing_items),
    dropi_config_items: arr(s.dropi_config_items),
  };
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
// SETUP VARIABLE POR PLANTILLA:
//   - El bloque `setup` del JSON de la plantilla decide qué se aplica:
//       templates_meta · dropi_config · remarketing · respuestas_rapidas
//   - Si la plantilla NO trae setup → todo true (retrocompatible).
//   - El cliente NO ve ni edita esto: lo define el superadmin en el editor.
//
// Cascada para nombre de tienda:
//   1. Body request `empresa` (lo que escribió el cliente en el modal)
//   2. configuraciones.nombre_configuracion (fallback automático)
//   3. null → compilador usa default huérfano "nuestra tienda"
// ──────────────────────────────────────────────────────────────
exports.aplicarGlobal = catchAsync(async (req, res, next) => {
  const { id_configuracion, id_plantilla, empresa, pais } = req.body;
  if (!id_configuracion || !id_plantilla)
    return next(new AppError('Faltan campos obligatorios', 400));

  const [plantilla] = await db.query(
    `SELECT data, pais, paises, version FROM kanban_plantillas_globales WHERE id = ? AND activo = 1 LIMIT 1`,
    { replacements: [id_plantilla], type: db.QueryTypes.SELECT },
  );
  if (!plantilla) return next(new AppError('Plantilla no encontrada', 404));

  // País final: si la plantilla es multipaís, el cliente elige uno de la lista
  // soportada. Si es de país único, se usa el de la plantilla.
  const paisesSoportados = String(plantilla.paises || plantilla.pais || 'EC')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const paisElegido = String(pais || '').trim().toUpperCase();
  let paisFinal;
  if (paisesSoportados.length > 1) {
    // Multipaís: el país elegido es obligatorio y debe estar soportado.
    if (!paisElegido || !paisesSoportados.includes(paisElegido)) {
      return next(
        new AppError(
          'Debes seleccionar un país válido para esta plantilla multipaís.',
          400,
        ),
      );
    }
    paisFinal = paisElegido;
  } else {
    paisFinal = paisesSoportados[0] || 'EC';
  }

  // Guardar en la config el país (para que el auto-orden NO asuma Ecuador) y la
  // versión de prompt aplicada (para que el cliente vea en su tablero si está
  // en la última versión).
  try {
    await db.query(
      `UPDATE configuraciones SET pais_plantilla = ?, prompt_version = ? WHERE id = ?`,
      {
        replacements: [
          paisFinal,
          Number(plantilla.version) || 1,
          id_configuracion,
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
  } catch (e) {
    console.warn(
      '[aplicarGlobal] no se pudo guardar pais_plantilla/prompt_version:',
      e.message,
    );
  }

  const [configRow] = await db.query(
    `SELECT api_key_openai, nombre_configuracion FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const api_key_openai = configRow?.api_key_openai || null;
  const nombreEmpresaConfig = configRow?.nombre_configuracion || null;

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

  // ═══ Parse data + resolver setup variable de la plantilla ═══
  const dataPlantilla =
    typeof plantilla.data === 'string'
      ? JSON.parse(plantilla.data)
      : plantilla.data;
  const { columnas } = dataPlantilla;
  const setup = _resolverSetup(dataPlantilla);

  console.log(
    `[aplicarGlobal] cfg=${id_configuracion} setup=`,
    JSON.stringify(setup),
  );

  const nombreTiendaResuelto =
    (empresa && empresa.trim()) || nombreEmpresaConfig || null;
  const personalizacionInicial = nombreTiendaResuelto
    ? { nombre_tienda: nombreTiendaResuelto }
    : {};

  console.log(
    `[aplicarGlobal] config=${id_configuracion} plantilla=${id_plantilla} ` +
      `nombre_tienda="${nombreTiendaResuelto || '(default huérfano)'}"`,
  );

  // ═══ IDEMPOTENCIA: columnas que YA existen para esta config ═══
  const columnasExistentes = await db.query(
    `SELECT estado_db FROM kanban_columnas WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const estadosExistentes = new Set(columnasExistentes.map((c) => c.estado_db));

  const resultado = [];

  for (const col of columnas) {
    // Si ya existe (re-aplicación o corrida previa que terminó en server), saltar.
    if (estadosExistentes.has(col.estado_db)) {
      resultado.push({
        columna: col.nombre,
        estado_db: col.estado_db,
        assistant_id: null,
        omitida: true,
      });
      continue;
    }

    let assistant_id = null;
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
          { headers, timeout: 20000 }, // ← evita que una llamada colgada infle el tiempo
        );
        assistant_id = aRes.data?.id || null;
      } catch (err) {
        console.error(`Error creando asistente ${col.nombre}:`, err.message);
      }
    }

    // INSERT con guard anti-carrera: si justo se duplicó, lo ignoramos.
    let insertResult;
    try {
      [insertResult] = await db.query(
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
    } catch (err) {
      if (err?.parent?.code === 'ER_DUP_ENTRY') {
        console.warn(
          `[aplicarGlobal] columna duplicada ignorada: ${col.estado_db}`,
        );
        resultado.push({
          columna: col.nombre,
          estado_db: col.estado_db,
          assistant_id,
          omitida: true,
        });
        continue;
      }
      throw err; // cualquier otro error sí lo dejamos subir
    }

    estadosExistentes.add(col.estado_db);

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
              col.instrucciones,
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

  // ═══ Foreground condicionado por setup ═══
  // Cada bloque se ejecuta SOLO si la plantilla lo tiene encendido.
  // Lo apagado devuelve { skipped: true } y simplemente no se crea.
  const resultadoRapidas = setup.respuestas_rapidas
    ? await _crearRespuestasRapidas(
        id_configuracion,
        setup.respuestas_rapidas_items
          ? new Set(setup.respuestas_rapidas_items)
          : null,
      )
    : { skipped: true };
  const resultadoDropiConfig = setup.dropi_config
    ? await _aplicarConfigDropiPorDefecto(
        id_configuracion,
        setup.dropi_config_items ? new Set(setup.dropi_config_items) : null,
      )
    : { skipped: true };
  const resultadoRemarketing = setup.remarketing
    ? await _aplicarRemarketingPorDefecto(
        id_configuracion,
        setup.remarketing_items ? new Set(setup.remarketing_items) : null,
      )
    : { skipped: true };

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
          setup,
          columnas: resultado,
          respuestas_rapidas: resultadoRapidas,
          dropi_config: resultadoDropiConfig,
          remarketing: resultadoRemarketing,
          templates_meta: setup.templates_meta
            ? 'en_proceso_async'
            : 'desactivado_en_setup',
        }),
      ],
    },
  );

  // ═══ RESPONDER YA: el Kanban ya es usable ═══
  res.json({
    success: true,
    data: {
      setup,
      columnas: resultado,
      respuestas_rapidas: resultadoRapidas,
      dropi_config: resultadoDropiConfig,
      remarketing: resultadoRemarketing,
      templates_meta: setup.templates_meta
        ? 'procesando_en_segundo_plano'
        : 'desactivado_en_setup',
    },
  });

  // ═══ SEGUNDO PLANO: templates Meta + sync catálogo ═══
  setImmediate(async () => {
    try {
      const resultadoTemplates = setup.templates_meta
        ? await _crearTemplatesMeta(
            id_configuracion,
            setup.templates_meta_items
              ? new Set(setup.templates_meta_items)
              : null,
          )
        : [{ status: 'skipped', mensaje: 'Desactivado en setup de plantilla' }];
      await db.query(
        `INSERT INTO configuraciones_kanban_global_log
           (id_configuracion, id_plantilla, accion, detalle)
         VALUES (?, ?, 'templates_meta', ?)`,
        {
          replacements: [
            id_configuracion,
            id_plantilla,
            JSON.stringify({ templates_meta: resultadoTemplates }),
          ],
        },
      );
      console.log(`[aplicarGlobal][cfg=${id_configuracion}] templates Meta OK`);
    } catch (err) {
      console.error(
        `[aplicarGlobal][cfg=${id_configuracion}] error templates Meta async:`,
        err.message,
      );
    }

    syncCatalogoTodasColumnasConfig(id_configuracion, {
      logger: async (...args) => console.log('[sync-catalogo]', ...args),
    }).catch((err) =>
      console.error('[sync-catalogo] Error en sync automático:', err.message),
    );
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

// KANBAN_TEMPLATES_META y KANBAN_RESPUESTAS_RAPIDAS viven en utils/kanban_catalogo.data.js

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

// catalogoSetup ahora vive en kanban_plantillas_admin.controller.js
// (ruta: POST /kanban_plantillas_admin/catalogo_setup)

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
       AND kc.assistant_id IS NOT NULL`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
}

// ──────────────────────────────────────────────────────────────
// Helper interno: resincroniza UNA configuración.
// NO lanza excepciones — siempre devuelve un objeto con el resultado.
// Usado por: personalizacionResincronizar (single) y
//            personalizacionResincronizarMasivo (bulk).
// ──────────────────────────────────────────────────────────────
async function _resincronizarUnaConfiguracion(id_configuracion) {
  try {
    // 1. Cargar config del cliente
    const [config] = await db.query(
      `SELECT api_key_openai, kanban_global_id
       FROM configuraciones WHERE id = ? LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );

    if (!config) {
      return {
        id_configuracion,
        success: false,
        error: 'Configuración no encontrada',
      };
    }
    if (!config.kanban_global_id) {
      return {
        id_configuracion,
        success: false,
        error: 'Esta configuración no usa plantilla global',
      };
    }
    if (!config.api_key_openai) {
      return {
        id_configuracion,
        success: false,
        error: 'No hay API key de OpenAI configurada en esta configuración',
      };
    }

    const id_plantilla = config.kanban_global_id;

    // 2. Cargar plantilla global actual
    const [plantilla] = await db.query(
      `SELECT data, version FROM kanban_plantillas_globales
       WHERE id = ? AND activo = 1 LIMIT 1`,
      { replacements: [id_plantilla], type: db.QueryTypes.SELECT },
    );
    if (!plantilla) {
      return {
        id_configuracion,
        success: false,
        error: 'Plantilla global no encontrada o inactiva',
      };
    }

    const dataPlantilla =
      typeof plantilla.data === 'string'
        ? JSON.parse(plantilla.data)
        : plantilla.data;

    const colsPlantilla = dataPlantilla?.columnas || [];

    // 3. Cargar columnas IA del cliente
    const columnasIA = await _getColumnasIADelCliente(id_configuracion);

    if (!columnasIA.length) {
      return {
        id_configuracion,
        success: false,
        error: 'No hay columnas IA activas en esta configuración',
      };
    }

    // 4. Headers OpenAI (con la API key del cliente)
    const headers = {
      Authorization: `Bearer ${config.api_key_openai}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'assistants=v2',
    };

    // 5. Procesar cada columna IA
    const resultados = await Promise.all(
      columnasIA.map(async (col) => {
        try {
          const colPlantilla = colsPlantilla.find(
            (c) => c.nombre === col.nombre,
          );

          if (!colPlantilla?.instrucciones) {
            return {
              id_kanban_columna: col.id,
              nombre: col.nombre,
              status: 'omitida',
              motivo: 'Sin prompt en plantilla global para esta columna',
            };
          }

          const promptBaseNuevo = colPlantilla.instrucciones;

          const [persoActual] = await db.query(
            `SELECT nombre_tienda, nombre_asistente_publico,
                    instrucciones_extra, info_envio,
                    productos_destacados, tono_personalizado
             FROM kanban_columnas_personalizaciones
             WHERE id_kanban_columna = ? LIMIT 1`,
            { replacements: [col.id], type: db.QueryTypes.SELECT },
          );

          const promptCompilado = compilarPromptFinal(
            promptBaseNuevo,
            persoActual || {},
          );

          await axios.post(
            `https://api.openai.com/v1/assistants/${col.assistant_id}`,
            { instructions: promptCompilado },
            { headers, timeout: 15000 },
          );

          await db.query(
            `UPDATE kanban_columnas SET instrucciones = ? WHERE id = ?`,
            {
              replacements: [promptCompilado, col.id],
              type: db.QueryTypes.UPDATE,
            },
          );

          await db.query(
            `UPDATE kanban_columnas_personalizaciones 
             SET prompt_base_snapshot = ?
             WHERE id_kanban_columna = ?`,
            {
              replacements: [promptBaseNuevo, col.id],
              type: db.QueryTypes.UPDATE,
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
            `[resincronizar] config=${id_configuracion} col=${col.nombre}: ${mensaje}`,
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

    const exitos_cols = resultados.filter((r) => r.status === 'ok').length;
    const errores_cols = resultados.filter((r) => r.status === 'error').length;
    const omitidas_cols = resultados.filter(
      (r) => r.status === 'omitida',
    ).length;

    // Quedó sincronizado con la versión actual de la plantilla global.
    if (errores_cols === 0) {
      try {
        await db.query(
          `UPDATE configuraciones SET prompt_version = ? WHERE id = ?`,
          {
            replacements: [Number(plantilla.version) || 1, id_configuracion],
            type: db.QueryTypes.UPDATE,
          },
        );
      } catch (e) {
        console.warn(
          `[resincronizar] no se pudo guardar prompt_version cfg=${id_configuracion}:`,
          e.message,
        );
      }
    }

    return {
      id_configuracion,
      success: errores_cols === 0,
      total_columnas: columnasIA.length,
      exitos_cols,
      errores_cols,
      omitidas_cols,
      version: Number(plantilla.version) || 1,
      resultados_columnas: resultados,
    };
  } catch (err) {
    console.error(
      `[resincronizar] error fatal config=${id_configuracion}: ${err.message}`,
    );
    return {
      id_configuracion,
      success: false,
      error: `Error inesperado: ${err.message}`,
    };
  }
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

// ──────────────────────────────────────────────────────────────
// RESINCRONIZAR — Actualiza el snapshot desde la plantilla global
//                 manteniendo la personalización del cliente.

//   1. Lee la plantilla global ACTUAL de cada columna IA del cliente.
//   2. Reemplaza el prompt_base_snapshot con esa versión nueva.
//   3. Re-compila el prompt usando los CAMPOS DE PERSONALIZACIÓN
//      que el cliente ya tenía guardados (nombre_tienda, info_envio, etc).
//   4. Actualiza kanban_columnas.instrucciones y el assistant en OpenAI.
//
// QUÉ NO HACE:
//   - NO toca los campos de personalización del cliente (los conserva).
//   - NO afecta a otros clientes.
//   - NO modifica la plantilla global.
//
// AISLAMIENTO: solo afecta al cliente que llama (id_configuracion).
// ──────────────────────────────────────────────────────────────
exports.personalizacionResincronizar = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));

  const r = await _resincronizarUnaConfiguracion(id_configuracion);

  // Errores fatales de validación → mantener comportamiento original (AppError 400/404)
  if (!r.success && !r.resultados_columnas) {
    const code = r.error === 'Configuración no encontrada' ? 404 : 400;
    return next(new AppError(r.error, code));
  }

  return res.json({
    success: r.success,
    message:
      r.errores_cols === 0
        ? `Prompt actualizado en ${r.exitos_cols} columna(s) IA`
        : `Actualización parcial: ${r.exitos_cols} ok, ${r.errores_cols} con error`,
    data: {
      total_columnas: r.total_columnas,
      exitos: r.exitos_cols,
      errores: r.errores_cols,
      resultados: r.resultados_columnas,
    },
  });
});

// ──────────────────────────────────────────────────────────────
// VERSIÓN DEL PROMPT — Estado de versión de una configuración
// POST /kanban_plantillas/personalizacion_version
//
// Body: { id_configuracion }
// Devuelve la versión de prompt aplicada vs. la última publicada, para que el
// cliente vea en su tablero si está al día o si hay una versión más nueva.
// ──────────────────────────────────────────────────────────────
exports.personalizacionVersion = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));

  const [config] = await db.query(
    `SELECT kanban_global_id, prompt_version FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!config) return next(new AppError('Configuración no encontrada', 404));

  // Sin plantilla global → no aplica el versionado (prompt propio/heredado).
  if (!config.kanban_global_id) {
    return res.json({
      success: true,
      data: { usa_plantilla_global: false },
    });
  }

  const [plantilla] = await db.query(
    `SELECT nombre, version, pais FROM kanban_plantillas_globales WHERE id = ? LIMIT 1`,
    { replacements: [config.kanban_global_id], type: db.QueryTypes.SELECT },
  );

  const ultima = Number(plantilla?.version) || 1;
  // Si nunca se guardó (aplicada antes de este feature), asumimos la última
  // publicada para no marcar como "desactualizado" sin fundamento.
  const aplicada =
    config.prompt_version == null ? ultima : Number(config.prompt_version);

  return res.json({
    success: true,
    data: {
      usa_plantilla_global: true,
      id_plantilla: config.kanban_global_id,
      nombre_plantilla: plantilla?.nombre || null,
      pais: config.pais_plantilla || plantilla?.pais || 'EC',
      aplicada,
      ultima,
      desactualizada: aplicada < ultima,
    },
  });
});

// ──────────────────────────────────────────────────────────────
// RESINCRONIZAR MASIVO — Aplica resincronización a múltiples configs
// POST /kanban_plantillas/personalizacion_resincronizar_masivo
//
// Body: { ids_configuracion: [12, 25, 47, ...], concurrencia?: 3 }
//
// - Procesa en lotes (concurrencia por defecto 3, máx 10).
// - Si una config falla (sin API key, sin plantilla, etc.), se reporta
//   como error pero NO aborta el resto.
// - Devuelve detalle de éxitos y errores por separado.
// ──────────────────────────────────────────────────────────────
exports.personalizacionResincronizarMasivo = catchAsync(
  async (req, res, next) => {
    const { ids_configuracion, concurrencia = 3 } = req.body;

    if (!Array.isArray(ids_configuracion) || ids_configuracion.length === 0) {
      return next(
        new AppError(
          'Falta ids_configuracion (debe ser un array no vacío)',
          400,
        ),
      );
    }

    // Limpiar duplicados y valores no válidos
    const idsUnicos = [
      ...new Set(ids_configuracion.map((x) => Number(x))),
    ].filter((x) => Number.isInteger(x) && x > 0);

    if (!idsUnicos.length) {
      return next(new AppError('No hay ids válidos en el array', 400));
    }

    // Tope de seguridad
    const LIMITE_MAX = 200;
    if (idsUnicos.length > LIMITE_MAX) {
      return next(
        new AppError(
          `Demasiadas configuraciones (${idsUnicos.length}). Máximo: ${LIMITE_MAX}`,
          400,
        ),
      );
    }

    // Concurrencia: 1-10
    const conc = Math.max(1, Math.min(Number(concurrencia) || 3, 10));
    const resultados = [];

    for (let i = 0; i < idsUnicos.length; i += conc) {
      const chunk = idsUnicos.slice(i, i + conc);
      const chunkResultados = await Promise.all(
        chunk.map((id) => _resincronizarUnaConfiguracion(id)),
      );
      resultados.push(...chunkResultados);
    }

    const exitos = resultados.filter((r) => r.success);
    const errores = resultados.filter((r) => !r.success);

    return res.json({
      success: errores.length === 0,
      message:
        errores.length === 0
          ? `Resincronización masiva exitosa en ${exitos.length} configuración(es)`
          : `Resincronización parcial: ${exitos.length} ok, ${errores.length} con error`,
      data: {
        total: idsUnicos.length,
        exitos_count: exitos.length,
        errores_count: errores.length,
        concurrencia_usada: conc,
        exitos: exitos.map((r) => ({
          id_configuracion: r.id_configuracion,
          total_columnas: r.total_columnas,
          columnas_actualizadas: r.exitos_cols,
          columnas_omitidas: r.omitidas_cols,
        })),
        errores: errores.map((r) => ({
          id_configuracion: r.id_configuracion,
          error: r.error,
          // Si hubo éxito parcial (algunas columnas fallaron, otras ok),
          // incluye el detalle:
          ...(r.resultados_columnas
            ? {
                total_columnas: r.total_columnas,
                columnas_actualizadas: r.exitos_cols,
                columnas_con_error: r.errores_cols,
                resultados_columnas: r.resultados_columnas,
              }
            : {}),
        })),
      },
    });
  },
);
