'use strict';

/**
 * API pública — configuración editable por terceros (CRM externos).
 *
 * Caso que lo motiva: el dueño de la cfg 277 conecta su CRM (Guardian) y
 * quiere leer/editar el prompt del bot, los flujos (secuencias de remarketing
 * por columna) y las plantillas/respuestas rápidas SIN pedirlo a mano.
 *
 * Reglas de esta superficie:
 *  - La llave manda: todo queda acotado a req.id_configuracion (fijado por
 *    apiKeyAuth). Un tercero jamás elige la conexión.
 *  - Escrituras solo con scope explícito (requireScope en las rutas).
 *  - TODA escritura se audita con el estado previo (api_public_auditoria):
 *    es el respaldo para revertir un prompt pisado. Si la tabla no existe
 *    aún (migración pendiente), se registra en el log del server y se sigue.
 *  - Nada de tokens de servicio ni endpoints internos: lo que el tercero
 *    necesita se expone AQUÍ, con el mínimo de campos.
 */

const axios = require('axios');
const { db } = require('../database/config');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

/* Scopes válidos de una llave. Cualquier otro valor se rechaza al crear. */
const SCOPES_VALIDOS = ['read', 'bot:write', 'flujos:write', 'plantillas:write', '*'];
exports.SCOPES_VALIDOS = SCOPES_VALIDOS;

/* ── Auditoría (tolerante a la tabla ausente) ── */
let auditoriaDisponible = true;
async function auditar(req, { recurso, accion, previo, nuevo }) {
  const fila = {
    id_api_key: req.apiKey?.id || 0,
    id_configuracion: req.id_configuracion,
    recurso,
    accion,
  };
  if (!auditoriaDisponible) {
    console.log('[api-public] auditoría (sin tabla):', JSON.stringify(fila));
    return;
  }
  try {
    await db.query(
      `INSERT INTO api_public_auditoria
         (id_api_key, id_configuracion, recurso, accion, detalle_previo, detalle_nuevo)
       VALUES (?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          fila.id_api_key,
          fila.id_configuracion,
          recurso,
          accion,
          previo != null ? JSON.stringify(previo).slice(0, 60000) : null,
          nuevo != null ? JSON.stringify(nuevo).slice(0, 60000) : null,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  } catch (e) {
    if (/doesn't exist|Unknown table/i.test(e?.message || '')) {
      auditoriaDisponible = false;
      console.log(
        '[api-public] api_public_auditoria no existe — correr api_public_scopes_migration.sql. Auditando a consola.',
      );
      console.log('[api-public] auditoría:', JSON.stringify(fila));
    } else {
      console.error('[api-public] error auditando:', e.message);
    }
  }
}

async function credsMeta(id_configuracion) {
  const [row] = await db.query(
    `SELECT id_whatsapp AS waba_id, token AS access_token
       FROM configuraciones WHERE id = ? AND suspendido = 0 LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!row?.waba_id || !row?.access_token) {
    throw new AppError('La conexión no tiene credenciales de WhatsApp.', 409);
  }
  return row;
}

/* ═══════════════════════════════════════════════════════════
   BOT / IA — prompts de las columnas del kanban
   ═══════════════════════════════════════════════════════════ */

/* GET /bot — columnas con su prompt. Es la "configuración del bot" real:
   cada columna del tablero tiene el suyo. */
exports.botLeer = catchAsync(async (req, res) => {
  const columnas = await db.query(
    `SELECT id, nombre, estado_db, activo, modelo,
            instrucciones, CHAR_LENGTH(COALESCE(instrucciones,'')) AS instrucciones_chars
       FROM kanban_columnas
      WHERE id_configuracion = ?
      ORDER BY id`,
    { replacements: [req.id_configuracion], type: db.QueryTypes.SELECT },
  );
  const [asistente] = await db.query(
    `SELECT activo FROM openai_assistants
      WHERE id_configuracion = ? AND tipo = 'ventas' AND deleted_at IS NULL
      LIMIT 1`,
    { replacements: [req.id_configuracion], type: db.QueryTypes.SELECT },
  );
  return res.json({
    isSuccess: true,
    data: {
      asistente_ventas_activo: asistente ? Number(asistente.activo) === 1 : false,
      columnas,
    },
  });
});

/* PUT /bot/columnas/:id — body { instrucciones }. El prompt anterior vuelve
   en la respuesta y queda en la auditoría: pisarlo sin respaldo es la clase
   de accidente que no se puede deshacer. */
exports.botEditarColumna = catchAsync(async (req, res, next) => {
  const idColumna = Number(req.params.id);
  const instrucciones = String(req.body?.instrucciones ?? '');
  if (!idColumna) return next(new AppError('id de columna inválido', 400));
  if (instrucciones.trim().length < 50) {
    return next(
      new AppError(
        'instrucciones demasiado cortas (mínimo 50 caracteres): un prompt vacío apaga el bot de la columna.',
        400,
      ),
    );
  }
  if (instrucciones.length > 60000) {
    return next(new AppError('instrucciones demasiado largas (máx 60000).', 400));
  }

  const [col] = await db.query(
    `SELECT id, nombre, estado_db, instrucciones FROM kanban_columnas
      WHERE id = ? AND id_configuracion = ? LIMIT 1`,
    {
      replacements: [idColumna, req.id_configuracion],
      type: db.QueryTypes.SELECT,
    },
  );
  if (!col) return next(new AppError('Columna no encontrada en esta conexión.', 404));

  /* El cierre de venta depende de que el prompt exija el tag: si el nuevo
     texto perdió TODOS los tags que el anterior sí tenía, casi seguro es un
     error del CRM — se rechaza con explicación, no en silencio. */
  const teniaTags = /\[[a-z_]+\]\s*:\s*true/i.test(col.instrucciones || '');
  const traeTags = /\[[a-z_]+\]\s*:\s*true/i.test(instrucciones);
  if (teniaTags && !traeTags) {
    return next(
      new AppError(
        'El prompt actual usa tags de acción ([generar_guia]:true, [asesor]:true…) y el nuevo texto no trae ninguno. Sin esos tags el bot deja de cerrar ventas y de derivar a asesor. Inclúyelos o confirma el cambio con el dueño de la conexión.',
        422,
      ),
    );
  }

  await db.query(
    `UPDATE kanban_columnas SET instrucciones = ? WHERE id = ? AND id_configuracion = ?`,
    {
      replacements: [instrucciones, idColumna, req.id_configuracion],
      type: db.QueryTypes.UPDATE,
    },
  );
  await auditar(req, {
    recurso: `bot.columna.${idColumna}`,
    accion: 'update',
    previo: { instrucciones: col.instrucciones },
    nuevo: { instrucciones },
  });

  return res.json({
    isSuccess: true,
    data: {
      id: col.id,
      nombre: col.nombre,
      estado_db: col.estado_db,
      instrucciones_anteriores: col.instrucciones,
    },
  });
});

/* ═══════════════════════════════════════════════════════════
   FLUJOS — etapas del tablero + secuencias de remarketing
   ═══════════════════════════════════════════════════════════ */

exports.flujosLeer = catchAsync(async (req, res) => {
  const columnas = await db.query(
    `SELECT id, nombre, estado_db, activo, es_principal, es_dropi_principal
       FROM kanban_columnas WHERE id_configuracion = ? ORDER BY id`,
    { replacements: [req.id_configuracion], type: db.QueryTypes.SELECT },
  );
  const secuencias = await db.query(
    `SELECT id, estado_contacto, secuencia, tiempo_espera_minutos,
            nombre_template, language_code, metodo_dentro_24h, prompt_ia,
            estado_destino, activo
       FROM configuracion_remarketing
      WHERE id_configuracion = ?
      ORDER BY estado_contacto, secuencia`,
    { replacements: [req.id_configuracion], type: db.QueryTypes.SELECT },
  );
  const porEstado = {};
  for (const s of secuencias) {
    (porEstado[s.estado_contacto] = porEstado[s.estado_contacto] || []).push(s);
  }
  return res.json({
    isSuccess: true,
    data: { columnas, remarketing: porEstado },
  });
});

/* PUT /flujos/remarketing/:estado — reemplaza la secuencia completa de esa
   columna (mismo contrato que la pantalla interna: insertar "solo lo que
   falta" rompería la numeración del encadenado). */
exports.flujosEditarRemarketing = catchAsync(async (req, res, next) => {
  const estado = String(req.params.estado || '').trim();
  const secuencias = Array.isArray(req.body?.secuencias)
    ? req.body.secuencias
    : null;
  if (!estado) return next(new AppError('estado requerido', 400));
  if (!secuencias || !secuencias.length || secuencias.length > 5) {
    return next(new AppError('secuencias debe ser un array de 1 a 5 pasos.', 400));
  }

  const [col] = await db.query(
    `SELECT id FROM kanban_columnas
      WHERE id_configuracion = ? AND estado_db = ? LIMIT 1`,
    { replacements: [req.id_configuracion, estado], type: db.QueryTypes.SELECT },
  );
  if (!col) {
    return next(
      new AppError(`La columna "${estado}" no existe en esta conexión.`, 404),
    );
  }

  const limpias = [];
  for (let i = 0; i < secuencias.length; i++) {
    const s = secuencias[i] || {};
    const minutos = Number(s.tiempo_espera_minutos);
    if (!Number.isFinite(minutos) || minutos < 10 || minutos > 20160) {
      return next(
        new AppError(
          `Paso ${i + 1}: tiempo_espera_minutos debe estar entre 10 y 20160 (14 días).`,
          400,
        ),
      );
    }
    const metodo = ['ia', 'respuesta_rapida', 'ninguno'].includes(
      String(s.metodo_dentro_24h || 'ninguno'),
    )
      ? String(s.metodo_dentro_24h || 'ninguno')
      : 'ninguno';
    const nombre_template = String(s.nombre_template || '').trim();
    const prompt_ia = s.prompt_ia != null ? String(s.prompt_ia) : null;
    if (metodo === 'ia' && !(prompt_ia || '').trim()) {
      return next(new AppError(`Paso ${i + 1}: metodo "ia" requiere prompt_ia.`, 400));
    }
    /* La misma lección del caso 889: IA sin plantilla de respaldo no le llega
       al que no responde. Se acepta, pero el contrato lo dice. */
    limpias.push({
      secuencia: i + 1,
      tiempo_espera_minutos: minutos,
      nombre_template,
      metodo_dentro_24h: metodo,
      prompt_ia,
      estado_destino: String(s.estado_destino || estado).trim() || estado,
      sin_respaldo: metodo !== 'ninguno' && !nombre_template,
    });
  }

  const previas = await db.query(
    `SELECT secuencia, tiempo_espera_minutos, nombre_template,
            metodo_dentro_24h, prompt_ia, estado_destino, activo
       FROM configuracion_remarketing
      WHERE id_configuracion = ? AND estado_contacto = ?
      ORDER BY secuencia`,
    { replacements: [req.id_configuracion, estado], type: db.QueryTypes.SELECT },
  );

  await db.query(
    `DELETE FROM configuracion_remarketing
      WHERE id_configuracion = ? AND estado_contacto = ?`,
    {
      replacements: [req.id_configuracion, estado],
      type: db.QueryTypes.DELETE,
    },
  );
  for (const s of limpias) {
    await db.query(
      `INSERT INTO configuracion_remarketing
         (id_configuracion, estado_contacto, secuencia,
          tiempo_espera_horas, tiempo_espera_minutos,
          nombre_template, language_code, estado_destino,
          metodo_dentro_24h, prompt_ia, usar_respuesta_rapida, activo)
       VALUES (?, ?, ?, ?, ?, ?, 'es', ?, ?, ?, ?, 1)`,
      {
        replacements: [
          req.id_configuracion,
          estado,
          s.secuencia,
          Math.round(s.tiempo_espera_minutos / 60),
          s.tiempo_espera_minutos,
          s.nombre_template,
          s.estado_destino,
          s.metodo_dentro_24h,
          s.prompt_ia,
          s.metodo_dentro_24h === 'respuesta_rapida' ? 1 : 0,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  }

  await auditar(req, {
    recurso: `flujos.remarketing.${estado}`,
    accion: 'update',
    previo: previas,
    nuevo: limpias,
  });

  return res.json({
    isSuccess: true,
    data: {
      estado_contacto: estado,
      pasos: limpias.length,
      advertencias: limpias
        .filter((s) => s.sin_respaldo)
        .map(
          (s) =>
            `Paso ${s.secuencia}: método "${s.metodo_dentro_24h}" sin nombre_template de respaldo — solo llegará a clientes que hayan escrito en las últimas 24h.`,
        ),
    },
  });
});

/* ═══════════════════════════════════════════════════════════
   RESPUESTAS RÁPIDAS (atajos del chat) — templates_chat_center
   ═══════════════════════════════════════════════════════════ */

exports.rapidasLeer = catchAsync(async (req, res) => {
  const rows = await db.query(
    `SELECT id_template AS id, atajo, mensaje, tipo_mensaje, ruta_archivo
       FROM templates_chat_center
      WHERE id_configuracion = ?
      ORDER BY atajo`,
    { replacements: [req.id_configuracion], type: db.QueryTypes.SELECT },
  );
  return res.json({ isSuccess: true, data: rows });
});

const validarRapida = (body) => {
  const atajo = String(body?.atajo || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .slice(0, 60);
  const mensaje = String(body?.mensaje || '').trim();
  if (!atajo) throw new AppError('atajo es requerido', 400);
  if (!mensaje || mensaje.length > 4000) {
    throw new AppError('mensaje es requerido (máx 4000 caracteres)', 400);
  }
  return { atajo, mensaje };
};

/* Solo texto por API (v1): los atajos con media se crean desde el panel. */
exports.rapidasCrear = catchAsync(async (req, res) => {
  const { atajo, mensaje } = validarRapida(req.body);
  const [ya] = await db.query(
    `SELECT id_template FROM templates_chat_center
      WHERE id_configuracion = ? AND atajo = ? LIMIT 1`,
    { replacements: [req.id_configuracion, atajo], type: db.QueryTypes.SELECT },
  );
  if (ya) throw new AppError(`El atajo "${atajo}" ya existe. Usa PUT para editarlo.`, 409);

  await db.query(
    `INSERT INTO templates_chat_center
       (id_configuracion, id_plataforma, atajo, mensaje, tipo_mensaje, principal)
     VALUES (?, NULL, ?, ?, 'text', 0)`,
    {
      replacements: [req.id_configuracion, atajo, mensaje],
      type: db.QueryTypes.INSERT,
    },
  );
  await auditar(req, {
    recurso: `rapidas.${atajo}`,
    accion: 'create',
    previo: null,
    nuevo: { atajo, mensaje },
  });
  return res.json({ isSuccess: true, data: { atajo, mensaje } });
});

exports.rapidasEditar = catchAsync(async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) return next(new AppError('id inválido', 400));
  const mensaje = String(req.body?.mensaje || '').trim();
  if (!mensaje || mensaje.length > 4000) {
    return next(new AppError('mensaje es requerido (máx 4000 caracteres)', 400));
  }
  const [previo] = await db.query(
    `SELECT id_template, atajo, mensaje, tipo_mensaje FROM templates_chat_center
      WHERE id_template = ? AND id_configuracion = ? LIMIT 1`,
    { replacements: [id, req.id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!previo) return next(new AppError('Respuesta rápida no encontrada.', 404));
  if (previo.tipo_mensaje !== 'text') {
    return next(
      new AppError('Por API solo se editan atajos de texto; los de media van por el panel.', 422),
    );
  }
  await db.query(
    `UPDATE templates_chat_center SET mensaje = ?
      WHERE id_template = ? AND id_configuracion = ?`,
    {
      replacements: [mensaje, id, req.id_configuracion],
      type: db.QueryTypes.UPDATE,
    },
  );
  await auditar(req, {
    recurso: `rapidas.${previo.atajo}`,
    accion: 'update',
    previo: { mensaje: previo.mensaje },
    nuevo: { mensaje },
  });
  return res.json({ isSuccess: true, data: { id, atajo: previo.atajo, mensaje } });
});

exports.rapidasEliminar = catchAsync(async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) return next(new AppError('id inválido', 400));
  const [previo] = await db.query(
    `SELECT id_template, atajo, mensaje FROM templates_chat_center
      WHERE id_template = ? AND id_configuracion = ? LIMIT 1`,
    { replacements: [id, req.id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!previo) return next(new AppError('Respuesta rápida no encontrada.', 404));
  await db.query(
    `DELETE FROM templates_chat_center WHERE id_template = ? AND id_configuracion = ?`,
    { replacements: [id, req.id_configuracion], type: db.QueryTypes.DELETE },
  );
  await auditar(req, {
    recurso: `rapidas.${previo.atajo}`,
    accion: 'delete',
    previo,
    nuevo: null,
  });
  return res.json({ isSuccess: true, data: { id, atajo: previo.atajo } });
});

/* ═══════════════════════════════════════════════════════════
   PLANTILLAS META (WhatsApp)
   ═══════════════════════════════════════════════════════════ */

exports.plantillasMetaLeer = catchAsync(async (req, res) => {
  const creds = await credsMeta(req.id_configuracion);
  const { data } = await axios.get(
    `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${creds.waba_id}/message_templates?fields=name,status,category,language,components&limit=200`,
    {
      headers: { Authorization: `Bearer ${creds.access_token}` },
      timeout: 20000,
    },
  );
  return res.json({ isSuccess: true, data: data?.data || [] });
});

/* POST /plantillas-meta — v1: BODY (con variables y example) + BUTTONS
   (quick_reply / url) + HEADER de TEXTO fijo. Sin media (eso requiere subir
   el archivo de ejemplo: por el panel). La aprobación la decide Meta. */
exports.plantillasMetaCrear = catchAsync(async (req, res, next) => {
  const name = String(req.body?.name || '').trim();
  const language = String(req.body?.language || 'es').trim();
  const category = ['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(
    String(req.body?.category || '').toUpperCase(),
  )
    ? String(req.body.category).toUpperCase()
    : 'UTILITY';
  const components = Array.isArray(req.body?.components)
    ? req.body.components
    : null;

  if (!/^[a-z0-9_]{1,60}$/.test(name)) {
    return next(
      new AppError('name inválido: minúsculas, números y _ (máx 60).', 400),
    );
  }
  if (!components?.length) {
    return next(new AppError('components es requerido.', 400));
  }
  for (const c of components) {
    const tipo = String(c?.type || '').toUpperCase();
    if (!['BODY', 'BUTTONS', 'HEADER', 'FOOTER'].includes(tipo)) {
      return next(new AppError(`Componente no soportado: ${c?.type}`, 400));
    }
    if (tipo === 'HEADER' && String(c?.format || 'TEXT').toUpperCase() !== 'TEXT') {
      return next(
        new AppError(
          'Por API solo se crean encabezados de TEXTO. Las plantillas con imagen/video se crean desde el panel (necesitan archivo de ejemplo).',
          422,
        ),
      );
    }
  }

  const creds = await credsMeta(req.id_configuracion);
  const resp = await axios.post(
    `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${creds.waba_id}/message_templates`,
    { name, language, category, components },
    {
      headers: {
        Authorization: `Bearer ${creds.access_token}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
      validateStatus: () => true,
    },
  );
  if (resp.status < 200 || resp.status >= 300) {
    return res.status(422).json({
      isSuccess: false,
      error: resp.data?.error || resp.data,
    });
  }
  await auditar(req, {
    recurso: `plantillas_meta.${name}`,
    accion: 'create',
    previo: null,
    nuevo: { name, language, category, components },
  });
  return res.json({ isSuccess: true, data: resp.data });
});
