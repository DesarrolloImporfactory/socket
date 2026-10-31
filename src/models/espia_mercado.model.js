const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Espía de mercado (Dropkiller propio, 30-oct-2026).
 *
 * Son datos de MERCADO, no de una cuenta: no llevan id_configuracion, llevan
 * `pais`. Viven en la BD principal. Las llena el recolector
 * (services/espia_mercado.service.js, cron/espiaMercado.js) y la extensión de
 * Chrome «Espía de tiendas» (POST /espia/anuncios).
 *
 * Tablas:
 *  - espia_producto      ficha por (pais, dropi_product_id) con acumulados.
 *  - espia_stock_actual  último stock por (pais, producto, bodega, variación).
 *  - espia_stock_foto    historial: una fila SOLO cuando cambia ese stock. Se purga a 120 días.
 *  - espia_ventas_dia    unidades por (pais, producto, fecha). Lo que lee la pantalla.
 *  - espia_pasada        bitácora de cada corrida del recolector.
 *  - espia_anuncio       anuncios vistos por la extensión en la Biblioteca de Meta.
 *  - espia_tienda        dominios con anuncios (perfil Shopify si responde /products.json).
 *  - espia_tienda_dia    anuncios activos por dominio y día (tendencia).
 *  - espia_seguimiento   qué sigue cada sub-usuario (tienda / producto).
 */

const comun = { timestamps: false, freezeTableName: true };

const EspiaProducto = db.define(
  'espia_producto',
  {
    pais: { type: DataTypes.STRING(2), allowNull: false, primaryKey: true },
    dropi_product_id: { type: DataTypes.BIGINT, allowNull: false, primaryKey: true },
    nombre: { type: DataTypes.STRING(300), allowNull: true },
    nombre_norm: { type: DataTypes.STRING(80), allowNull: true },
    tipo: { type: DataTypes.STRING(12), allowNull: true },
    sku: { type: DataTypes.STRING(120), allowNull: true },
    proveedor_id: { type: DataTypes.BIGINT, allowNull: true },
    proveedor_nombre: { type: DataTypes.STRING(200), allowNull: true },
    precio: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    sugerido: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    categoria: { type: DataTypes.STRING(200), allowNull: true },
    imagen_url: { type: DataTypes.STRING(600), allowNull: true },
    external_id: { type: DataTypes.STRING(100), allowNull: true },
    privado: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    primera_vez: { type: DataTypes.DATE, allowNull: false },
    ultima_vez: { type: DataTypes.DATE, allowNull: false },
    stock_actual: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ventas_total: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    reabastecimientos: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  {
    ...comun,
    tableName: 'espia_producto',
    indexes: [
      { name: 'ix_espia_producto_prov', fields: ['pais', 'proveedor_id'] },
      { name: 'ix_espia_producto_norm', fields: ['pais', 'nombre_norm'] },
      { name: 'ix_espia_producto_ext', fields: ['pais', 'external_id'] },
      { name: 'ix_espia_producto_ultima', fields: ['pais', 'ultima_vez'] },
    ],
  },
);

const EspiaStockActual = db.define(
  'espia_stock_actual',
  {
    pais: { type: DataTypes.STRING(2), allowNull: false, primaryKey: true },
    dropi_product_id: { type: DataTypes.BIGINT, allowNull: false, primaryKey: true },
    warehouse_id: { type: DataTypes.BIGINT, allowNull: false, primaryKey: true },
    variacion_id: { type: DataTypes.BIGINT, allowNull: false, primaryKey: true, defaultValue: 0 },
    stock: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    fecha_hora: { type: DataTypes.DATE, allowNull: false },
  },
  { ...comun, tableName: 'espia_stock_actual' },
);

const EspiaStockFoto = db.define(
  'espia_stock_foto',
  {
    pais: { type: DataTypes.STRING(2), allowNull: false, primaryKey: true },
    dropi_product_id: { type: DataTypes.BIGINT, allowNull: false, primaryKey: true },
    warehouse_id: { type: DataTypes.BIGINT, allowNull: false, primaryKey: true },
    variacion_id: { type: DataTypes.BIGINT, allowNull: false, primaryKey: true, defaultValue: 0 },
    fecha_hora: { type: DataTypes.DATE, allowNull: false, primaryKey: true },
    stock: { type: DataTypes.INTEGER, allowNull: false },
  },
  {
    ...comun,
    tableName: 'espia_stock_foto',
    indexes: [{ name: 'ix_espia_stock_foto_fecha', fields: ['fecha_hora'] }],
  },
);

const EspiaVentasDia = db.define(
  'espia_ventas_dia',
  {
    pais: { type: DataTypes.STRING(2), allowNull: false, primaryKey: true },
    dropi_product_id: { type: DataTypes.BIGINT, allowNull: false, primaryKey: true },
    fecha: { type: DataTypes.DATEONLY, allowNull: false, primaryKey: true },
    unidades: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    reabastecido: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
  },
  {
    ...comun,
    tableName: 'espia_ventas_dia',
    indexes: [{ name: 'ix_espia_ventas_dia_fecha', fields: ['pais', 'fecha'] }],
  },
);

const EspiaPasada = db.define(
  'espia_pasada',
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
    pais: { type: DataTypes.STRING(2), allowNull: false },
    fuente: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'dropi' }, // dropi | mock
    inicio: { type: DataTypes.DATE, allowNull: false },
    fin: { type: DataTypes.DATE, allowNull: true },
    estado: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'corriendo' }, // corriendo | ok | frenada | error
    paginas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    productos: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    fotos_escritas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ventas_sumadas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    errores_429: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    freno_hasta: { type: DataTypes.DATE, allowNull: true },
    error: { type: DataTypes.STRING(500), allowNull: true },
  },
  {
    ...comun,
    tableName: 'espia_pasada',
    indexes: [{ name: 'ix_espia_pasada_pais', fields: ['pais', 'inicio'] }],
  },
);

const EspiaAnuncio = db.define(
  'espia_anuncio',
  {
    ad_archive_id: { type: DataTypes.STRING(40), allowNull: false, primaryKey: true },
    pais: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'ALL' },
    pagina_id: { type: DataTypes.STRING(40), allowNull: true },
    pagina_nombre: { type: DataTypes.STRING(200), allowNull: true },
    dominio: { type: DataTypes.STRING(190), allowNull: true },
    url_destino: { type: DataTypes.STRING(1000), allowNull: true },
    producto: { type: DataTypes.STRING(200), allowNull: true },
    titulo: { type: DataTypes.STRING(300), allowNull: true },
    texto: { type: DataTypes.TEXT, allowNull: true },
    tipo: { type: DataTypes.STRING(10), allowNull: true }, // imagen | video
    media_url: { type: DataTypes.STRING(1000), allowNull: true },
    imagen_url: { type: DataTypes.STRING(1000), allowNull: true },
    plataformas: { type: DataTypes.STRING(100), allowNull: true },
    inicio: { type: DataTypes.DATEONLY, allowNull: true },
    primera_vez_visto: { type: DataTypes.DATE, allowNull: false },
    ultima_vez_visto: { type: DataTypes.DATE, allowNull: false },
    activo: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
    n_duplicados: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    veces_visto: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    visto_por: { type: DataTypes.INTEGER, allowNull: true }, // id_sub_usuario del último envío
  },
  {
    ...comun,
    tableName: 'espia_anuncio',
    indexes: [
      { name: 'ix_espia_anuncio_dominio', fields: ['dominio', 'activo'] },
      { name: 'ix_espia_anuncio_pais_visto', fields: ['pais', 'ultima_vez_visto'] },
      { name: 'ix_espia_anuncio_inicio', fields: ['inicio'] },
    ],
  },
);

const EspiaTienda = db.define(
  'espia_tienda',
  {
    dominio: { type: DataTypes.STRING(190), allowNull: false, primaryKey: true },
    nombre: { type: DataTypes.STRING(200), allowNull: true },
    pais_principal: { type: DataTypes.STRING(3), allowNull: true },
    es_shopify: { type: DataTypes.TINYINT, allowNull: true }, // null = sin revisar
    productos: { type: DataTypes.INTEGER, allowNull: true },
    moneda: { type: DataTypes.STRING(10), allowNull: true },
    tema: { type: DataTypes.STRING(120), allowNull: true },
    producto_top: { type: DataTypes.STRING(200), allowNull: true },
    anuncios_activos: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    primera_vez: { type: DataTypes.DATE, allowNull: false },
    ultima_vez: { type: DataTypes.DATE, allowNull: false },
    ultima_revision: { type: DataTypes.DATE, allowNull: true }, // cuándo se consultó /products.json
  },
  {
    ...comun,
    tableName: 'espia_tienda',
    indexes: [{ name: 'ix_espia_tienda_activos', fields: ['pais_principal', 'anuncios_activos'] }],
  },
);

const EspiaTiendaDia = db.define(
  'espia_tienda_dia',
  {
    dominio: { type: DataTypes.STRING(190), allowNull: false, primaryKey: true },
    fecha: { type: DataTypes.DATEONLY, allowNull: false, primaryKey: true },
    anuncios_activos: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    anuncios_nuevos: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  { ...comun, tableName: 'espia_tienda_dia' },
);

const EspiaSeguimiento = db.define(
  'espia_seguimiento',
  {
    id_sub_usuario: { type: DataTypes.BIGINT, allowNull: false, primaryKey: true },
    tipo: { type: DataTypes.STRING(12), allowNull: false, primaryKey: true }, // tienda | producto
    ref: { type: DataTypes.STRING(190), allowNull: false, primaryKey: true }, // dominio o `${pais}:${dropi_product_id}`
    creado_en: { type: DataTypes.DATE, allowNull: false },
  },
  { ...comun, tableName: 'espia_seguimiento' },
);

module.exports = {
  EspiaProducto,
  EspiaStockActual,
  EspiaStockFoto,
  EspiaVentasDia,
  EspiaPasada,
  EspiaAnuncio,
  EspiaTienda,
  EspiaTiendaDia,
  EspiaSeguimiento,
};
