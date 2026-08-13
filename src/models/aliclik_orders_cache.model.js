const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Espejo local de los pedidos de Aliclik.
 *
 * A diferencia de dropi_orders_cache (que es una optimización para no golpear
 * la API), acá el cache es parte del camino crítico: el webhook de Aliclik
 * llega solo con { orderNumber, callStatus, status, dispatchStatus } — sin
 * teléfono, sin productos, sin total. Sin esta tabla no hay a quién notificar.
 */
const AliclikOrdersCache = db.define(
  'aliclik_orders_cache',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    // Identificador del pedido en Aliclik (ej. "ALC000123456789"). Es un
    // string, no un entero como el de Dropi.
    order_number: { type: DataTypes.STRING(60), allowNull: false },
    id_configuracion: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },

    // Los tres ejes de estado, tal cual los devuelve Aliclik
    call_status: DataTypes.STRING(40),
    status: DataTypes.STRING(40),
    dispatch_status: DataTypes.STRING(40),
    // Resultado del mapeo a nuestro vocabulario canónico
    estado_config: DataTypes.STRING(50),

    total: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    name: DataTypes.STRING(200),
    surname: DataTypes.STRING(200),
    phone: DataTypes.STRING(100),
    city: DataTypes.STRING(200),
    state: DataTypes.STRING(200),
    product_detail: DataTypes.TEXT,
    order_created_at: DataTypes.DATE,
    order_data: DataTypes.TEXT('long'),
    synced_at: DataTypes.DATE,
  },
  {
    tableName: 'aliclik_orders_cache',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    freezeTableName: true,
    // El UNIQUE se declara acá además de en la migración porque server.js
    // corre db.sync({force:false}), que crea las tablas faltantes. Sin él, un
    // deploy hecho antes de aplicar el SQL crearía la tabla sin la clave y el
    // updateOnDuplicate de upsertOrders insertaría filas repetidas en vez de
    // actualizar, en silencio.
    indexes: [
      {
        name: 'uq_aliclik_order',
        unique: true,
        fields: ['order_number', 'id_configuracion'],
      },
      { name: 'idx_aliclik_cache_config', fields: ['id_configuracion'] },
      {
        name: 'idx_aliclik_cache_phone',
        fields: ['id_configuracion', 'phone'],
      },
    ],
  },
);

module.exports = AliclikOrdersCache;
