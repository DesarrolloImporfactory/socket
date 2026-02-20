const { DataTypes } = require('sequelize');
const { db_2 } = require('../../database/config');

const ImporsuitCursos = db_2.define(
  'cursos',
  {
    id_curso: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
        autoIncrement: true,
    },
    nombre: { type: DataTypes.STRING(255), allowNull: false },
    imagen: { type: DataTypes.TEXT, allowNull: true },
    paquete: { type: DataTypes.ENUM("importacion", "ecommerce", "membresia_ecommerce"), allowNull: false},
    instructor: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    descripcion: { type: DataTypes.TEXT, allowNull: true },
    activo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
        defaultValue: db_2.literal('CURRENT_TIMESTAMP'),
    },
    updated_at: {
      type: DataTypes.DATE,
        allowNull: true,
        defaultValue: null,
    },

},
{
  tableName: 'cursos',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = ImporsuitCursos;

