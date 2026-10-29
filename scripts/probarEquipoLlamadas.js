/* Pruebas de los ayudantes de llamadas desde Team (sin base de datos):
 *   node scripts/probarEquipoLlamadas.js
 * Lo importante: la señal de audio (SDP) sale del servidor por el tapado de
 * teléfonos del rol «equipo»; escrita con letras tiene que llegar idéntica. */
const assert = require('assert');
const { aLetras, deLetras, puentes, habilitado, chatEnPrueba, zadarmaPrendido, faseWa, listaIds } = require('../src/utils/equipoLlamadas');
const { taparTelefonos } = require('../src/utils/taparTelefonos');

// SDP como las de Meta: ssrc de 9 cifras que empiezan en 9, puertos, IPs.
const SDP = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=audio 3478 UDP/TLS/RTP/SAVPF 111 126',
  'c=IN IP4 157.240.19.130',
  'a=candidate:1 1 udp 2122260223 157.240.19.130 3478 typ host generation 0',
  'a=candidate:2 1 udp 1686052607 593 99 926 3107 typ srflx',
  'a=ice-ufrag:0991234567',
  'a=fingerprint:sha-256 0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9:0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9',
  'a=ssrc:912345678 cname:wa',
  'a=ssrc:5939992631 msid:x',
  '',
].join('\r\n');

let ok = 0;
const prueba = (nombre, fn) => {
  fn();
  ok += 1;
  console.log('✓', nombre);
};

prueba('sin codificar, el tapado SÍ rompe la SDP (por eso se codifica)', () => {
  const r = taparTelefonos({ data: { audio: SDP } });
  assert.notStrictEqual(r.data.audio, SDP);
});

prueba('codificada pasa por el tapado sin un cambio y vuelve igual', () => {
  const cod = aLetras(SDP);
  assert.ok(/^[g-v]+$/.test(cod), 'solo letras');
  const r = taparTelefonos({ status: 'success', data: { llamada: 123, fase: 'en_curso', audio: cod } });
  assert.strictEqual(r.data.audio, cod);
  assert.strictEqual(deLetras(r.data.audio), SDP);
});

prueba('texto con tildes y emojis vuelve igual', () => {
  const t = 'ñandú 📞 ¿sí? 0991234567';
  assert.strictEqual(deLetras(aLetras(t)), t);
});

prueba('puentes: «265:818, 242:818» y basura ignorada', () => {
  assert.deepStrictEqual(puentes('265:818, 242:818,x:1,3:,:4'), { 265: 818, 242: 818 });
  assert.deepStrictEqual(puentes(''), {});
  assert.deepStrictEqual(puentes(undefined), {});
});

prueba('chatEnPrueba: vacío = todos; con lista, solo esos', () => {
  assert.strictEqual(chatEnPrueba(5, {}), true);
  assert.strictEqual(chatEnPrueba(239984, { EQUIPO_LLAMADAS_CHATS: '239984' }), true);
  assert.strictEqual(chatEnPrueba('239984', { EQUIPO_LLAMADAS_CHATS: ' 239984 , 7' }), true);
  assert.strictEqual(chatEnPrueba(5, { EQUIPO_LLAMADAS_CHATS: '239984' }), false);
});

prueba('habilitado: apagado sin EQUIPO_LLAMADAS=1; lista de asesores', () => {
  assert.strictEqual(habilitado(378, {}), false);
  assert.strictEqual(habilitado(378, { EQUIPO_LLAMADAS: '0', EQUIPO_LLAMADAS_SUBS: '378' }), false);
  assert.strictEqual(habilitado(378, { EQUIPO_LLAMADAS: '1' }), true);
  assert.strictEqual(habilitado(378, { EQUIPO_LLAMADAS: '1', EQUIPO_LLAMADAS_SUBS: '378,377' }), true);
  assert.strictEqual(habilitado(1886, { EQUIPO_LLAMADAS: '1', EQUIPO_LLAMADAS_SUBS: '378,377' }), false);
  // mal escrita (sin ningún id válido) = nadie
  assert.strictEqual(habilitado(378, { EQUIPO_LLAMADAS: '1', EQUIPO_LLAMADAS_SUBS: 'x' }), false);
  assert.deepStrictEqual(listaIds(' '), null);
});

prueba('Zadarma solo con EQUIPO_LLAMADAS_ZADARMA=1', () => {
  assert.strictEqual(zadarmaPrendido({}), false);
  assert.strictEqual(zadarmaPrendido({ EQUIPO_LLAMADAS_ZADARMA: '1' }), true);
});

prueba('fases de WhatsApp', () => {
  assert.deepStrictEqual(faseWa({ estado: 'llamando' }, {}), { fase: 'llamando' });
  assert.deepStrictEqual(faseWa({ estado: 'accepted' }, {}), { fase: 'en_curso' });
  assert.deepStrictEqual(faseWa({ estado: 'rejected_cliente' }, {}), { fase: 'terminada', motivo: 'rechazada' });
  assert.deepStrictEqual(faseWa(null, { estado: 'completed', duracion_seg: 42, fin_at: new Date() }), { fase: 'terminada', motivo: 'completada', duracion_seg: 42 });
  assert.deepStrictEqual(faseWa(null, { estado: 'missed', fin_at: new Date() }), { fase: 'terminada', motivo: 'no_contesto', duracion_seg: 0 });
  assert.deepStrictEqual(faseWa(null, { estado: 'ringing' }), { fase: 'terminada', motivo: 'fallo' });
});

console.log(`\n${ok} pruebas bien`);
