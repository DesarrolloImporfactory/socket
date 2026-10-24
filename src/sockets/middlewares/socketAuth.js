const jwt = require("jsonwebtoken");
const { sesionVigente } = require("../../utils/sesionVigente");

// Códigos con los que la sesión está muerta aunque el token sea auténtico:
// el socket se rechaza en las dos puertas (presence y la principal).
const SESION_MUERTA = new Set(["USER_NOT_FOUND", "USER_SUSPENDED", "TOKEN_REVOKED"]);

function errorConCodigo(code) {
  const err = new Error(code);
  err.data = { code };
  return err;
}

function usuarioDelSocket(decoded, user) {
  return {
    id_sub_usuario: Number(decoded.id_sub_usuario),
    id_usuario: Number(user?.id_usuario ?? decoded.id_usuario),
    // El rol sale de la base, no del token: el token puede ser de antes de
    // un cambio de rol.
    rol: user?.rol ?? decoded.rol,
    nombre: decoded.nombre,
    iat: Number(decoded.iat) || 0,
  };
}

/*  Presence: sin sesión vigente no entra. */
module.exports = function socketAuth() {
  return async (socket, next) => {
    let decoded;
    try {
      const token = socket.handshake?.auth?.token;
      if (!token) return next(new Error("NO_TOKEN"));

      decoded = jwt.verify(token, process.env.SECRET_JWT_SEED);

      // Usted dijo que el token trae: id_sub_usuario, id_usuario, rol, etc.
      if (!decoded?.id_sub_usuario) return next(new Error("NO_ID_SUB_USUARIO"));
    } catch (err) {
      return next(new Error("INVALID_TOKEN"));
    }

    try {
      const { ok, code, user } = await sesionVigente(decoded);
      if (!ok) return next(errorConCodigo(code));
      socket.user = usuarioDelSocket(decoded, user);
    } catch (err) {
      // fail-open, igual que antes: si la base falla se confía en el token.
      console.warn("[socketAuth] sesionVigente falló —", err.message);
      socket.user = usuarioDelSocket(decoded, null);
    }
    next();
  };
};

/*  Socket principal (chats): suave mientras el front no mande el token en
 *  todas sus pantallas. Deja entrar sin token o con token inválido (y lo
 *  cuenta), pero rechaza una sesión muerta: suspendido, eliminado o con
 *  sesión cerrada. Pedir el token a todos es el tramo 3.
 */
const conteo = { con: 0, sin: 0, rechazados: 0, porMotivo: {}, porOrigen: {} };

function contar(socket, tipo, motivo) {
  conteo[tipo] += 1;
  if (motivo) conteo.porMotivo[motivo] = (conteo.porMotivo[motivo] || 0) + 1;
  if (tipo !== "con") {
    const h = socket.handshake?.headers || {};
    const origen = String(h.origin || "sin-origen").slice(0, 60);
    const agente = /Mobile|Android|iPhone/i.test(h["user-agent"] || "") ? "movil" : "escritorio";
    const clave = `${origen} ${agente}`;
    conteo.porOrigen[clave] = (conteo.porOrigen[clave] || 0) + 1;
  }
}

function registrarConteo() {
  if (conteo.con + conteo.sin + conteo.rechazados === 0) return;
  console.log("[SOCKET_SESION]", JSON.stringify(conteo));
  conteo.con = 0;
  conteo.sin = 0;
  conteo.rechazados = 0;
  conteo.porMotivo = {};
  conteo.porOrigen = {};
}

let relojConteo = null;

module.exports.socketAuthSuave = function socketAuthSuave() {
  if (!relojConteo) {
    relojConteo = setInterval(registrarConteo, 60 * 60 * 1000);
    relojConteo.unref?.();
  }

  return async (socket, next) => {
    socket.user = null;
    socket.sinSesion = null;

    const token = socket.handshake?.auth?.token;
    if (!token) {
      socket.sinSesion = "TOKEN_MISSING";
      contar(socket, "sin", "TOKEN_MISSING");
      return next();
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.SECRET_JWT_SEED);
    } catch (err) {
      socket.sinSesion = err.name === "TokenExpiredError" ? "TOKEN_EXPIRED" : "TOKEN_INVALID";
      contar(socket, "sin", socket.sinSesion);
      return next();
    }
    if (!decoded?.id_sub_usuario) {
      socket.sinSesion = "TOKEN_INVALID";
      contar(socket, "sin", "TOKEN_INVALID");
      return next();
    }

    try {
      const { ok, code, user } = await sesionVigente(decoded);
      if (!ok) {
        if (SESION_MUERTA.has(code)) {
          contar(socket, "rechazados", code);
          return next(errorConCodigo(code));
        }
        socket.sinSesion = code;
        contar(socket, "sin", code);
        return next();
      }
      socket.user = usuarioDelSocket(decoded, user);
      contar(socket, "con");
    } catch (err) {
      // fail-open: si la base falla no se corta el chat de nadie.
      console.warn("[socketAuthSuave] sesionVigente falló —", err.message);
      socket.user = usuarioDelSocket(decoded, null);
      contar(socket, "con");
    }
    next();
  };
};

module.exports.SESION_MUERTA = SESION_MUERTA;
module.exports._conteo = conteo;
