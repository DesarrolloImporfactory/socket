const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const EtiquetaService = require ('../services/etiqueta.service');

exports.obtenerEtiquetasAsignadas = catchAsync(async(req, res, next)=>{
    const id_cliente_chat_center = parseInt(req.body.id_cliente_chat_center, 10);
    
    if(!id_cliente_chat_center){
        return next(new AppError('id_cliente_chat_center es requerido', 400));
    }

    const etiquetasAsignadas = await EtiquetaService.obtenerEtiquetasAsignadas(id_cliente_chat_center);

    res.status(200).json({
        status: '200',
        title: 'Petición exitosa',
        message: 'Etiquetas asignadas obtenidas correctamente',
        etiquetasAsignadas,
    })
})