// models/productos_wizard_flujo.model.js
// Progreso del "flujo de venta por pasos" del wizard, por cliente × producto.
// `paso` es el índice del paso cuya respuesta se está ESPERANDO (0 = la
// pregunta gancho del mensaje inicial). Cuando el cliente valida el último
// paso, o el flujo se corta (edad fuera de rango, cambio de columna), la fila
// pasa a estado 'terminado' y la conversación queda en manos de la IA.
//
// Tabla nueva: db.sync la crea sola en el arranque (misma BD dev/prod, igual
// que productos_wizard — ver el encabezado de ese modelo).
const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const ProductosWizardFlujo = db.define(
  'productos_wizard_flujo',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    id_configuracion: { type: DataTypes.BIGINT, allowNull: false },
    id_cliente: { type: DataTypes.INTEGER, allowNull: false },
    id_producto: { type: DataTypes.INTEGER, allowNull: false },
    paso: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // 'respondiendo' = un turno reclamó el paso y está en su retraso
    // configurado (hasta 3 min) antes de enviar el copy; es el candado que
    // evita el copy duplicado si el cliente escribe durante la espera. Si un
    // reinicio mata la espera, intentarPasoFlujo la rescata a los 5 minutos.
    estado: {
      type: DataTypes.ENUM('activo', 'respondiendo', 'terminado'),
      allowNull: false,
      defaultValue: 'activo',
    },
    // La columna del kanban donde arrancó el flujo. Si el contacto se mueve
    // (la IA cerró, un humano lo tomó), el flujo se da por terminado: mandar
    // un copy de mitad de embudo en "guía generada" sería hablar solo.
    estado_contacto_inicio: { type: DataTypes.STRING(64), allowNull: true },
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
    tableName: 'productos_wizard_flujo',
    timestamps: false,
    indexes: [
      { unique: true, fields: ['id_cliente', 'id_producto'] },
      { fields: ['id_configuracion'] },
    ],
  },
);

module.exports = ProductosWizardFlujo;
