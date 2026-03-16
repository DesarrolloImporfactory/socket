const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const Planes_chat_center = db.define(
  'planes_chat_center',
  {
    id_plan: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
      allowNull: false,
    },
    activo: {
      type: DataTypes.INTEGER,
      defaultValue: 1,
      allowNull: true,
    },
    nombre_plan: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    descripcion_plan: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    precio_plan: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    n_conversaciones: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    n_conexiones: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    max_subusuarios: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    max_conexiones: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    duracion_plan: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    id_product_stripe: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    id_price: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    ahorro: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    link_pago: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    max_imagenes_ia: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Máximo de imágenes IA por mes (0 = sin acceso)',
    },
    max_angulos_ia: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },

    // ═══════════════════════════════════════════════════════
    // NUEVAS COLUMNAS — Ecosistema 4 Planes
    // ═══════════════════════════════════════════════════════
    tools_access: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: 'both',
      comment: 'insta_landing | imporchat | both',
    },
    max_banners_mes: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    max_secciones_landing: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    max_estilos_visuales: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    max_productos_dropi: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '-1 = ilimitado',
    },
    max_agentes_whatsapp: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    landing_whatsapp_link: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    ab_testing: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    bot_entrenado: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    analytics_nivel: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'none',
      comment: 'none | basico | completo | avanzado',
    },
    max_subcuentas: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    soporte_nivel: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: 'chat_24h',
      comment: 'chat_24h | whatsapp_4h | vip_onboarding',
    },
    trial_type: {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: 'none',
      comment: 'none | days | usage',
    },
    trial_value: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'dias o cantidad de usos gratis',
    },
    multi_numero_whatsapp: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    bulk_gen_productos: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    estilos_custom: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    secciones_custom: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    sort_order: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'orden visual en frontend',
    },
  },
  {
    sequelize: db,
    tableName: 'planes_chat_center',
    timestamps: false,
    freezeTableName: true,
  },
);

module.exports = Planes_chat_center;
