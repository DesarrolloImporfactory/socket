/*  Prueba del rol «equipo» (utils/rolEquipo.js), sin base de datos.
 *
 *  Los modelos y sesionVigente se reemplazan por dobles. Números inventados.
 *  Uso (desde la raíz del proyecto, con node_modules):
 *    node scripts/probar_rol_equipo.js
 */
const path = require('path');
const http = require('http');
const assert = require('assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.SECRET_JWT_SEED = 'semilla-de-prueba';
process.env.ROL_EQUIPO_CUENTAS = '254';
process.env.ROL_EQUIPO_PRUEBA_SUBS = '7,8';
delete process.env.RUTAS_SESION_EXIGIR;
const SRC = path.join(__dirname, '..', 'src');

// Sub-usuarios de mentira: 1 ventas, 3 equipo (cuenta 254), 4 equipo de una
// cuenta no habilitada, 5 equipo suspendido; 7 y 8 ventas de prueba
// (ROL_EQUIPO_PRUEBA_SUBS), 7 en la 254 y 8 en una cuenta no habilitada.
const SUBS = {
  1: { id_sub_usuario: 1, id_usuario: 9, rol: 'ventas', suspendido: 0, nombre_encargado: 'V' },
  3: { id_sub_usuario: 3, id_usuario: 254, rol: 'equipo', suspendido: 0, nombre_encargado: 'E' },
  4: { id_sub_usuario: 4, id_usuario: 77, rol: 'equipo', suspendido: 0, nombre_encargado: 'X' },
  5: { id_sub_usuario: 5, id_usuario: 254, rol: 'equipo', suspendido: 1, nombre_encargado: 'S' },
  7: { id_sub_usuario: 7, id_usuario: 254, rol: 'ventas', suspendido: 0, nombre_encargado: 'P' },
  8: { id_sub_usuario: 8, id_usuario: 77, rol: 'ventas', suspendido: 0, nombre_encargado: 'Q' },
};
const fila = (o) => (o ? { ...o, toJSON: () => ({ ...o }) } : null);

function doble(rel, exportsObj) {
  const f = require.resolve(path.join(SRC, rel));
  require.cache[f] = { id: f, filename: f, loaded: true, exports: exportsObj };
}
doble('utils/sesionVigente', {
  sesionVigente: async (d) => {
    const u = SUBS[Number(d.id_sub_usuario)];
    if (!u) return { ok: false, code: 'USER_NOT_FOUND', user: null };
    if (u.suspendido) return { ok: false, code: 'USER_SUSPENDED', user: u };
    return { ok: true, code: null, user: { ...u } };
  },
});
doble('models/sub_usuarios_chat_center.model', {
  findByPk: async (id) => fila(SUBS[Number(id)]),
  create: async (o) => fila(o),
  update: async () => [1],
});
doble('models/configuraciones.model', {});
// Sequelize real sin conectar: los modelos se definen y nada toca una base.
const { Sequelize } = require('sequelize');
const falsa = () => {
  const d = new Sequelize('mysql://x:y@127.0.0.1:9/z', { logging: false });
  d.query = async () => [];
  return d;
};
doble('database/config', { db: falsa(), db_2: falsa() });

const { protect } = require(path.join(SRC, 'middlewares/auth.middleware'));
const rutas = require(path.join(SRC, 'middlewares/rutasSinSesion'));
const excluirRoles = require(path.join(SRC, 'middlewares/excluirRoles.middleware'));
const { cerradoParaEquipo } = require(path.join(SRC, 'sockets/middlewares/socketAuth.js'));
const { crearSubUsuario } = require(path.join(SRC, 'utils/crearSubUsuario'));
const { actualizarSubUsuario } = require(path.join(SRC, 'utils/actualizarSubUsuario'));
const { puedeTenerRolEquipo, rutaPermitidaEquipo } = require(path.join(SRC, 'utils/rolEquipo'));
const equipoRouter = require(path.join(SRC, 'routes/equipo.routes'));
const errorHandler = require(path.join(SRC, 'controllers/error.controller'));

const CEL = '593991234567';
const SECRETO = 'secreto-de-team-de-prueba-0123456789';
const SELLO = { expiresIn: '1h', issuer: 'chatcenter', audience: 'team' };
const firmar = (p, opts = { expiresIn: '1h' }) => jwt.sign(p, process.env.SECRET_JWT_SEED, opts);
const T = {
  ventas: firmar({ id_sub_usuario: 1, rol: 'ventas' }),
  equipoLogin: firmar({ id_sub_usuario: 3, rol: 'equipo' }),
  equipoTeam: firmar({ id_sub_usuario: 3, rol: 'equipo', origen: 'team' }, SELLO),
  teamDeVentas: firmar({ id_sub_usuario: 1, rol: 'equipo', origen: 'team' }, SELLO),
  teamSinSello: firmar({ id_sub_usuario: 3, rol: 'equipo', origen: 'team' }),
};

function app() {
  const a = express();
  a.use(express.json());
  a.use(rutas.vigilar);
  a.use('/api/v1/equipo', equipoRouter);
  // Rutas de prueba que devuelven un teléfono.
  a.get('/api/v1/equipo/_datos', protect, (req, res) => res.json({ celular_cliente: CEL, texto_mensaje: 'cel 0987654321' }));
  a.get('/api/v1/equipo/_send', protect, (req, res) => res.send({ telefono: CEL }));
  a.get('/api/v1/equipo/_texto', protect, (req, res) => res.send('hola'));
  a.get('/api/v1/equipo/_json_texto', protect, (req, res) => res.type('json').send(JSON.stringify({ telefono: CEL })));
  a.get('/api/v1/equipo/_texto_cel', protect, (req, res) => res.send('llama al 0991234567'));
  a.get('/api/v1/equipo/_write', protect, (req, res) => {
    res.write(CEL);
    res.end();
  });
  a.get('/api/v1/equipo/_vacio', protect, (req, res) => res.status(204).end());
  a.get('/api/v1/chats', protect, (req, res) => res.json({ celular_cliente: CEL }));
  a.get('/api/v1/metricas', protect, excluirRoles('ventas'), (req, res) => res.json({ ok: 1 }));
  a.get('/api/v1/ajustes', protect, excluirRoles('administrador'), (req, res) => res.json({ ok: 1 }));
  // Ruta del lote A1 (sin protect hoy, en sombra).
  a.get('/api/v1/whatsapp_managment/programados_por_config', (req, res) => res.json({ telefono: CEL }));
  a.use(errorHandler);
  return new Promise((ok) => {
    const s = a.listen(0, () => ok(s));
  });
}

function pedir(s, metodo, ruta, { token, cabeceras = {}, cuerpo } = {}) {
  return new Promise((ok, mal) => {
    const datos = cuerpo ? JSON.stringify(cuerpo) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: s.address().port,
        method: metodo,
        path: ruta,
        headers: Object.assign(
          { 'user-agent': 'prueba/1.0' },
          token ? { authorization: 'Bearer ' + token } : {},
          datos ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(datos) } : {},
          cabeceras,
        ),
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          let j = null;
          try {
            j = JSON.parse(b);
          } catch (_) {}
          ok({ status: res.statusCode, body: j, texto: b });
        });
      },
    );
    req.on('error', mal);
    if (datos) req.write(datos);
    req.end();
  });
}

let fallos = 0;
async function caso(nombre, fn) {
  try {
    await fn();
    console.log('  ok  ', nombre);
  } catch (e) {
    fallos += 1;
    console.log('  FALLA', nombre, '—', e.message);
  }
}

(async () => {
  const s = await app();

  console.log('Sesión (protect)');
  await caso('ventas con su token pasa y ve el número', async () => {
    const r = await pedir(s, 'GET', '/api/v1/chats', { token: T.ventas });
    assert.equal(r.status, 200);
    assert.equal(r.body.celular_cliente, CEL);
  });
  await caso('equipo con token de login → 401 EQUIPO_SOLO_TEAM', async () => {
    const r = await pedir(s, 'GET', '/api/v1/equipo/yo', { token: T.equipoLogin });
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'EQUIPO_SOLO_TEAM');
  });
  await caso('equipo con sesión de Team en una ruta vieja → 403', async () => {
    const r = await pedir(s, 'GET', '/api/v1/chats', { token: T.equipoTeam });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'EQUIPO_RUTA_NO_PERMITIDA');
  });
  await caso('ruta vieja en mayúsculas tampoco', async () => {
    assert.equal((await pedir(s, 'GET', '/API/V1/CHATS', { token: T.equipoTeam })).status, 403);
  });
  await caso('sesión de Team de alguien que ya no es equipo → 401', async () => {
    const r = await pedir(s, 'GET', '/api/v1/equipo/yo', { token: T.teamDeVentas });
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'EQUIPO_SOLO_TEAM');
  });
  await caso('equipo en /equipo/yo pasa', async () => {
    const r = await pedir(s, 'GET', '/api/v1/equipo/yo', { token: T.equipoTeam });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.id_sub_usuario, 3);
  });
  await caso('res.json le llega tapado (clave y texto)', async () => {
    const r = await pedir(s, 'GET', '/api/v1/equipo/_datos', { token: T.equipoTeam });
    assert.equal(r.body.celular_cliente, '•••• 4567');
    assert.ok(!/\d{6,}/.test(r.body.texto_mensaje), r.body.texto_mensaje);
  });
  await caso('res.send(objeto) también y un texto pasa igual', async () => {
    assert.equal((await pedir(s, 'GET', '/api/v1/equipo/_send', { token: T.equipoTeam })).body.telefono, '•••• 4567');
    assert.equal((await pedir(s, 'GET', '/api/v1/equipo/_texto', { token: T.equipoTeam })).texto, 'hola');
  });
  await caso('res.send(texto JSON) y un texto con celular también van tapados', async () => {
    const r = await pedir(s, 'GET', '/api/v1/equipo/_json_texto', { token: T.equipoTeam });
    assert.ok(!r.texto.includes(CEL), r.texto);
    const t = await pedir(s, 'GET', '/api/v1/equipo/_texto_cel', { token: T.equipoTeam });
    assert.ok(!t.texto.includes('0991234567'), t.texto);
  });
  await caso('res.write con datos se corta (500, sin el número)', async () => {
    const r = await pedir(s, 'GET', '/api/v1/equipo/_write', { token: T.equipoTeam });
    assert.equal(r.status, 500);
    assert.ok(!r.texto.includes(CEL), r.texto);
  });
  await caso('res.end() vacío pasa (204)', async () => {
    assert.equal((await pedir(s, 'GET', '/api/v1/equipo/_vacio', { token: T.equipoTeam })).status, 204);
  });
  await caso('sesión de Team sin el sello (iss/aud) → 401', async () => {
    const r = await pedir(s, 'GET', '/api/v1/equipo/yo', { token: T.teamSinSello });
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'EQUIPO_SOLO_TEAM');
  });
  await caso('sacar la cuenta de ROL_EQUIPO_CUENTAS corta la sesión viva', async () => {
    process.env.ROL_EQUIPO_CUENTAS = '';
    const r = await pedir(s, 'GET', '/api/v1/equipo/yo', { token: T.equipoTeam });
    process.env.ROL_EQUIPO_CUENTAS = '254';
    assert.equal(r.status, 401);
    assert.equal((await pedir(s, 'GET', '/api/v1/equipo/yo', { token: T.equipoTeam })).status, 200);
  });
  await caso('«Equipo» con mayúscula o espacios cuenta como equipo', async () => {
    SUBS[6] = { id_sub_usuario: 6, id_usuario: 254, rol: ' Equipo', suspendido: 0 };
    const r = await pedir(s, 'GET', '/api/v1/chats', { token: firmar({ id_sub_usuario: 6, rol: 'ventas' }) });
    delete SUBS[6];
    assert.equal(r.status, 401);
    assert.equal(cerradoParaEquipo({}, { rol: 'EQUIPO' }), true);
  });
  await caso('rutaPermitidaEquipo: prefijo, mayúsculas, «..», URL absoluta', () => {
    assert.ok(rutaPermitidaEquipo('/api/v1/equipo/yo?x=1'));
    assert.ok(rutaPermitidaEquipo('/API/V1/EQUIPO/yo'));
    assert.ok(!rutaPermitidaEquipo('/api/v1/equipo'));
    assert.ok(!rutaPermitidaEquipo('/api/v1/equipo/../chats'));
    assert.ok(!rutaPermitidaEquipo('/api/v1/equipos/x'));
    assert.ok(!rutaPermitidaEquipo('http://x/api/v1/chats'));
  });

  console.log('Rutas sin sesión (vigilante en sombra)');
  await caso('ruta A1 sin token sigue pasando (sombra)', async () => {
    assert.equal((await pedir(s, 'GET', '/api/v1/whatsapp_managment/programados_por_config')).status, 200);
  });
  await caso('ruta A1 con sesión de Team → 403, no la puerta abierta', async () => {
    const r = await pedir(s, 'GET', '/api/v1/whatsapp_managment/programados_por_config', { token: T.equipoTeam });
    assert.equal(r.status, 403);
  });
  await caso('ruta A1 con token de login de un equipo → 401', async () => {
    const r = await pedir(s, 'GET', '/api/v1/whatsapp_managment/programados_por_config', { token: T.equipoLogin });
    assert.equal(r.status, 401);
  });

  console.log('excluirRoles');
  await caso('excluirRoles(ventas) también deja fuera a equipo', async () => {
    // equipo no llega ni a excluirRoles (protect lo frena antes); ventas sí.
    assert.equal((await pedir(s, 'GET', '/api/v1/metricas', { token: T.ventas })).status, 403);
    const mw = excluirRoles('ventas');
    let st = null;
    await mw({ sessionUser: { id_sub_usuario: 3 } }, { status: (c) => ((st = c), { json: () => {} }) }, () => (st = 'next'));
    assert.equal(st, 403);
  });
  await caso('excluirRoles(administrador) no agrega equipo de más', async () => {
    const mw = excluirRoles('administrador');
    let st = null;
    await mw({ sessionUser: { id_sub_usuario: 3 } }, { status: (c) => ((st = c), { json: () => {} }) }, () => (st = 'next'));
    assert.equal(st, 'next');
  });

  console.log('Canal en vivo');
  await caso('cerradoParaEquipo', () => {
    assert.equal(cerradoParaEquipo({ origen: 'team' }, { rol: 'ventas' }), true);
    assert.equal(cerradoParaEquipo({ rol: 'ventas' }, { rol: 'equipo' }), true);
    assert.equal(cerradoParaEquipo({ rol: 'equipo' }, null), true);
    assert.equal(cerradoParaEquipo({ rol: 'equipo' }, { rol: 'ventas' }), false);
    assert.equal(cerradoParaEquipo({ rol: 'ventas' }, null), false);
  });

  console.log('Asignar el rol');
  await caso('puedeTenerRolEquipo lee ROL_EQUIPO_CUENTAS', () => {
    assert.equal(puedeTenerRolEquipo(254), true);
    assert.equal(puedeTenerRolEquipo('254'), true);
    assert.equal(puedeTenerRolEquipo(77), false);
  });
  await caso('ROL_EQUIPO_CUENTAS vacío: ninguna cuenta', () => {
    process.env.ROL_EQUIPO_CUENTAS = '';
    const r = puedeTenerRolEquipo(254);
    process.env.ROL_EQUIPO_CUENTAS = '254';
    assert.equal(r, false);
  });
  await caso('crear un equipo en cuenta no habilitada → 403; en la 254 sí', async () => {
    await assert.rejects(
      crearSubUsuario({ id_usuario: 77, usuario: 'u', password: 'x', email: 'e', nombre_encargado: 'n', rol: 'equipo' }),
      (e) => e.statusCode === 403,
    );
    const ok = await crearSubUsuario({ id_usuario: 254, usuario: 'u', password: 'x', email: 'e', nombre_encargado: 'n', rol: 'equipo' });
    assert.equal(ok.rol, 'equipo');
  });
  await caso('cambiar a equipo en cuenta no habilitada → 403', async () => {
    await assert.rejects(
      actualizarSubUsuario({ id_sub_usuario: 1, usuario: 'u', email: 'e', nombre_encargado: 'n', rol: 'equipo' }),
      (e) => e.statusCode === 403,
    );
  });

  console.log('POST /equipo/sesion');
  delete process.env.TEAM_EQUIPO_TOKEN;
  await caso('sin TEAM_EQUIPO_TOKEN configurado → 503', async () => {
    assert.equal((await pedir(s, 'POST', '/api/v1/equipo/sesion', { token: 'x', cuerpo: { id_sub_usuario: 3 } })).status, 503);
  });
  process.env.TEAM_EQUIPO_TOKEN = 'corto';
  await caso('TEAM_EQUIPO_TOKEN de menos de 32 caracteres → 503 (cerrada)', async () => {
    assert.equal((await pedir(s, 'POST', '/api/v1/equipo/sesion', { token: 'corto', cuerpo: { id_sub_usuario: 3 } })).status, 503);
  });
  process.env.TEAM_EQUIPO_TOKEN = SECRETO;
  await caso('token de Team equivocado → 401', async () => {
    assert.equal((await pedir(s, 'POST', '/api/v1/equipo/sesion', { token: 'otro', cuerpo: { id_sub_usuario: 3 } })).status, 401);
  });
  await caso('ventas, cuenta no habilitada, suspendido o inexistente → 403', async () => {
    for (const id of [1, 4, 5, 999]) {
      const r = await pedir(s, 'POST', '/api/v1/equipo/sesion', { token: SECRETO, cuerpo: { id_sub_usuario: id } });
      assert.equal(r.status, 403, 'id ' + id);
    }
  });
  await caso('equipo de la 254 → token de Team que funciona en /equipo/yo', async () => {
    const r = await pedir(s, 'POST', '/api/v1/equipo/sesion', {
      cabeceras: { 'x-team-token': SECRETO },
      cuerpo: { id_sub_usuario: 3, team_usuario: 'prueba' },
    });
    assert.equal(r.status, 200);
    const d = jwt.decode(r.body.token);
    assert.equal(d.origen, 'team');
    assert.equal(d.iss, 'chatcenter');
    assert.equal(d.aud, 'team');
    assert.equal(d.team_usuario, 'prueba');
    assert.ok(d.exp - d.iat <= 8 * 3600);
    assert.equal((await pedir(s, 'GET', '/api/v1/equipo/yo', { token: r.body.token })).status, 200);
    assert.equal((await pedir(s, 'GET', '/api/v1/chats', { token: r.body.token })).status, 403);
  });
  await caso('«Ver como» pide sesión de solo lectura: el token lo lleva; sin pedirlo, no', async () => {
    const r = await pedir(s, 'POST', '/api/v1/equipo/sesion', {
      cabeceras: { 'x-team-token': SECRETO },
      cuerpo: { id_sub_usuario: 3, team_usuario: 'silla 1 (ver como 2)', solo_lectura: true },
    });
    assert.equal(r.status, 200);
    assert.equal(jwt.decode(r.body.token).solo_lectura, true);
    const r2 = await pedir(s, 'POST', '/api/v1/equipo/sesion', {
      cabeceras: { 'x-team-token': SECRETO },
      cuerpo: { id_sub_usuario: 3, solo_lectura: 'true' }, // solo el booleano cuenta
    });
    assert.equal(jwt.decode(r2.body.token).solo_lectura, undefined);
  });

  console.log('Prueba sin cambiar el rol (ROL_EQUIPO_PRUEBA_SUBS)');
  const sesionDe = (id) =>
    pedir(s, 'POST', '/api/v1/equipo/sesion', { cabeceras: { 'x-team-token': SECRETO }, cuerpo: { id_sub_usuario: id } });
  let tPrueba = null;
  await caso('ventas de prueba de la 254 → sesión de Team', async () => {
    const r = await sesionDe(7);
    assert.equal(r.status, 200);
    tPrueba = r.body.token;
    assert.equal(jwt.decode(tPrueba).origen, 'team');
    const yo = await pedir(s, 'GET', '/api/v1/equipo/yo', { token: tPrueba });
    assert.equal(yo.status, 200);
    assert.equal(yo.body.data.rol, 'ventas');
  });
  await caso('con la sesión de Team le llega tapado', async () => {
    const r = await pedir(s, 'GET', '/api/v1/equipo/_datos', { token: tPrueba });
    assert.equal(r.body.celular_cliente, '•••• 4567');
  });
  await caso('con la sesión de Team, rutas viejas → 403', async () => {
    const r = await pedir(s, 'GET', '/api/v1/chats', { token: tPrueba });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'EQUIPO_RUTA_NO_PERMITIDA');
  });
  await caso('con la sesión de Team, ruta A1 sin sesión → 403', async () => {
    const r = await pedir(s, 'GET', '/api/v1/whatsapp_managment/programados_por_config', { token: tPrueba });
    assert.equal(r.status, 403);
  });
  await caso('con la sesión de Team no entra al canal en vivo', () => {
    assert.equal(cerradoParaEquipo(jwt.decode(tPrueba), SUBS[7]), true);
  });
  await caso('con su token de login sigue igual: ve el número y entra al socket', async () => {
    const tLogin = firmar({ id_sub_usuario: 7, rol: 'ventas' });
    const r = await pedir(s, 'GET', '/api/v1/chats', { token: tLogin });
    assert.equal(r.status, 200);
    assert.equal(r.body.celular_cliente, CEL);
    assert.equal(cerradoParaEquipo(jwt.decode(tLogin), SUBS[7]), false);
  });
  await caso('con su token de login, las rutas de Team → 403 SOLO_EQUIPO', async () => {
    const r = await pedir(s, 'GET', '/api/v1/equipo/yo', { token: firmar({ id_sub_usuario: 7, rol: 'ventas' }) });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'SOLO_EQUIPO');
  });
  await caso('ventas de prueba de una cuenta no habilitada → 403', async () => {
    assert.equal((await sesionDe(8)).status, 403);
  });
  await caso('ventas fuera de la lista sigue sin sesión de Team', async () => {
    assert.equal((await sesionDe(1)).status, 403);
  });
  await caso('sacarlo de la lista corta la sesión viva', async () => {
    process.env.ROL_EQUIPO_PRUEBA_SUBS = '8';
    const r = await pedir(s, 'GET', '/api/v1/equipo/yo', { token: tPrueba });
    process.env.ROL_EQUIPO_PRUEBA_SUBS = '7,8';
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'EQUIPO_SOLO_TEAM');
    assert.equal((await pedir(s, 'GET', '/api/v1/equipo/yo', { token: tPrueba })).status, 200);
  });
  await caso('sacar la cuenta también la corta', async () => {
    process.env.ROL_EQUIPO_CUENTAS = '';
    const r = await pedir(s, 'GET', '/api/v1/equipo/yo', { token: tPrueba });
    process.env.ROL_EQUIPO_CUENTAS = '254';
    assert.equal(r.status, 401);
  });
  await caso('renew e issue-imporsuit-token no canjean una sesión de Team', async () => {
    // auth.controller crea clientes de servicios al cargarse: llaves de mentira.
    for (const k of ['OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'RESEND_API_KEY']) process.env[k] = process.env[k] || 'llave-de-prueba';
    const auth = require(path.join(SRC, 'controllers/auth.controller'));
    for (const fn of [auth.renew, auth.issueImporsuitToken]) {
      let st = null;
      let cuerpo = null;
      const res = { status: (c) => ((st = c), { json: (b) => (cuerpo = b) }) };
      await fn({ sesionTeam: true, sessionUser: { ...SUBS[7], email: 'e', usuario: 'u' } }, res, (e) => (st = e));
      assert.equal(st, 403);
      assert.equal(cuerpo.code, 'EQUIPO_SOLO_TEAM');
    }
  });
  await caso('ROL_EQUIPO_PRUEBA_SUBS vacío: nadie de prueba', async () => {
    process.env.ROL_EQUIPO_PRUEBA_SUBS = '';
    const r = await sesionDe(7);
    process.env.ROL_EQUIPO_PRUEBA_SUBS = '7,8';
    assert.equal(r.status, 403);
  });

  s.close();
  console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
  process.exit(fallos ? 1 : 0);
})();
