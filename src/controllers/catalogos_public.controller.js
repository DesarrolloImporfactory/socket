const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const CatalogosChatCenter = require('../models/catalogos_chat_center.model');
const CatalogosItemsChatCenter = require('../models/catalogos_items_chat_center.model');
const ProductosChatCenter = require('../models/productos_chat_center.model');
const CategoriasChatCenter = require('../models/categorias_chat_center.model');

exports.verCatalogoPublico = catchAsync(async (req, res, next) => {
  const { slug } = req.params;

  const catalogo = await CatalogosChatCenter.findOne({
    where: { slug, eliminado: 0 },
  });

  if (!catalogo) return next(new AppError('Catálogo no encontrado', 404));

  const items = await CatalogosItemsChatCenter.findAll({
    where: { id_catalogo: catalogo.id },
    order: [
      ['orden', 'ASC'],
      ['id', 'ASC'],
    ],
  });

  const productIds = items.map((it) => it.id_producto);
  if (!productIds.length) {
    return res.status(200).json({
      status: 'success',
      data: {
        catalogo: {
          titulo_publico: catalogo.titulo_publico || catalogo.nombre_interno,
          descripcion_publica: catalogo.descripcion_publica || null,
          modo_visibilidad: catalogo.modo_visibilidad,
          settings: catalogo.settings_json
            ? JSON.parse(catalogo.settings_json)
            : null,
          slug: catalogo.slug,
        },
        productos: [],
      },
    });
  }

  // Traer productos (y categoría) en una sola consulta
  const productos = await ProductosChatCenter.findAll({
    where: {
      id: productIds,
      eliminado: 0,
    },
    include: [
      {
        model: CategoriasChatCenter,
        as: 'categoria', // si no tiene asociación, abajo le dejo alternativa sin include
        attributes: ['id', 'nombre'],
        required: false,
      },
    ],
  });

  // Mapear por id para ordenar por "items.orden"
  const map = new Map(productos.map((p) => [p.id, p]));

  // Filtro por visibilidad del catálogo usando producto.es_privado
  const modo = catalogo.modo_visibilidad; // PUBLIC_ONLY | PRIVATE_ONLY | BOTH

  const ordered = items
    .map((it) => map.get(it.id_producto))
    .filter(Boolean)
    .filter((p) => {
      const priv = Number(p.es_privado) === 1;
      const pub = !priv; // incluye null/0 como público
      if (modo === 'PUBLIC_ONLY') return pub;
      if (modo === 'PRIVATE_ONLY') return priv;
      return true; // BOTH
    });

  return res.status(200).json({
    status: 'success',
    data: {
      catalogo: {
        titulo_publico: catalogo.titulo_publico || catalogo.nombre_interno,
        descripcion_publica: catalogo.descripcion_publica || null,
        modo_visibilidad: catalogo.modo_visibilidad,
        settings: catalogo.settings_json
          ? JSON.parse(catalogo.settings_json)
          : null,
        slug: catalogo.slug,
      },
      productos: ordered,
    },
  });
});
