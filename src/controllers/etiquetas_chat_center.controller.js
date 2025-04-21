const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const EtiquetasChatCenterEntity = require('../entities/etiquetas_chat_center');
const EtiquetaService = require('../services/etiqueta.service');

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
