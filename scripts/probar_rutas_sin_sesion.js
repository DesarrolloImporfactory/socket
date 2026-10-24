/*  Prueba de middlewares/rutasSinSesion.js, sin base de datos.
 *
 *  sesionVigente se reemplaza por un doble (sub-usuario 1 vigente, 2
 *  suspendido) para probar el camino de un token válido sin tocar la base.
 *  Uso (desde la raíz del proyecto, con node_modules):
 *    node scripts/probar_rutas_sin_sesion.js
 */
const path = require('path');
const http = require('http');
const assert = require('assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.SECRET_JWT_SEED = process.env.SECRET_JWT_SEED_PRUEBA || 'semilla-de-prueba';
const SRC = path.join(__dirname, '..', 'src');

// Dobles: sin base, sin modelos.
function doble(rel, exportsObj) {
  const f = require.resolve(path.join(SRC, rel));
  require.cache[f] = { id: f, filename: f, loaded: true, exports: exportsObj };
}
doble('utils/sesionVigente', {
  sesionVigente: async (d) =>
    Number(d.id_sub_usuario) === 1
      ? { ok: true, user: { id_sub_usuario: 1, id_usuario: 9 } }
      : { ok: false, code: 'USER_SUSPENDED' },
});
doble('models/configuraciones.model', {});
doble('database/config', { db: {}, db_2: {} });

function cargar(exigir) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('rutasSinSesion') || k.includes('auth.middleware')) delete require.cache[k];
  }
  if (exigir === undefined) delete process.env.RUTAS_SESION_EXIGIR;
  else process.env.RUTAS_SESION_EXIGIR = exigir;
  return require(path.join(SRC, 'middlewares/rutasSinSesion'));
}

function servidor(mod) {
  const app = express();
  app.use(mod.vigilar);
  app.all('*', (req, res) => res.json({ paso: true, user: req.sessionUser || null }));
  return new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
}

function pedir(s, metodo, ruta, token) {
  return new Promise((ok, mal) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: s.address().port,
        method: metodo,
        path: ruta,
        headers: Object.assign(
          { 'user-agent': 'prueba/1.0' },
          token ? { authorization: 'Bearer ' + token } : {},
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
          ok({ status: res.statusCode, body: j });
        });
      },
    );
    req.on('error', mal);
    req.end();
  });
}

const R_A1 = '/api/v1/whatsapp_managment/programados_por_config';
const R_A3 = '/api/v1/whatsapp_managment/obtenerTemplatesWhatsapp';
const R_PUB = '/api/v1/whatsapp/webhook';

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
  const valido = jwt.sign({ id_sub_usuario: 1 }, process.env.SECRET_JWT_SEED, { expiresIn: '1h' });
  const suspendido = jwt.sign({ id_sub_usuario: 2 }, process.env.SECRET_JWT_SEED, { expiresIn: '1h' });
  const vencido = jwt.sign({ id_sub_usuario: 1, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.SECRET_JWT_SEED);

  // ---------- reglas ----------
  let mod = cargar();
  console.log('Reglas');
  await caso('A1 y A3 están en el archivo', () => {
    assert.ok(mod.REGLAS.some((r) => r.lote === 'A1'));
    assert.ok(mod.REGLAS.some((r) => r.lote === 'A3'));
  });
  await caso('ninguna regla cubre un webhook o el login', () => {
    assert.equal(mod.buscar('POST', R_PUB), null);
    assert.equal(mod.buscar('POST', '/api/v1/auth/login'), null);
    assert.equal(mod.buscar('POST', '/api/v1/dropi_webhook/orders'), null);
  });
  await caso('mayúsculas, barra final, HEAD y %xx no esquivan', () => {
    assert.equal(mod.buscar('GET', R_A1.toUpperCase()).lote, 'A1');
    assert.equal(mod.buscar('GET', R_A1 + '/').lote, 'A1');
    assert.equal(mod.buscar('HEAD', R_A1).lote, 'A1');
    assert.equal(mod.buscar('GET', R_A1.replace('programados', '%70rogramados')).lote, 'A1');
  });
  await caso('otro método no se confunde', () => {
    assert.equal(mod.buscar('DELETE', R_A1), null);
  });
  await caso('una ruta fija gana a una con parámetro', () => {
    const r = mod.buscar('POST', '/api/v1/cotizaciones/crm/registrarMensaje');
    assert.ok(r && !r.ruta.includes(':'), 'tomó ' + (r && r.ruta));
  });
  await caso('exigidos lee la variable', () => {
    assert.deepEqual([...mod.exigidos(' a1, A2 ,')], ['A1', 'A2']);
    assert.equal(mod.exigidos('').size, 0);
  });
  await caso('clasificar', () => {
    assert.equal(mod.clasificar(undefined), 'TOKEN_MISSING');
    assert.equal(mod.clasificar('Bearer '), 'TOKEN_MISSING');
    assert.equal(mod.clasificar('Bearer basura'), 'TOKEN_INVALID');
    assert.equal(mod.clasificar('Bearer ' + vencido), 'TOKEN_EXPIRED');
    assert.equal(mod.clasificar('Bearer ' + valido), null);
  });

  // ---------- sombra ----------
  console.log('Sombra (sin RUTAS_SESION_EXIGIR)');
  let s = await servidor(mod);
  await caso('sin token pasa igual', async () => {
    assert.equal((await pedir(s, 'GET', R_A1)).status, 200);
  });
  await caso('con token válido pasa', async () => {
    assert.equal((await pedir(s, 'GET', R_A1, valido)).status, 200);
  });
  s.close();

  // ---------- exigir A1 ----------
  console.log('Exigir A1');
  mod = cargar('A1');
  s = await servidor(mod);
  await caso('A1 sin token → 401 TOKEN_MISSING', async () => {
    const r = await pedir(s, 'GET', R_A1);
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'TOKEN_MISSING');
  });
  await caso('A1 en mayúsculas sin token → 401', async () => {
    assert.equal((await pedir(s, 'GET', R_A1.toUpperCase())).status, 401);
  });
  await caso('A1 token basura → 401 TOKEN_INVALID', async () => {
    assert.equal((await pedir(s, 'GET', R_A1, 'basura')).body.code, 'TOKEN_INVALID');
  });
  await caso('A1 token vencido → 401 TOKEN_EXPIRED', async () => {
    assert.equal((await pedir(s, 'GET', R_A1, vencido)).body.code, 'TOKEN_EXPIRED');
  });
  await caso('A1 suspendido → 401 USER_SUSPENDED', async () => {
    assert.equal((await pedir(s, 'GET', R_A1, suspendido)).body.code, 'USER_SUSPENDED');
  });
  await caso('A1 token válido → pasa con sessionUser', async () => {
    const r = await pedir(s, 'GET', R_A1, valido);
    assert.equal(r.status, 200);
    assert.equal(r.body.user.id_sub_usuario, 1);
  });
  await caso('A3 sin token sigue pasando', async () => {
    assert.equal((await pedir(s, 'POST', R_A3)).status, 200);
  });
  await caso('webhook sin token sigue pasando', async () => {
    assert.equal((await pedir(s, 'POST', R_PUB)).status, 200);
  });
  s.close();

  console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
  process.exit(fallos ? 1 : 0);
})();
