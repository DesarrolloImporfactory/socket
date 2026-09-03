/* Prueba de SOLO LECTURA de los endpoints nuevos de la API pública
   (GET /conversaciones y GET /conversaciones/:id/mensajes) contra la cfg 277.
   No envía nada: ejecuta los handlers con un req falso. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { db } = require('../src/database/config');
const ctrl = require('../src/controllers/public_mensajes.controller');

function fakeRes() {
  const r = { statusCode: 200 };
  r.status = (c) => ((r.statusCode = c), r);
  r.json = (b) => ((r.body = b), r);
  return r;
}
const correr = (handler, req) =>
  new Promise((resolve) => {
    const res = fakeRes();
    const next = (err) => resolve({ err, res });
    res.json = ((orig) => (b) => {
      orig(b);
      resolve({ res });
      return res;
    })(res.json);
    handler(req, res, next);
  });

(async () => {
  const [contacto] = await db.query(
    `SELECT id, celular_cliente FROM clientes_chat_center
      WHERE id_configuracion = 277 AND deleted_at IS NULL
        AND COALESCE(celular_last9,'') <> '' AND propietario = 0
      ORDER BY ultimo_mensaje_at DESC LIMIT 1`,
    { type: db.QueryTypes.SELECT },
  );
  if (!contacto) throw new Error('cfg 277 sin contactos');
  console.log('contacto de prueba:', contacto.id);

  // 1) buscar por teléfono con formato "sucio" (+ y espacio)
  const telSucio = '+' + String(contacto.celular_cliente).replace(/(\d{3})/, '$1 ');
  let r = await correr(ctrl.conversacionBuscar, {
    id_configuracion: 277,
    query: { telefono: telSucio },
  });
  console.log('\nGET /conversaciones →', r.err ? `ERR ${r.err.message}` : JSON.stringify(r.res.body, null, 2));

  // 2) teléfono inexistente → 404 con guía
  r = await correr(ctrl.conversacionBuscar, {
    id_configuracion: 277,
    query: { telefono: '573999999990' },
  });
  console.log('\nGET /conversaciones (inexistente) → status', r.res?.statusCode, r.err ? `ERR ${r.err.message}` : r.res.body?.mensaje);

  // 3) mensajes del chat (5)
  r = await correr(ctrl.conversacionMensajes, {
    id_configuracion: 277,
    params: { id: contacto.id },
    query: { limit: 5 },
  });
  if (r.err) console.log('\nmensajes ERR', r.err.message);
  else {
    const d = r.res.body.data;
    console.log('\nGET /conversaciones/:id/mensajes → chat', d.chat_id, 'total', d.mensajes.length, 'cursor', d.paginacion.antes_de_id);
    for (const m of d.mensajes) {
      console.log(` [${m.de}] ${m.tipo} :: ${String(m.texto).slice(0, 60)}${m.tipo === 'audio' ? ' | transcripcion=' + String(m.transcripcion).slice(0, 40) : ''}`);
    }
  }

  // 4) un chat con audio transcrito, para verificar el campo
  const [audio] = await db.query(
    `SELECT celular_recibe FROM mensajes_clientes
      WHERE id_configuracion = 277 AND tipo_mensaje = 'audio'
        AND COALESCE(texto_mensaje,'') <> '' AND deleted_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    { type: db.QueryTypes.SELECT },
  );
  if (audio) {
    r = await correr(ctrl.conversacionMensajes, {
      id_configuracion: 277,
      params: { id: audio.celular_recibe },
      query: { limit: 50 },
    });
    const conAudio = (r.res?.body?.data?.mensajes || []).filter((m) => m.tipo === 'audio');
    console.log('\nchat con audios:', audio.celular_recibe, '→ audios en página:', conAudio.length);
    conAudio.slice(0, 3).forEach((m) => console.log('  transcripcion:', String(m.transcripcion).slice(0, 80)));
  } else {
    console.log('\n(cfg 277 sin audios transcritos aún)');
  }

  // 5) chat de otra config → debe dar 404
  r = await correr(ctrl.conversacionMensajes, {
    id_configuracion: 277,
    params: { id: 1 },
    query: {},
  });
  console.log('\nchat ajeno →', r.err ? `bloqueado OK (${r.err.statusCode})` : 'FUGA: devolvió datos');

  process.exit(0);
})().catch((e) => {
  console.error('ERR', e);
  process.exit(1);
});
