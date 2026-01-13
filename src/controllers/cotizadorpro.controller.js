const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const Clientes_chat_center = require('../models/clientes_chat_center.model');
const User = require('../models/user.model');
const Plaforma = require('../models/plataforma.model');
const { Op } = require('sequelize');
const { normalizePhoneNumber, generatePhoneVariations } = require('../utils/phoneUtils');
const UsuarioPlataforma = require('../models/usuario_plataforma.model');
const { db_2 } = require('../database/config');
exports.obtenerCotizaciones = catchAsync(async (req, res, next) => {    
    const { id_chat } = req.params;

    if (!id_chat) {
        return next(new AppError('id_chat es requerido', 400));
    }

    const  cliente  = await Clientes_chat_center.findOne({ where: { id: id_chat } });

    if (!cliente) {
        return next(new AppError('Cliente no encontrado', 404));
    }

    const celular = cliente.celular_cliente;

    // Normalizar el número de teléfono
    const phoneInfo = normalizePhoneNumber(celular, '593'); // '593' es Ecuador por defecto
    console.log('Información del teléfono:', phoneInfo);
    // { normalizedPhone: '987654321', countryCode: '593', country: 'Ecuador', hasCountryCode: true/false }

    // Generar variaciones del número para búsqueda flexible
    const phoneVariations = generatePhoneVariations(celular, '593');

    // Buscar plataformas usando las variaciones del número
    const plataforma = await Plaforma.findAll({ 
        where: { 
            [Op.or]: phoneVariations.map(variation => ({
                whatsapp: { [Op.like]: `%${variation}%` }
            }))
        }, 
        order: [['id_plataforma', 'ASC']] 
    });

    // poner todos los id_plataforma en un array
    const plataformaIds = plataforma.map(p => p.id_plataforma);
    console.log('IDs de plataformas:', plataformaIds);

    const usuarioPlataformas = await UsuarioPlataforma.findAll({ 
        where: {
            id_plataforma: {
                [Op.in]: plataformaIds
            }
        }
    });

    //poner todo los id_usuario en un array
    const usuarioIds = usuarioPlataformas.map(up => up.id_usuario);

    //buscar cotizaciones de esos usuarios
    const cotizaciones = await db_2.query(`
        SELECT 
                    c.id_cotizacion,
                    c.fecha_creacion,
                    c.estado,
                    d.pais_origen,
                    d.pais_destino,
                    COUNT(pc.id_producto_cot) AS total_productos,
                    SUM(pc.cant) AS total_cantidad,
                    COUNT(DISTINCT pc.id_proveedor) AS total_proveedores,
                    u.nombre_users as cliente,
                    a.nombre_users as asesor
                FROM cotizadorpro_cotizaciones c
                LEFT JOIN cotizadorpro_detalle_cot d ON c.id_cotizacion = d.id_cotizacion
                LEFT JOIN cotizadorpro_productos_cot pc ON c.id_cotizacion = pc.id_cotizacion
                LEFT JOIN users u ON d.id_users = u.id_users
                LEFT JOIN users a ON c.id_asesor = a.id_users
                WHERE d.id_users IN (${usuarioIds.join(',')})
                GROUP BY c.id_cotizacion
                ORDER BY c.fecha_creacion DESC
        ` , { type: db_2.QueryTypes.SELECT });

    console.log('Cotizaciones encontradas:', cotizaciones.length);
        
    console.log("Query ejecutada:", cotizaciones);
    res.status(200).json({
        status: '200',
        title: 'Petición exitosa',
        message: 'Cotizaciones obtenidas correctamente',
        cotizaciones: cotizaciones ? cotizaciones : []
    });
});