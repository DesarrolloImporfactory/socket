/* Pruebas de «Consentidos» (soporteExpertos/consentidos.js): qué momento le
   toca a cada alumno, los candados y los textos. Sin red ni base.
   Uso: node scripts/probar_soporte_expertos_consentidos.js */

'use strict';

const fs = require('fs');
const path = require('path');
const C = require('../src/utils/soporteExpertos/consentidos');
const T = require('../src/utils/soporteExpertos/textos');

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
const claves = (l) => l.map((x) => x.momento).join(',');
const REF = '2026-10-24';
const cont = (o = {}) => ({ nombre: 'MAR-24', destino: 'ec', estado: 'cerrado', fecha_cierre: '2026-10-01', ...o });

console.log('1. Carga: un momento por hecho del día');
prueba('marca recibida ese día → recibido_china con cajas', (() => {
  const m = C.momentosDeCarga({ marcas: [{ codigo: 'EC-77', fecha_recibida: '2026-10-24 15:02:00', cajas: 3 }, { codigo: 'EC-78', fecha_recibida: '2026-10-20', cajas: 9 }] }, REF);
  return claves(m) === 'recibido_china' && m[0].datos.cajas === 3 && m[0].datos.marca === 'EC-77';
})());
prueba('marca recibida otro día → nada', C.momentosDeCarga({ marcas: [{ codigo: 'EC-1', fecha_recibida: '2026-10-23' }] }, REF).length === 0);
prueba('subió al contenedor ese día (aún abierto) → en_contenedor', claves(C.momentosDeCarga({ asignada: REF, contenedor: cont({ fecha_cierre: null }) }, REF)) === 'en_contenedor');
prueba('subió y el contenedor ya se cerró → no repite «en contenedor»', !claves(C.momentosDeCarga({ asignada: REF, contenedor: cont({ fecha_cierre: REF }) }, REF)).includes('en_contenedor'));
prueba('se cerró ese día → contenedor_cerrado', claves(C.momentosDeCarga({ contenedor: cont({ fecha_cierre: REF }) }, REF)) === 'contenedor_cerrado');
prueba('zarpó ese día → zarpo (gana a cerrado)', C.momentosDeCarga({ contenedor: cont({ fecha_cierre: REF, fecha_salida: REF }) }, REF)[0].momento === 'zarpo');
prueba('llegó a puerto → puerto', claves(C.momentosDeCarga({ contenedor: cont({ fecha_salida: '2026-10-02', fecha_puerto: REF }) }, REF)) === 'puerto');
prueba('llegó a la bodega → bodega_destino primero', C.momentosDeCarga({ contenedor: cont({ fecha_puerto: REF, fecha_bodega_destino: REF }) }, REF)[0].momento === 'bodega_destino');
prueba('nota para el cliente escrita ese día → novedad con la nota', (() => {
  const m = C.momentosDeCarga({ contenedor: cont({ nota_cliente: 'Retraso de la naviera', nota_cliente_at: '2026-10-24 09:00' }) }, REF);
  return m.some((x) => x.momento === 'novedad' && x.datos.nota === 'Retraso de la naviera');
})());
prueba('nota vacía → no hay novedad', !claves(C.momentosDeCarga({ contenedor: cont({ nota_cliente: '  ', nota_cliente_at: REF }) }, REF)).includes('novedad'));
prueba('entrega «entregada» ese día → entregada', claves(C.momentosDeCarga({ entrega: { estado: 'entregada', fecha_entrega: REF } }, REF)) === 'entregada');

console.log('\n2. Sigue en camino (cada 10 días)');
prueba('día 10 desde el zarpe → sigue_en_camino', claves(C.momentosDeCarga({ contenedor: cont({ fecha_salida: '2026-10-14' }) }, REF)) === 'sigue_en_camino');
prueba('día 20 desde el cierre sin zarpe → sigue_en_camino', claves(C.momentosDeCarga({ contenedor: cont({ fecha_cierre: '2026-10-04' }) }, REF)) === 'sigue_en_camino');
prueba('día 11 → nada', C.momentosDeCarga({ contenedor: cont({ fecha_salida: '2026-10-13' }) }, REF).length === 0);
prueba('ya llegó a puerto → no dice «sigue en camino»', C.momentosDeCarga({ contenedor: cont({ fecha_salida: '2026-10-14', fecha_puerto: '2026-10-20' }) }, REF).length === 0);
prueba('contenedor en aduana o liberado → ya no «sigue en camino»', ['aduana', 'liberado', 'bodega_destino'].every((e) => C.momentosDeCarga({ contenedor: cont({ fecha_salida: '2026-10-14', estado: e }) }, REF).length === 0));
prueba('en tránsito → sí', claves(C.momentosDeCarga({ contenedor: cont({ fecha_salida: '2026-10-14', estado: 'entransito' }) }, REF)) === 'sigue_en_camino');
prueba('estado desconocido → nada (no se adivina)', C.momentosDeCarga({ contenedor: cont({ fecha_salida: '2026-10-14', estado: 'raro' }) }, REF).length === 0);
prueba('con novedad escrita → cuenta la novedad, no «sin novedades»', (() => {
  const m = C.momentosDeCarga({ contenedor: cont({ fecha_salida: '2026-10-14', nota_cliente: 'Transbordo en Panamá' }) }, REF)[0];
  const t = C.textoDe(m.momento, m.datos, 'Ana');
  return /«Transbordo en Panamá»/.test(t) && !/sin novedades/.test(t);
})());
prueba('contenedor finalizado → nada', C.momentosDeCarga({ contenedor: cont({ fecha_salida: '2026-10-14', estado: 'finalizado' }) }, REF).length === 0);
prueba('estimada vencida no se nombra', C.momentosDeCarga({ contenedor: cont({ fecha_salida: '2026-10-14', fecha_estimada: '2026-10-20' }) }, REF)[0].datos.estimada === null);
prueba('estimada futura sí se nombra', C.momentosDeCarga({ contenedor: cont({ fecha_salida: '2026-10-14', fecha_estimada: '2026-11-30' }) }, REF)[0].datos.estimada === '2026-11-30');

console.log('\n3. Fecha estimada vencida (solo equipo)');
prueba('venció ayer y no llegó → aviso al equipo', C.estimadaVencida(cont({ fecha_estimada: '2026-10-23' }), REF));
prueba('venció hace 5 días → ya se avisó, no se repite', !C.estimadaVencida(cont({ fecha_estimada: '2026-10-19' }), REF));
prueba('ya llegó a la bodega → no', !C.estimadaVencida(cont({ fecha_estimada: '2026-10-23', fecha_bodega_destino: '2026-10-22' }), REF));
prueba('contenedor sin cerrar → no', !C.estimadaVencida(cont({ fecha_cierre: null, fecha_estimada: '2026-10-23' }), REF));

console.log('\n4. Alumno: pagos, logro, reunión, clases');
prueba('pago registrado ese día → pago_recibido con el monto sumado', (() => {
  const m = C.momentosDeAlumno({ pagos: [{ fecha: REF, monto: 100, moneda: 'USD' }, { fecha: REF, monto: 50.5, moneda: 'USD' }, { fecha: '2026-10-01', monto: 9 }] }, REF);
  return claves(m) === 'pago_recibido' && m[0].datos.monto === '$150.50';
})());
prueba('pago en pesos → «MXN»', C.momentosDeAlumno({ pagos: [{ fecha: REF, monto: 1200, moneda: 'MXN' }] }, REF)[0].datos.monto === '$1,200.00 MXN');
prueba('pago de 0 → nada', C.momentosDeAlumno({ pagos: [{ fecha: REF, monto: 0 }] }, REF).length === 0);
prueba('completó módulos 1 y 2 ese día → logro con el enlace de la agenda', (() => {
  const m = C.momentosDeAlumno({ modulosListosEl: '2026-10-24 18:00' }, REF);
  return claves(m) === 'logro' && /contenido=737/.test(m[0].datos.enlace);
})());
prueba('reunión ese día → post_reunion con el día', (() => {
  const m = C.momentosDeAlumno({ reuniones: [{ inicio: '2026-10-24 10:00', estado: 'Agendado' }] }, REF);
  return claves(m) === 'post_reunion' && m[0].datos.dia === 'sábado 24';
})());
prueba('reunión cancelada → nada', C.momentosDeAlumno({ reuniones: [{ inicio: REF, estado: 'Cancelado' }] }, REF).length === 0);
prueba('día 3 sin ninguna lección → primera_clase', claves(C.momentosDeAlumno({ alta: '2026-10-21 12:00', lecciones: 0 }, REF)) === 'primera_clase');
prueba('día 3 pero ya vio una → nada', C.momentosDeAlumno({ alta: '2026-10-21', lecciones: 1 }, REF).length === 0);
prueba('día 4 sin lecciones → nada (solo se dice una vez)', C.momentosDeAlumno({ alta: '2026-10-20', lecciones: 0 }, REF).length === 0);
prueba('14 días sin avanzar con 5+ lecciones → te_guarde con la lección', (() => {
  const m = C.momentosDeAlumno({ lecciones: 8, ultimoAvance: '2026-10-10 20:00', ultimaLeccion: { titulo: 'CASH RAPIDO', enlace: 'https://imporfactory.app/cursos/30?contenido=960' } }, REF);
  return claves(m) === 'te_guarde' && m[0].datos.leccion === 'CASH RAPIDO';
})());
prueba('14 días pero solo 3 lecciones → nada', C.momentosDeAlumno({ lecciones: 3, ultimoAvance: '2026-10-10', ultimaLeccion: { titulo: 'X', enlace: 'u' } }, REF).length === 0);
prueba('sin enlace de la lección → nada', C.momentosDeAlumno({ lecciones: 8, ultimoAvance: '2026-10-10', ultimaLeccion: { titulo: 'X' } }, REF).length === 0);

console.log('\n5. Prioridad');
prueba('carga gana a pago, pago a curso', C.elegir([{ momento: 'te_guarde' }, { momento: 'pago_recibido' }, { momento: 'sigue_en_camino' }]).momento === 'sigue_en_camino');
prueba('bodega_destino gana a todo', C.elegir([{ momento: 'recibido_china' }, { momento: 'bodega_destino' }, { momento: 'logro' }]).momento === 'bodega_destino');
prueba('sin momentos → null', C.elegir([]) === null);

console.log('\n6. Candados');
const AHORA = Date.UTC(2026, 9, 25, 14, 0); // domingo 25-oct 09:00 de Ecuador
const H = 3600 * 1000;
const chat = { id: 1, bot_openia: 1 };
const cli = (horas, tx = 'hola') => ({ rol: 0, resp: null, t: AHORA - horas * H, tx });
const per = (horas, resp = 'Johan') => ({ rol: 1, resp, t: AHORA - horas * H, tx: 'te ayudo' });
const cand = (o) => C.aplicarCandados({ momento: 'zarpo', chat, ahora: AHORA, ...o });
prueba('pidió que no le escriban → no', cand({ mensajes: [cli(100, 'Por favor ya no me escriban más')] }).accion === 'no');
prueba('«stop» → no', cand({ mensajes: [cli(30, 'STOP')] }).accion === 'no');
prueba('baja vista más atrás → no', cand({ bajas: true }).accion === 'no');
prueba('sin chat en la línea → no', C.aplicarCandados({ momento: 'zarpo', chat: null, ahora: AHORA }).accion === 'no');
prueba('bot apagado en el chat → aviso al asesor', cand({ chat: { id: 1, bot_openia: 0 } }).accion === 'aviso_asesor');
prueba('un asesor le escribió hace 3 h → aviso al asesor', cand({ mensajes: [cli(4), per(3)] }).accion === 'aviso_asesor');
prueba('«Whatsapp» (desde el celular) también es persona', cand({ mensajes: [per(2, 'Whatsapp')] }).accion === 'aviso_asesor');
prueba('el asesor escribió hace 30 h → ya no frena', cand({ mensajes: [per(30)] }).accion !== 'aviso_asesor');
prueba('la respuesta del bot no frena', cand({ mensajes: [cli(2), per(2, 'IA_Contacto inicial')] }).accion === 'escribir');
prueba('plantilla de venta hace 5 h → pasa a mañana', cand({ mensajes: [per(5, 'cron_template_programado')] }).accion === 'pasa_a_manana');
prueba('valoración hace 2 h → pasa a mañana', cand({ mensajes: [per(2, 'Sistema de valoraciones')] }).accion === 'pasa_a_manana');
prueba('ya recibió 1 de curso esta semana → otro de curso no', C.aplicarCandados({ momento: 'te_guarde', chat, ahora: AHORA, enviados: [{ momento: 'logro', t: AHORA - 48 * H }] }).accion === 'no');
prueba('uno de curso esta semana → uno de carga sí', cand({ enviados: [{ momento: 'logro', t: AHORA - 48 * H }] }).accion === 'escribir');
prueba('dos de carga esta semana → el tercero no', cand({ enviados: [{ momento: 'en_contenedor', t: AHORA - 48 * H }, { momento: 'recibido_china', t: AHORA - 96 * H }] }).accion === 'no');
prueba('uno de hace 8 días ya no cuenta', C.aplicarCandados({ momento: 'te_guarde', chat, ahora: AHORA, enviados: [{ momento: 'logro', t: AHORA - 8 * 24 * H }] }).accion === 'escribir');
prueba('escribió hace 3 h → texto libre', cand({ mensajes: [cli(3)] }).via === 'texto');
prueba('no escribe hace 2 días → plantilla', cand({ mensajes: [cli(48)] }).via === 'plantilla');

console.log('\n7. Textos');
prueba('los textos siguen SIN aprobar', T.CONSENTIDOS_APROBADO === false);
prueba('hay un texto para cada momento', Object.keys(C.MOMENTOS).every((k) => T.CONSENTIDOS[k]));
prueba('el texto con novedad no deja llaves', !/[{}]/.test(C.textoDe('sigue_en_camino', { contenedor: 'X', nota: 'n' }, 'Ana')));
prueba('ningún texto con voseo', !Object.values(T.CONSENTIDOS).some((t) => /\b(tenés|podés|querés|sabés|mirá|escribime|avisame|contame|decime|vos)\b/i.test(t)));
prueba('ningún texto promete una hora o un día', !Object.values(T.CONSENTIDOS).some((t) => /\b(hoy|mañana|en \d+ (horas|días|minutos)|en breve)\b/i.test(t)));
prueba('no son textos fijos de la guardia', !Object.values(T.CONSENTIDOS).some((t) => Object.values(T.TEXTOS_FIJOS).includes(t)));
const z = C.textoDe('zarpo', { contenedor: 'MAR-24', estimada: '2026-11-30' }, 'maría josé');
prueba('zarpó con fecha → nombre, contenedor y fecha', z === '🚢 María, tu carga ya va en camino en el contenedor MAR-24. La llegada estimada es el 30 de noviembre. Te voy contando cada paso.', z);
const z2 = C.textoDe('zarpo', { contenedor: 'MAR-24' }, 'MARÍA');
prueba('zarpó sin fecha → «apenas tengamos la fecha»', /Apenas tengamos la fecha de llegada, te la paso\./.test(z2), z2);
const sn = C.textoDe('en_contenedor', { contenedor: 'MAR-24' }, '');
prueba('sin nombre → arranca limpio con mayúscula', sn === 'Tu carga ya está asignada al contenedor MAR-24 📦. Te escribo cuando zarpe.', sn);
const hn = C.textoDe('primera_clase', { enlace: 'https://imporfactory.app' }, '123');
prueba('nombre que no es nombre → «Hola 👋»', hn.startsWith('Hola 👋 ¿Ya pudiste'), hn);
const rc = C.textoDe('recibido_china', { marca: 'EC-77', cajas: 1 }, 'Luis');
prueba('una caja → «(1 caja)»', rc.includes('EC-77 ya llegó a nuestra bodega en China (1 caja).'), rc);
prueba('bodega en Ecuador → «nuestra bodega de Ecuador»', C.textoDe('bodega_destino', { destino: 'ec' }, 'Ana').includes('nuestra bodega de Ecuador.'));
prueba('bodega sin destino → «nuestra bodega.»', C.textoDe('bodega_destino', {}, 'Ana').includes('nuestra bodega. El equipo'));
prueba('ningún texto deja una llave {…} sin cambiar', Object.keys(C.MOMENTOS).every((k) => !/[{}]/.test(C.textoDe(k, {}, 'Ana'))));
prueba('enmascarar: «maría» → «M***», vacío → «Alumno»', C.enmascarar('maría') === 'M***' && C.enmascarar('') === 'Alumno');

console.log('\n8. El ensayo no puede escribirle a nadie');
const script = fs.readFileSync(path.join(__dirname, 'consentidos_soporte_expertos.js'), 'utf8');
prueba('el script no importa nada que envíe WhatsApp', !/enviarMensaje|webhook_whatsapp|graph\.facebook|sendMessage|axios|fetch\(/i.test(script));
prueba('el script no escribe en la base', !/\b(INSERT|UPDATE|DELETE|REPLACE INTO|ALTER|CREATE|DROP)\b/.test(script));

console.log(`\n${fallos ? `HAY FALLAS: ${fallos} fallan, ${ok} pasan` : `TODO BIEN: ${ok} pasan, 0 fallan`}`);
process.exit(fallos ? 1 : 0);
