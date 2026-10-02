const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Llave de OpenAI con la que se transcriben y resumen las llamadas (una sola
 * fila, id = 1). Es la llave de Imporfactory: el análisis va incluido en el
 * precio del minuto, no lo paga el negocio. Si no hay fila (o está apagada),
 * telefonia_ia.service cae a la api_key_openai de la conexión; si tampoco
 * hay, la llamada queda sin análisis (estado 'sin_llave').
 *
 * Se guarda desde /telefonia (super administrador), cifrada con
 * utils/cryptoToken igual que la secreta de Zadarma. Tabla creada por db.sync.
 */
const TelefoniaIA = db.define(
  'telefonia_ia',
  {
    id: { type: DataTypes.TINYINT, allowNull: false, primaryKey: true, defaultValue: 1 },
    api_key_enc: { type: DataTypes.TEXT, allowNull: false },
    api_key_last4: { type: DataTypes.STRING(4), allowNull: true },
    activo: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
    modelo_transcripcion: { type: DataTypes.STRING(60), allowNull: false, defaultValue: 'gpt-4o-mini-transcribe' },
    modelo_resumen: { type: DataTypes.STRING(60), allowNull: false, defaultValue: 'gpt-5-mini' },
    actualizado_por: { type: DataTypes.INTEGER, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: 'telefonia_ia', timestamps: false, freezeTableName: true },
);

module.exports = TelefoniaIA;
