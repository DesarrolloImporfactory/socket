const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const EtiquetasChatCenterEntity = require('../entities/etiquetas_chat_center');
const EtiquetaService = require('../services/etiqueta.service');
const { db } = require('../database/config');


exports.obtenerEtiquetas = catchAsync(async (req, res, next) =>{
    const id_configuracion = parseInt(req.body.id_configuracion, 10);

    if(!id_configuracion){
        return next(new AppError('id_configuracion es requerido', 400));
    }

    const etiquetas = await EtiquetaService.obtenerEtiquetas(id_configuracion);

    res.status(200).json({
        status: '200',
        title: 'Petición exitosa',
        message: 'Etiquetas obtenidas correctamente',
        etiquetas, //arreglo devuelto por Sequelize
    })
})


/**
 * POST /api/v1/etiquetas_chat_center/agregarEtiqueta
 *
 * Crea una nueva etiqueta asociada a una plataforma.
 *
 * @param {string} nombre_etiqueta - Nombre visible de la etiqueta
 * @param {string} color_etiqueta - Color en formato HEX (ej: #FF0000)
 * @param {number} id_configuracion - id_configuracion
 * @returns {object} status 200 si se crea, 500 si ocurre error
 *
 * @example Body JSON:
 * {
 *   "nombre_etiqueta": "Urgente",
 *   "color_etiqueta": "#ff0000",
 *   "id_plataforma": 1
 * }
 */

exports.agregarEtiqueta = catchAsync(async (req, res, next) => {
    const { nombre_etiqueta, color_etiqueta, id_configuracion } = req.body;

    try {
        const etiqueta = new EtiquetasChatCenterEntity(nombre_etiqueta, color_etiqueta, id_configuracion);
        await EtiquetaService.guardar(etiqueta);

        res.status(200).json({
            status: '200',
            title: 'Petición exitosa',
            message: 'Etiqueta agregada correctamente',
        });
    } catch (err) {
        return next(new AppError(err.message || 'Error al agregar la etiqueta', 500));
    }
});

/**
 * DELETE /api/v1/etiquetas_chat_center/eliminarEtiqueta/:id
 *
 * Elimina permanentemente una etiqueta por su ID.
 *
 * @param {number} id - ID de la etiqueta a eliminar (en params)
 * @returns {object} status 200 si se elimina, 500 si ocurre un error
 *
 * @example
 * DELETE /api/v1/etiquetas_chat_center/eliminarEtiqueta/31
 */
exports.eliminarEtiqueta = catchAsync(async (req, res, next) => {
    const id = parseInt(req.params.id, 10); // 👈 cast a entero, El 10 garantiza que lo interpreta como número decimal, no octal, hexadecimal ni nada raro.
    try {
        await EtiquetaService.eliminar(id);

        res.status(200).json({
            status: '200',
            title: 'Petición exitosa',
            message: 'Etiqueta eliminada correctamente'
        });
    } catch (err) {
        return next(new AppError(err.message || 'Error al eliminar la etiqueta', 500));
    }
});

exports.toggleAsignacionEtiqueta = catchAsync(async (req, res, next) =>{
    const {id_cliente_chat_center, id_etiqueta, id_configuracion} = req.body;

    try{
        const resultado = await EtiquetaService.toggleAsignacion(
            id_cliente_chat_center,
            id_etiqueta,
            id_configuracion
        );  
        res.status(resultado.status).json(resultado);
    } catch (err){
        return next(new AppError(err.message || 'Error al asignar/desasignar etiqueta', 500));
    }
})


// GET /api/v1/etiquetas_chat_center/etiquetas_existentes?id_configuracion=OPCIONAL
exports.etiquetasExistentes = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;

  // Etiquetas definidas en catálogo que tengan al menos una asignación (conteo>0).
  // Si pasas id_configuracion, filtra por esa conf; si no, trae global.
  const where = [];
  const params = [];

  if (id_configuracion) { where.push('ecc.id_configuracion = ?'); params.push(id_configuracion); }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const sql = `
    SELECT
      ecc.id_etiqueta,
      ecc.nombre_etiqueta,
      ecc.color_etiqueta,
      COUNT(ea.id) AS conteo
    FROM etiquetas_chat_center ecc
    LEFT JOIN etiquetas_asignadas ea
      ON ea.id_etiqueta = ecc.id_etiqueta
      AND ea.id_configuracion = ecc.id_configuracion
    ${whereClause}
    GROUP BY ecc.id_etiqueta, ecc.nombre_etiqueta, ecc.color_etiqueta
    HAVING conteo > 0
    ORDER BY ecc.nombre_etiqueta ASC;
  `;

  const filas = await db.query(sql, { replacements: params, type: db.QueryTypes.SELECT });

  return res.status(200).json({
    status: 'success',
    etiquetas: filas.map(f => ({
      id_etiqueta: Number(f.id_etiqueta),
      nombre_etiqueta: f.nombre_etiqueta,
      color_etiqueta: f.color_etiqueta,
      conteo: Number(f.conteo || 0),
    })),
  });
});