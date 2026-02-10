const jwt = require("jsonwebtoken");

module.exports = function socketAuth() {
  return (socket, next) => {
    try {
      const token = socket.handshake?.auth?.token;
      if (!token) return next(new Error("NO_TOKEN"));

      const decoded = jwt.verify(token, process.env.SECRET_JWT_SEED);

      // Usted dijo que el token trae: id_sub_usuario, id_usuario, rol, etc.
      if (!decoded?.id_sub_usuario) return next(new Error("NO_ID_SUB_USUARIO"));

      socket.user = {
        id_sub_usuario: Number(decoded.id_sub_usuario),
        id_usuario: Number(decoded.id_usuario),
        rol: decoded.rol,
        nombre: decoded.nombre,
      };

      next();
    } catch (err) {
      return next(new Error("INVALID_TOKEN"));
    }
  };
};
