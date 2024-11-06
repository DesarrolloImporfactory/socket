const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const EtiquetasChatCenter = db.define('etiquetas_chat_center', {
  id_etiqueta: {
    type: DataTypes.INTEGER,
    allowNull: false,
    autoIncrement: true,
    primaryKey: true,
  },
  id_plataforma: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  nombre_etiqueta: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  color_etiqueta: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
});

module.exports = EtiquetasChatCenter;
