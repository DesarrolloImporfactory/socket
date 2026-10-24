/*  Pruebas sin base ni red de:
 *   - utils/sesionVigente.js (existe / suspendido / sesión cerrada / fail-open)
 *   - middlewares/auth.middleware.js → protect (los 401 con su `code`)
 *   - sockets/cortarSesiones.js → aCortar (a quién se corta en la revisión)
 *
 *  Uso: node scripts/probar_sesion_vigente.js
 *  (necesita jsonwebtoken instalado; con otra carpeta: NODE_PATH=…/node_modules)
 */
const path = require('path');
const Module = require('module');

process.env.SECRET_JWT_SEED = process.env.SECRET_JWT_SEED || 'semilla-de-prueba';

// ---- dobles de la base ----------------------------------------------------
const estado = { subs: new Map(), logouts: [], db2Falla: false };

const dbDoble = {
  QueryTypes: { SELECT: 'SELECT' },
  query: async () => [],
};
const db2Doble = {
  QueryTypes: { SELECT: 'SELECT' },
  query: async (sql, opts) => {
    if (estado.db2Falla) throw new Error('db_2 caída');
    const [email, usuario] = opts.replacements;
    const row = estado.logouts.find(
      (l) => l.email_users === email || l.usuario_users === usuario,
    );
    return row ? [{ ts: row.ts }] : [];
  },
};
const SubDoble = {
  findOne: async ({ where }) => estado.subs.get(Number(where.id_sub_usuario)) || null,
};

const src = path.join(__dirname, '..', 'src');
const dobles = {
  [path.join(src, 'database', 'config.js')]: { db: dbDoble, db_2: db2Doble },
  [path.join(src, 'models', 'sub_usuarios_chat_center.model.js')]: SubDoble,
  [path.join(src, 'models', 'configuraciones.model.js')]: { findOne: async () => null },
};
const cargarOriginal = Module._load;
Module._load = function (request, parent, isMain) {
  const resuelto = (() => {
    try {
      return Module._resolveFilename(request, parent, isMain);
    } catch {
      return null;
    }
  })();
  if (resuelto && dobles[resuelto]) return dobles[resuelto];
  return cargarOriginal.apply(this, arguments);
};

const jwt = require('jsonwebtoken');
const { sesionVigente } = require('../src/utils/sesionVigente');
const { protect } = require('../src/middlewares/auth.middleware');
const { aCortar } = require('../src/sockets/cortarSesiones');

// ---- utilidades -------------------------------------------------------------
let pasan = 0;
let fallan = 0;
function ok(cond, nombre, extra) {
  if (cond) pasan += 1;
  else {
    fallan += 1;
    console.log('  ✗', nombre, extra !== undefined ? JSON.stringify(extra) : '');
  }
}
const ahora = () => Math.floor(Date.now() / 1000);
function reiniciar() {
  estado.subs = new Map([
    [10, { id_sub_usuario: 10, id_usuario: 254, rol: 'administrador', email: 'ana@x.com', usuario: 'ana', suspendido: 0 }],
    [11, { id_sub_usuario: 11, id_usuario: 254, rol: 'ventas', email: 'beto@x.com', usuario: 'beto', suspendido: 1 }],
    [12, { id_sub_usuario: 12, id_usuario: 254, rol: 'ventas', email: 'caro@x.com', usuario: 'caro', suspendido: 0 }],
    [13, { id_sub_usuario: 13, id_usuario: 254, rol: 'ventas', email: null, usuario: null, suspendido: 0 }],
  ]);
  estado.logouts = [];
  estado.db2Falla = false;
}

async function llamarProtect(headers) {
  const req = { headers };
  let resultado = null;
  await new Promise((resolve) => {
    const res = {
      status(c) {
        this._c = c;
        return this;
      },
      json(body) {
        resultado = { status: this._c, body };
        resolve();
      },
    };
    protect(req, res, (err) => {
      resultado = err ? { error: err } : { next: true, user: req.sessionUser };
      resolve();
    });
  });
  return resultado;
}
const firmar = (payload, opts = { expiresIn: '7d' }) =>
  jwt.sign(payload, process.env.SECRET_JWT_SEED, opts);

(async () => {
  // ---- sesionVigente --------------------------------------------------------
  reiniciar();
  const iat = ahora() - 100;
  let r = await sesionVigente({ id_sub_usuario: 999, iat });
  ok(!r.ok && r.code === 'USER_NOT_FOUND', 'S1 no existe → USER_NOT_FOUND', r);

  r = await sesionVigente({ id_sub_usuario: 11, iat });
  ok(!r.ok && r.code === 'USER_SUSPENDED', 'S2 suspendido → USER_SUSPENDED', r.code);

  r = await sesionVigente({ id_sub_usuario: 10, iat });
  ok(r.ok && r.user.id_sub_usuario === 10, 'S3 activo sin logout → ok');

  estado.logouts = [{ email_users: 'ana@x.com', usuario_users: 'ana', ts: iat + 10 }];
  r = await sesionVigente({ id_sub_usuario: 10, iat });
  ok(!r.ok && r.code === 'TOKEN_REVOKED', 'S4 logout después del token → TOKEN_REVOKED', r.code);

  estado.logouts = [{ email_users: 'ana@x.com', usuario_users: 'ana', ts: iat - 10 }];
  r = await sesionVigente({ id_sub_usuario: 10, iat });
  ok(r.ok, 'S5 logout antes del token → ok');

  estado.logouts = [{ email_users: 'otra@x.com', usuario_users: 'ana', ts: iat + 10 }];
  r = await sesionVigente({ id_sub_usuario: 10, iat });
  ok(!r.ok && r.code === 'TOKEN_REVOKED', 'S6 coincide por usuario (como antes) → TOKEN_REVOKED');

  estado.logouts = [{ email_users: 'ana@x.com', usuario_users: 'ana', ts: iat + 10 }];
  estado.db2Falla = true;
  r = await sesionVigente({ id_sub_usuario: 10, iat });
  ok(r.ok, 'S7 Imporsuit caída → fail-open ok');

  reiniciar();
  r = await sesionVigente({ id_sub_usuario: 13, iat });
  ok(r.ok, 'S8 sin correo ni usuario → ok (no se consulta logout)');

  // suspendido gana aunque además haya logout
  estado.logouts = [{ email_users: 'beto@x.com', usuario_users: 'beto', ts: iat + 10 }];
  r = await sesionVigente({ id_sub_usuario: 11, iat });
  ok(r.code === 'USER_SUSPENDED', 'S9 suspendido y con logout → USER_SUSPENDED');

  // ---- protect --------------------------------------------------------------
  reiniciar();
  let p = await llamarProtect({});
  ok(p.status === 401 && p.body.code === 'TOKEN_MISSING', 'P1 sin token → 401 TOKEN_MISSING', p);
  ok(p.body.message === 'No has iniciado sesión. Inicia sesión para continuar.', 'P1 mensaje igual que antes');

  p = await llamarProtect({ authorization: 'Bearer basura' });
  ok(p.status === 401 && p.body.code === 'TOKEN_INVALID', 'P2 token roto → TOKEN_INVALID', p);

  p = await llamarProtect({
    authorization: 'Bearer ' + firmar({ id_sub_usuario: 10, iat: ahora() - 1000 }, { expiresIn: 1 }),
  });
  ok(p.status === 401 && p.body.code === 'TOKEN_EXPIRED', 'P3 vencido → TOKEN_EXPIRED', p);

  p = await llamarProtect({ authorization: 'Bearer ' + firmar({ id_sub_usuario: 999 }) });
  ok(p.status === 401 && p.body.code === 'USER_NOT_FOUND', 'P4 no existe → USER_NOT_FOUND');
  ok(p.body.message === 'El usuario de esta sesión ya no existe.', 'P4 mensaje igual que antes');

  p = await llamarProtect({ authorization: 'Bearer ' + firmar({ id_sub_usuario: 11 }) });
  ok(p.status === 401 && p.body.code === 'USER_SUSPENDED', 'P5 suspendido → 401 USER_SUSPENDED', p);
  ok(p.body.message === 'Tu acceso está suspendido. Habla con tu administrador.', 'P5 mensaje');
  ok(p.body.status === 'fail', 'P5 status fail');

  estado.logouts = [{ email_users: 'ana@x.com', usuario_users: 'ana', ts: ahora() + 5 }];
  p = await llamarProtect({ authorization: 'Bearer ' + firmar({ id_sub_usuario: 10 }) });
  ok(p.status === 401 && p.body.code === 'TOKEN_REVOKED', 'P6 sesión cerrada → TOKEN_REVOKED');
  ok(p.body.message === 'Sesión cerrada en otro dispositivo', 'P6 mensaje igual que antes');

  reiniciar();
  p = await llamarProtect({ authorization: 'Bearer ' + firmar({ id_sub_usuario: 10 }) });
  ok(p.next && p.user && p.user.id_sub_usuario === 10, 'P7 activo → next con sessionUser', p);

  // ---- aCortar ----------------------------------------------------------------
  const s = (id, iat) => ({ user: { id_sub_usuario: id, iat } });
  const subs = [
    { id_sub_usuario: 10, suspendido: 0, email: 'ana@x.com', usuario: 'ana' },
    { id_sub_usuario: 11, suspendido: 1, email: 'beto@x.com', usuario: 'beto' },
    { id_sub_usuario: 12, suspendido: 0, email: 'caro@x.com', usuario: 'caro' },
    { id_sub_usuario: 14, suspendido: 0, email: null, usuario: 'dani' },
  ];
  const t = 1000;
  let c = aCortar([s(10, t), s(11, t), s(12, t), s(99, t)], subs, []);
  const codigos = (lista) => lista.map((x) => `${x.socket.user.id_sub_usuario}:${x.code}`).sort();
  ok(
    JSON.stringify(codigos(c)) === JSON.stringify(['11:USER_SUSPENDED', '99:USER_NOT_FOUND']),
    'C1 corta suspendido y eliminado, deja a los activos',
    codigos(c),
  );

  c = aCortar([s(10, t), s(12, t)], subs, [
    { email_users: 'ANA@x.com', usuario_users: 'ana', ts: t + 1 },
    { email_users: 'caro@x.com', usuario_users: 'caro', ts: t - 1 },
  ]);
  ok(JSON.stringify(codigos(c)) === JSON.stringify(['10:TOKEN_REVOKED']), 'C2 logout después del token (sin mayúsculas)', codigos(c));

  c = aCortar([s(10, t)], subs, [{ email_users: 'otra@x.com', usuario_users: 'ana', ts: t + 1 }]);
  ok(c.length === 0, 'C3 no corta por usuario si tiene correo (prudente)', codigos(c));

  c = aCortar([s(14, t)], subs, [{ email_users: 'x@y.com', usuario_users: 'dani', ts: t + 1 }]);
  ok(JSON.stringify(codigos(c)) === JSON.stringify(['14:TOKEN_REVOKED']), 'C4 sin correo → mira el usuario', codigos(c));

  c = aCortar([s(10, 0)], subs, [{ email_users: 'ana@x.com', usuario_users: 'ana', ts: t + 1 }]);
  ok(c.length === 0, 'C5 sin iat no se corta por logout');

  c = aCortar([s(10, t), s(10, t)], subs, [{ email_users: 'ana@x.com', usuario_users: 'ana', ts: t + 1 }]);
  ok(c.length === 2, 'C6 corta todas las pestañas de la misma persona');

  console.log(`\nprobar_sesion_vigente: ${pasan} bien / ${fallan} mal`);
  process.exit(fallan ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
