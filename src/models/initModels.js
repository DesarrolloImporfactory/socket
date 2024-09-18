const User = require('./User'); // Asegúrate de que la ruta y el nombre son correctos
const Plataforma = require('./Plataforma');
const UsuarioPlataforma = require('./UsuarioPlataforma');

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
