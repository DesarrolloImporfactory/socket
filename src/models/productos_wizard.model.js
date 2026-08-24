// models/productos_wizard.model.js
// Configuración del "wizard de producto": lo que el negocio define UNA vez por
// producto para que el primer mensaje salga fijo (sin IA) y las preguntas
// frecuentes se contesten con respuestas quemadas.
//
// Va en tabla aparte, 1:1 con productos_chat_center, a propósito: la BD es la
// misma en dev y producción, y `db.sync` crea tablas nuevas pero NO altera las
// existentes. Si estas columnas se sumaran al modelo de productos_chat_center
// sin la migración aplicada, cada `findAll` del catálogo en producción
// reventaría con "Unknown column". Así, el módulo viejo no se entera.
const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/* Los JSON viajan como TEXT serializado (no DataTypes.JSON) para no depender
   de la versión del motor MySQL/MariaDB de producción. El parse lo hace el
   servicio (leerJson / guardarJson). */

const ProductosWizard = db.define(
  'productos_wizard',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    id_configuracion: { type: DataTypes.BIGINT, allowNull: false },
    id_producto: { type: DataTypes.INTEGER, allowNull: false, unique: true },

    // Decide la pregunta gancho: físico cierra por cantidad, natural/salud por
    // síntoma (y activa el guardrail de claims médicos), servicio por fecha/
    // agenda (sin unidades ni "pagas al recibir").
    tipo_venta: {
      type: DataTypes.ENUM('fisico', 'natural_salud', 'servicio'),
      allowNull: false,
      defaultValue: 'fisico',
    },

    // Las 3 respuestas crudas del negocio (paso 2).
    problema_resuelve: { type: DataTypes.TEXT, allowNull: true },
    antes_despues: { type: DataTypes.TEXT, allowNull: true },
    beneficios: { type: DataTypes.TEXT, allowNull: true },

    // Generado por IA y editable (paso 3).
    descripcion_ia: { type: DataTypes.TEXT, allowNull: true },
    pregunta_gancho: { type: DataTypes.TEXT, allowNull: true },
    intro_mensaje: { type: DataTypes.TEXT, allowNull: true },
    linea_envio: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: '🚚 Envío gratis y pagas al recibir',
    },
    // JSON: ["bullet 1", ...]
    bullets_json: { type: DataTypes.TEXT('long'), allowNull: true },
    // JSON: [{ tipo:'image'|'video', url, origen:'producto'|'subida'|'ia', etiqueta }]
    // Tope: 3 imágenes + 1 video. Ese es el paquete del primer mensaje.
    media_json: { type: DataTypes.TEXT('long'), allowNull: true },
    // JSON: [{ pregunta, respuesta, claves:[...] , activa:1 }]
    respuestas_rapidas_json: { type: DataTypes.TEXT('long'), allowNull: true },

    // El mensaje FIJO ya compuesto (paso 4). Se manda tal cual, sin modelo.
    mensaje_inicial: { type: DataTypes.TEXT, allowNull: true },

    // Interruptores del runtime.
    usar_respuestas_rapidas: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 1,
    },
    wizard_completado: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    activo: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },

    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: 'productos_wizard',
    timestamps: false,
    indexes: [
      { fields: ['id_configuracion'] },
      { unique: true, fields: ['id_producto'] },
    ],
  },
);

module.exports = ProductosWizard;
