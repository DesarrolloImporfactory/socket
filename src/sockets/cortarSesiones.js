const { db, db_2 } = require('../database/config');

/*  Corta los sockets ya abiertos de una sesión que murió.
 *
 *  El middleware del socket solo mira al conectar: una cuenta suspendida (o
 *  con sesión cerrada en Imporsuit) seguía con su chat en vivo abierto hasta
 *  recargar. Hoy no hay un botón que suspenda sub-usuarios (se hace a mano en
 *  la base o lo hace el downgrade de Stripe), así que en vez de engancharse a
 *  cada lugar se revisa cada minuto a quienes están conectados.
 *
 *  Antes de cortar se avisa al navegador con SESION_TERMINADA { code } para
 *  que cierre la sesión y no se quede reintentando.
 */

function namespaces(io) {
  const lista = [];
  if (io) lista.push(io.of('/'));
  if (global.presenceIo) lista.push(global.presenceIo);
  return lista;
}

function socketsConSesion(io) {
  const out = [];
  for (const ns of namespaces(io)) {
    for (const s of ns.sockets.values()) {
      if (s.user?.id_sub_usuario) out.push(s);
    }
  }
  return out;
}

function cortar(socket, code) {
  try {
    socket.emit('SESION_TERMINADA', { code });
  } finally {
    socket.disconnect(true);
  }
}

// Corta ya los sockets de un sub-usuario (para quien suspenda desde código).
function cortarSesionesDe(io, id_sub_usuario, code = 'USER_SUSPENDED') {
  const id = Number(id_sub_usuario);
  let cortados = 0;
  for (const s of socketsConSesion(io)) {
    if (Number(s.user.id_sub_usuario) === id) {
      cortar(s, code);
      cortados += 1;
    }
  }
  return cortados;
}

// Decide a quién cortar. Puro, para poder probarlo sin base.
//   sockets: [{ user: { id_sub_usuario, iat } }]
//   subs:    [{ id_sub_usuario, suspendido, email, usuario }]
//   logouts: [{ email_users, usuario_users, ts }]
function aCortar(sockets, subs, logouts) {
  const porId = new Map(subs.map((u) => [Number(u.id_sub_usuario), u]));
  const tsPorClave = new Map();
  for (const l of logouts) {
    const ts = Number(l.ts) || 0;
    for (const k of [l.email_users, l.usuario_users]) {
      if (!k) continue;
      const clave = String(k).toLowerCase();
      tsPorClave.set(clave, Math.max(tsPorClave.get(clave) || 0, ts));
    }
  }

  const out = [];
  for (const s of sockets) {
    const u = porId.get(Number(s.user.id_sub_usuario));
    if (!u) {
      out.push({ socket: s, code: 'USER_NOT_FOUND' });
      continue;
    }
    if (Number(u.suspendido) === 1) {
      out.push({ socket: s, code: 'USER_SUSPENDED' });
      continue;
    }
    const iat = Number(s.user.iat) || 0;
    // Más prudente que sesionVigente (que acepta correo O usuario): aquí se
    // echa a alguien, así que se mira solo su correo, y el usuario solo si no
    // tiene correo. Si protect lo rechaza por usuario, el front igual sale.
    const clave = String(u.email || u.usuario || '').toLowerCase();
    const ts = clave ? tsPorClave.get(clave) || 0 : 0;
    if (iat && ts > iat) out.push({ socket: s, code: 'TOKEN_REVOKED' });
  }
  return out;
}

async function revisarConectados(io) {
  const sockets = socketsConSesion(io);
  if (!sockets.length) return 0;

  const ids = [...new Set(sockets.map((s) => Number(s.user.id_sub_usuario)))];
  const subs = await db.query(
    `SELECT id_sub_usuario, suspendido, email, usuario
       FROM sub_usuarios_chat_center
      WHERE id_sub_usuario IN (?)`,
    { replacements: [ids], type: db.QueryTypes.SELECT },
  );

  const claves = [...new Set(subs.map((u) => u.email || u.usuario).filter(Boolean))];
  let logouts = [];
  if (claves.length) {
    try {
      logouts = await db_2.query(
        `SELECT email_users, usuario_users, UNIX_TIMESTAMP(logout_at) AS ts
           FROM users
          WHERE logout_at IS NOT NULL
            AND (email_users IN (?) OR usuario_users IN (?))`,
        { replacements: [claves, claves], type: db_2.QueryTypes.SELECT },
      );
    } catch (err) {
      // fail-open, como protect: sin Imporsuit solo se mira la suspensión.
      console.warn('[cortarSesiones] logout_at no disponible —', err.message);
    }
  }

  const cortes = aCortar(sockets, subs, logouts);
  for (const { socket, code } of cortes) cortar(socket, code);
  if (cortes.length) {
    console.log(
      '[SOCKET_SESION] cortados',
      JSON.stringify(cortes.map((c) => ({ id: c.socket.user.id_sub_usuario, code: c.code }))),
    );
  }
  return cortes.length;
}

let reloj = null;

function iniciarRevisionDeSesiones(io, cadaMs = 60 * 1000) {
  if (reloj) return;
  let corriendo = false;
  reloj = setInterval(async () => {
    if (corriendo) return;
    corriendo = true;
    try {
      await revisarConectados(io);
    } catch (err) {
      console.warn('[cortarSesiones] revisión falló —', err.message);
    } finally {
      corriendo = false;
    }
  }, cadaMs);
  reloj.unref?.();
}

module.exports = {
  cortarSesionesDe,
  revisarConectados,
  iniciarRevisionDeSesiones,
  aCortar,
};
