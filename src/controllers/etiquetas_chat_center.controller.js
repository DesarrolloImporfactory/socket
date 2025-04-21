const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const EtiquetasChatCenterEntity = require('../entities/etiquetas_chat_center');
const EtiquetaService = require('../services/etiqueta.service');


/**
 * POST /api/v1/etiquetas_chat_center/agregarEtiqueta
 *
 * Crea una nueva etiqueta asociada a una plataforma.
 *
 * @param {string} nombre_etiqueta - Nombre visible de la etiqueta
 * @param {string} color_etiqueta - Color en formato HEX (ej: #FF0000)
 * @param {number} id_plataforma - ID de la plataforma asociada
 * @returns {object} status 200 si se crea, 500 si ocurre error
 *
 * @example Body JSON:
 * {
 *   "nombre_etiqueta": "Urgente",
 *   "color_etiqueta": "#ff0000",
 *   "id_plataforma": 1
 * }
 */

exports.AgregarEtiqueta = catchAsync(async (req, res, next) => {
    const { nombre_etiqueta, color_etiqueta, id_plataforma } = req.body;

    try {
        const etiqueta = new EtiquetasChatCenterEntity(nombre_etiqueta, color_etiqueta, id_plataforma);
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
exports.EliminarEtiqueta = catchAsync(async (req, res, next) => {
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
