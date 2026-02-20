const { DataTypes } = require('sequelize');
const { db_2 } = require('../../database/config');

const ImporsuitApiCursos = db_2.define(
  'api_cursos',
  {
    id_api_curso: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    id_api: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: {
        model: 'api',
        key: 'id_api',
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    id_curso: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: {
        model: 'cursos',
        key: 'id_curso',
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    activo: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    fecha_asignacion: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: db_2.literal('CURRENT_TIMESTAMP'),
    },
    fecha_modificacion: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    tableName: 'api_cursos',
    timestamps: false,
    freezeTableName: true,
    indexes: [
      {
        unique: true,
        fields: ['id_api', 'id_curso'],
        name: 'unique_api_curso',
      },
      {
        fields: ['id_api'],
        name: 'idx_id_api',
      },
      {
        fields: ['id_curso'],
        name: 'idx_id_curso',
      },
    ],
  }
);

module.exports = ImporsuitApiCursos;
