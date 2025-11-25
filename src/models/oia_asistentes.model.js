const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const OiaAsistentes = db.define(
  'oia_asistentes',
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    tipo: {
      type: DataTypes.ENUM(
        'contacto_inicial',
        'plataformas_clases',
        'productos_proveedores',
        'ventas_imporfactory',
        'ventas_productos',
        'ventas_servicios',
        'cotizaciones_imporfactory'
      ),
      allowNull: false,
    },
    nombre_bot: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    assistant_id: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    fecha_registro: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: db.literal('CURRENT_TIMESTAMP'),
    },
  },
  {
    tableName: 'oia_asistentes',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = OiaAsistentes;
