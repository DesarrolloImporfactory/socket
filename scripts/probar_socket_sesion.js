/*  Prueba del socket con sesión: un servidor socket.io de verdad en
 *  127.0.0.1 (puerto al azar), con la base reemplazada por dobles.
 *   - Principal (suave): entra sin token y con token roto; rechaza suspendido,
 *     eliminado y sesión cerrada; el rol sale de la base.
 *   - /presence: igual que antes sin token, y ahora también rechaza suspendido.
 *   - Revisión de conectados: corta los sockets abiertos de quien quedó
 *     suspendido, avisando SESION_TERMINADA antes.
 *
 *  Uso: NODE_PATH=…/node_modules node scripts/probar_socket_sesion.js
 *  (necesita jsonwebtoken, socket.io y socket.io-client)
 */
const path = require('path');
const http = require('http');
const Module = require('module');

process.env.SECRET_JWT_SEED = process.env.SECRET_JWT_SEED || 'semilla-de-prueba';

const estado = { subs: new Map(), logouts: [], subFalla: false };
const dbDoble = {
  QueryTypes: { SELECT: 'SELECT' },
  query: async (sql, opts) => {
    if (/FROM sub_usuarios_chat_center/.test(sql)) {
      const ids = opts.replacements[0];
      return ids.map((id) => estado.subs.get(Number(id))).filter(Boolean);
    }
    return [];
  },
};
const db2Doble = {
  QueryTypes: { SELECT: 'SELECT' },
  query: async (sql, opts) => {
    if (/logout_at IS NOT NULL/.test(sql)) {
      const claves = opts.replacements[0];
      return estado.logouts.filter(
        (l) => claves.includes(l.email_users) || claves.includes(l.usuario_users),
      );
    }
    const [email, usuario] = opts.replacements;
    const row = estado.logouts.find((l) => l.email_users === email || l.usuario_users === usuario);
    return row ? [{ ts: row.ts }] : [];
  },
};
const SubDoble = {
  findOne: async ({ where }) => {
    if (estado.subFalla) throw new Error('base caída');
    return estado.subs.get(Number(where.id_sub_usuario)) || null;
  },
};
const src = path.join(__dirname, '..', 'src');
const dobles = {
  [path.join(src, 'database', 'config.js')]: { db: dbDoble, db_2: db2Doble },
  [path.join(src, 'models', 'sub_usuarios_chat_center.model.js')]: SubDoble,
};
const cargarOriginal = Module._load;
Module._load = function (request, parent, isMain) {
  let resuelto = null;
  try {
    resuelto = Module._resolveFilename(request, parent, isMain);
  } catch {}
  if (resuelto && dobles[resuelto]) return dobles[resuelto];
  return cargarOriginal.apply(this, arguments);
};

const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const ioCliente = require('socket.io-client');
const socketAuth = require('../src/sockets/middlewares/socketAuth.js');
const { revisarConectados, cortarSesionesDe } = require('../src/sockets/cortarSesiones');

let pasan = 0;
let fallan = 0;
function ok(cond, nombre, extra) {
  if (cond) pasan += 1;
  else {
    fallan += 1;
    console.log('  ✗', nombre, extra !== undefined ? JSON.stringify(extra) : '');
  }
}
const firmar = (p) => jwt.sign(p, process.env.SECRET_JWT_SEED, { expiresIn: '7d' });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function reiniciar() {
  estado.subs = new Map([
    [10, { id_sub_usuario: 10, id_usuario: 254, rol: 'administrador', email: 'ana@x.com', usuario: 'ana', suspendido: 0 }],
    [11, { id_sub_usuario: 11, id_usuario: 254, rol: 'ventas', email: 'beto@x.com', usuario: 'beto', suspendido: 1 }],
    [12, { id_sub_usuario: 12, id_usuario: 254, rol: 'ventas', email: 'caro@x.com', usuario: 'caro', suspendido: 0 }],
  ]);
  estado.logouts = [];
  estado.subFalla = false;
}

(async () => {
  reiniciar();
  const server = http.createServer();
  const io = new Server(server);
  const presence = io.of('/presence');
  global.presenceIo = presence;
  presence.use(socketAuth());
  presence.on('connection', () => {});
  io.use(socketAuth.socketAuthSuave());
  const usuariosServidor = new Map();
  io.on('connection', (s) => {
    usuariosServidor.set(s.id, { user: s.user, sinSesion: s.sinSesion });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  const abiertos = [];
  function conectar(ns, token) {
    return new Promise((resolve) => {
      const c = ioCliente(url + ns, {
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        auth: token === undefined ? {} : { token },
      });
      abiertos.push(c);
      c.on('connect', () => resolve({ c, ok: true }));
      c.on('connect_error', (err) => resolve({ c, ok: false, msg: err.message, code: err.data?.code }));
    });
  }

  // ---- socket principal ---------------------------------------------------------
  let r = await conectar('/', undefined);
  ok(r.ok, 'M1 sin token entra (suave)');
  ok(usuariosServidor.get(r.c.id)?.sinSesion === 'TOKEN_MISSING', 'M1 marcado TOKEN_MISSING');

  r = await conectar('/', 'basura');
  ok(r.ok, 'M2 token roto entra (suave)');
  ok(usuariosServidor.get(r.c.id)?.sinSesion === 'TOKEN_INVALID', 'M2 marcado TOKEN_INVALID');

  r = await conectar('/', firmar({ id_sub_usuario: 10, id_usuario: 254, rol: 'super_administrador' }));
  ok(r.ok, 'M3 activo entra');
  const u = usuariosServidor.get(r.c.id)?.user;
  ok(u && u.id_sub_usuario === 10 && u.id_usuario === 254, 'M3 socket.user con ids', u);
  ok(u && u.rol === 'administrador', 'M3 el rol sale de la base, no del token', u?.rol);
  const anaPrincipal = r.c;

  r = await conectar('/', firmar({ id_sub_usuario: 11 }));
  ok(!r.ok && r.msg === 'USER_SUSPENDED' && r.code === 'USER_SUSPENDED', 'M4 suspendido rechazado', r.msg);

  r = await conectar('/', firmar({ id_sub_usuario: 999 }));
  ok(!r.ok && r.code === 'USER_NOT_FOUND', 'M5 eliminado rechazado', r.msg);

  estado.logouts = [{ email_users: 'caro@x.com', usuario_users: 'caro', ts: Math.floor(Date.now() / 1000) + 5 }];
  r = await conectar('/', firmar({ id_sub_usuario: 12 }));
  ok(!r.ok && r.code === 'TOKEN_REVOKED', 'M6 sesión cerrada rechazada', r.msg);
  estado.logouts = [];

  estado.subFalla = true;
  r = await conectar('/', firmar({ id_sub_usuario: 12 }));
  ok(r.ok, 'M7 base caída → entra (fail-open)');
  estado.subFalla = false;

  const conteo = socketAuth._conteo;
  ok(conteo.sin === 2 && conteo.rechazados === 3 && conteo.con === 2, 'M8 conteo con/sin/rechazados', conteo);
  ok(conteo.porMotivo.USER_SUSPENDED === 1 && conteo.porMotivo.TOKEN_MISSING === 1, 'M8 conteo por motivo', conteo.porMotivo);

  // ---- presence -------------------------------------------------------------------
  r = await conectar('/presence', undefined);
  ok(!r.ok && r.msg === 'NO_TOKEN', 'P1 presence sin token → NO_TOKEN (igual que antes)', r.msg);
  r = await conectar('/presence', 'basura');
  ok(!r.ok && r.msg === 'INVALID_TOKEN', 'P2 presence token roto → INVALID_TOKEN (igual que antes)', r.msg);
  r = await conectar('/presence', firmar({ id_sub_usuario: 11 }));
  ok(!r.ok && r.code === 'USER_SUSPENDED', 'P3 presence suspendido rechazado', r.msg);
  r = await conectar('/presence', firmar({ id_sub_usuario: 10 }));
  ok(r.ok, 'P4 presence activo entra');
  const anaPresence = r.c;

  // ---- revisión de los ya conectados ----------------------------------------------
  const avisos = [];
  const cortes = [];
  for (const [nombre, c] of [['principal', anaPrincipal], ['presence', anaPresence]]) {
    c.on('SESION_TERMINADA', (d) => avisos.push(`${nombre}:${d.code}`));
    c.on('disconnect', (motivo) => cortes.push(`${nombre}:${motivo}`));
  }
  let n = await revisarConectados(io);
  ok(n === 0, 'R1 nadie suspendido → no corta a nadie', n);

  estado.subs.get(10).suspendido = 1;
  n = await revisarConectados(io);
  await espera(150);
  ok(n === 2, 'R2 Ana suspendida → corta sus 2 sockets', n);
  ok(avisos.sort().join() === 'presence:USER_SUSPENDED,principal:USER_SUSPENDED', 'R2 aviso SESION_TERMINADA en los dos', avisos);
  ok(cortes.sort().join() === 'presence:io server disconnect,principal:io server disconnect', 'R2 corte por el servidor', cortes);

  // los sin sesión no se tocan
  const sinSesionSigue = abiertos[0].connected;
  ok(sinSesionSigue, 'R3 el socket sin token sigue conectado (suave hasta el tramo 3)');

  // cortarSesionesDe directo
  estado.subs.get(10).suspendido = 0;
  r = await conectar('/', firmar({ id_sub_usuario: 10 }));
  const cortadosDirecto = cortarSesionesDe(io, 10);
  await espera(100);
  ok(cortadosDirecto === 1 && !r.c.connected, 'R4 cortarSesionesDe corta al instante', cortadosDirecto);

  for (const c of abiertos) c.close();
  io.close();
  console.log(`\nprobar_socket_sesion: ${pasan} bien / ${fallan} mal`);
  process.exit(fallan ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
