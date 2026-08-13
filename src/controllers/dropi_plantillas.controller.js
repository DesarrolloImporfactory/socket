const catchAsync = require('../utils/catchAsync');
const { db } = require('../database/config');
const {
  ESTADOS_ALICLIK,
} = require('../services/aliclik_notifier.service');

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

  const registros = await db.query(
    `SELECT estado_dropi, nombre_template, language_code, activo,
            mensaje_rapido, usar_respuesta_rapida, parametros_json, body_text,
            columna_destino, enviar_en_orden_bot
     FROM dropi_plantillas_config
     WHERE id_configuracion = ? AND proveedor = ?`,
    {
      replacements: [id_configuracion, proveedor],
      type: db.QueryTypes.SELECT,
    },
  );

  const resultado = {};
  for (const estado of ESTADOS_POR_PROVEEDOR[proveedor]) {
    const encontrado = registros.find((r) => r.estado_dropi === estado);
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
