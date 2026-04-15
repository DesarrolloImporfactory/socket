const catchAsync = require('../utils/catchAsync');
const { db } = require('../database/config');

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

// ── Obtener config de todos los estados ──────────────────────
exports.obtener = catchAsync(async (req, res) => {
  const { id_configuracion } = req.body;

  const registros = await db.query(
    `SELECT estado_dropi, nombre_template, language_code, activo,
            mensaje_rapido, usar_respuesta_rapida, parametros_json
     FROM dropi_plantillas_config
     WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  const resultado = {};
  for (const estado of ESTADOS_DROPI) {
    const encontrado = registros.find((r) => r.estado_dropi === estado);
    resultado[estado] = {
      nombre_template: encontrado?.nombre_template || '',
      language_code: encontrado?.language_code || 'es',
      activo: encontrado?.activo ?? 0,
      mensaje_rapido: encontrado?.mensaje_rapido || '',
      usar_respuesta_rapida: encontrado?.usar_respuesta_rapida ?? 1,
      parametros_json: encontrado?.parametros_json || null,
    };
  }

  return res.json({ success: true, data: resultado });
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
  } = req.body;

  if (!id_configuracion || !estado_dropi) {
    return res
      .status(400)
      .json({ success: false, message: 'Faltan campos obligatorios' });
  }

  const [existe] = await db.query(
    `SELECT id FROM dropi_plantillas_config
     WHERE id_configuracion = ? AND estado_dropi = ? LIMIT 1`,
    {
      replacements: [id_configuracion, estado_dropi],
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
           parametros_json = ?
       WHERE id_configuracion = ? AND estado_dropi = ?`,
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
          id_configuracion,
          estado_dropi,
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
  } else {
    await db.query(
      `INSERT INTO dropi_plantillas_config
         (id_configuracion, estado_dropi, nombre_template, language_code,
          activo, mensaje_rapido, usar_respuesta_rapida, parametros_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_configuracion,
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
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  }

  return res.json({ success: true, message: 'Configuración guardada' });
});
