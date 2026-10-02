const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Transcripción y resumen con IA de una llamada telefónica (Zadarma).
 *
 * Una fila por llamada grabada. La crea services/telefonia_ia.service.js
 * apenas la grabación llega a nuestro servidor: primero la transcripción
 * (gpt-4o-mini-transcribe) y luego el resumen estructurado (gpt-5-mini).
 * Va en tabla aparte, y no en telefonia_llamadas, para que db.sync la cree
 * sola sin tocar la tabla existente (sync nunca hace ALTER).
 */
const TelefoniaAnalisis = db.define(
  'telefonia_analisis',
  {
    id_llamada: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, primaryKey: true },
    id_configuracion: { type: DataTypes.INTEGER, allowNull: false },
    /** pendiente → listo | error | sin_llave (no hay API key con la que analizar) */
    estado: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pendiente' },
    transcripcion: { type: DataTypes.TEXT('medium'), allowNull: true },
    /** 3-5 líneas en español, para el chat y el dashboard. */
    resumen: { type: DataTypes.TEXT, allowNull: true },
    /** JSON: { resultado, motivo, objeciones[], compromisos[], siguiente_paso,
     *  sentimiento, calidad_atencion (1-5), mejoras[] } */
    analisis: { type: DataTypes.TEXT, allowNull: true },
    modelo_transcripcion: { type: DataTypes.STRING(60), allowNull: true },
    modelo_resumen: { type: DataTypes.STRING(60), allowNull: true },
    tokens_entrada: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    tokens_salida: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    /** Estimado del costo en OpenAI (centavos), para la pantalla del super admin. */
    costo_centavos: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    /** 'maestra' (llave de /telefonia) o 'conexion' (api_key_openai del negocio). */
    origen_llave: { type: DataTypes.STRING(20), allowNull: true },
    error: { type: DataTypes.STRING(500), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: 'telefonia_analisis',
    timestamps: false,
    freezeTableName: true,
    indexes: [{ name: 'idx_tel_analisis_cfg', fields: ['id_configuracion', 'created_at'] }],
  },
);

module.exports = TelefoniaAnalisis;
