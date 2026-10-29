/*  Prueba del chat de Team (rutas de lectura de /api/v1/equipo/) y de los
 *  filtros de findChats, sin base de datos: db.query se reemplaza y se mira
 *  el SQL que se habría mandado. Números inventados.
 *    node scripts/probar_chats_equipo.js
 */
const path = require('path');
// Fecha de chat_center (hora de Ecuador, sin zona) de hace N minutos.
const ec = (min) => new Date(Date.now() - 5 * 3600e3 - min * 60e3).toISOString().slice(0, 19).replace('T', ' ');
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
let ventanaAbierta = true; // ¿el cliente escribió en las últimas 24 h?
let alguienLoMovio = false; // ¿otro asesor movió el chat antes del UPDATE?
let yaCerrado = false; // ¿otro asesor lo cerró antes?
let plantillaReciente = false; // ¿ya se le mandó la información hace minutos?
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
  // Bandeja: 21 y 23 esperan a una persona, 22 espera al cliente; 30 y 31 con
  // bot; 32 con bot pero el bot lo pasó; 24 sin bot y quieto hace 20 días.
  // 33, 34 y 35 con bot: en 33 y 34 un asesor escribió después del bot (33: el
  // cliente volvió a escribir; 34: no); en 35 el bot contestó después del asesor.
  if (/c\.bot_openia = 0\s+ORDER BY/.test(sql)) {
    return [21, 22, 23, 24].map((id) => ({ id, nombre_cliente: `Cliente ${id}`, celular_cliente: CEL, source: 'wa', id_encargado: id === 21 ? 3 : null }));
  }
  if (/ORDER BY ult_cliente DESC/.test(sql)) return [{ id: '31' }, { id: '30' }, { id: '35' }, { id: '33' }, { id: '34' }, { id: '32' }, { id: '99' }];
  if (/c\.bot_openia = 1 AND c\.id IN/.test(sql)) {
    return [30, 31, 32, 33, 34, 35].map((id) => ({ id, nombre_cliente: `Cliente ${id}`, celular_cliente: CEL, source: 'wa', id_encargado: null }));
  }
  if (/AS ult_persona/.test(sql)) {
    return [
      // 21 y 22 llegan como Date, igual que db.query en producción (medido el 26-oct).
      { id: '21', ult_cliente: new Date(Date.now() - 55 * 60e3), ult_persona: new Date(Date.now() - 60 * 60e3), ult_id: 121 },
      { id: '22', ult_cliente: new Date(Date.now() - 120 * 60e3), ult_persona: new Date(Date.now() - 90 * 60e3), ult_id: 122 },
      { id: '23', ult_cliente: ec(180), ult_persona: null, ult_id: 123 },
      { id: '24', ult_cliente: ec(20 * 1440), ult_persona: null, ult_id: 124 },
      { id: '30', ult_cliente: ec(50), ult_persona: null, ult_id: 130 },
      { id: '31', ult_cliente: ec(20), ult_persona: null, ult_id: 131 },
      { id: '32', ult_cliente: ec(15), ult_persona: null, ult_id: 132, ult_bot_id: 132 },
      { id: '33', ult_cliente: new Date(Date.now() - 20 * 60e3), ult_persona: new Date(Date.now() - 40 * 60e3), ult_id: 133, ult_bot_id: 233 },
      { id: '34', ult_cliente: new Date(Date.now() - 30 * 60e3), ult_persona: new Date(Date.now() - 10 * 60e3), ult_id: 134, ult_bot_id: 234 },
      { id: '35', ult_cliente: new Date(Date.now() - 20 * 60e3), ult_persona: new Date(Date.now() - 120 * 60e3), ult_id: 135, ult_bot_id: 235 },
    ];
  }
  if (/SELECT id, celular_recibe, tipo_mensaje/.test(sql)) {
    const hace = { 133: 20, 134: 10, 135: 20, 233: 90, 234: 90, 235: 60 };
    return r[0].map((id) => ({ id, celular_recibe: String(id % 100), tipo_mensaje: 'text', texto_mensaje: id === 132 ? 'Listo, un asesor te escribe en un momento.' : `último de ${id % 100}, llámame al 0991234567`, created_at: hace[id] ? new Date(Date.now() - hace[id] * 60e3) : '2026-10-26 11:00:00' }));
  }
  if (/AS desde/.test(sql)) {
    return [{ id: '21', desde: '2026-10-26 10:01:00' }, { id: '23', desde: '2026-10-26 07:50:00' }];
  }
  if (/FROM clientes_chat_center\s+WHERE id = \?/.test(sql)) {
    if (Number(r[0]) === 11) return [{ id: 11, celular_cliente: CEL, id_encargado: 3 }];
    if (Number(r[0]) === 15) return [{ id: 15, celular_cliente: CEL, id_encargado: null }];
    if (Number(r[0]) === 13) return [{ id: 13, celular_cliente: CEL_US }];
    if (Number(r[0]) === 14) return [{ id: 14, celular_cliente: CEL, source: 'ig' }];
    return [];
  }
  if (/MAX\(created_at\) AS ult/.test(sql)) {
    return [{ ult: ventanaAbierta ? '2026-10-25 10:00:00' : null }];
  }
  if (/AS n FROM mensajes_clientes/.test(sql)) return [{ n: plantillaReciente ? 1 : 0 }];
  if (/FROM mensajes_clientes/.test(sql)) {
    // Como la base: del más nuevo al más viejo.
    return [
      { id: 3, rol_mensaje: 1, tipo_mensaje: 'text', texto_mensaje: 'te escribo al 305 555 0142', responsable: 'Front 1', created_at: '2026-10-24 10:02:00' },
      { id: 2, rol_mensaje: 0, tipo_mensaje: 'text', texto_mensaje: 'hola, mi número es 099 123 4567', created_at: '2026-10-24 10:00:00' },
    ];
  }
  if (/FROM sub_usuarios_chat_center s/.test(sql)) {
    if (Number(r[0]) !== 254 || Number(r[1]) !== 265) return [];
    return [
      { id_sub_usuario: 5, id_usuario: 254, rol: 'administrador', nombre_encargado: 'Vivi', id_departamento: 7 },
      { id_sub_usuario: 4, id_usuario: 254, rol: 'equipo', nombre_encargado: 'F', id_departamento: 7, email: 'f@x.com' },
      { id_sub_usuario: 3, id_usuario: 254, rol: 'equipo', nombre_encargado: 'E', id_departamento: 7 },
    ];
  }
  if (/UPDATE clientes_chat_center SET id_encargado/.test(sql)) return [undefined, alguienLoMovio ? 0 : 1];
  if (/UPDATE clientes_chat_center SET chat_cerrado = 1/.test(sql)) return [undefined, yaCerrado ? 0 : 1];
  if (/FROM kanban_columnas/.test(sql)) return [{ estado_db: 'nuevo_lead' }];
  if (/c\.propietario = 1/.test(sql)) return [{ id: 1, id_telefono: '777' }];
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
  4: { id_sub_usuario: 4, id_usuario: 254, rol: 'equipo', suspendido: 0, nombre_encargado: 'F' },
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
// El envío nunca sale de aquí: se anota lo que se habría mandado a Meta.
let enviados = [];
let metaFalla = false;
// Nota de voz sin ffmpeg ni almacén: «MALO» no se puede leer, «CORTO» dura 0,2 s.
let subirFalla = false;
let subidas = 0;
const URL_NOTA = 'https://imp-datas.s3.amazonaws.com/audio/2026-10-27T15-00-00-000Z-nota-voz.ogg';
const notaDeVoz = require(path.join(SRC, 'utils/notaDeVoz'));
notaDeVoz.convertirAOggOpus = async (b) => {
  const t = b.toString('utf8', 0, 5);
  if (t === 'MALO!') throw new Error('Invalid data found when processing input');
  return { ogg: Buffer.from('OggS' + 'x'.repeat(200)), segundos: t === 'CORTO' ? 0.2 : 3.4 };
};
notaDeVoz.subirAlUploader = async () => {
  if (subirFalla) throw new Error('ECONNRESET');
  subidas += 1;
  return URL_NOTA;
};
// Foto sin almacén: se anota lo que se habría subido.
const URL_FOTO = 'https://imp-datas.s3.amazonaws.com/image/2026-10-27T15-00-00-000Z-foto.jpg';
let fotosSubidas = [];
const imagenTeam = require(path.join(SRC, 'utils/imagenTeam'));
imagenTeam.subirImagen = async (b, tipo) => {
  if (subirFalla) throw new Error('ECONNRESET');
  fotosSubidas.push({ bytes: b.length, tipo });
  return tipo === 'png' ? URL_FOTO.replace(/jpg$/, 'png') : URL_FOTO;
};
// «Enviar información»: el historial y el envío a Meta se reemplazan.
const historialMod = require(path.join(SRC, 'utils/historialCargas'));
let historialStub = null;
let telefonoHistorial = null;
historialMod.historialDelTelefono = async (tel) => {
  telefonoHistorial = tel;
  return historialStub ? historialStub(tel) : { estado: 'sin_carga', total: 0, cotizaciones: [] };
};
const plantillaCarga = require(path.join(SRC, 'utils/plantillaCarga'));
let plantillas = [];
let plantillaFalla = false;
plantillaCarga.enviar = async (d) => {
  if (plantillaFalla) throw new Error('(#131026) Message undeliverable to 593991234567');
  plantillas.push(d);
  return { wamid: 'wamid.HBgMNTkzOTkxMjM0NTY3', estado: 'accepted' };
};
ChatService.prototype.getDataAdmin = async (id) => ({ id, id_telefono: '777', token: 'llave' });
ChatService.prototype.sendMessage = async (d) => {
  if (metaFalla) throw new Error('(#131030) Recipient 593991234567 not in allowed list');
  enviados.push(d);
  return {
    messages: [{ id: 'wamid.HBgMNTkzOTkxMjM0NTY3' }],
    mensajeNuevo: { id: 900 + enviados.length, texto_mensaje: d.mensaje, responsable: d.nombre_encargado, id_wamid_mensaje: 'wamid.HBgMNTkzOTkxMjM0NTY3', uid_whatsapp: d.to, created_at: '2026-10-25 11:00:00' },
  };
};
// Transferir: la nota, el historial y el aviso al socket se anotan, no se escriben.
let notas = [];
require(path.join(SRC, 'models/mensaje_cliente.model')).create = async (d) => {
  notas.push(d);
  return { id: 1, ...d };
};
let historial = [];
require(path.join(SRC, 'models/historial_encargados.model')).create = async (d) => {
  historial.push(d);
  return { id: 1, ...d };
};
let avisosSocket = [];
const ecs = require.resolve(path.join(SRC, 'utils/webhook_whatsapp/enviar_consulta_socket'));
require.cache[ecs] = { id: ecs, filename: ecs, loaded: true, exports: { enviarConsultaAPI: async (...a) => avisosSocket.push(a) } };
// Cerrar: el ajuste del kanban, el tablero y la encuesta se reemplazan.
let volverAlCerrar = true;
const kcc = require.resolve(path.join(SRC, 'utils/kanbanConfigCuenta'));
require.cache[kcc] = { id: kcc, filename: kcc, loaded: true, exports: { getKanbanConfigCuenta: async () => ({ volver_al_cerrar: volverAlCerrar }) } };
let tablero = [];
require(path.join(SRC, 'controllers/dashboardEmitter')).emitByConfig = async (...a) => tablero.push(a);
let encuestas = [];
const enc = require.resolve(path.join(SRC, 'utils/encuestaSatisfaccion'));
require.cache[enc] = { id: enc, filename: enc, loaded: true, exports: { intentarEnviarEncuesta: async (d) => (encuestas.push(d), { programado: true, delay_minutos: 5 }) } };
const rutas = require(path.join(SRC, 'middlewares/rutasSinSesion'));
const equipoRouter = require(path.join(SRC, 'routes/equipo.routes'));
const errorHandler = require(path.join(SRC, 'controllers/error.controller'));

const firmar = (p) => jwt.sign(p, process.env.SECRET_JWT_SEED, { expiresIn: '1h' });
const TEAM = jwt.sign({ id_sub_usuario: 3, rol: 'equipo', origen: 'team' }, process.env.SECRET_JWT_SEED, { expiresIn: '1h', issuer: 'chatcenter', audience: 'team' });
const ADMIN = firmar({ id_sub_usuario: 1, rol: 'administrador' });
const teamDe = (id, extra = {}) =>
  jwt.sign({ id_sub_usuario: id, rol: 'equipo', origen: 'team', ...extra }, process.env.SECRET_JWT_SEED, { expiresIn: '1h', issuer: 'chatcenter', audience: 'team' });

function app() {
  const a = express();
  a.use(express.json());
  a.use(rutas.vigilar);
  a.use('/api/v1/equipo', equipoRouter);
  a.use(errorHandler);
  return new Promise((ok) => {
    const s = a.listen(0, () => ok(s));
  });
}
function pedir(s, ruta, token, cuerpo) {
  return new Promise((ok, mal) => {
    const headers = token ? { authorization: 'Bearer ' + token } : {};
    if (cuerpo !== undefined) headers['content-type'] = 'application/json';
    const req = http.request(
      { host: '127.0.0.1', port: s.address().port, method: cuerpo === undefined ? 'GET' : 'POST', path: ruta, headers },
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
    req.end(cuerpo === undefined ? undefined : JSON.stringify(cuerpo));
  });
}
const sqlChats = () => consultas.filter((c) => /FROM vista_chats/.test(c.sql)).pop();

// multipart a mano, como lo manda Team (CURLFile): campos y un archivo «audio».
function pedirAudio(s, ruta, token, campos, archivo) {
  const borde = '----prueba' + Date.now();
  const partes = [];
  for (const [k, v] of Object.entries(campos || {})) {
    partes.push(Buffer.from(`--${borde}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (archivo) {
    partes.push(Buffer.from(`--${borde}\r\nContent-Disposition: form-data; name="${archivo.campo || 'audio'}"; filename="${archivo.nombre}"\r\nContent-Type: ${archivo.tipo}\r\n\r\n`));
    partes.push(archivo.datos, Buffer.from('\r\n'));
  }
  partes.push(Buffer.from(`--${borde}--\r\n`));
  const cuerpo = Buffer.concat(partes);
  return new Promise((ok, mal) => {
    const headers = { 'content-type': `multipart/form-data; boundary=${borde}`, 'content-length': cuerpo.length };
    if (token) headers.authorization = 'Bearer ' + token;
    const req = http.request({ host: '127.0.0.1', port: s.address().port, method: 'POST', path: ruta, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let j = null;
        try {
          j = JSON.parse(b);
        } catch (_) {}
        ok({ status: res.statusCode, body: j, texto: b });
      });
    });
    req.on('error', mal);
    req.end(cuerpo);
  });
}

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

  console.log('Responder desde Team');
  const ENVIAR = '/api/v1/equipo/chats/11/mensajes';
  await caso('contesta al chat visible: el número lo pone el servidor y no vuelve', async () => {
    enviados = [];
    const r = await pedir(s, ENVIAR, TEAM, { id_configuracion: 265, texto: '  Hola Ana, ya revisé tu carga  ' });
    assert.equal(r.status, 200, r.texto);
    assert.equal(enviados.length, 1);
    assert.equal(enviados[0].to, CEL);
    assert.equal(enviados[0].mensaje, 'Hola Ana, ya revisé tu carga');
    assert.equal(enviados[0].tipo_mensaje, 'text');
    assert.equal(enviados[0].id_configuracion, 265);
    assert.equal(enviados[0].nombre_encargado, 'E');
    assert.equal(r.body.data.rol_mensaje, 1);
    assert.equal(r.body.data.texto_mensaje, 'Hola Ana, ya revisé tu carga');
    assert.equal(r.body.data.responsable, 'E');
    assert.ok(!r.texto.includes(CEL) && !r.texto.includes('wamid') && !r.texto.includes('llave'), r.texto);
  });
  await caso('lo que mande Team como número se ignora', async () => {
    enviados = [];
    const r = await pedir(s, ENVIAR, TEAM, { id_configuracion: 265, texto: 'hola', to: '593000000001', celular_cliente: '593000000001' });
    assert.equal(r.status, 200);
    assert.equal(enviados[0].to, CEL);
  });
  await caso('el número del cliente escrito en el mensaje vuelve tapado a Team', async () => {
    const r = await pedir(s, ENVIAR, TEAM, { id_configuracion: 265, texto: 'te llamo al 0991234567' });
    assert.equal(r.status, 200);
    assert.ok(!r.texto.includes('0991234567'), r.texto);
  });
  await caso('la ventana se mira en la base: mensajes del cliente de ese chat, 24 h', async () => {
    await pedir(s, ENVIAR, TEAM, { id_configuracion: 265, texto: 'hola' });
    const q = consultas.find((c) => /MAX\(created_at\) AS ult/.test(c.sql));
    assert.ok(q.sql.includes('rol_mensaje = 0') && q.sql.includes('INTERVAL 24 HOUR'), q.sql);
    assert.deepEqual(q.opts.replacements, ['11', 265]);
  });
  await caso('sin texto, con espacios o muy largo → 400 y no envía', async () => {
    enviados = [];
    for (const cuerpo of [{ id_configuracion: 265 }, { id_configuracion: 265, texto: '   \n ' }, { id_configuracion: 265, texto: 'x'.repeat(4097) }, { id_configuracion: 265, texto: ['hola'] }]) {
      assert.equal((await pedir(s, ENVIAR, TEAM, cuerpo)).status, 400, JSON.stringify(cuerpo).slice(0, 40));
    }
    assert.equal(enviados.length, 0);
  });
  await caso('chat que no es suyo o de otra cuenta → 404 y no envía', async () => {
    enviados = [];
    assert.equal((await pedir(s, '/api/v1/equipo/chats/12/mensajes', TEAM, { id_configuracion: 265, texto: 'hola' })).status, 404);
    assert.equal((await pedir(s, ENVIAR, TEAM, { id_configuracion: 999, texto: 'hola' })).status, 404);
    assert.equal((await pedir(s, '/api/v1/equipo/chats/abc/mensajes', TEAM, { id_configuracion: 265, texto: 'hola' })).status, 400);
    assert.equal(enviados.length, 0);
  });
  await caso('chat de Instagram o Messenger → 422 (por ahora solo WhatsApp)', async () => {
    enviados = [];
    assert.equal((await pedir(s, '/api/v1/equipo/chats/14/mensajes', TEAM, { id_configuracion: 265, texto: 'hola' })).status, 422);
    assert.equal(enviados.length, 0);
  });
  await caso('cliente sin escribir en 24 h → 422 con el aviso de plantilla, no envía', async () => {
    enviados = [];
    ventanaAbierta = false;
    const r = await pedir(s, ENVIAR, TEAM, { id_configuracion: 265, texto: 'hola' });
    ventanaAbierta = true;
    assert.equal(r.status, 422);
    assert.ok(/24 horas/.test(r.body.message), r.texto);
    assert.equal(enviados.length, 0);
  });
  await caso('«Ver como» (sesión de solo lectura) → 403 y no envía', async () => {
    enviados = [];
    const r = await pedir(s, ENVIAR, teamDe(3, { solo_lectura: true }), { id_configuracion: 265, texto: 'hola' });
    assert.equal(r.status, 403);
    assert.equal(enviados.length, 0);
    assert.ok(!consultas.some((c) => /FROM clientes_chat_center/.test(c.sql)), 'ni siquiera busca el chat');
  });
  await caso('un administrador con su token de login no contesta por aquí', async () => {
    enviados = [];
    assert.equal((await pedir(s, ENVIAR, ADMIN, { id_configuracion: 265, texto: 'hola' })).status, 403);
    assert.equal(enviados.length, 0);
  });
  await caso('Meta rechaza → 502 sin el detalle (traía el número)', async () => {
    metaFalla = true;
    const r = await pedir(s, ENVIAR, TEAM, { id_configuracion: 265, texto: 'hola' });
    metaFalla = false;
    assert.equal(r.status, 502);
    assert.ok(!r.texto.includes(CEL) && !r.texto.includes('131030'), r.texto);
  });
  console.log('Nota de voz desde Team');
  const AUDIO = '/api/v1/equipo/chats/11/audio';
  const webm = (txt = 'GRABA') => ({ nombre: 'nota.webm', tipo: 'audio/webm;codecs=opus', datos: Buffer.from(txt + 'x'.repeat(500)) });
  await caso('manda la nota de voz al chat visible: ogg, como audio, el número lo pone el servidor', async () => {
    enviados = [];
    subidas = 0;
    const r = await pedirAudio(s, AUDIO, TEAM, { id_configuracion: 265, to: '593000000001' }, webm());
    assert.equal(r.status, 200, r.texto);
    assert.equal(subidas, 1);
    assert.equal(enviados.length, 1);
    assert.equal(enviados[0].to, CEL);
    assert.equal(enviados[0].tipo_mensaje, 'document');
    assert.equal(enviados[0].ruta_archivo, URL_NOTA);
    assert.ok(/\.ogg$/.test(enviados[0].ruta_archivo));
    assert.equal(enviados[0].id_configuracion, 265);
    assert.equal(enviados[0].nombre_encargado, 'E');
    assert.equal(r.body.data.tipo_mensaje, 'audio');
    assert.equal(r.body.data.ruta_archivo, URL_NOTA, 'la URL vuelve sin tapar');
    assert.ok(!r.texto.includes(CEL) && !r.texto.includes('wamid'), r.texto);
  });
  await caso('Safari (audio/mp4) también entra', async () => {
    enviados = [];
    const r = await pedirAudio(s, AUDIO, TEAM, { id_configuracion: 265 }, { nombre: 'nota.mp4', tipo: 'audio/mp4', datos: Buffer.from('GRABA' + 'x'.repeat(300)) });
    assert.equal(r.status, 200, r.texto);
    assert.equal(enviados.length, 1);
  });
  await caso('sin archivo, con otro tipo, ilegible o vacía → 400 y no envía', async () => {
    enviados = [];
    subidas = 0;
    assert.equal((await pedirAudio(s, AUDIO, TEAM, { id_configuracion: 265 })).status, 400);
    assert.equal((await pedirAudio(s, AUDIO, TEAM, { id_configuracion: 265 }, { nombre: 'x.pdf', tipo: 'application/pdf', datos: Buffer.from('%PDF-1.4') })).status, 400);
    const ilegible = await pedirAudio(s, AUDIO, TEAM, { id_configuracion: 265 }, webm('MALO!'));
    assert.equal(ilegible.status, 400);
    assert.ok(/Vuelve a grabarla/.test(ilegible.body.message), ilegible.texto);
    assert.equal((await pedirAudio(s, AUDIO, TEAM, { id_configuracion: 265 }, webm('CORTO'))).status, 400);
    assert.equal(enviados.length, 0);
    assert.equal(subidas, 0);
  });
  await caso('más de 8 MB → 413 y no envía', async () => {
    enviados = [];
    const r = await pedirAudio(s, AUDIO, TEAM, { id_configuracion: 265 }, { nombre: 'n.webm', tipo: 'audio/webm', datos: Buffer.alloc(8 * 1024 * 1024 + 10, 1) });
    assert.equal(r.status, 413, r.texto);
    assert.equal(enviados.length, 0);
  });
  await caso('«Ver como» → 403; chat ajeno → 404; Instagram y fuera de 24 h → 422; admin → 403', async () => {
    enviados = [];
    subidas = 0;
    assert.equal((await pedirAudio(s, AUDIO, teamDe(3, { solo_lectura: true }), { id_configuracion: 265 }, webm())).status, 403);
    assert.equal((await pedirAudio(s, '/api/v1/equipo/chats/12/audio', TEAM, { id_configuracion: 265 }, webm())).status, 404);
    assert.equal((await pedirAudio(s, AUDIO, TEAM, { id_configuracion: 999 }, webm())).status, 404);
    assert.equal((await pedirAudio(s, '/api/v1/equipo/chats/14/audio', TEAM, { id_configuracion: 265 }, webm())).status, 422);
    ventanaAbierta = false;
    const fuera = await pedirAudio(s, AUDIO, TEAM, { id_configuracion: 265 }, webm());
    ventanaAbierta = true;
    assert.equal(fuera.status, 422);
    assert.ok(/24 horas/.test(fuera.body.message), fuera.texto);
    assert.equal((await pedirAudio(s, AUDIO, ADMIN, { id_configuracion: 265 }, webm())).status, 403);
    assert.equal(enviados.length, 0);
    assert.equal(subidas, 0, 'no sube nada si no se puede enviar');
  });
  await caso('falla el almacén → 502; Meta rechaza → 502 sin el número', async () => {
    enviados = [];
    subirFalla = true;
    const r1 = await pedirAudio(s, AUDIO, TEAM, { id_configuracion: 265 }, webm());
    subirFalla = false;
    assert.equal(r1.status, 502);
    assert.equal(enviados.length, 0);
    metaFalla = true;
    const r2 = await pedirAudio(s, AUDIO, TEAM, { id_configuracion: 265 }, webm());
    metaFalla = false;
    assert.equal(r2.status, 502);
    assert.ok(/nota de voz/.test(r2.body.message) && !r2.texto.includes(CEL), r2.texto);
  });

  console.log('Foto desde Team');
  const FOTO = '/api/v1/equipo/chats/11/imagen';
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(500, 3)]);
  const foto = (datos = JPG, nombre = 'foto.jpg', tipo = 'image/jpeg') => ({ campo: 'imagen', nombre, tipo, datos });
  await caso('manda la foto con leyenda al chat visible: como imagen, el número lo pone el servidor', async () => {
    enviados = [];
    fotosSubidas = [];
    const r = await pedirAudio(s, FOTO, TEAM, { id_configuracion: 265, texto: '  Así llegó tu caja  ', to: '593000000001' }, foto());
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(fotosSubidas, [{ bytes: JPG.length, tipo: 'jpg' }]);
    assert.equal(enviados.length, 1);
    assert.equal(enviados[0].to, CEL);
    assert.equal(enviados[0].tipo_mensaje, 'image');
    assert.equal(enviados[0].ruta_archivo, URL_FOTO);
    assert.equal(enviados[0].mensaje, 'Así llegó tu caja');
    assert.equal(enviados[0].nombre_encargado, 'E');
    assert.equal(r.body.data.tipo_mensaje, 'image');
    assert.equal(r.body.data.ruta_archivo, URL_FOTO, 'la URL vuelve sin tapar');
    assert.ok(!r.texto.includes(CEL) && !r.texto.includes('wamid'), r.texto);
  });
  await caso('PNG y sin leyenda también salen', async () => {
    enviados = [];
    const r = await pedirAudio(s, FOTO, TEAM, { id_configuracion: 265 }, foto(PNG, 'c.png', 'image/png'));
    assert.equal(r.status, 200, r.texto);
    assert.equal(enviados[0].mensaje, '');
    assert.ok(/\.png$/.test(enviados[0].ruta_archivo));
  });
  await caso('sin foto, otro archivo con nombre .jpg, leyenda larga o más de 5 MB → no envía', async () => {
    enviados = [];
    fotosSubidas = [];
    assert.equal((await pedirAudio(s, FOTO, TEAM, { id_configuracion: 265 })).status, 400);
    const falsa = await pedirAudio(s, FOTO, TEAM, { id_configuracion: 265 }, foto(Buffer.from('%PDF-1.4 hola'), 'x.jpg', 'image/jpeg'));
    assert.equal(falsa.status, 400);
    assert.ok(/JPG o PNG/.test(falsa.body.message), falsa.texto);
    assert.equal((await pedirAudio(s, FOTO, TEAM, { id_configuracion: 265, texto: 'x'.repeat(1025) }, foto())).status, 400);
    const grande = await pedirAudio(s, FOTO, TEAM, { id_configuracion: 265 }, foto(Buffer.concat([JPG, Buffer.alloc(5 * 1024 * 1024)])));
    assert.equal(grande.status, 413, grande.texto);
    assert.equal(enviados.length, 0);
    assert.equal(fotosSubidas.length, 0);
  });
  await caso('foto: «Ver como» → 403; chat ajeno → 404; fuera de 24 h → 422; admin → 403; nada se sube', async () => {
    enviados = [];
    fotosSubidas = [];
    assert.equal((await pedirAudio(s, FOTO, teamDe(3, { solo_lectura: true }), { id_configuracion: 265 }, foto())).status, 403);
    assert.equal((await pedirAudio(s, '/api/v1/equipo/chats/12/imagen', TEAM, { id_configuracion: 265 }, foto())).status, 404);
    assert.equal((await pedirAudio(s, '/api/v1/equipo/chats/14/imagen', TEAM, { id_configuracion: 265 }, foto())).status, 422);
    ventanaAbierta = false;
    const fuera = await pedirAudio(s, FOTO, TEAM, { id_configuracion: 265 }, foto());
    ventanaAbierta = true;
    assert.equal(fuera.status, 422);
    assert.ok(/24 horas/.test(fuera.body.message), fuera.texto);
    assert.equal((await pedirAudio(s, FOTO, ADMIN, { id_configuracion: 265 }, foto())).status, 403);
    assert.equal(enviados.length, 0);
    assert.equal(fotosSubidas.length, 0);
  });
  await caso('foto: falla el almacén → 502; Meta rechaza → 502 sin el número', async () => {
    enviados = [];
    subirFalla = true;
    const r1 = await pedirAudio(s, FOTO, TEAM, { id_configuracion: 265 }, foto());
    subirFalla = false;
    assert.equal(r1.status, 502);
    assert.equal(enviados.length, 0);
    metaFalla = true;
    const r2 = await pedirAudio(s, FOTO, TEAM, { id_configuracion: 265 }, foto());
    metaFalla = false;
    assert.equal(r2.status, 502);
    assert.ok(/foto/.test(r2.body.message) && !r2.texto.includes(CEL), r2.texto);
  });
  await caso('tipoDeImagen: por los bytes, no por el nombre', async () => {
    assert.equal(imagenTeam.tipoDeImagen(JPG), 'jpg');
    assert.equal(imagenTeam.tipoDeImagen(PNG), 'png');
    assert.equal(imagenTeam.tipoDeImagen(Buffer.from('GIF89a......')), null);
    assert.equal(imagenTeam.tipoDeImagen(null), null);
  });

  await caso('tope: 20 envíos por minuto por asesor; el 21 → 429', async () => {
    enviados = [];
    const T4 = teamDe(4);
    for (let i = 0; i < 20; i += 1) assert.equal((await pedir(s, ENVIAR, T4, { id_configuracion: 265, texto: 'n' + i })).status, 200);
    const r = await pedir(s, ENVIAR, T4, { id_configuracion: 265, texto: 'uno más' });
    assert.equal(r.status, 429);
    assert.equal(enviados.length, 20);
    // El tope es por asesor: el 3 sigue pudiendo.
    assert.equal((await pedir(s, ENVIAR, TEAM, { id_configuracion: 265, texto: 'hola' })).status, 200);
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
  await caso('historial de cargas: chat visible → estado sin el número; ajeno → 404', async () => {
    const r = await pedir(s, '/api/v1/equipo/chats/11/historial-cargas?id_configuracion=265', TEAM);
    assert.equal(r.status, 200, r.texto);
    assert.ok(typeof r.body.data.estado === 'string' && Array.isArray(r.body.data.cotizaciones), r.texto);
    assert.ok(!r.texto.includes(CEL), r.texto);
    assert.equal((await pedir(s, '/api/v1/equipo/chats/12/historial-cargas?id_configuracion=265', TEAM)).status, 404);
    assert.equal((await pedir(s, '/api/v1/equipo/chats/11/historial-cargas?id_configuracion=265', ADMIN)).status, 403);
  });
  await caso('carga de un chat que no es suyo → 404 y no busca', async () => {
    telefonoPedido = null;
    assert.equal((await pedir(s, '/api/v1/equipo/chats/12/carga?id_configuracion=265', TEAM)).status, 404);
    assert.equal(telefonoPedido, null);
  });
  await caso('un administrador no usa la agenda de Team', async () => {
    assert.equal((await pedir(s, '/api/v1/equipo/agenda?id_configuracion=265', ADMIN)).status, 403);
  });

  await caso('bandeja: tres grupos; el que más espera, primero; bot por lo más reciente', async () => {
    consultas = [];
    const r = await pedir(s, '/api/v1/equipo/bandeja?id_configuracion=265', TEAM);
    assert.equal(r.status, 200, r.texto);
    const g = r.body.data;
    assert.deepEqual(g.te_toca.map((c) => c.id), [23, 21, 32, 33]);
    assert.deepEqual(g.esperando.map((c) => c.id), [34, 22]);
    assert.deepEqual(g.bot.map((c) => c.id), [31, 30, 35]);
    // 33 y 34: un asesor entró después del bot → salen del verde aunque el bot siga encendido.
    const c33 = g.te_toca.find((c) => c.id === 33);
    assert.equal(c33.asesor, true);
    assert.equal(c33.bot, true);
    assert.equal(c33.pase, false);
    assert.equal(g.esperando[0].asesor, true);
    assert.equal(g.bot.find((c) => c.id === 35).asesor, false);
    // 32: el bot lo pasó y sigue encendido → «Te toca», espera desde el pase.
    const pasado = g.te_toca.find((c) => c.id === 32);
    assert.equal(pasado.pase, true);
    assert.equal(pasado.bot, true);
    assert.equal(pasado.espera_desde, '2026-10-26 11:00:00');
    assert.equal(g.te_toca[0].bot, false);
    // 24: sin movimiento en 20 días → no aparece.
    assert.ok(![...g.te_toca, ...g.esperando, ...g.bot].some((c) => c.id === 24), 'el chat quieto hace 20 días no sale');
    assert.equal(g.te_toca[0].espera_desde, '2026-10-26 07:50:00');
    assert.equal(g.te_toca[1].es_mio, true);
    assert.ok(!r.texto.includes('0991234567') && !r.texto.includes(CEL), 'los teléfonos van tapados');
  });
  await caso('bandeja: el alcance es el del asesor y lo del bot no cuenta como persona', async () => {
    consultas = [];
    await pedir(s, '/api/v1/equipo/bandeja?id_configuracion=265', TEAM);
    const sinBot = consultas.find((c) => /c\.bot_openia = 0/.test(c.sql));
    assert.ok(/c\.id_encargado = \? OR \(c\.id_encargado IS NULL/.test(sinBot.sql));
    assert.deepEqual(sinBot.opts.replacements, [265, 3]);
    const t = consultas.find((c) => /AS ult_persona/.test(c.sql));
    assert.ok(/NOT REGEXP '\^\(IA_/.test(t.sql), t.sql);
    assert.ok(/NOT IN \('reaction', 'edit', 'revoke'\)/.test(t.sql), 'la vista previa no es una reacción');
    assert.ok(/INTERVAL 30 DAY/.test(t.sql), 'las horas se miran en 30 días');
  });
  await caso('bandeja: de una línea ajena → 404', async () => {
    assert.equal((await pedir(s, '/api/v1/equipo/bandeja?id_configuracion=999', TEAM)).status, 404);
  });
  await caso('devolver al bot: enciende el bot en ese chat', async () => {
    consultas = [];
    const r = await pedir(s, '/api/v1/equipo/chats/11/bot', TEAM, { id_configuracion: 265, encender: true });
    assert.equal(r.status, 200, r.texto);
    const u = consultas.find((c) => /UPDATE clientes_chat_center SET bot_openia/.test(c.sql));
    assert.deepEqual(u.opts.replacements, [1, 11, 265]);
  });
  await caso('lo atiendo yo: apaga el bot', async () => {
    consultas = [];
    assert.equal((await pedir(s, '/api/v1/equipo/chats/11/bot', TEAM, { id_configuracion: 265, encender: false })).status, 200);
    assert.deepEqual(consultas.find((c) => /SET bot_openia/.test(c.sql)).opts.replacements, [0, 11, 265]);
  });
  await caso('bot: chat ajeno → 404, sin decir qué → 400, «Ver como» → 403; nada se escribe', async () => {
    consultas = [];
    assert.equal((await pedir(s, '/api/v1/equipo/chats/12/bot', TEAM, { id_configuracion: 265, encender: true })).status, 404);
    assert.equal((await pedir(s, '/api/v1/equipo/chats/11/bot', TEAM, { id_configuracion: 265, encender: 'si' })).status, 400);
    assert.equal((await pedir(s, '/api/v1/equipo/chats/11/bot', teamDe(3, { solo_lectura: true }), { id_configuracion: 265, encender: true })).status, 403);
    assert.ok(!consultas.some((c) => /UPDATE/.test(c.sql)));
  });

  console.log('Pasar el chat a otro asesor');
  const PASAR = '/api/v1/equipo/chats/11/transferir';
  const limpiar = () => {
    notas = [];
    historial = [];
    avisosSocket = [];
  };
  const updates = () => consultas.filter((c) => /UPDATE clientes_chat_center SET id_encargado/.test(c.sql));
  await caso('asesores: los de la línea, los de Team primero, solo id y nombre', async () => {
    const r = await pedir(s, '/api/v1/equipo/asesores?id_configuracion=265', TEAM);
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.body.data, [
      { id: 3, nombre: 'E', en_team: true, soy_yo: true },
      { id: 4, nombre: 'F', en_team: true, soy_yo: false },
      { id: 5, nombre: 'Vivi', en_team: false, soy_yo: false },
    ]);
    assert.ok(!r.texto.includes('f@x.com'), 'sin correo');
    const q = consultas.find((c) => /FROM sub_usuarios_chat_center s/.test(c.sql));
    assert.ok(/s\.suspendido = 0/.test(q.sql) && /d\.id_configuracion = \?/.test(q.sql), q.sql);
  });
  await caso('asesores de una línea ajena → 404', async () => {
    assert.equal((await pedir(s, '/api/v1/equipo/asesores?id_configuracion=999', TEAM)).status, 404);
  });
  await caso('pasa su chat a otro asesor: encargado, historial, nota interna y aviso', async () => {
    limpiar();
    const r = await pedir(s, PASAR, TEAM, { id_configuracion: 265, a_sub: 4, motivo: '  es de   ecommerce ' });
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.body.data, { id: 11, a_sub: 4, nombre: 'F' });
    assert.deepEqual(updates()[0].opts.replacements, [4, 11, 265, 3]);
    assert.ok(/id_encargado <=> \?/.test(updates()[0].sql), 'solo si nadie lo movió');
    assert.ok(/chat_cerrado = 0/.test(updates()[0].sql));
    assert.equal(historial.length, 1);
    assert.equal(historial[0].id_encargado_anterior, 3);
    assert.equal(historial[0].id_encargado_nuevo, 4);
    assert.equal(historial[0].id_departamento_asginado, 7);
    assert.equal(historial[0].motivo, 'Desde Team: es de ecommerce');
    assert.equal(notas.length, 1);
    assert.equal(notas[0].rol_mensaje, 3);
    assert.equal(notas[0].tipo_mensaje, 'notificacion');
    assert.equal(notas[0].celular_recibe, 11);
    assert.equal(notas[0].texto_mensaje, 'E te transfirió este chat. Motivo: es de ecommerce');
    assert.deepEqual(avisosSocket, [[265, 11]]);
    assert.ok(!r.texto.includes(CEL), r.texto);
  });
  await caso('un chat en espera también se puede pasar', async () => {
    limpiar();
    const r = await pedir(s, '/api/v1/equipo/chats/15/transferir', TEAM, { id_configuracion: 265, a_sub: 4 });
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(updates()[0].opts.replacements, [4, 15, 265, null]);
    assert.equal(notas[0].texto_mensaje, 'E te transfirió este chat. Motivo: sin motivo');
  });
  await caso('no se puede: ya es suyo 409, fuera de la línea 422, sin destino 400, ajeno 404', async () => {
    limpiar();
    assert.equal((await pedir(s, PASAR, TEAM, { id_configuracion: 265, a_sub: 3 })).status, 409);
    assert.equal((await pedir(s, PASAR, TEAM, { id_configuracion: 265, a_sub: 99 })).status, 422);
    assert.equal((await pedir(s, PASAR, TEAM, { id_configuracion: 265 })).status, 400);
    assert.equal((await pedir(s, PASAR, TEAM, { id_configuracion: 265, a_sub: '4; DROP' })).status, 400);
    assert.equal((await pedir(s, '/api/v1/equipo/chats/12/transferir', TEAM, { id_configuracion: 265, a_sub: 4 })).status, 404);
    assert.equal((await pedir(s, PASAR, TEAM, { id_configuracion: 999, a_sub: 4 })).status, 404);
    assert.equal(updates().length, 0);
    assert.equal(notas.length + historial.length + avisosSocket.length, 0);
  });
  await caso('«Ver como» (gerencia) sí pasa: la nota dice Gerencia y el historial va sin autor del asesor', async () => {
    limpiar();
    const r = await pedir(s, PASAR, teamDe(3, { solo_lectura: true }), { id_configuracion: 265, a_sub: 5, motivo: 'reparto' });
    assert.equal(r.status, 200, r.texto);
    assert.equal(notas[0].texto_mensaje, 'Gerencia te transfirió este chat. Motivo: reparto');
    assert.equal(historial[0].motivo, 'Gerencia desde Team: reparto');
  });
  await caso('si otro lo movió justo antes → 409 y no deja nota ni historial', async () => {
    limpiar();
    alguienLoMovio = true;
    const r = await pedir(s, PASAR, TEAM, { id_configuracion: 265, a_sub: 4 });
    alguienLoMovio = false;
    assert.equal(r.status, 409);
    assert.equal(notas.length + historial.length + avisosSocket.length, 0);
  });
  await caso('motivo de más de 200 caracteres se corta', async () => {
    limpiar();
    await pedir(s, PASAR, TEAM, { id_configuracion: 265, a_sub: 4, motivo: 'x'.repeat(500) });
    assert.equal(historial[0].motivo, 'Desde Team: ' + 'x'.repeat(200));
  });
  await caso('un administrador con su token de login no transfiere por aquí', async () => {
    limpiar();
    assert.equal((await pedir(s, PASAR, ADMIN, { id_configuracion: 265, a_sub: 4 })).status, 403);
    assert.equal(updates().length, 0);
  });

  console.log('Cerrar el chat');
  const CERRAR = '/api/v1/equipo/chats/11/cerrar';
  const limpiarCierre = () => {
    notas = [];
    avisosSocket = [];
    tablero = [];
    encuestas = [];
    consultas = [];
  };
  const cierres = () => consultas.filter((c) => /UPDATE clientes_chat_center SET chat_cerrado = 1/.test(c.sql));
  await caso('cierra su chat: cerrado, bot encendido, columna principal, tablero, nota, aviso y encuesta', async () => {
    limpiarCierre();
    const r = await pedir(s, CERRAR, TEAM, { id_configuracion: 265 });
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.body.data, { id: 11, cerrado: true });
    const u = cierres()[0];
    assert.ok(/bot_openia = 1/.test(u.sql) && /chat_cerrado_at = NOW\(\)/.test(u.sql) && /estado_contacto = \?/.test(u.sql), u.sql);
    assert.ok(/COALESCE\(chat_cerrado, 0\) = 0/.test(u.sql), 'solo si seguía abierto');
    assert.deepEqual(u.opts.replacements, ['nuevo_lead', 11, 265]);
    assert.deepEqual(tablero, [[265, 'chat_resolved', { chatsResolved: 1 }]]);
    assert.equal(notas.length, 1);
    assert.equal(notas[0].rol_mensaje, 3);
    assert.equal(notas[0].tipo_mensaje, 'notificacion');
    assert.equal(notas[0].celular_recibe, 11);
    assert.ok(/^Chat cerrado por E — \d\d\/\d\d\/\d{4}/.test(notas[0].texto_mensaje), notas[0].texto_mensaje);
    assert.deepEqual(avisosSocket, [[265, 11]]);
    assert.equal(encuestas.length, 1, 'programa la encuesta como ImporChat');
    assert.equal(encuestas[0].idClienteChatCenter, 11);
    assert.ok(!r.texto.includes(CEL));
  });
  await caso('si la cuenta no devuelve el contacto al cerrar, no toca la columna', async () => {
    limpiarCierre();
    volverAlCerrar = false;
    const r = await pedir(s, CERRAR, TEAM, { id_configuracion: 265 });
    volverAlCerrar = true;
    assert.equal(r.status, 200, r.texto);
    assert.ok(!/estado_contacto/.test(cierres()[0].sql));
    assert.deepEqual(cierres()[0].opts.replacements, [11, 265]);
  });
  await caso('ya estaba cerrado → 409 y no deja nota ni aviso', async () => {
    limpiarCierre();
    yaCerrado = true;
    const r = await pedir(s, CERRAR, TEAM, { id_configuracion: 265 });
    yaCerrado = false;
    assert.equal(r.status, 409);
    assert.equal(notas.length + avisosSocket.length + tablero.length, 0);
  });
  await caso('no se puede: chat ajeno 404, línea ajena 404, id raro 400, admin con su login 403', async () => {
    limpiarCierre();
    assert.equal((await pedir(s, '/api/v1/equipo/chats/12/cerrar', TEAM, { id_configuracion: 265 })).status, 404);
    assert.equal((await pedir(s, CERRAR, TEAM, { id_configuracion: 999 })).status, 404);
    assert.equal((await pedir(s, '/api/v1/equipo/chats/abc/cerrar', TEAM, { id_configuracion: 265 })).status, 400);
    assert.equal((await pedir(s, CERRAR, ADMIN, { id_configuracion: 265 })).status, 403);
    assert.equal(cierres().length, 0);
    assert.equal(notas.length, 0);
  });
  await caso('«Ver como» (gerencia) sí cierra y la nota dice Gerencia', async () => {
    limpiarCierre();
    const r = await pedir(s, CERRAR, teamDe(3, { solo_lectura: true }), { id_configuracion: 265 });
    assert.equal(r.status, 200, r.texto);
    assert.ok(notas[0].texto_mensaje.startsWith('Chat cerrado por Gerencia — '), notas[0].texto_mensaje);
  });
  await caso('Instagram no lleva encuesta; con ENCUESTA_AL_CERRAR_DESDE_TEAM=0 ninguno', async () => {
    limpiarCierre();
    await pedir(s, '/api/v1/equipo/chats/14/cerrar', TEAM, { id_configuracion: 265 });
    assert.equal(encuestas.length, 0, 'el chat 14 es de Instagram');
    process.env.ENCUESTA_AL_CERRAR_DESDE_TEAM = '0';
    const r = await pedir(s, CERRAR, TEAM, { id_configuracion: 265 });
    delete process.env.ENCUESTA_AL_CERRAR_DESDE_TEAM;
    assert.equal(r.status, 200, r.texto);
    assert.equal(encuestas.length, 0, 'apagada por el interruptor');
  });

  console.log('«Enviar información» (plantilla de carga)');
  const INFO = '/api/v1/equipo/chats/11/enviar-informacion';
  const HIST = {
    estado: 'encontradas',
    total: 3,
    cliente: 'MARÍA josé Pérez',
    cotizaciones: [
      { id_cotizacion: 9, entregada: true, contenedor: 'C#1', paso_nombre: 'Entregada' },
      { id_cotizacion: 8, entregada: false, contenedor: null, paso_nombre: 'En bodega de China' },
      { id_cotizacion: 7, entregada: false, contenedor: 'C#14', paso_nombre: 'En tránsito', nota_cliente: 'Llegó al puerto; dudas al 0991234567', llegada_estimada: '4 de noviembre de 2026' },
    ],
  };
  const limpiarInfo = () => {
    plantillas = [];
    notas = [];
    plantillaFalla = false;
    plantillaReciente = false;
    historialStub = async () => HIST;
    telefonoHistorial = null;
  };
  await caso('vista previa: la carga más reciente en contenedor, sin enviar y sin el número', async () => {
    limpiarInfo();
    const r = await pedir(s, INFO, TEAM, { id_configuracion: 265 });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.body.data.id_cotizacion, 7);
    assert.equal(r.body.data.contenedor, 'C#14');
    assert.ok(r.body.data.texto.startsWith('Hola María 👋 Te escribe el equipo de Importaciones.'), r.body.data.texto);
    assert.ok(r.body.data.texto.includes('contenedor C#14:') && r.body.data.texto.includes('📅 Fecha estimada de llegada: 4 de noviembre de 2026'), r.body.data.texto);
    assert.ok(!r.texto.includes(CEL) && !r.texto.includes('0991234567'), r.texto);
    assert.equal(telefonoHistorial, CEL, 'busca por el número del chat');
    assert.equal(plantillas.length, 0);
  });
  await caso('es plantilla: sale aunque el cliente no escriba hace más de 24 h', async () => {
    limpiarInfo();
    ventanaAbierta = false;
    const r = await pedir(s, INFO, TEAM, { id_configuracion: 265, confirmar: true, id_cotizacion: 7 });
    ventanaAbierta = true;
    assert.equal(r.status, 200, r.texto);
    assert.equal(plantillas.length, 1);
  });
  await caso('confirmar: manda los 4 datos al número del chat y la deja en el historial', async () => {
    limpiarInfo();
    const r = await pedir(s, INFO, TEAM, { id_configuracion: 265, confirmar: true, id_cotizacion: 7, to: '593990000000' });
    assert.equal(r.status, 200, r.texto);
    assert.equal(plantillas.length, 1);
    const d = plantillas[0];
    assert.equal(d.to, CEL, 'el número lo pone el servidor');
    assert.deepEqual(d.p, { 1: 'María', 2: 'C#14', 3: 'Llegó al puerto; dudas al 0991234567', 4: '4 de noviembre de 2026' });
    const n = notas[notas.length - 1];
    assert.equal(n.tipo_mensaje, 'template');
    assert.equal(n.template_name, 'carga_novedad_contenedor');
    assert.equal(n.celular_recibe, '11');
    assert.equal(n.id_cliente, 1);
    assert.equal(n.responsable, 'E');
    assert.equal(JSON.parse(n.ruta_archivo).placeholders['2'], 'C#14');
    assert.equal(r.body.data.tipo_mensaje, 'template');
    assert.ok(!r.texto.includes(CEL) && !r.texto.includes('0991234567'), r.texto);
  });
  await caso('la carga cambió entre la vista previa y el envío → 409 y no envía', async () => {
    limpiarInfo();
    assert.equal((await pedir(s, INFO, TEAM, { id_configuracion: 265, confirmar: true, id_cotizacion: 9 })).status, 409, 'entregada');
    assert.equal((await pedir(s, INFO, TEAM, { id_configuracion: 265, confirmar: true, id_cotizacion: 8 })).status, 409, 'sin contenedor');
    assert.equal((await pedir(s, INFO, TEAM, { id_configuracion: 265, confirmar: true, id_cotizacion: 555 })).status, 409, 'de otro cliente');
    assert.equal((await pedir(s, INFO, TEAM, { id_configuracion: 265, confirmar: true })).status, 400, 'sin carga');
    assert.equal(plantillas.length, 0);
  });
  await caso('ya se la mandaron hace minutos → 409 y no repite', async () => {
    limpiarInfo();
    plantillaReciente = true;
    const r = await pedir(s, INFO, TEAM, { id_configuracion: 265, confirmar: true, id_cotizacion: 7 });
    assert.equal(r.status, 409, r.texto);
    assert.equal(plantillas.length, 0);
  });
  await caso('sin carga en contenedor, dos clientes o Imporsuit caído → no envía', async () => {
    limpiarInfo();
    historialStub = async () => ({ ...HIST, cotizaciones: HIST.cotizaciones.slice(0, 2) });
    assert.equal((await pedir(s, INFO, TEAM, { id_configuracion: 265 })).status, 422);
    historialStub = async () => ({ estado: 'varios_clientes', total: 0, cotizaciones: [] });
    assert.equal((await pedir(s, INFO, TEAM, { id_configuracion: 265 })).status, 422);
    historialStub = async () => ({ estado: 'error', total: 0, cotizaciones: [] });
    assert.equal((await pedir(s, INFO, TEAM, { id_configuracion: 265, confirmar: true, id_cotizacion: 7 })).status, 502);
    assert.equal(plantillas.length, 0);
  });
  await caso('«Ver como», admin, chat ajeno, Instagram u otra línea → no envía', async () => {
    limpiarInfo();
    assert.equal((await pedir(s, INFO, teamDe(3, { solo_lectura: true }), { id_configuracion: 265, confirmar: true, id_cotizacion: 7 })).status, 403);
    assert.equal((await pedir(s, INFO, ADMIN, { id_configuracion: 265, confirmar: true, id_cotizacion: 7 })).status, 403);
    assert.equal((await pedir(s, '/api/v1/equipo/chats/12/enviar-informacion', TEAM, { id_configuracion: 265, confirmar: true, id_cotizacion: 7 })).status, 404);
    assert.equal((await pedir(s, '/api/v1/equipo/chats/14/enviar-informacion', TEAM, { id_configuracion: 265, confirmar: true, id_cotizacion: 7 })).status, 422);
    assert.equal((await pedir(s, INFO, TEAM, { id_configuracion: 999, confirmar: true, id_cotizacion: 7 })).status, 404);
    const linea = plantillaCarga.LINEA;
    plantillaCarga.LINEA = 300;
    const r = await pedir(s, INFO, TEAM, { id_configuracion: 265, confirmar: true, id_cotizacion: 7 });
    plantillaCarga.LINEA = linea;
    assert.equal(r.status, 422, r.texto);
    assert.equal(plantillas.length, 0);
  });
  await caso('Meta la rechaza → 502 sin el detalle y nada en el historial', async () => {
    limpiarInfo();
    plantillaFalla = true;
    const r = await pedir(s, INFO, TEAM, { id_configuracion: 265, confirmar: true, id_cotizacion: 7 });
    assert.equal(r.status, 502, r.texto);
    assert.ok(!r.texto.includes('591') && !r.texto.includes(CEL) && !r.texto.includes('131026'), r.texto);
    assert.equal(notas.length, 0);
  });
  await caso('datos de la plantilla: sin nota, sin fecha, nombre raro y saltos de línea', async () => {
    const p = plantillaCarga.parametros({ contenedor: ' C#2 ', paso_nombre: 'En tránsito' }, '🙂');
    assert.deepEqual(p, { 1: 'Importador', 2: 'C#2', 3: 'Tu carga está en: En tránsito.', 4: 'por confirmar' });
    const q = plantillaCarga.parametros({ contenedor: 'C#3', nota_cliente: 'línea 1\n\nlínea\t2      fin' }, 'ángel');
    assert.equal(q[1], 'Ángel');
    assert.equal(q[3], 'línea 1 línea 2 fin');
    assert.equal(plantillaCarga.parametros({ contenedor: 'C#4' }, '')[3], 'Tu carga ya está en el contenedor.');
    assert.equal(plantillaCarga.elegirCarga([{ id_cotizacion: 1, entregada: false, contenedor: '  ' }]), null);
  });

  console.log = silenciar;
  s.close();
  console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
  process.exit(fallos ? 1 : 0);
})();
