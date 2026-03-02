const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');

const CatalogosChatCenter = require('../models/catalogos_chat_center.model');
const CatalogosItemsChatCenter = require('../models/catalogos_items_chat_center.model');
const ProductosChatCenter = require('../models/productos_chat_center.model');
const CategoriasChatCenter = require('../models/categorias_chat_center.model');

// helpers
const toInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const slugify = (text) => {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quitar tildes
    .replace(/[^a-z0-9]+/g, '-') // no alfanumérico -> -
    .replace(/^-+|-+$/g, '') // trim -
    .slice(0, 80);
};

async function generateUniqueSlug(base) {
  const clean = slugify(base) || 'catalogo';
  let slug = clean;
  let i = 0;

  // probar hasta que sea único
  while (true) {
    const exists = await CatalogosChatCenter.findOne({ where: { slug } });
    if (!exists) return slug;
    i += 1;
    slug = `${clean}-${i}`;
  }
}

const normalizeModoVisibilidad = (v) => {
  const val = String(v || '')
    .toUpperCase()
    .trim();
  if (val === 'PUBLIC_ONLY' || val === 'PRIVATE_ONLY' || val === 'BOTH')
    return val;
  return 'BOTH';
};

// ========== LISTAR ==========
exports.listarCatalogos = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const catalogos = await CatalogosChatCenter.findAll({
    where: { id_configuracion, eliminado: 0 },
    order: [['id', 'DESC']],
  });

  return res.status(200).json({ status: 'success', data: catalogos });
});

// ========== OBTENER (detalle + items) ==========
exports.obtenerCatalogo = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  const id_catalogo = toInt(req.body?.id_catalogo);

  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));
  if (!id_catalogo) return next(new AppError('id_catalogo es requerido', 400));

  const catalogo = await CatalogosChatCenter.findOne({
    where: { id: id_catalogo, id_configuracion, eliminado: 0 },
  });
  if (!catalogo) return next(new AppError('Catálogo no encontrado', 404));

  const items = await CatalogosItemsChatCenter.findAll({
    where: { id_catalogo },
    order: [
      ['orden', 'ASC'],
      ['id', 'ASC'],
    ],
  });

  return res.status(200).json({
    status: 'success',
    data: { catalogo, items },
  });
});

// ========== CREAR ==========
exports.crearCatalogo = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  const nombre_interno = req.body?.nombre_interno;
  const titulo_publico = req.body?.titulo_publico ?? null;
  const descripcion_publica = req.body?.descripcion_publica ?? null;

  const modo_visibilidad = normalizeModoVisibilidad(req.body?.modo_visibilidad);

  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));
  if (!nombre_interno)
    return next(new AppError('nombre_interno es requerido', 400));

  const slug = await generateUniqueSlug(titulo_publico || nombre_interno);

  const nuevo = await CatalogosChatCenter.create({
    id_configuracion,
    nombre_interno,
    titulo_publico,
    descripcion_publica,
    slug,
    modo_visibilidad,
    settings_json: null,
    eliminado: 0,
  });

  return res.status(201).json({
    status: 'success',
    data: nuevo,
    message: 'Catálogo creado correctamente.',
  });
});

// ========== ACTUALIZAR ==========
exports.actualizarCatalogo = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  const id_catalogo = toInt(req.body?.id_catalogo);

  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));
  if (!id_catalogo) return next(new AppError('id_catalogo es requerido', 400));

  const catalogo = await CatalogosChatCenter.findOne({
    where: { id: id_catalogo, id_configuracion, eliminado: 0 },
  });
  if (!catalogo) return next(new AppError('Catálogo no encontrado', 404));

  const {
    nombre_interno,
    titulo_publico,
    descripcion_publica,
    modo_visibilidad,
  } = req.body;

  if (typeof nombre_interno !== 'undefined')
    catalogo.nombre_interno = nombre_interno;

  if (typeof titulo_publico !== 'undefined')
    catalogo.titulo_publico = titulo_publico || null;

  if (typeof descripcion_publica !== 'undefined')
    catalogo.descripcion_publica = descripcion_publica || null;

  if (typeof modo_visibilidad !== 'undefined')
    catalogo.modo_visibilidad = normalizeModoVisibilidad(modo_visibilidad);

  // Si cambia título/nombre y quiere regenerar slug automáticamente (opcional):
  // yo NO lo haría por defecto para no romper links ya enviados.
  // Si usted quiere, hacemos un endpoint separado "regenerarSlug".

  await catalogo.save();

  return res.status(200).json({
    status: 'success',
    data: catalogo,
    message: 'Catálogo actualizado correctamente.',
  });
});

// ========== ELIMINAR (soft) ==========
exports.eliminarCatalogo = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  const id_catalogo = toInt(req.body?.id_catalogo);

  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));
  if (!id_catalogo) return next(new AppError('id_catalogo es requerido', 400));

  const catalogo = await CatalogosChatCenter.findOne({
    where: { id: id_catalogo, id_configuracion, eliminado: 0 },
  });
  if (!catalogo) return next(new AppError('Catálogo no encontrado', 404));

  catalogo.eliminado = 1;
  await catalogo.save();

  return res.status(200).json({
    status: 'success',
    message: 'Catálogo eliminado correctamente.',
  });
});

// ========== GUARDAR ITEMS (reemplaza lista completa) ==========
exports.guardarItemsCatalogo = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  const id_catalogo = toInt(req.body?.id_catalogo);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));
  if (!id_catalogo) return next(new AppError('id_catalogo es requerido', 400));

  const catalogo = await CatalogosChatCenter.findOne({
    where: { id: id_catalogo, id_configuracion, eliminado: 0 },
  });
  if (!catalogo) return next(new AppError('Catálogo no encontrado', 404));

  // Validar que los productos existan y pertenezcan a la misma configuración
  const productIds = items.map((it) => toInt(it?.id_producto)).filter((x) => x);

  if (!productIds.length) {
    // si manda vacío, solo limpiamos
    await CatalogosItemsChatCenter.destroy({ where: { id_catalogo } });
    return res.status(200).json({
      status: 'success',
      message: 'Catálogo sin productos (items limpiados).',
    });
  }

  const productosValidos = await ProductosChatCenter.findAll({
    where: { id_configuracion, id: productIds, eliminado: 0 },
    attributes: ['id'],
  });

  const validSet = new Set(productosValidos.map((p) => p.id));
  const invalid = productIds.filter((id) => !validSet.has(id));
  if (invalid.length) {
    return next(
      new AppError(
        `Hay productos inválidos o de otra configuración: ${invalid.join(', ')}`,
        400,
      ),
    );
  }

  // Transacción para reemplazar items
  await db.transaction(async (t) => {
    await CatalogosItemsChatCenter.destroy({
      where: { id_catalogo },
      transaction: t,
    });

    const rows = items
      .map((it, idx) => {
        const id_producto = toInt(it?.id_producto);
        if (!id_producto) return null;
        const orden = toInt(it?.orden);
        return {
          id_catalogo,
          id_producto,
          orden: Number.isFinite(orden) ? orden : idx,
        };
      })
      .filter(Boolean);

    if (rows.length) {
      await CatalogosItemsChatCenter.bulkCreate(rows, { transaction: t });
    }
  });

  return res.status(200).json({
    status: 'success',
    message: 'Items del catálogo guardados correctamente.',
  });
});

// ========== GUARDAR SETTINGS (campos a mostrar) ==========
exports.guardarSettingsCatalogo = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  const id_catalogo = toInt(req.body?.id_catalogo);
  const settings = req.body?.settings ?? null;

  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));
  if (!id_catalogo) return next(new AppError('id_catalogo es requerido', 400));

  const catalogo = await CatalogosChatCenter.findOne({
    where: { id: id_catalogo, id_configuracion, eliminado: 0 },
  });
  if (!catalogo) return next(new AppError('Catálogo no encontrado', 404));

  // Guardar como JSON string (o null)
  catalogo.settings_json = settings ? JSON.stringify(settings) : null;
  await catalogo.save();

  return res.status(200).json({
    status: 'success',
    message: 'Configuración del catálogo guardada correctamente.',
    data: catalogo,
  });
});
