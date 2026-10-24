/*  Prueba de utils/taparTelefonos.js. No necesita base ni dependencias.
 *  Los números son inventados.
 *    node scripts/probar_tapar_telefonos.js
 */
const assert = require('assert');
const path = require('path');
const { taparTelefonos, enmascararTelefono } = require(path.join(__dirname, '..', 'src/utils/taparTelefonos'));

const CEL = '593991234567';
let fallos = 0;
function caso(nombre, fn) {
  try {
    fn();
    console.log('  ok  ', nombre);
  } catch (e) {
    fallos += 1;
    console.log('  FALLA', nombre, '—', e.message);
  }
}
const sinCifras = (s) => !/\d{5,}/.test(String(s).replace(/•••• \d{4}/g, ''));

caso('enmascararTelefono', () => {
  assert.equal(enmascararTelefono(CEL), '•••• 4567');
  assert.equal(enmascararTelefono('+593 99 123 4567'), '•••• 4567');
  assert.equal(enmascararTelefono('12'), '••••');
  assert.equal(enmascararTelefono(null), null);
  assert.equal(enmascararTelefono(''), '');
});

caso('claves de teléfono en un objeto plano', () => {
  const r = taparTelefonos({ id: 7, celular_cliente: CEL, uid_cliente: CEL, telefono_limpio: '0991234567', nombre_cliente: 'Ana' });
  assert.deepEqual(r, { id: 7, celular_cliente: '•••• 4567', uid_cliente: '•••• 4567', telefono_limpio: '•••• 4567', nombre_cliente: 'Ana' });
});

caso('anidado y en arrays', () => {
  const r = taparTelefonos({ chats: [{ cliente: { celular_cliente: CEL } }, { telefono: 5215512345678 }] });
  assert.equal(r.chats[0].cliente.celular_cliente, '•••• 4567');
  assert.equal(r.chats[1].telefono, '•••• 5678');
});

caso('fila de Sequelize (toJSON)', () => {
  const fila = { toJSON: () => ({ celular_cliente: CEL, id: 1 }), celular_cliente: 'no-debe-salir' };
  assert.deepEqual(taparTelefonos([fila]), [{ celular_cliente: '•••• 4567', id: 1 }]);
});

caso('no cambia el original', () => {
  const o = { celular_cliente: CEL };
  taparTelefonos(o);
  assert.equal(o.celular_cliente, CEL);
});

caso('el wamid se quita como clave', () => {
  const r = taparTelefonos({ id: 3, id_wamid_mensaje: 'wamid.HBgMNTkzOTkxMjM0NTY3FQIAERgS', context_wamid: 'wamid.x' });
  assert.deepEqual(r, { id: 3 });
});

caso('el wamid se quita por su valor dentro de un texto', () => {
  const r = taparTelefonos({ nota: 'ver wamid.HBgMNTkzOTkxMjM0NTY3FQIAERgS fin' });
  assert.ok(!r.nota.includes('wamid'), r.nota);
});

caso('JSON guardado como texto (ruta_archivo con original_message_id)', () => {
  const r = taparTelefonos({ ruta_archivo: JSON.stringify({ original_message_id: 'wamid.ABC', url: 'https://x/y.jpg' }) });
  const j = JSON.parse(r.ruta_archivo);
  assert.equal(j.original_message_id, undefined);
  assert.equal(j.url, 'https://x/y.jpg');
});

caso('json_mensaje de Meta: from y wa_id', () => {
  const meta = { messages: [{ from: CEL, id: 'wamid.QQ', text: { body: 'hola' } }], contacts: [{ wa_id: CEL }] };
  const r = taparTelefonos({ json_mensaje: JSON.stringify(meta) });
  assert.ok(!r.json_mensaje.includes(CEL), r.json_mensaje);
  assert.ok(!r.json_mensaje.includes('wamid'), r.json_mensaje);
});

caso('ruta_archivo que es una URL simple queda igual', () => {
  assert.equal(taparTelefonos({ ruta_archivo: 'https://cdn/x/123456789.jpg' }).ruta_archivo, 'https://cdn/x/123456789.jpg');
});

caso('el cliente escribe su propio número con espacios', () => {
  const r = taparTelefonos({ celular_cliente: CEL, texto_mensaje: 'mi número es 099 123 4567 gracias' });
  assert.ok(sinCifras(r.texto_mensaje), r.texto_mensaje);
});

caso('número de otra persona detrás de «cel»', () => {
  const r = taparTelefonos({ texto_mensaje: 'llama a mi esposa cel: 0987654321' });
  assert.ok(sinCifras(r.texto_mensaje), r.texto_mensaje);
});

caso('número con +593 y +52 sin palabra clave', () => {
  const r = taparTelefonos({ texto_mensaje: 'escríbeme al +593 98 765 4321 o al +52 55 1234 5678' });
  assert.ok(sinCifras(r.texto_mensaje), r.texto_mensaje);
});

caso('cédula o número de guía sin palabra clave se queda', () => {
  const t = 'mi cédula 1712345678 y la guía 88123456789';
  assert.equal(taparTelefonos({ texto_mensaje: t }).texto_mensaje, t);
});

caso('la llave de Meta no sale', () => {
  const r = taparTelefonos({ configuracion: { id: 265, token: 'EAAG...', wa_token: 'x', access_token: 'y', nombre: 'L' } });
  assert.deepEqual(r, { configuracion: { id: 265, nombre: 'L' } });
});

caso('from/to que no son teléfono (rango de fechas) quedan', () => {
  const r = taparTelefonos({ rango: { from: '2026-10-01', to: '2026-10-24' } });
  assert.deepEqual(r, { rango: { from: '2026-10-01', to: '2026-10-24' } });
});

caso('null, fechas, números sueltos e ids no se tocan', () => {
  const f = new Date(0);
  const r = taparTelefonos({ a: null, b: undefined, fecha: f, celular_recibe: 123456789, total: 5000000 });
  assert.equal(r.a, null);
  assert.equal(r.fecha, f);
  assert.equal(r.celular_recibe, 123456789);
  assert.equal(r.total, 5000000);
  assert.ok('b' in r);
});

caso('un ciclo no cuelga', () => {
  const o = { celular_cliente: CEL };
  o.yo = o;
  const r = taparTelefonos(o);
  assert.equal(r.celular_cliente, '•••• 4567');
});

caso('telefonosConocidos tapa un número que no venía en la respuesta', () => {
  const r = taparTelefonos({ texto_mensaje: 'soy yo, 0991234567' }, { telefonosConocidos: [CEL] });
  assert.ok(sinCifras(r.texto_mensaje), r.texto_mensaje);
});

console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
process.exit(fallos ? 1 : 0);
