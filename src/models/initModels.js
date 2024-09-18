const User = require('./user.model');
const Plataforma = require('./plataforma.model');
const UsuarioPlataforma = require('./usuario_plataforma.model');

const initModel = () => {
  // Relación muchos a muchos entre User y Plataforma a través de UsuarioPlataforma
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
};

module.exports = initModel;
