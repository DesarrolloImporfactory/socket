const crypto = require('crypto');
const { Op } = require('sequelize');
const catchAsync = require('../utils/catchAsync');
const ShopifyConfiguraciones = require('../models/shopify_configuraciones.model');

/* ============================================================
   Helpers
   ============================================================ */
const generarWebhookSecret = () => {
  return crypto.randomBytes(32).toString('hex');
};

const validarShopDomain = (domain) => {
  if (!domain) return false;
  const d = String(domain).trim().toLowerCase();
  return d.endsWith('.myshopify.com') && d.length > '.myshopify.com'.length;
};

const normalizarShopDomain = (domain) => {
  return String(domain).trim().toLowerCase();
};

/* ============================================================
   GET / — listar configuraciones por id_configuracion
   ============================================================ */
exports.listar = catchAsync(async (req, res) => {
  const { id_configuracion } = req.query;

  if (!id_configuracion) {
    return res.status(400).json({
      isSuccess: false,
      message: 'id_configuracion es requerido',
    });
  }

  const configs = await ShopifyConfiguraciones.findAll({
    where: { id_configuracion: parseInt(id_configuracion, 10) },
    order: [['created_at', 'DESC']],
  });

  return res.json({
    isSuccess: true,
    data: configs,
  });
});

/* ============================================================
   POST / — crear nueva configuración
   ============================================================ */
exports.crear = catchAsync(async (req, res) => {
  const { id_configuracion, shop_domain, prefijo_pais, tiempo_espera_horas } =
    req.body;

  // Validaciones
  if (!id_configuracion) {
    return res.status(400).json({
      isSuccess: false,
      message: 'id_configuracion es requerido',
    });
  }

  if (!validarShopDomain(shop_domain)) {
    return res.status(400).json({
      isSuccess: false,
      message: 'El dominio debe terminar en .myshopify.com',
    });
  }

  const shopDomainNormalizado = normalizarShopDomain(shop_domain);

  // Regla: 1 sola integración por configuración
  const existeEnConfig = await ShopifyConfiguraciones.findOne({
    where: { id_configuracion: parseInt(id_configuracion, 10) },
  });
  if (existeEnConfig) {
    return res.status(409).json({
      isSuccess: false,
      message:
        'Ya existe una integración Shopify para esta configuración. Elimine la actual primero.',
    });
  }

  // Verificar que el dominio no esté usado por otra cuenta
  const dominioUsado = await ShopifyConfiguraciones.findOne({
    where: { shop_domain: shopDomainNormalizado },
  });
  if (dominioUsado) {
    return res.status(409).json({
      isSuccess: false,
      message: 'Este dominio Shopify ya está registrado en otra cuenta.',
    });
  }

  // Crear con secret auto-generado
  const nuevo = await ShopifyConfiguraciones.create({
    id_configuracion: parseInt(id_configuracion, 10),
    shop_domain: shopDomainNormalizado,
    webhook_secret: generarWebhookSecret(),
    prefijo_pais: prefijo_pais || '593',
    tiempo_espera_horas: parseInt(tiempo_espera_horas, 10) || 1,
    activo: 1,
  });

  return res.status(201).json({
    isSuccess: true,
    data: nuevo,
    message: 'Integración Shopify creada correctamente',
  });
});

/* ============================================================
   PATCH /:id — editar configuración
   ============================================================ */
exports.editar = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { shop_domain, prefijo_pais, tiempo_espera_horas, activo } = req.body;

  const config = await ShopifyConfiguraciones.findByPk(id);
  if (!config) {
    return res.status(404).json({
      isSuccess: false,
      message: 'Configuración no encontrada',
    });
  }

  // Si cambian el shop_domain, validar
  if (shop_domain !== undefined) {
    if (!validarShopDomain(shop_domain)) {
      return res.status(400).json({
        isSuccess: false,
        message: 'El dominio debe terminar en .myshopify.com',
      });
    }

    const shopDomainNormalizado = normalizarShopDomain(shop_domain);

    // Si es diferente al actual, verificar que no esté en otra cuenta
    if (shopDomainNormalizado !== config.shop_domain) {
      const otroDominio = await ShopifyConfiguraciones.findOne({
        where: {
          shop_domain: shopDomainNormalizado,
          id: { [Op.ne]: parseInt(id, 10) },
        },
      });
      if (otroDominio) {
        return res.status(409).json({
          isSuccess: false,
          message: 'Este dominio ya está registrado en otra cuenta',
        });
      }
    }
  }

  // Construir updates solo con campos permitidos
  const updates = {};
  if (shop_domain !== undefined)
    updates.shop_domain = normalizarShopDomain(shop_domain);
  if (prefijo_pais !== undefined) updates.prefijo_pais = prefijo_pais;
  if (tiempo_espera_horas !== undefined)
    updates.tiempo_espera_horas = parseInt(tiempo_espera_horas, 10) || 1;
  if (activo !== undefined) updates.activo = activo ? 1 : 0;

  await config.update(updates);

  return res.json({
    isSuccess: true,
    data: config,
    message: 'Configuración actualizada correctamente',
  });
});

/* ============================================================
   DELETE /:id — eliminar configuración
   ============================================================ */
exports.eliminar = catchAsync(async (req, res) => {
  const { id } = req.params;

  const config = await ShopifyConfiguraciones.findByPk(id);
  if (!config) {
    return res.status(404).json({
      isSuccess: false,
      message: 'Configuración no encontrada',
    });
  }

  await config.destroy();

  return res.json({
    isSuccess: true,
    message: 'Configuración eliminada correctamente',
  });
});

/* ============================================================
   POST /:id/regenerar-secret — regenerar webhook secret
   ============================================================ */
exports.regenerarSecret = catchAsync(async (req, res) => {
  const { id } = req.params;

  const config = await ShopifyConfiguraciones.findByPk(id);
  if (!config) {
    return res.status(404).json({
      isSuccess: false,
      message: 'Configuración no encontrada',
    });
  }

  const nuevoSecret = generarWebhookSecret();
  await config.update({ webhook_secret: nuevoSecret });

  return res.json({
    isSuccess: true,
    data: config,
    message:
      'Webhook secret regenerado. Recuerda actualizarlo en cada webhook de Shopify.',
  });
});
