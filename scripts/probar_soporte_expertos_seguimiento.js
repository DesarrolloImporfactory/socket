/* Pruebas del seguimiento al cliente de Expertos que quedó esperando
   (soporteExpertos/seguimiento.js). Sin red ni base.
   Uso: node scripts/probar_soporte_expertos_seguimiento.js */

'use strict';

const path = require('path');
// `ajustesIA` importa la base solo para leer la fila; aquí no se usa.
const rutaDb = require.resolve(path.join(__dirname, '../src/database/config'));
require.cache[rutaDb] = { id: rutaDb, filename: rutaDb, loaded: true, exports: { db: {}, db_2: {} } };

const { decidirSeguimiento, esAutomatico, UMBRAL_CLIENTE } = require('../src/utils/soporteExpertos/seguimiento');
const { minutosHabiles } = require('../src/utils/soporteExpertos/horario');
const T = require('../src/utils/soporteExpertos/textos');
const ajustes = require('../src/utils/ajustesIA');

let ok = 0;
let fallos = 0;
function prueba(nombre, pasa, detalle = '') {
  if (pasa) {
    ok++;
    console.log(`  OK    ${nombre}`);
  } else {
    fallos++;
    console.log(`  FALLA ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

// Hora de Ecuador → ms. El 26-oct-2026 es lunes; el 23, viernes.
const ec = (dia, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return Date.UTC(2026, 9, dia, h + 5, m);
};
let id = 0;
const cli = (t, tx, tm = 'text') => ({ id: ++id, rol: 0, resp: null, t, tx, tm });
const bot = (t, tx = T.MENSAJE_ASESOR) => ({ id: ++id, rol: 1, resp: 'IA_Contacto', t, tx, tm: 'text' });
const humano = (t, tx = 'Hola, ya te ayudo') => ({ id: ++id, rol: 1, resp: 'Johan', t, tx, tm: 'text' });
const seg = (t) => ({ id: ++id, rol: 1, resp: 'IA_Seguimiento Expertos', t, tx: 'Sigo pendiente…', tm: 'text' });
const EC = '593987000111';
const MX = '5215512345678';
const d = (mensajes, ahora, telefono = EC) => decidirSeguimiento({ mensajes, ahora, telefono });

console.log('1. Minutos de oficina (L-V 08:00-17:30, Ecuador)');
prueba('lunes 10:00 → 13:00 = 180', minutosHabiles(ec(26, '10:00'), ec(26, '13:00')) === 180);
prueba('viernes 17:00 → lunes 09:00 = 90 (sin noche ni fin de semana)', minutosHabiles(ec(23, '17:00'), ec(26, '09:00')) === 90);
prueba('sábado entero = 0', minutosHabiles(ec(24, '08:00'), ec(24, '20:00')) === 0);
prueba('al revés = 0', minutosHabiles(ec(26, '13:00'), ec(26, '10:00')) === 0);

console.log('\n2. El bot le dijo «un asesor te escribe» y nadie le escribió');
let r = d([cli(ec(26, '08:30'), 'quiero cotizar 500 lámparas'), bot(ec(26, '08:31'))], ec(26, '12:00'));
prueba('3 h 30 de oficina después: se le escribe', r.caso === 'espera_asesor' && r.accion === 'texto', JSON.stringify(r));
prueba('el texto dice el área (cotizaciones) y no promete hora', /área de cotizaciones/.test(r.texto) && !/apenas abramos|hoy|minutos|horas/.test(r.texto), r.texto);
prueba('la persona es Belén', r.destino?.id === 378);
r = d([cli(ec(26, '08:30'), 'quiero cotizar'), bot(ec(26, '08:31')), cli(ec(26, '08:32'), 'ok gracias')], ec(26, '12:00'));
prueba('su «ok gracias» no reinicia el reloj ni lo cierra', r.caso === 'espera_asesor' && r.esperaMin >= UMBRAL_CLIENTE);
r = d([cli(ec(26, '10:00'), 'dónde está mi carga'), bot(ec(26, '10:01'))], ec(26, '11:30'));
prueba('con 1 h 30 todavía no', r.caso === null && /espera 90/.test(r.razon));
r = d([cli(ec(26, '08:30'), 'dónde está mi carga'), bot(ec(26, '08:31'))], ec(26, '12:00'), MX);
prueba('logística de México → Johan', r.destino?.id === 377 && /logística/.test(r.texto));

console.log('\n3. Cuándo NO se le escribe');
r = d([cli(ec(26, '08:30'), 'quiero cotizar'), bot(ec(26, '08:31')), humano(ec(26, '09:00'))], ec(26, '12:00'));
prueba('una persona ya le escribió', r.caso === null);
r = d([cli(ec(26, '08:30'), 'quiero cotizar'), bot(ec(26, '08:31')), seg(ec(26, '11:40'))], ec(26, '12:00'));
prueba('ya se le hizo seguimiento a este turno', r.caso === null && /ya se le hizo/.test(r.razon));
r = d(
  [seg(ec(21, '10:00')), humano(ec(21, '10:30')), seg(ec(22, '10:00')), humano(ec(22, '10:30')), cli(ec(26, '08:30'), 'hola, la factura?'), bot(ec(26, '08:31'))],
  ec(26, '12:00'),
);
prueba('tope de 2 seguimientos en 7 días', r.caso === null && /tope/.test(r.razon));
r = d([cli(ec(26, '08:30'), 'quiero cotizar'), bot(ec(26, '08:31'))], ec(26, '18:00'));
prueba('fuera del horario del equipo: solo se lista', r.caso === 'espera_asesor' && r.accion === 'listar' && !r.texto);
r = d(
  [cli(ec(26, '08:30'), 'quiero cotizar'), bot(ec(26, '08:31')), { id: ++id, rol: 1, resp: 'cron_template_programado', t: ec(26, '09:00'), tx: 'Hola, seguimiento…', tm: 'template' }],
  ec(26, '12:00'),
);
prueba('ya le llegó una plantilla programada: solo se lista', r.accion === 'listar' && /plantilla programada/.test(r.razon));
r = d([cli(ec(23, '09:00'), 'quiero cotizar'), bot(ec(23, '09:01'))], ec(26, '12:00'));
prueba('pasaron más de 24 h desde su último mensaje: necesita plantilla, no texto', r.accion === 'plantilla' && !r.texto);
r = d([humano(ec(26, '08:00')), cli(ec(26, '08:30'), 'Muchas gracias 🙏')], ec(26, '12:00'));
prueba('solo dijo «gracias»: nada', r.caso === null);
r = d([cli(ec(26, '08:30'), 'Gracias por tu mensaje. En este momento no podemos atenderte.')], ec(26, '12:00'));
prueba('es el bot de su tienda: nada', r.caso === null);
r = d([cli(ec(26, '08:30'), 'quiero cotizar'), bot(ec(26, '08:31'), T.MENSAJE_CLASE)], ec(26, '12:00'));
prueba('el bot le resolvió (no fue un pase): nada', r.caso === null && /el bot le respondi/.test(r.razon));

console.log('\n4. Gestión con un asesor sin respuesta: solo se lista para el equipo');
r = d([humano(ec(26, '08:00')), cli(ec(26, '08:30'), '¿y cuánto sale el flete?')], ec(26, '11:00'));
prueba('2 h 30 sin respuesta: espera_equipo para Belén, sin texto', r.caso === 'espera_equipo' && r.accion === 'listar' && r.destino.id === 378 && !r.texto);
r = d([humano(ec(26, '08:00')), cli(ec(26, '08:30'), '¿y cuánto sale el flete?')], ec(26, '09:30'));
prueba('1 h: todavía no', r.caso === null);
r = d(
  [humano(ec(26, '08:00')), cli(ec(26, '08:30'), '¿y el flete?'), { id: ++id, rol: 3, resp: 'IA_Escalado Expertos', t: ec(26, '08:31'), tx: 'nota', tm: 'notificacion' }],
  ec(26, '11:00'),
);
prueba('las notas internas no cuentan como respuesta', r.caso === 'espera_equipo');

console.log('\n5. Quién cuenta como persona');
prueba('IA_, cron_, Automatizador, Soporte y Sistema de valoraciones son automáticos', ['IA_Contacto', 'cron_template_programado', 'Automatizador | Cotizador Pro', 'Soporte', 'Sistema de valoraciones'].every(esAutomatico));
prueba('Johan, Belen y «Whatsapp» (contestó desde el celular) son personas', !['Johan', 'Belen', 'Whatsapp'].some(esAutomatico));

console.log('\n6. Ajustes y textos');
const n = (v) => ajustes.normalizar({ soporte_expertos: v }).soporte_expertos.seguimiento;
prueba('sin la clave: apagado', n({}) === false);
prueba('«simulado» y «real» se guardan; true queda apagado', n({ seguimiento: 'simulado' }) === 'simulado' && n({ seguimiento: 'real' }) === 'real' && n({ seguimiento: true }) === false);
prueba('el texto sigue SIN aprobar (no se le escribe a nadie)', T.SEGUIMIENTO_APROBADO === false);
prueba('el texto no está en los textos fijos de la guardia', !Object.values(T.TEXTOS_FIJOS).includes(T.MENSAJE_SEGUIMIENTO));

console.log(`\n${fallos ? `HAY FALLAS: ${fallos} fallan, ${ok} pasan` : `TODO BIEN: ${ok} pasan, 0 fallan`}`);
process.exit(fallos ? 1 : 0);
