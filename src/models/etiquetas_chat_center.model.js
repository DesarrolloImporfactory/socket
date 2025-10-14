const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const EtiquetasChatCenter = db.define(
  'etiquetas_chat_center',
  {
    id_etiqueta: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    /* id_plataforma: {
      type: DataTypes.INTEGER,
      allowNull: false,
    }, */
    id_configuracion: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: {
        model: 'configuraciones',
        key: 'id',
      },
    },
    nombre_etiqueta: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    color_etiqueta: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
  },
  {
    tableName: 'etiquetas_chat_center', // 👈 asegúrate de esto si la tabla ya existe
    timestamps: false, // 👈 si no tienes createdAt/updatedAt
  }
);

module.exports = EtiquetasChatCenter;
