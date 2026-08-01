const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const ProductosChatCenter = db.define(
  'productos_chat_center',
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    id_configuracion: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    nombre: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    descripcion: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    // ===== nuevos =====
    material: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },

    tipo: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    // 1 = tiene variantes (talla/color) en productos_variaciones
    es_variable: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    precio: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    precio_proveedor: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
    },

    duracion: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },

    /* Plan de sesiones de un servicio. Vacío o 1 = sesión única; min < max = el
       plan varía según el caso (borrado de tatuajes: puede terminar en 3 o en
       8). El bot lo cruza con las sesiones a las que la persona SÍ vino para
       saber si empuja la siguiente, si pregunta o si ya terminó. */
    sesiones_min: {
      type: DataTypes.SMALLINT,
      allowNull: true,
    },
    sesiones_max: {
      type: DataTypes.SMALLINT,
      allowNull: true,
    },
    nombre_upsell: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    descripcion_upsell: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    precio_upsell: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
    imagen_upsell_url: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    imagen_url: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    video_url: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },

    // ===== nuevos =====
    landing_url: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },

    external_source: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },

    external_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },

    // ===== nuevos =====
    id_dropi: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },

    stock: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },

    // ===== nuevos =====
    es_privado: {
      type: DataTypes.TINYINT,
      allowNull: true,
    },

    combos_producto: {
      type: DataTypes.BLOB,
      allowNull: true,
    },
    eliminado: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    id_categoria: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'categorias_chat_center',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    },
    fecha_creacion: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    fecha_actualizacion: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: 'productos_chat_center',
    timestamps: false,
  },
);

module.exports = ProductosChatCenter;
