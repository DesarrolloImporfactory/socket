/*  Prueba del chat de Team (rutas de lectura de /api/v1/equipo/) y de los
 *  filtros de findChats, sin base de datos: db.query se reemplaza y se mira
 *  el SQL que se habría mandado. Números inventados.
 *    node scripts/probar_chats_equipo.js
 */
const path = require('path');
const http = require('http');
const assert = require('assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const { Sequelize } = require('sequelize');

process.env.SECRET_JWT_SEED = 'semilla-de-prueba';
process.env.ROL_EQUIPO_CUENTAS = '254';
delete process.env.RUTAS_SESION_EXIGIR;
const SRC = path.join(__dirname, '..', 'src');
const CEL = '593991234567';
const CEL_US = '13055550142';

// Base falsa: Sequelize real (los modelos se definen) pero sin conectar.
const falsa = () => new Sequelize('mysql://x:y@127.0.0.1:9/z', { logging: false });
const db = falsa();
const db_2 = falsa();
let consultas = [];
function responder(sql, opts) {
  const r = opts?.replacements;
  if (/FROM configuraciones\s+WHERE id = \? AND id_usuario = \?/.test(sql)) {
    return Number(r[0]) === 265 && Number(r[1]) === 254 ? [{ id: 265, nombre_configuracion: 'Línea 265' }] : [];
  }
  if (/FROM configuraciones\s+WHERE id_usuario = \?/.test(sql)) {
    return Number(r[0]) === 254 ? [{ id: 265, nombre_configuracion: 'Línea 265' }] : [];
  }
  if (/FROM vista_chats/.test(sql)) {
    return [{ id: 11, celular_cliente: CEL, nombre_cliente: 'Ana', texto_mensaje: 'mi cel 0991234567', mensaje_created_at: '2026-10-24 10:00:00' }];
  }
  if (/FROM clientes_chat_center\s+WHERE id = \?/.test(sql)) {
    if (Number(r[0]) === 11) return [{ id: 11, celular_cliente: CEL }];
    if (Number(r[0]) === 13) return [{ id: 13, celular_cliente: CEL_US }];
    return [];
  }
  if (/FROM mensajes_clientes/.test(sql)) {
    // Como la base: del más nuevo al más viejo.
    return [
      { id: 3, rol_mensaje: 1, tipo_mensaje: 'text', texto_mensaje: 'te escribo al 305 555 0142', responsable: 'Front 1', created_at: '2026-10-24 10:02:00' },
      { id: 2, rol_mensaje: 0, tipo_mensaje: 'text', texto_mensaje: 'hola, mi número es 099 123 4567', created_at: '2026-10-24 10:00:00' },
    ];
  }
  if (/FROM appointments a/.test(sql)) {
    return [{ id: 7, title: 'Reunión con Ana 0991234567', status: 'Agendado', start_utc: '2026-10-27 15:00:00', end_utc: '2026-10-27 15:30:00', meeting_url: 'https://meet.google.com/abc-defg-hij' }];
  }
  return [];
}
db.query = async (sql, opts) => {
  consultas.push({ sql, opts });
  return responder(sql, opts);
};
db_2.query = async () => [];
const dbf = require.resolve(path.join(SRC, 'database/config'));
require.cache[dbf] = { id: dbf, filename: dbf, loaded: true, exports: { db, db_2 } };

const SUBS = {
  1: { id_sub_usuario: 1, id_usuario: 9, rol: 'administrador', suspendido: 0 },
  3: { id_sub_usuario: 3, id_usuario: 254, rol: 'equipo', suspendido: 0, nombre_encargado: 'E' },
};
const sv = require.resolve(path.join(SRC, 'utils/sesionVigente'));
require.cache[sv] = {
  id: sv,
  filename: sv,
  loaded: true,
  exports: {
    sesionVigente: async (d) => {
      const u = SUBS[Number(d.id_sub_usuario)];
      return u ? { ok: true, code: null, user: { ...u } } : { ok: false, code: 'USER_NOT_FOUND', user: null };
    },
  },
};

// Modelos que findChats / getChatsByClient usan directo.
const Configuraciones = require(path.join(SRC, 'models/configuraciones.model'));
Configuraciones.findOne = async () => ({ telefono: '1' });
const ClientesChatCenter = require(path.join(SRC, 'models/clientes_chat_center.model'));
ClientesChatCenter.findAll = async () => [
  {
    celular_cliente: CEL,
    toJSON: () => ({
      id: 11,
      celular_cliente: CEL,
      nombre_cliente: 'Ana',
      mensajes: [
        { id: 1, texto_mensaje: 'hola, mi número es 099 123 4567', id_wamid_mensaje: 'wamid.HBgMNTkz', json_mensaje: JSON.stringify({ from: CEL, id: 'wamid.Q' }) },
      ],
    }),
  },
];
require(path.join(SRC, 'models/plataforma.model')).findAll = async () => [];
let vistosMarcados = 0;
require(path.join(SRC, 'models/mensaje_cliente.model')).update = async () => {
  vistosMarcados += 1;
  return [1];
};

// La lectura de la carga es la del bot de la línea; aquí se reemplaza para ver
// qué número recibe y que lo que vuelve salga sin teléfonos.
const cargaCliente = require(path.join(SRC, 'utils/soporteExpertos/cargaCliente'));
const cargasReal = cargaCliente.cargasDelTelefono;
let cargaStub = null;
let telefonoPedido = null;
cargaCliente.cargasDelTelefono = async (tel, o) => {
  telefonoPedido = tel;
  return cargaStub ? cargaStub(tel) : cargasReal(tel, o);
};

const ChatService = require(path.join(SRC, 'services/chat.service'));
const rutas = require(path.join(SRC, 'middlewares/rutasSinSesion'));
const equipoRouter = require(path.join(SRC, 'routes/equipo.routes'));
const errorHandler = require(path.join(SRC, 'controllers/error.controller'));

const firmar = (p) => jwt.sign(p, process.env.SECRET_JWT_SEED, { expiresIn: '1h' });
const TEAM = jwt.sign({ id_sub_usuario: 3, rol: 'equipo', origen: 'team' }, process.env.SECRET_JWT_SEED, { expiresIn: '1h', issuer: 'chatcenter', audience: 'team' });
const ADMIN = firmar({ id_sub_usuario: 1, rol: 'administrador' });

function app() {
  const a = express();
  a.use(rutas.vigilar);
  a.use('/api/v1/equipo', equipoRouter);
  a.use(errorHandler);
  return new Promise((ok) => {
    const s = a.listen(0, () => ok(s));
  });
}
function pedir(s, ruta, token) {
  return new Promise((ok, mal) => {
    const req = http.request(
      { host: '127.0.0.1', port: s.address().port, method: 'GET', path: ruta, headers: token ? { authorization: 'Bearer ' + token } : {} },
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
    req.end();
  });
}
const sqlChats = () => consultas.filter((c) => /FROM vista_chats/.test(c.sql)).pop();

let fallos = 0;
async function caso(nombre, fn) {
  try {
    consultas = [];
    await fn();
    console.log('  ok  ', nombre);
  } catch (e) {
    fallos += 1;
    console.log('  FALLA', nombre, '—', e.message);
  }
}

(async () => {
  const silenciar = console.log;
  const s = await app();

  console.log('findChats: filtros que llegan del cliente');
  await caso('etiqueta con SQL dentro se ignora; la entera queda igual que antes', async () => {
    await new ChatService().findChats(265, 1, 'administrador', {
      filtros: { selectedEtiquetas: [{ value: "1}', '$') OR 1=1 -- " }, { value: 5 }, { value: '7' }] },
    });
    const q = sqlChats();
    assert.ok(!/OR 1=1/.test(q.sql), q.sql);
    assert.ok(q.sql.includes(`JSON_CONTAINS(etiquetas, '{"id": 5}', '$') AND JSON_CONTAINS(etiquetas, '{"id": 7}', '$')`), q.sql);
  });
  await caso('estado del contacto va como valor, no pegado', async () => {
    await new ChatService().findChats(265, 1, 'administrador', {
      filtros: { selectedEstado_contacto: { value: "x' OR '1'='1" } },
    });
    const q = sqlChats();
    assert.ok(q.sql.includes('estado_db = :estadoContacto'), q.sql);
    assert.ok(!q.sql.includes("'1'='1"), q.sql);
    assert.equal(q.opts.replacements.estadoContacto, "x' OR '1'='1");
  });
  await caso('sin etiquetas válidas no se agrega la condición', async () => {
    await new ChatService().findChats(265, 1, 'administrador', { filtros: { selectedEtiquetas: [{ value: 'a' }] } });
    assert.ok(!sqlChats().sql.includes('JSON_CONTAINS'));
  });

  console.log('Rutas de Team');
  await caso('un administrador no usa las rutas de Team (403 SOLO_EQUIPO)', async () => {
    const r = await pedir(s, '/api/v1/equipo/conexiones', ADMIN);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'SOLO_EQUIPO');
  });
  await caso('conexiones: solo las de su cuenta, sin el número', async () => {
    const r = await pedir(s, '/api/v1/equipo/conexiones', TEAM);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data, [{ id: 265, nombre_configuracion: 'Línea 265' }]);
    assert.equal(consultas[0].opts.replacements[0], 254);
  });
  await caso('chats: sus chats, con el teléfono tapado', async () => {
    const r = await pedir(s, '/api/v1/equipo/chats?id_configuracion=265', TEAM);
    assert.equal(r.status, 200);
    assert.equal(r.body.data[0].celular_cliente, '•••• 4567');
    assert.ok(!r.texto.includes('0991234567') && !r.texto.includes(CEL), r.texto);
    const q = sqlChats();
    assert.ok(q.sql.includes('id_encargado = :id_sub_usuario'), q.sql);
    assert.equal(q.opts.replacements.id_sub_usuario, 3);
  });
  await caso('chats en espera: los sin encargado', async () => {
    await pedir(s, '/api/v1/equipo/chats?id_configuracion=265&scope=espera', TEAM);
    assert.ok(sqlChats().sql.includes('id_encargado IS NULL'));
  });
  await caso('un admin de prueba en Team ve solo lo suyo, no la línea entera', async () => {
    SUBS[2] = { id_sub_usuario: 2, id_usuario: 254, rol: 'administrador', suspendido: 0 };
    process.env.ROL_EQUIPO_PRUEBA_SUBS = '2';
    const t = jwt.sign({ id_sub_usuario: 2, rol: 'administrador', origen: 'team' }, process.env.SECRET_JWT_SEED, { expiresIn: '1h', issuer: 'chatcenter', audience: 'team' });
    const r = await pedir(s, '/api/v1/equipo/chats?id_configuracion=265', t);
    delete process.env.ROL_EQUIPO_PRUEBA_SUBS;
    delete SUBS[2];
    assert.equal(r.status, 200);
    const q = sqlChats();
    assert.ok(q.sql.includes('id_encargado = :id_sub_usuario'), q.sql);
    assert.equal(q.opts.replacements.id_sub_usuario, 2);
  });
  await caso('conexión de otra cuenta → 404 y no consulta chats', async () => {
    const r = await pedir(s, '/api/v1/equipo/chats?id_configuracion=999', TEAM);
    assert.equal(r.status, 404);
    assert.equal(sqlChats(), undefined);
  });
  await caso('buscar por número no se manda; por nombre sí', async () => {
    await pedir(s, '/api/v1/equipo/chats?id_configuracion=265&q=0991', TEAM);
    assert.ok(!sqlChats().sql.includes(':searchTerm'));
    await pedir(s, '/api/v1/equipo/chats?id_configuracion=265&q=09%259%25', TEAM);
    assert.ok(!sqlChats().sql.includes(':searchTerm'));
    await pedir(s, '/api/v1/equipo/chats?id_configuracion=265&q=an_', TEAM);
    assert.ok(!sqlChats().sql.includes(':searchTerm'));
    await pedir(s, '/api/v1/equipo/chats?id_configuracion=265&q=ana', TEAM);
    assert.ok(sqlChats().sql.includes(':searchTerm'));
  });
  await caso('límite de 30 y filtros de más ignorados', async () => {
    await pedir(s, '/api/v1/equipo/chats?id_configuracion=265&limit=500&selectedEtiquetas=1', TEAM);
    const q = sqlChats();
    assert.equal(q.opts.replacements.limit, 30);
    assert.ok(!q.sql.includes('JSON_CONTAINS'));
  });
  await caso('mensajes de un chat visible: tapados, en orden y con tope', async () => {
    const r = await pedir(s, '/api/v1/equipo/chats/11/mensajes?id_configuracion=265', TEAM);
    assert.equal(r.status, 200);
    assert.ok(!r.texto.includes('wamid'), r.texto);
    assert.ok(!r.texto.includes('099 123 4567') && !r.texto.includes(CEL) && r.texto.includes('•••• 4567'), r.texto);
    assert.deepEqual(r.body.data[0].mensajes.map((m) => m.id), [2, 3]);
    const q = consultas.filter((c) => /FROM mensajes_clientes/.test(c.sql)).pop();
    assert.ok(/LIMIT 200\b/.test(q.sql), q.sql);
    assert.deepEqual(q.opts.replacements, ['11', 265]);
  });
  await caso('abrir un chat desde Team no lo marca como leído', async () => {
    vistosMarcados = 0;
    await pedir(s, '/api/v1/equipo/chats/11/mensajes?id_configuracion=265', TEAM);
    assert.equal(vistosMarcados, 0);
    assert.ok(!consultas.some((c) => /UPDATE\s+mensajes_clientes/i.test(c.sql)));
  });
  await caso('el número del chat en otro formato también sale tapado', async () => {
    const r = await pedir(s, '/api/v1/equipo/chats/13/mensajes?id_configuracion=265', TEAM);
    assert.equal(r.status, 200);
    assert.ok(!r.texto.includes('305 555 0142') && r.texto.includes('•••• 0142'), r.texto);
  });
  await caso('mensajes de un chat que no es suyo → 404', async () => {
    assert.equal((await pedir(s, '/api/v1/equipo/chats/12/mensajes?id_configuracion=265', TEAM)).status, 404);
  });
  await caso('mensajes con la conexión de otra cuenta → 404', async () => {
    assert.equal((await pedir(s, '/api/v1/equipo/chats/11/mensajes?id_configuracion=999', TEAM)).status, 404);
  });

  console.log('Barra lateral de Team');
  await caso('agenda: solo las suyas de esa línea, con Meet y sin teléfono', async () => {
    const r = await pedir(s, '/api/v1/equipo/agenda?id_configuracion=265', TEAM);
    assert.equal(r.status, 200);
    const q = consultas.find((c) => /FROM appointments a/.test(c.sql));
    assert.ok(q.sql.includes('a.assigned_user_id = ?') && q.sql.includes('c.account_id = ?'), q.sql);
    assert.deepEqual(q.opts.replacements, [265, 3]);
    assert.ok(!/0991234567/.test(r.texto), r.texto);
    assert.equal(r.body.data[0].meeting_url, 'https://meet.google.com/abc-defg-hij');
  });
  await caso('agenda con la conexión de otra cuenta → 404 y no consulta', async () => {
    const r = await pedir(s, '/api/v1/equipo/agenda?id_configuracion=999', TEAM);
    assert.equal(r.status, 404);
    assert.ok(!consultas.some((c) => /FROM appointments a/.test(c.sql)));
  });
  await caso('carga: se busca por el número del chat y vuelve sin él', async () => {
    telefonoPedido = null;
    cargaStub = async () => ({
      estado: 'encontradas',
      hay_mas: 0,
      cargas: [{ id_cotizacion: 4512, destino: 'Ecuador', marcas: ['ANA22'], paso: 4, paso_nombre: 'En tránsito', entregada: false, parcial: false, contenedor: 'MSKU1234567', fecha_estimada_texto: '12 de noviembre', estimada_vencida: false, marcas_pendientes: [], nota_cliente: 'Llamar al 0991234567', informable: true, motivo: null, texto_cliente: 'Hola 593991234567', telefono: CEL }],
    });
    const r = await pedir(s, '/api/v1/equipo/chats/11/carga?id_configuracion=265', TEAM);
    cargaStub = null;
    assert.equal(r.status, 200);
    assert.equal(telefonoPedido, CEL);
    assert.equal(r.body.data.cargas[0].paso, 4);
    assert.equal(r.body.data.cargas[0].texto_cliente, undefined);
    assert.ok(!r.texto.includes(CEL) && !r.texto.includes('0991234567'), r.texto);
  });
  await caso('carga: la nota con el número del chat en otro formato sale tapada', async () => {
    cargaStub = async () => ({ estado: 'encontradas', hay_mas: 0, cargas: [{ id_cotizacion: 1, paso: 2, nota_cliente: 'Escribió desde 305 555 0142', informable: true }] });
    const r = await pedir(s, '/api/v1/equipo/chats/13/carga?id_configuracion=265', TEAM);
    cargaStub = null;
    assert.equal(r.status, 200);
    assert.equal(r.body.data.cargas[0].nota_cliente, 'Escribió desde •••• 0142');
  });
  await caso('carga sin nada en Imporsuit: dice el estado, no falla', async () => {
    const r = await pedir(s, '/api/v1/equipo/chats/11/carga?id_configuracion=265', TEAM);
    assert.equal(r.status, 200);
    assert.ok(typeof r.body.data.estado === 'string' && r.body.data.estado !== 'encontradas', r.texto);
  });
  await caso('carga de un chat que no es suyo → 404 y no busca', async () => {
    telefonoPedido = null;
    assert.equal((await pedir(s, '/api/v1/equipo/chats/12/carga?id_configuracion=265', TEAM)).status, 404);
    assert.equal(telefonoPedido, null);
  });
  await caso('un administrador no usa la agenda de Team', async () => {
    assert.equal((await pedir(s, '/api/v1/equipo/agenda?id_configuracion=265', ADMIN)).status, 403);
  });

  console.log = silenciar;
  s.close();
  console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
  process.exit(fallos ? 1 : 0);
})();
