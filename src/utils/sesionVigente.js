const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const { db_2 } = require('../database/config');

/*  ¿La sesión de este token sigue valiendo?
 *
 *  Recibe el token YA verificado (jwt.verify) y mira la base:
 *   - USER_NOT_FOUND: el sub-usuario ya no existe.
 *   - USER_SUSPENDED: el sub-usuario está suspendido (suspendido = 1). Antes
 *     solo lo frenaba el login, y un token emitido antes seguía valiendo 7 días.
 *   - TOKEN_REVOKED: users.logout_at (Imporsuit) es posterior a iat.
 *
 *  Lo usan `protect` (REST) y los middlewares del socket, para que las tres
 *  puertas digan lo mismo. Devuelve { ok, code, user }.
 */
async function sesionVigente(decoded) {
  const user = await Sub_usuarios_chat_center.findOne({
    where: { id_sub_usuario: decoded?.id_sub_usuario },
  });
  if (!user) return { ok: false, code: 'USER_NOT_FOUND', user: null };

  if (Number(user.suspendido) === 1) {
    return { ok: false, code: 'USER_SUSPENDED', user };
  }

  // Single sign-out: si users.logout_at > iat, el token fue revocado.
  // Mapeamos por email (no por id_usuario): id_usuario es de la BD chatcenter
  // y NO corresponde al id_users de imporsuit. El email sí es común a ambas BDs.
  const email = user.email;
  const usuario = user.usuario;
  const iat = decoded.iat;
  if ((email || usuario) && iat) {
    try {
      const [row] = await db_2.query(
        `SELECT UNIX_TIMESTAMP(logout_at) AS ts
           FROM users
          WHERE email_users = ? OR usuario_users = ?
          LIMIT 1`,
        {
          replacements: [email || '', usuario || email || ''],
          type: db_2.QueryTypes.SELECT,
        },
      );
      const logoutAt = row && row.ts ? Number(row.ts) : 0;
      if (logoutAt > iat) return { ok: false, code: 'TOKEN_REVOKED', user };
    } catch (err) {
      // fail-open: si la consulta falla no bloqueamos al usuario
      console.warn('sesionVigente: error consultando users.logout_at —', err.message);
    }
  }

  return { ok: true, code: null, user };
}

module.exports = { sesionVigente };
