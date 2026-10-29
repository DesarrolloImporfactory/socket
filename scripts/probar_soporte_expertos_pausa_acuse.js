/* Pruebas de E1 (aviso masivo o fuera de oficina no pausan al bot), E4 (el
   acuse «Recibí tu mensaje…» una sola vez por chat) y la pausa por persona
   (Johan, 28-oct: el bot no se mete si una persona ya atiende el chat),
   soporteExpertos/pausaYAcuse.js.
   Sin red ni base. Uso: node scripts/probar_soporte_expertos_pausa_acuse.js */

'use strict';

const path = require('path');
// `ajustesIA` importa la base solo para leer la fila; aquí no se usa.
const rutaDb = require.resolve(path.join(__dirname, '../src/database/config'));
require.cache[rutaDb] = { id: rutaDb, filename: rutaDb, loaded: true, exports: { db: {}, db_2: {} } };

const { humanoQuePausa, esAcuse, acuseRepetido, decidirPausaPersona, cuentaComoPersona } = require('../src/utils/soporteExpertos/pausaYAcuse');
const { normalizar } = require('../src/utils/ajustesIA');
const { textoAlHorario } = require('../src/utils/soporteExpertos/horario');
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

// Hora de Ecuador → ms. El 27-oct-2026 es martes.
const ec = (dia, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return Date.UTC(2026, 9, dia, h + 5, m);
};
const HORARIO = { dias: [1, 2, 3, 4, 5], desde: '08:00', hasta: '17:00', utc: -5 };
const AVISO = 'Hoy a las 19:00 tenemos la clase en vivo de importación. El enlace es el de siempre, te esperamos.';
const contar = (mapa) => async (texto) => mapa[texto] ?? 1;

(async () => {
  console.log('\n1. E1: qué mensaje de una persona pausa al bot');
  {
    const ahora = ec(27, '10:30');
    let h = await humanoQuePausa([{ responsable: 'Johan', texto_mensaje: 'Hola, ya reviso tu caso', seg: 600 }], { horarioEquipo: HORARIO, ahora, destinosDe: contar({}) });
    prueba('Johan escribió hace 10 min en oficina: pausa', h?.responsable === 'Johan');

    h = await humanoQuePausa([{ responsable: 'Belen', texto_mensaje: AVISO, seg: 900 }], { horarioEquipo: HORARIO, ahora, destinosDe: contar({ [AVISO]: 57 }) });
    prueba('un aviso que salió a 57 clientes: NO pausa', h === null);

    h = await humanoQuePausa([{ responsable: 'Belen', texto_mensaje: AVISO, seg: 900 }], { horarioEquipo: HORARIO, ahora, destinosDe: contar({ [AVISO]: 2 }) });
    prueba('el mismo texto a solo 2 clientes: sí pausa (es una persona atendiendo)', h?.responsable === 'Belen');

    h = await humanoQuePausa([{ responsable: 'Belen', texto_mensaje: 'Hola', seg: 300 }], { horarioEquipo: HORARIO, ahora, destinosDe: contar({ Hola: 40 }) });
    prueba('un «Hola» corto a muchos no cuenta como masivo: pausa', h?.responsable === 'Belen');

    h = await humanoQuePausa(
      [
        { responsable: 'Belen', texto_mensaje: AVISO, seg: 300 },
        { responsable: 'Johan', texto_mensaje: 'Te paso la cotización en un momento, dame unos minutos', seg: 1200 },
      ],
      { horarioEquipo: HORARIO, ahora, destinosDe: contar({ [AVISO]: 30 }) },
    );
    prueba('aviso masivo encima de un mensaje real de Johan: pausa por Johan', h?.responsable === 'Johan');

    h = await humanoQuePausa([{ responsable: 'IA_Contacto', texto_mensaje: 'x', seg: 60 }], { horarioEquipo: HORARIO, ahora });
    prueba('lo que escribió la IA no pausa', h === null);

    let errores = 0;
    h = await humanoQuePausa([{ responsable: 'Belen', texto_mensaje: AVISO, seg: 300 }], {
      horarioEquipo: HORARIO,
      ahora,
      destinosDe: async () => {
        errores++;
        throw new Error('base caída');
      },
    });
    prueba('si no se pudo contar los destinos, cuenta como persona: pausa', h?.responsable === 'Belen' && errores === 1);
  }
  {
    const ahora = ec(27, '07:50');
    let h = await humanoQuePausa([{ responsable: 'Johan', texto_mensaje: 'Mañana te confirmo la fecha', seg: 40 * 60 }], { horarioEquipo: HORARIO, ahora, destinosDe: contar({}) });
    prueba('mensaje de Johan a las 07:10 (fuera de oficina): NO pausa', h === null);

    h = await humanoQuePausa([{ responsable: 'Johan', texto_mensaje: 'Te confirmo la fecha', seg: 60 }], { horarioEquipo: HORARIO, ahora: ec(27, '08:05'), destinosDe: contar({}) });
    prueba('el mismo a las 08:04 (en oficina): pausa', h?.responsable === 'Johan');

    h = await humanoQuePausa([{ responsable: 'Johan', texto_mensaje: 'Te confirmo el lunes', seg: 600 }], { horarioEquipo: HORARIO, ahora: ec(25, '11:00'), destinosDe: contar({}) });
    prueba('un domingo a las 10:50: NO pausa', h === null);

    h = await humanoQuePausa([{ responsable: 'Johan', texto_mensaje: 'Te confirmo el lunes', seg: 600 }], { horarioEquipo: null, ahora: ec(25, '11:00') });
    prueba('sin horario_equipo en los ajustes: pausa como antes', h?.responsable === 'Johan');

    h = await humanoQuePausa([{ responsable: 'Whatsapp Business', texto_mensaje: 'ya te llamo', seg: 120 }], { horarioEquipo: HORARIO, ahora: ec(27, '15:00'), destinosDe: contar({}) });
    prueba('«Whatsapp Business» (alguien desde el teléfono) en oficina: pausa', h?.responsable === 'Whatsapp Business');
  }

  console.log('\n2. E4: qué es un acuse');
  {
    const variantes = [
      T.MENSAJE_ASESOR,
      textoAlHorario(T.MENSAJE_ASESOR, true),
      textoAlHorario(T.MENSAJE_ASESOR, false, 'mañana desde las 8:00'),
      T.MENSAJE_RECIBIDO,
      T.MENSAJE_ARCHIVO,
      T.MENSAJE_FALLBACK,
      'Recibí tu mensaje. El área de logística revisa tu carga y un asesor te escribe apenas abramos.',
    ];
    prueba('los acuses fijos, con cualquier final según la hora, son acuses', variantes.every(esAcuse), variantes.filter((v) => !esAcuse(v)).join(' | '));
    const noAcuses = [
      'Recibí lo que enviaste, pero no lo puedo abrir. Cuéntame en un mensaje qué necesitas con eso y lo dejo anotado para el asesor.',
      'Recibí tu comprobante. Lo sumo a tu caso para cobranza; un asesor lo revisa y te escribe apenas abramos.',
      'Tu carga IMP-2231 está en tránsito y llega el 3 de noviembre.',
      `Recibí tu mensaje. Un asesor lo revisa y te escribe apenas abramos. Mientras tanto, la clase de cómo escribirle a un proveedor está aquí: https://imporfactory.app/cursos/30?contenido=383 y el directorio completo en https://imporfactory.app/proveedores`,
    ];
    prueba('un pedido de datos, un comprobante, un estado o un acuse con contenido NO son acuses', !noAcuses.some(esAcuse), noAcuses.filter(esAcuse).join(' | '));
  }

  console.log('\n3. E4: el acuse sale una sola vez por chat');
  {
    const acuse = textoAlHorario(T.MENSAJE_ASESOR, true);
    prueba('primer acuse del chat: sale', !acuseRepetido(acuse, [{ responsable: 'IA_Contacto', texto_mensaje: 'Hola. Cuéntame qué necesitas.' }]));
    prueba('sin nada antes: sale', !acuseRepetido(acuse, []));
    prueba('la IA ya lo mandó y nadie escribió: NO sale', acuseRepetido(acuse, [{ responsable: 'IA_Contacto', texto_mensaje: T.MENSAJE_ASESOR }]));
    prueba('…aunque el anterior tuviera otro final («mañana desde las 8:00»)', acuseRepetido(acuse, [{ responsable: 'IA_Contacto', texto_mensaje: textoAlHorario(T.MENSAJE_ASESOR, false, 'mañana desde las 8:00') }]));
    prueba('…y aunque el anterior fuera «Recibido. Lo sumo a tu caso»', acuseRepetido(acuse, [{ responsable: 'IA_Contacto', texto_mensaje: T.MENSAJE_RECIBIDO }]));
    prueba('…o el respaldo «Recibimos tu mensaje»', acuseRepetido(T.MENSAJE_RECIBIDO, [{ responsable: 'IA_respaldo', texto_mensaje: T.MENSAJE_FALLBACK }]));
    prueba(
      'si Johan escribió después del acuse, el siguiente sí sale',
      !acuseRepetido(acuse, [
        { responsable: 'Johan', texto_mensaje: 'Hola, dime' },
        { responsable: 'IA_Contacto', texto_mensaje: T.MENSAJE_ASESOR },
      ]),
    );
    prueba(
      'si Johan escribió ANTES del acuse, el segundo no sale',
      acuseRepetido(acuse, [
        { responsable: 'IA_Contacto', texto_mensaje: T.MENSAJE_ASESOR },
        { responsable: 'Johan', texto_mensaje: 'Hola, dime' },
      ]),
    );
    prueba(
      'un acuse con respuestas de la IA en medio sigue contando',
      acuseRepetido(acuse, [
        { responsable: 'IA_Contacto', texto_mensaje: 'Tu carga está en tránsito.' },
        { responsable: 'IA_Contacto', texto_mensaje: T.MENSAJE_ASESOR },
      ]),
    );
    prueba('una respuesta que no es acuse sale siempre', !acuseRepetido('Tu carga está en tránsito.', [{ responsable: 'IA_Contacto', texto_mensaje: T.MENSAJE_ASESOR }]));
  }


  console.log('\n3. Pausa por persona (Johan, 28-oct): una persona ya atiende el chat');
  {
    // Chat 953642 del 27-oct: Johan escribió a las 9:05 y el bot se metió 4 veces desde las 9:53.
    const johan = { resp: 'Johan Bonilla ImporFactory', t: ec(27, '09:05') };
    const base = [
      { rol: 1, resp: johan.resp, tx: 'tenemos fecha de salida el 15 de noviembre', t: johan.t },
      { rol: 0, tx: 'Buenos días le envío la cotización y el cbm', t: ec(27, '09:52') },
    ];
    const d = (extra, ahora, opts = {}) =>
      decidirPausaPersona({ mensajes: [...base, ...extra], humano: johan, ahora, horario: HORARIO, minutos: 60, horas: 24, ...opts });

    prueba('sin persona en el chat, el bot contesta como siempre', decidirPausaPersona({ mensajes: base, humano: null, ahora: ec(27, '09:53'), horario: HORARIO }) === null);
    let r = d([], ec(27, '09:53'));
    prueba('el cliente escribe 47 min después de Johan: el bot calla (antes se metía)', r?.accion === 'callar' && r.espera === 1, JSON.stringify(r));
    r = d([{ rol: 0, tx: 'Aqui esta la cantidad', t: ec(27, '10:40') }], ec(27, '10:40'));
    prueba('vuelve a escribir a los 48 min de espera: sigue callado', r?.accion === 'callar' && r.espera === 48, JSON.stringify(r));
    r = d([{ rol: 0, tx: '¿me ayudan?', t: ec(27, '10:53') }], ec(27, '10:53'));
    prueba('60 min de oficina sin respuesta: un T8 con el nombre de Johan', r?.accion === 't8' && r.nombre === 'Johan' && r.desde === johan.t && r.espera === 61, JSON.stringify(r));
    const t8 = { rol: 1, resp: 'IA_Pausa persona', tx: T.PROACTIVO.sigue_con.replace('{nombre}', 'Johan').replace('{desde}', 'las 9:05'), t: ec(27, '10:53') };
    r = d([t8, { rol: 0, tx: 'hola??', t: ec(27, '11:30') }], ec(27, '11:30'));
    prueba('el T8 sale una sola vez: después vuelve a callar', r?.accion === 'callar' && r.t8Enviado === true, JSON.stringify(r));
    const johan2 = { resp: johan.resp, t: ec(27, '11:40') };
    r = decidirPausaPersona({
      mensajes: [...base, t8, { rol: 1, resp: johan.resp, tx: 'Ya te envío', t: johan2.t }, { rol: 0, tx: 'ok', t: ec(27, '11:45') }],
      humano: johan2, ahora: ec(27, '12:50'), horario: HORARIO, minutos: 60, horas: 24,
    });
    prueba('si Johan contesta, el reloj y el T8 empiezan de nuevo', r?.accion === 't8' && r.desde === johan2.t, JSON.stringify(r));
    prueba('fuera de oficina el bot contesta como hoy', d([{ rol: 0, tx: 'hola', t: ec(27, '18:10') }], ec(27, '18:10')) === null);
    prueba(
      'Johan escribió hace más de 24 h: el bot contesta como siempre',
      d([{ rol: 0, tx: 'hola', t: ec(28, '09:30') }], ec(28, '09:30')) === null,
    );
    // Las horas de la noche no cuentan: Johan 16:40, cliente 16:50, al otro día 8:30 = 10 + 30 min.
    const tarde = { resp: johan.resp, t: ec(27, '16:40') };
    const noche = [{ rol: 1, resp: tarde.resp, tx: 'mañana te confirmo', t: tarde.t }, { rol: 0, tx: 'ok gracias', t: ec(27, '16:50') }];
    r = decidirPausaPersona({ mensajes: [...noche, { rol: 0, tx: 'buenos días', t: ec(28, '08:30') }], humano: tarde, ahora: ec(28, '08:30'), horario: HORARIO });
    prueba('la noche no cuenta como espera (10 + 30 min): calla', r?.accion === 'callar' && r.espera === 40, JSON.stringify(r));
    r = decidirPausaPersona({ mensajes: [...noche, { rol: 0, tx: '¿y?', t: ec(28, '08:55') }], humano: tarde, ahora: ec(28, '08:55'), horario: HORARIO });
    prueba('al otro día, con 65 min de oficina: T8', r?.accion === 't8' && r.espera === 65, JSON.stringify(r));
    r = decidirPausaPersona({ mensajes: base, humano: { resp: 'Whatsapp Business', t: johan.t }, ahora: ec(27, '09:53'), horario: HORARIO });
    prueba('escrito desde el celular («Whatsapp Business»): calla igual', r?.accion === 'callar', JSON.stringify(r));
    r = decidirPausaPersona({ mensajes: base, humano: { resp: 'Whatsapp Business', t: johan.t }, ahora: ec(27, '10:53'), horario: HORARIO });
    prueba('… pero sin nombre no hay T8: pasado el plazo contesta como hoy', r === null, JSON.stringify(r));
    prueba('«Soporte Importaciones» (avisos de cargas) no es una persona', !cuentaComoPersona('Soporte Importaciones'));
    prueba('«Automatizador | Cotizador Pro» no es una persona', !cuentaComoPersona('Automatizador | Cotizador Pro'));
    prueba('Johan sí es una persona', cuentaComoPersona('Johan Bonilla ImporFactory'));
    prueba(
      'si el humano es un aviso de cargas, el bot contesta como siempre',
      decidirPausaPersona({ mensajes: base, humano: { resp: 'Soporte Importaciones', t: johan.t }, ahora: ec(27, '09:53'), horario: HORARIO }) === null,
    );
    r = decidirPausaPersona({
      mensajes: [base[0], { rol: 0, tx: 'gracias, ¿y el CBM?', t: ec(27, '09:10') }, { rol: 0, tx: '¿?', t: ec(27, '09:45') }],
      humano: johan, ahora: ec(27, '09:45'), horario: HORARIO, minutos: 30,
    });
    prueba('la ventana se puede cambiar (30 min): a los 35 min de espera, T8', r?.accion === 't8' && r.espera === 35, JSON.stringify(r));
    prueba(
      'el texto del T8 es el aprobado por Daniel',
      T.PROACTIVO.sigue_con.startsWith('Tu caso sigue con {nombre} desde {desde}.'),
    );

    const aj = (v) => normalizar(JSON.stringify({ soporte_expertos: { escalar: 'real', ...v } })).soporte_expertos.pausa_persona;
    prueba('ajuste: sin el campo, apagado', aj({}) === null);
    prueba('ajuste: `true` = 60 min y 24 h', JSON.stringify(aj({ pausa_persona: true })) === '{"minutos":60,"horas":24}');
    prueba('ajuste: un objeto cambia la ventana', JSON.stringify(aj({ pausa_persona: { minutos: 90, horas: 12 } })) === '{"minutos":90,"horas":12}');
    prueba('ajuste: valores locos quedan en rango (15-480 min, 1-72 h)', JSON.stringify(aj({ pausa_persona: { minutos: 2, horas: 500 } })) === '{"minutos":15,"horas":72}');
  }

  console.log(`\n${fallos ? `HAY FALLAS: ${fallos} fallan, ${ok} pasan` : `TODO BIEN: ${ok} pasan, 0 fallan`}`);
  process.exit(fallos ? 1 : 0);
})();
