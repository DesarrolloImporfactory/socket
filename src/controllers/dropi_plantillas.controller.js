const catchAsync = require('../utils/catchAsync');
const { db } = require('../database/config');
const {
  ESTADOS_ALICLIK,
  ALICLIK_EXPONE_GUIA,
  dependeDeLaGuia,
} = require('../services/aliclik_notifier.service');
const {
  rangoDiasEntrega,
  invalidarConfigRespondedor,
} = require('../utils/respondedorLogistico');

const ESTADOS_DROPI = [
  'PENDIENTE CONFIRMACION',
  'CANCELADO',
  'CARRITOS ABANDONADOS',
  'PENDIENTE',
  'GUIA GENERADA',
  'EN TRANSITO',
  'RETIRO EN AGENCIA',
  'NOVEDAD',
  'ENTREGADA',
  'DEVOLUCION',
];

/**
 * Esta pantalla configura "estado del pedido → plantilla de WhatsApp", y eso
 * es común a cualquier proveedor de fulfillment. Lo único que cambia por
 * proveedor es qué estados existen: Aliclik no tiene guías (no expone el
 * número en ninguna parte de su API) ni carritos abandonados.
 */
const ESTADOS_POR_PROVEEDOR = {
  dropi: ESTADOS_DROPI,
  aliclik: ESTADOS_ALICLIK,
};

function resolverProveedor(valor) {
  const p = String(valor || 'dropi')
    .trim()
    .toLowerCase();
  return ESTADOS_POR_PROVEEDOR[p] ? p : 'dropi';
}

// ── Obtener config de todos los estados ──────────────────────
exports.obtener = catchAsync(async (req, res) => {
  const { id_configuracion } = req.body;
  const proveedor = resolverProveedor(req.body.proveedor);

  const traerFilas = (prov) =>
    db.query(
      `SELECT estado_dropi, nombre_template, language_code, activo,
              mensaje_rapido, usar_respuesta_rapida, parametros_json, body_text,
              columna_destino, enviar_en_orden_bot
       FROM dropi_plantillas_config
       WHERE id_configuracion = ? AND proveedor = ?`,
      {
        replacements: [id_configuracion, prov],
        type: db.QueryTypes.SELECT,
      },
    );

  const registros = await traerFilas(proveedor);

  // HERENCIA: Aliclik no arranca de cero. Si un estado no tiene fila propia,
  // se muestra la de Dropi —que es la que de verdad va a usar el notifier
  // (services/aliclik_notifier.service.js → getPlantillasAliclik)— marcada
  // como heredada. Guardar en esta pestaña crea la fila propia, que pasa a
  // pisar la de Dropi solo para ese estado.
  const hereda = proveedor === 'aliclik';
  const registrosBase = hereda ? await traerFilas('dropi') : [];

  const resultado = {};
  for (const estado of ESTADOS_POR_PROVEEDOR[proveedor]) {
    const propio = registros.find((r) => r.estado_dropi === estado);
    const heredado = propio
      ? null
      : registrosBase.find((r) => r.estado_dropi === estado) || null;
    const encontrado = propio || heredado;

    // Aliclik todavía no entrega guía: si la plantilla heredada la necesita,
    // el notifier la degrada a "solo mover de columna". Se avisa acá para que
    // la pantalla lo diga en vez de prometer un envío que no ocurre.
    const sinEnvioPorGuia =
      hereda && !ALICLIK_EXPONE_GUIA && dependeDeLaGuia(encontrado);

    resultado[estado] = {
      nombre_template: encontrado?.nombre_template || '',
      language_code: encontrado?.language_code || 'es',
      activo: encontrado?.activo ?? 0,
      mensaje_rapido: encontrado?.mensaje_rapido || '',
      usar_respuesta_rapida: encontrado?.usar_respuesta_rapida ?? 1,
      parametros_json: encontrado?.parametros_json || null,
      body_text: encontrado?.body_text || null,
      columna_destino: encontrado?.columna_destino || null,
      // Solo aplica a PENDIENTE CONFIRMACION: mandar la plantilla también
      // cuando el bot cierra la venta por WhatsApp y crea la orden.
      // Encendido por defecto (registros previos a la columna incluidos).
      enviar_en_orden_bot: encontrado?.enviar_en_orden_bot ?? 1,
      // Viene de la pestaña Dropi, no hay fila propia para este proveedor.
      heredado: !!heredado,
      // Está configurado, pero no va a enviar mensaje: le falta la guía.
      sin_envio_por_guia: !!sinEnvioPorGuia,
    };
  }

  return res.json({ success: true, data: resultado, proveedor });
});

// ── Guardar config de un estado ──────────────────────────────
exports.guardar = catchAsync(async (req, res) => {
  const {
    id_configuracion,
    estado_dropi,
    nombre_template,
    language_code,
    activo,
    mensaje_rapido,
    usar_respuesta_rapida,
    parametros_json,
    body_text,
    columna_destino,
    enviar_en_orden_bot,
  } = req.body;

  if (!id_configuracion || !estado_dropi) {
    return res
      .status(400)
      .json({ success: false, message: 'Faltan campos obligatorios' });
  }

  const proveedor = resolverProveedor(req.body.proveedor);

  // Evita guardar un estado que no existe para ese proveedor (ej. una
  // "GUIA GENERADA" de Aliclik, que nunca se dispararía porque su API no
  // expone guías).
  if (!ESTADOS_POR_PROVEEDOR[proveedor].includes(estado_dropi)) {
    return res.status(400).json({
      success: false,
      message: `El estado "${estado_dropi}" no aplica para ${proveedor}`,
    });
  }

  // Normalizar columna_destino: string vacío → null
  const columnaDestinoClean =
    columna_destino && String(columna_destino).trim() !== ''
      ? String(columna_destino).trim()
      : null;

  const tieneTemplate = !!(nombre_template && nombre_template.trim());

  // Gate "venta cerrada por el bot" (solo lo usa PENDIENTE CONFIRMACION). Si
  // el front no lo manda, se conserva el valor actual en vez de resetearlo.
  const envioBotClean =
    enviar_en_orden_bot === undefined || enviar_en_orden_bot === null
      ? null
      : enviar_en_orden_bot
        ? 1
        : 0;

  // Validar: si se activa, debe tener una plantilla seleccionada O estar en
  // modo "solo mover de columna" (sin plantilla, pero con columna destino).
  if (activo && !tieneTemplate && !columnaDestinoClean) {
    return res.status(400).json({
      success: false,
      message:
        'Selecciona una plantilla de WhatsApp o una columna destino para activar este estado',
    });
  }

  const [existe] = await db.query(
    `SELECT id FROM dropi_plantillas_config
     WHERE id_configuracion = ? AND proveedor = ? AND estado_dropi = ? LIMIT 1`,
    {
      replacements: [id_configuracion, proveedor, estado_dropi],
      type: db.QueryTypes.SELECT,
    },
  );

  if (existe) {
    await db.query(
      `UPDATE dropi_plantillas_config
       SET nombre_template = ?,
           language_code = ?,
           activo = ?,
           mensaje_rapido = ?,
           usar_respuesta_rapida = ?,
           parametros_json = ?,
           body_text = ?,
           columna_destino = ?,
           enviar_en_orden_bot = COALESCE(?, enviar_en_orden_bot)
       WHERE id_configuracion = ? AND proveedor = ? AND estado_dropi = ?`,
      {
        replacements: [
          nombre_template || null,
          language_code || 'es',
          activo ? 1 : 0,
          mensaje_rapido || null,
          usar_respuesta_rapida !== undefined
            ? usar_respuesta_rapida
              ? 1
              : 0
            : 1,
          parametros_json || null,
          body_text || null,
          columnaDestinoClean,
          envioBotClean,
          id_configuracion,
          proveedor,
          estado_dropi,
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
  } else {
    await db.query(
      `INSERT INTO dropi_plantillas_config
         (id_configuracion, proveedor, estado_dropi, nombre_template, language_code,
          activo, mensaje_rapido, usar_respuesta_rapida, parametros_json, body_text,
          columna_destino, enviar_en_orden_bot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_configuracion,
          proveedor,
          estado_dropi,
          nombre_template || null,
          language_code || 'es',
          activo ? 1 : 0,
          mensaje_rapido || null,
          usar_respuesta_rapida !== undefined
            ? usar_respuesta_rapida
              ? 1
              : 0
            : 1,
          parametros_json || null,
          body_text || null,
          columnaDestinoClean,
          envioBotClean === null ? 1 : envioBotClean,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  }

  return res.json({ success: true, message: 'Configuración guardada' });
});

/* ═══════════════════════════════════════════════════════════
   Respondedor logístico sin IA (utils/respondedorLogistico.js)
   Ajustes por cuenta: interruptor general + rango manual de
   días para la intención "demora". Sin fila = encendido y
   automático (histórico real de entregas).
   ═══════════════════════════════════════════════════════════ */

// Tope alto a propósito: solo evita basura (0, negativos, "999"), no opina
// sobre la promesa comercial — eso es decisión del negocio.
const DEMORA_DIAS_TOPE = 60;

// ── Obtener config del respondedor ──────────────────────────
exports.obtenerRespondedor = catchAsync(async (req, res) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion) {
    return res
      .status(400)
      .json({ success: false, message: 'Falta id_configuracion' });
  }

  const [row] = await db.query(
    `SELECT activo, demora_dias_min, demora_dias_max
       FROM respondedor_logistico_config
      WHERE id_configuracion = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  // El rango real (últimos 90 días, toda la tienda) se muestra en la pantalla
  // como referencia: que el negocio decida el manual viendo sus datos.
  const rango_auto = await rangoDiasEntrega(id_configuracion, null).catch(
    () => null,
  );

  return res.json({
    success: true,
    data: {
      activo: row ? Number(row.activo) : 1,
      demora_dias_min: row?.demora_dias_min ?? null,
      demora_dias_max: row?.demora_dias_max ?? null,
      rango_auto,
    },
  });
});

// ── Guardar config del respondedor ──────────────────────────
exports.guardarRespondedor = catchAsync(async (req, res) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion) {
    return res
      .status(400)
      .json({ success: false, message: 'Falta id_configuracion' });
  }

  const activo = req.body.activo ? 1 : 0;

  // Rango manual: o los dos días válidos, o ninguno (automático).
  let min = req.body.demora_dias_min;
  let max = req.body.demora_dias_max;
  const vacio = (v) => v === null || v === undefined || v === '';
  if (vacio(min) && vacio(max)) {
    min = null;
    max = null;
  } else {
    min = Number(min);
    max = Number(max);
    if (
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min < 1 ||
      max < min ||
      max > DEMORA_DIAS_TOPE
    ) {
      return res.status(400).json({
        success: false,
        message: `El rango manual debe ser en días enteros: mínimo 1, máximo ${DEMORA_DIAS_TOPE}, y el "hasta" no puede ser menor que el "desde"`,
      });
    }
  }

  await db.query(
    `INSERT INTO respondedor_logistico_config
       (id_configuracion, activo, demora_dias_min, demora_dias_max,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       activo = VALUES(activo),
       demora_dias_min = VALUES(demora_dias_min),
       demora_dias_max = VALUES(demora_dias_max),
       updated_at = NOW()`,
    {
      replacements: [id_configuracion, activo, min, max],
      type: db.QueryTypes.INSERT,
    },
  );

  // El webhook cachea esta config 60s en memoria: al guardar desde la
  // pantalla, que el cambio aplique al siguiente mensaje.
  invalidarConfigRespondedor(id_configuracion);

  return res.json({ success: true, message: 'Configuración guardada' });
});
