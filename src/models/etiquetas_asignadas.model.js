const {DataTypes} = require('sequelize');
const {db} = require('../database/config');

const EtiquetasAsignadas = db.define('etiquetas_asignadas',{
    id :{
     type: DataTypes.INTEGER,
     allowNull: false,
     autoIncrement: true,
     primaryKey: true,
    },
    id_etiqueta:{
     type: DataTypes.INTEGER,
     allowNull: false,
    },
    id_cliente_chat_center:{
     type: DataTypes.INTEGER,
     allowNull: false,
    },
    id_plataforma:{
     type: DataTypes.INTEGER,
     allowNull: false,
    },
}, {
    tableName: 'etiquetas_asignadas',
    timestamps: false,
})

module.exports = EtiquetasAsignadas;