const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const PlanesPersonalizadosStripe = db.define('planes_personalizados_stripe', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  id_usuario: {
    type: DataTypes.INTEGER,
    allowNull: false,
    unique: true,
  },
  id_plan_base: {
    type: DataTypes.INTEGER,
    defaultValue: 5,
  },
  n_conexiones: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  max_subusuarios: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  max_conexiones: { 
    type: DataTypes.INTEGER, 
    defaultValue: 0,
  }, 
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  updated_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'planes_personalizados_stripe',
  timestamps: false,
  comment: 'Planes personalizados de stripe',
  freezeTableName: true,
});

module.exports = PlanesPersonalizadosStripe;
