const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const ClientesChatCenter = db.define(
  'clientes_chat_center',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    id_plataforma: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      references: { model: 'plataformas', key: 'id_plataforma' },
    },
    id_configuracion: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },
    id_etiqueta: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    uid_cliente: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
    },
    nombre_cliente: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
    },
    apellido_cliente: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
    },
    email_cliente: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
      validate: { isEmail: true },
    },
    celular_cliente: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
    },
    imagePath: {
      type: DataTypes.STRING(300),
      allowNull: true,
      defaultValue: null,
    },
    mensajes_por_dia_cliente: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    estado_cliente: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 1,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    deleted_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    chat_cerrado: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    bot_openia: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    id_departamento: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    id_encargado: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    pedido_confirmado: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0,
    },
    telefono_limpio: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
    },
    id_factura: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
    },
    fecha_guia: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    transporte: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
    },
    estado_factura: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0,
    },
    etiquetas: {
      type: DataTypes.BLOB,
      allowNull: true,
    },
    novedad_info: {
      type: DataTypes.BLOB,
      allowNull: true,
    },
    estado_contacto: {
      type: DataTypes.ENUM(
        'contacto_inicial',
        'plataformas_clases',
        'productos_proveedores',
        'ventas_imporfactory',
        'asesor',
        'cotizaciones_imporfactory',
        'ia_ventas',
        'generar_guia',
        'seguimiento',
        'cancelado',
        'ia_ventas_imporshop',
        'atencion_urgente'
      ),
      allowNull: true,
      defaultValue: 'contacto_inicial',
    },
    propietario: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0,
    },
    direccion: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
    },
    productos: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    tableName: 'clientes_chat_center',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = ClientesChatCenter;
