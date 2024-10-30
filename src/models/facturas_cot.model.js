const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const FacturasCot = db.define(
  'facturas_cot',
  {
    id_factura: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    numero_factura: {
      type: DataTypes.STRING(20),
      allowNull: false,
      unique: true,
    },
    fecha_factura: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    id_usuario: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    monto_factura: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    estado_factura: {
      type: DataTypes.TINYINT,
      allowNull: false,
    },
    nombre: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },
    telefono: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },
    provincia: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },
    c_principal: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },
    ciudad_cot: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    c_secundaria: {
      type: DataTypes.STRING(1500),
      allowNull: false,
    },
    referencia: {
      type: DataTypes.STRING(1500),
      allowNull: false,
    },
    observacion: {
      type: DataTypes.STRING(1500),
      allowNull: false,
    },
    guia_enviada: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    transporte: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    identificacion: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    celular: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    drogshipin: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    importado: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    plataforma_importa: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    estado_guia_sistema: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    impreso: {
      type: DataTypes.TINYINT,
      allowNull: true,
    },
    facturada: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    factura_numero: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    numero_guia: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    anulada: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    identificacionO: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    id_plataforma: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    ciudadO: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    nombreO: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    direccionO: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    telefonoO: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    referenciaO: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    numeroCasaO: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    cod: {
      type: DataTypes.TINYINT,
      allowNull: true,
    },
    valor_seguro: {
      type: DataTypes.DOUBLE,
      allowNull: true,
    },
    no_piezas: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    tipo_servicio: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    peso: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    contiene: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },
    costo_flete: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    costo_producto: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    comentario: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },
    id_transporte: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    provinciaO: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    id_propietario: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    id_bodega: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    valida_transportadora: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    fecha_guia: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    novedad: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    tipo_novedad: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    recibo: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    novedad_solventado: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    novedad_observacion: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    googlemaps: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    estado_pedido: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    detalle_noDesea_pedido: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
  },
  {
    sequelize: db,
    tableName: 'facturas_cot',
    timestamps: false,
  }
);

module.exports = FacturasCot;
