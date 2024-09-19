const User = require('./user.model');
const Plataforma = require('./plataforma.model');
const UsuarioPlataforma = require('./usuario_plataforma.model');
const ClientesChatCenter = require('./clientes_chat_center.model');
const MensajesClientes = require('./mensaje_cliente.model');

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
};
module.exports = initModel;
