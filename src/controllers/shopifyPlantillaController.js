const catchAsync = require('../utils/catchAsync');
const ShopifyConfiguraciones = require('../models/shopify_configuraciones.model');

/* ============================================================
   POST /obtener — leer la config de plantilla actual
   Body: { id_configuracion }
   ============================================================ */
exports.obtener = catchAsync(async (req, res) => {
  const { id_configuracion } = req.body;

  if (!id_configuracion) {
    return res.status(400).json({
      success: false,
      message: 'id_configuracion es requerido',
    });
  }

  const config = await ShopifyConfiguraciones.findOne({
    where: { id_configuracion: parseInt(id_configuracion, 10) },
  });

  if (!config) {
    // No hay integración Shopify aún
    return res.json({ success: true, data: null });
  }

  return res.json({
    success: true,
    data: {
      id: config.id,
      envio_automatico: config.envio_automatico,
      nombre_template: config.nombre_template_recuperacion || null,
      language_code: config.language_code || 'es',
      // se devuelve como string; el front lo parsea con safeJsonParse (igual que dropi_plantillas)
      parametros_json: config.parametros_json || null,
      body_text: config.body_text || null,
    },
  });
});

/* ============================================================
   POST /guardar — guardar la config de plantilla
   Body: {
     id_configuracion,
     nombre_template,
     language_code,
     parametros_json (STRING ya serializado, igual que dropi_plantillas),
     body_text,
     envio_automatico
   }
   ============================================================ */
exports.guardar = catchAsync(async (req, res) => {
  const {
    id_configuracion,
    nombre_template,
    language_code,
    parametros_json,
    body_text,
    envio_automatico,
  } = req.body;

  if (!id_configuracion) {
    return res.status(400).json({
      success: false,
      message: 'id_configuracion es requerido',
    });
  }

  const config = await ShopifyConfiguraciones.findOne({
    where: { id_configuracion: parseInt(id_configuracion, 10) },
  });

  if (!config) {
    return res.status(404).json({
      success: false,
      message:
        'Primero debes conectar tu tienda Shopify antes de configurar la plantilla.',
    });
  }

  // Si activan el envío automático, debe haber un template seleccionado
  if (envio_automatico && !nombre_template) {
    return res.status(400).json({
      success: false,
      message:
        'Debes seleccionar una plantilla para activar el envío automático.',
    });
  }

  await config.update({
    nombre_template_recuperacion: nombre_template || null,
    language_code: language_code || 'es',
    parametros_json: parametros_json || null, // ya viene serializado del front
    body_text: body_text || null,
    envio_automatico: envio_automatico ? 1 : 0,
  });

  return res.json({
    success: true,
    message: 'Configuración de plantilla guardada correctamente',
    data: {
      id: config.id,
      envio_automatico: config.envio_automatico,
      nombre_template: config.nombre_template_recuperacion,
      language_code: config.language_code,
    },
  });
});
