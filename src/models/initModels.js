const User = require('./user.model');
const Plataforma = require('./plataforma.model');
const UsuarioPlataforma = require('./usuario_plataforma.model');
const ClientesChatCenter = require('./clientes_chat_center.model');
const MensajesClientes = require('./mensaje_cliente.model');
const EtiquetasChatCenter = require('./etiquetas_chat_center.model');
const FacturasCot = require('./facturas_cot.model');
const DetalleFactCot = require('./detalle_fact_cot.model');
const Productos = require('./productos.model');
const InventarioBodegas = require('./inventario_bodegas.model');

const initModel = () => {
  // Asociaciones existentes
  User.belongsToMany(Plataforma, {
    through: UsuarioPlataforma,
    foreignKey: 'id_usuario',
    otherKey: 'id_plataforma',
    as: 'plataformas',
  });

  Plataforma.belongsToMany(User, {
    through: UsuarioPlataforma,
    foreignKey: 'id_plataforma',
    otherKey: 'id_usuario',
    as: 'usuarios',
  });

  // Asociación entre Plataforma y ClientesChatCenter
  Plataforma.hasMany(ClientesChatCenter, {
    foreignKey: 'id_plataforma',
    as: 'clientes',
  });
  ClientesChatCenter.belongsTo(Plataforma, {
    foreignKey: 'id_plataforma',
    as: 'plataforma',
  });

  // Asociación entre ClientesChatCenter y MensajesClientes
  ClientesChatCenter.hasMany(MensajesClientes, {
    foreignKey: 'id_cliente',
    as: 'mensajes',
  });
  MensajesClientes.belongsTo(ClientesChatCenter, {
    foreignKey: 'id_cliente',
    as: 'cliente',
  });

  // Asociación entre Plataforma y MensajesClientes
  Plataforma.hasMany(MensajesClientes, {
    foreignKey: 'id_plataforma',
    as: 'mensajes',
  });
  MensajesClientes.belongsTo(Plataforma, {
    foreignKey: 'id_plataforma',
    as: 'plataforma',
  });

  // Asociación entre ClientesChatCenter y EtiquetasChatCenter
  ClientesChatCenter.belongsTo(EtiquetasChatCenter, {
    foreignKey: 'id_etiqueta',
    as: 'etiqueta',
  });

  FacturasCot.hasMany(DetalleFactCot, {
    foreignKey: 'id_factura',
    as: 'detalles',
  });

  DetalleFactCot.belongsTo(FacturasCot, {
    foreignKey: 'id_factura',
    as: 'factura',
  });

  Plataforma.hasMany(FacturasCot, {
    foreignKey: 'id_plataforma',
    as: 'facturas',
  });

  FacturasCot.belongsTo(Plataforma, {
    foreignKey: 'id_plataforma',
    as: 'plataforma',
  });

  Plataforma.hasMany(DetalleFactCot, {
    foreignKey: 'id_plataforma',
    as: 'detalles',
  });

  DetalleFactCot.belongsTo(Plataforma, {
    foreignKey: 'id_plataforma',
    as: 'plataforma',
  });

  Productos.hasMany(DetalleFactCot, {
    foreignKey: 'id_producto',
    as: 'detalles',
  });

  DetalleFactCot.belongsTo(Productos, {
    foreignKey: 'id_producto',
    as: 'producto',
  });

  Plataforma.hasMany(Productos, {
    foreignKey: 'id_plataforma',
    as: 'productos',
  });

  Productos.belongsTo(Plataforma, {
    foreignKey: 'id_plataforma',
    as: 'plataforma',
  });

  InventarioBodegas.belongsTo(Productos, {
    foreignKey: 'id_producto',
    as: 'producto',
  });

  Productos.hasMany(InventarioBodegas, {
    foreignKey: 'id_producto',
    as: 'inventarios',
  });

  Plataforma.hasMany(InventarioBodegas, {
    foreignKey: 'id_plataforma',
    as: 'inventarios',
  });

  InventarioBodegas.belongsTo(Plataforma, {
    foreignKey: 'id_plataforma',
    as: 'plataforma',
  });

  DetalleFactCot.belongsTo(InventarioBodegas, {
    foreignKey: 'id_inventario',
    as: 'inventario',
  });

  InventarioBodegas.hasMany(DetalleFactCot, {
    foreignKey: 'id_inventario',
    as: 'detalles',
  });
};
module.exports = initModel;
