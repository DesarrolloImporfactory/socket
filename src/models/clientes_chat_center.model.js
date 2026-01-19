const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const ClientesChatCenter = db.define(
  'clientes_chat_center',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },

    id_plataforma: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    id_configuracion: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },

    // En BD es LONGTEXT (json), no int
    id_etiqueta: { type: DataTypes.TEXT('long'), allowNull: true },

    uid_cliente: { type: DataTypes.STRING(255), allowNull: true },
    nombre_cliente: { type: DataTypes.STRING(255), allowNull: true },
    apellido_cliente: { type: DataTypes.STRING(255), allowNull: true },
    email_cliente: { type: DataTypes.STRING(255), allowNull: true },
    celular_cliente: { type: DataTypes.STRING(255), allowNull: true },

    // ✅ NUEVOS
    page_id: { type: DataTypes.STRING(64), allowNull: true },
    external_id: { type: DataTypes.STRING(64), allowNull: true },
    source: {
      type: DataTypes.ENUM('wa', 'ms', 'ig', ''),
      allowNull: true,
      defaultValue: 'wa',
    },

    imagePath: { type: DataTypes.STRING(300), allowNull: true },

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
      defaultValue: DataTypes.NOW,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: DataTypes.NOW,
    },
    deleted_at: { type: DataTypes.DATE, allowNull: true },

    chat_cerrado: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    bot_openia: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },

    id_departamento: { type: DataTypes.INTEGER, allowNull: true },
    id_encargado: { type: DataTypes.INTEGER, allowNull: true },

    pedido_confirmado: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    telefono_limpio: { type: DataTypes.STRING(20), allowNull: true },

    id_factura: { type: DataTypes.BIGINT, allowNull: true },
    fecha_guia: { type: DataTypes.DATEONLY, allowNull: true },
    transporte: { type: DataTypes.STRING(255), allowNull: true },
    estado_factura: { type: DataTypes.INTEGER, allowNull: true },

    etiquetas: { type: DataTypes.TEXT('long'), allowNull: true },
    novedad_info: { type: DataTypes.TEXT('long'), allowNull: true },

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

    propietario: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    direccion: { type: DataTypes.STRING(255), allowNull: true },
    productos: { type: DataTypes.STRING(255), allowNull: true },
  },
  {
    tableName: 'clientes_chat_center',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = ClientesChatCenter;
