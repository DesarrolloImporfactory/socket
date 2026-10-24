/* Pruebas de «mi reunión y mi sesión de implementación» del bot de Expertos
   (soporteExpertos/reunionCliente.js + ver_mi_reunion en herramientas.js).
   Sin red ni base: las dos bases son dobles. Uso: node scripts/probar_soporte_expertos_reunion.js */

'use strict';

const path = require('path');
const rutaDb = require.resolve(path.join(__dirname, '../src/database/config'));
require.cache[rutaDb] = { id: rutaDb, filename: rutaDb, loaded: true, exports: { db: {}, db_2: {} } };

const R = require('../src/utils/soporteExpertos/reunionCliente');
const { crearHerramientas, sumarHechosHerramientas } = require('../src/utils/soporteExpertos/herramientas');
const { revisarTurno } = require('../src/utils/soporteExpertos/turno');
const { consultarImporchat } = require('../src/utils/soporteExpertos/diagnosticoCuenta');
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

const EC = '593987000111';
const PE = '51987000111';
// Lunes 26-oct-2026, 09:00 en Ecuador.
const AHORA = new Date(Date.UTC(2026, 9, 26, 14, 0));

const cita = (o) => ({
  id: 9, status: 'Agendado', inicio_utc: '2026-10-27 15:00', fin_utc: '2026-10-27 15:30',
  meeting_url: 'https://meet.google.com/abc-defg-hij', time_zone: 'America/Guayaquil',
  phone: '+593 98 700 0111', name: 'Ana Pérez', asesor: 'juan carlos', ...o,
});
const ALUMNA = { id_users: 50, whatsapp: '+593 98 700 0111', email: 'ana@gmail.com', nombre: 'Ana Pérez' };

/* Doble del calendario de IMPORCHAT: filtra por cuenta como la base. */
function imporchat({ citas = [], falla = null } = {}) {
  const sqls = [];
  return {
    sqls,
    consultar: async (sql, rep) => {
      sqls.push({ sql, rep });
      if (falla) throw new Error(falla);
      return rep.cuenta === 265 ? citas : [];
    },
  };
}
/* Doble de Imporsuit. */
function imporsuit({ usuarios = [ALUMNA], perfil = {}, total = 29, completados = 0, mentorias = [], falla = null } = {}) {
  const sqls = [];
  return {
    sqls,
    consultar: async (sql, rep) => {
      sqls.push({ sql, rep });
      if (falla) throw new Error(falla);
      if (/FROM plataformas/.test(sql)) return usuarios;
      if (/FROM users WHERE/.test(sql))
        return rep[0].map((id) => ({ id_users: id, ecommerce: 1, mentoria_implementacion: 0, mentoria_bloqueada: 0, ...perfil }));
      if (/COUNT\(\*\) AS total/.test(sql)) return [{ total }];
      if (/GROUP BY ccp\.id_users/.test(sql)) return completados ? [{ id_users: rep[0][0], completados }] : [];
      if (/FROM mentoria_citas/.test(sql)) return mentorias;
      return [];
    },
  };
}
const leer = (tel, ic, is) =>
  R.reunionesDelTelefono(tel, { cuenta: 265, consultarImporchat: ic.consultar, consultarImporsuit: is.consultar, ahora: AHORA });

(async () => {
  console.log('1. Quién es: solo el número del que escribe');
  let ic = imporchat({ citas: [cita()] });
  let is = imporsuit();
  let r = await leer(EC, ic, is);
  prueba('su reunión de mañana aparece', r.calendario.proximas.length === 1 && r.calendario.proximas[0].id === 9);
  prueba('se busca por los 9 últimos del que escribe y la cuenta propia', ic.sqls[0].rep.cola === '987000111' && ic.sqls[0].rep.cuenta === 265);
  r = await R.reunionesDelTelefono(EC, { cuenta: 999, consultarImporchat: ic.consultar, consultarImporsuit: is.consultar, ahora: AHORA });
  prueba('el calendario de otra cuenta no se lee', r.calendario.proximas.length === 0);
  r = await leer(EC, imporchat({ citas: [cita({ phone: '0987000111' })] }), is);
  prueba('guardado sin código y escribe desde Ecuador: vale', r.calendario.proximas.length === 1);
  r = await leer(PE, imporchat({ citas: [cita({ phone: '0987000111' })] }), imporsuit({ usuarios: [{ ...ALUMNA, whatsapp: '0987000111' }] }));
  prueba('guardado sin código y escribe desde Perú: no vale (ni calendario ni plataforma)', r.calendario.proximas.length === 0 && r.mentoria.estado === 'sin_alumno');
  r = await leer(EC, imporchat({ citas: [cita({ phone: '+51 987 000 111' })] }), is);
  prueba('mismo final pero de otro país: no vale', r.calendario.proximas.length === 0);
  r = await leer(EC, imporchat({ citas: [cita(), cita({ id: 10, name: 'Pedro Gómez', inicio_utc: '2026-10-28 15:00', fin_utc: '2026-10-28 15:30' })] }), is);
  prueba('el número en reuniones de dos personas: no se informa', r.calendario.estado === 'varios' && /varias personas/.test(R.bloqueReunion(r)));
  r = await leer(EC, imporchat({ citas: [cita(), cita({ id: 10, name: 'ana', inicio_utc: '2026-10-28 15:00', fin_utc: '2026-10-28 15:30' })] }), is);
  prueba('la misma persona escrita distinto: se listan las dos', r.calendario.estado === 'ok' && r.calendario.proximas.length === 2);
  r = await leer(EC, ic, imporsuit({ usuarios: [ALUMNA, { ...ALUMNA, id_users: 51, nombre: 'Luis Mora', email: 'luis@gmail.com' }] }));
  prueba('dos alumnos distintos con el número: la mentoría no se informa', r.mentoria.estado === 'varios');
  r = await R.reunionesDelTelefono('123', { cuenta: 265, consultarImporchat: ic.consultar, consultarImporsuit: is.consultar });
  prueba('número que no sirve: no consulta', r.estado === 'telefono_no_valido' && /No se pudo consultar/.test(R.bloqueReunion(r)));

  console.log('\n2. Qué se lee del calendario');
  r = await leer(EC, imporchat({ citas: [cita()] }), is);
  const p = r.calendario.proximas[0];
  prueba('hora de Ecuador (15:00 UTC → 10:00)', p.cuando.hora === '10:00' && p.cuando.fecha === '2026-10-27', JSON.stringify(p.cuando));
  prueba('«mañana» y el día de la semana', p.cuando.relativo === 'mañana' && p.cuando.dia === 'martes');
  prueba('con quién: solo el primer nombre', p.con === 'Juan');
  prueba('el enlace del Meet', p.enlace === 'https://meet.google.com/abc-defg-hij');
  r = await leer(EC, imporchat({ citas: [cita({ status: 'Cancelado' })] }), is);
  prueba('cancelada: no es próxima, va como anterior «cancelada»', !r.calendario.proximas.length && /cancelada/.test(R.bloqueReunion(r)));
  r = await leer(EC, imporchat({ citas: [cita({ inicio_utc: '2026-10-22 15:00', fin_utc: '2026-10-22 15:30', status: 'Completado' })] }), is);
  prueba('una pasada: va como anterior, no como próxima', !r.calendario.proximas.length && /Reunión anterior: jueves 22 de octubre/.test(R.bloqueReunion(r)));
  r = await leer(EC, imporchat({ citas: [cita({ inicio_utc: '2026-10-26 13:45', fin_utc: '2026-10-26 14:15' })] }), is);
  prueba('la que está en curso todavía es «próxima» (hoy)', r.calendario.proximas.length === 1 && r.calendario.proximas[0].cuando.relativo === 'hoy');
  r = await leer(EC, imporchat({ citas: [cita({ meeting_url: 'javascript:alert(1)' })] }), is);
  prueba('un enlace raro no se pasa', r.calendario.proximas[0].enlace === null && /Sin enlace/.test(R.bloqueReunion(r)));
  r = await leer(EC, imporchat({ citas: [cita({ time_zone: 'America/Mexico_City' })] }), is);
  prueba('calendario de México: hora de Ciudad de México', /09:00 \(hora de Ciudad de México\)/.test(R.bloqueReunion(r)), R.bloqueReunion(r));
  prueba('las consultas son SELECT y no traen descripción ni título', [ic.sqls[0].sql].every((q) => /^\s*SELECT/i.test(q) && !/description|title/.test(q)));
  let error = null;
  try {
    await consultarImporchat('UPDATE appointments SET status = "Cancelado"');
  } catch (e) {
    error = e.message;
  }
  prueba('el adaptador de IMPORCHAT se niega a escribir', /solo se permiten consultas SELECT/.test(String(error)));

  console.log('\n3. La sesión de implementación');
  r = await leer(EC, imporchat(), imporsuit({ completados: 24 }));
  prueba('le faltan 5 de 29', r.mentoria.faltan === 5 && /Lleva 24 de 29 clases.*le faltan 5/.test(R.bloqueReunion(r)));
  prueba('con el enlace para agendarla', R.bloqueReunion(r).includes(R.ENLACE_AGENDA));
  r = await leer(EC, imporchat(), imporsuit({ completados: 29 }));
  prueba('completó todo sin habilitar: que entre a «Agenda tu implementación»', /ya completó las 29 clases/.test(R.bloqueReunion(r)));
  prueba('…y no se escribe nada en la base (no se llama a autohabilitar)', is.sqls.every((q) => /^\s*SELECT/i.test(q.sql)));
  r = await leer(EC, imporchat(), imporsuit({ perfil: { mentoria_implementacion: 1 } }));
  prueba('habilitada sin cita: la agenda el alumno', /HABILITADA y sin agendar/.test(R.bloqueReunion(r)));
  r = await leer(EC, imporchat(), imporsuit({ perfil: { mentoria_implementacion: 1 }, mentorias: [{ id_cita: 1, id_users: 50, inicio: '2026-10-28 08:00', estado: 'agendada', activa: 1, meet_url: 'https://meet.google.com/xyz-abcd-efg', chatcenter_cita_id: 77 }] }));
  prueba('cita agendada: día, hora y Meet', /agendada: miércoles 28 de octubre, 08:00 \(hora de Ecuador\)\. Enlace: https:\/\/meet\.google\.com\/xyz-abcd-efg/.test(R.bloqueReunion(r)), R.bloqueReunion(r));
  r = await leer(EC, imporchat({ citas: [cita({ id: 77, inicio_utc: '2026-10-28 13:00', fin_utc: '2026-10-28 13:20' })] }), imporsuit({ perfil: { mentoria_implementacion: 1 }, mentorias: [{ id_cita: 1, id_users: 50, inicio: '2026-10-28 08:00', estado: 'agendada', activa: 1, meet_url: null, chatcenter_cita_id: 77 }] }));
  prueba('la cita de la mentoría que también está en el calendario no sale dos veces', r.calendario.proximas.length === 0);
  r = await leer(EC, imporchat(), imporsuit({ perfil: { mentoria_implementacion: 1 }, mentorias: [{ id_cita: 1, id_users: 50, inicio: '2026-09-09 14:00', estado: 'agendada', activa: 1, meet_url: null }] }));
  prueba('una «agendada» que ya pasó: ya tuvo su sesión, la revisa el equipo', /ya tuvo su sesión/.test(R.bloqueReunion(r)));
  r = await leer(EC, imporchat(), imporsuit({ perfil: { mentoria_bloqueada: 1 } }));
  prueba('bloqueada: no se dice «bloqueada», la revisa el equipo', /no está disponible/.test(R.bloqueReunion(r)) && !/bloquead/.test(R.bloqueReunion(r)));
  r = await leer(EC, imporchat(), imporsuit({ perfil: { ecommerce: 0 } }));
  prueba('no es de Ecommerce: lo dice sin prometer', /no figura como tal/.test(R.bloqueReunion(r)));
  r = await leer(EC, imporchat(), imporsuit({ usuarios: [] }));
  prueba('sin alumno con ese número', /no hay un alumno/.test(R.bloqueReunion(r)));
  r = await leer(EC, imporchat({ falla: 'caída' }), imporsuit({ completados: 3 }));
  prueba('si el calendario falla, la mentoría igual sale', r.estado === 'leido' && /no se pudo consultar/i.test(R.bloqueReunion(r)) && /le faltan 26/.test(R.bloqueReunion(r)));
  r = await leer(EC, imporchat({ falla: 'x' }), imporsuit({ falla: 'y' }));
  prueba('si fallan las dos: error, sin días ni horas', r.estado === 'error' && /No digas días/.test(R.bloqueReunion(r)));
  const lento = { consultar: () => new Promise((res) => setTimeout(() => res([]), 400)) };
  r = await R.reunionesDelTelefono(EC, { cuenta: 265, consultarImporchat: lento.consultar, consultarImporsuit: lento.consultar, limite_ms: 50, ahora: AHORA });
  prueba('base lenta: corta a tiempo', r.estado === 'error');

  console.log('\n4. Lo que ve el modelo');
  r = await leer(EC, imporchat({ citas: [cita()] }), imporsuit({ completados: 24 }));
  const bloque = R.bloqueReunion(r);
  prueba('trae la próxima con día, hora, zona, asesor y enlace', /Próxima reunión: martes 27 de octubre, 10:00 \(hora de Ecuador\), con Juan\. Enlace: https:\/\/meet/.test(bloque), bloque);
  prueba('le dice que no agende ni proponga horas', /No agendes, no cambies, no canceles ni propongas/.test(bloque));
  prueba('no trae el apellido del asesor ni el del alumno', !/Carlos|carlos|Pérez/.test(bloque));

  console.log('\n5. La guardia: respalda el día y la hora leídos, y nada más');
  const hechos = () => ({ respaldo: { firme: T.MENSAJE_ASESOR, estado: '' }, textoSeguro: T.MENSAJE_ASESOR, carga: null, adjuntos: [] });
  const revisar = (respuesta, mensaje = '¿a qué hora es mi reunión?') => {
    const h = hechos();
    sumarHechosHerramientas(h, [bloque], null, { mensaje, respuesta, reuniones: r });
    return revisarTurno(respuesta, h);
  };
  for (const t of [
    'Tu reunión es mañana a las 10:00 (hora de Ecuador) con Juan. Te conectas aquí: https://meet.google.com/abc-defg-hij',
    'Tienes tu reunión el martes 27 de octubre a las 10 am con Juan.',
    'Es el martes a las 10:00 a. m.',
    'Te faltan 5 de 29 clases de los módulos 1 y 2. Al completarlas se abre «Agenda tu implementación»: https://imporfactory.app/cursos/32?contenido=737',
  ]) {
    const rev = revisar(t);
    prueba(`pasa: «${t.slice(0, 60)}…»`, !rev.cambiada, (rev.motivos || []).join('; '));
  }
  let rev = revisar('Tu reunión es mañana a las 11:00.');
  prueba('una hora que no se leyó: se frena', rev.cambiada, (rev.motivos || []).join('; '));
  rev = revisar('Tu reunión es el jueves 29 de octubre a las 10:00.');
  prueba('un día que no se leyó: se frena', rev.cambiada);
  rev = revisar('Te conectas aquí: https://meet.google.com/otro-link-xyz');
  prueba('un enlace que no se leyó: se frena', rev.cambiada);
  rev = revisar('Listo, te agendo para el martes a las 10:00.');
  prueba('«te agendo»: se frena (el bot no agenda)', rev.cambiada, (rev.motivos || []).join('; '));
  prueba('las variantes no van al modelo', !bloque.includes('10 am') && !bloque.includes('a. m.'));

  console.log('\n6. Texto seguro si la guardia rechaza');
  let h = hechos();
  sumarHechosHerramientas(h, [bloque], null, { mensaje: 'a qué hora es mi reunión?', respuesta: 'x', reuniones: r });
  prueba('«a qué hora es mi reunión»: la armada en código', h.textoSeguro === 'Tu próxima reunión es el martes 27 de octubre a las 10:00 (hora de Ecuador) con Juan. Te conectas aquí: https://meet.google.com/abc-defg-hij', h.textoSeguro);
  h = hechos();
  sumarHechosHerramientas(h, [bloque], null, { mensaje: 'cómo agendo mi mentoría de implementación', respuesta: 'x', reuniones: r });
  prueba('«cómo agendo mi mentoría»: cuántas clases le faltan y el enlace', /te faltan 5 de 29 clases/.test(h.textoSeguro) && h.textoSeguro.includes(R.ENLACE_AGENDA), h.textoSeguro);
  h = hechos();
  sumarHechosHerramientas(h, [bloque], null, { mensaje: 'quiero agendar una llamada con mi asesor', respuesta: 'x', reuniones: r });
  prueba('«quiero agendar una llamada»: sigue el asesor (reunión nueva)', h.textoSeguro === T.MENSAJE_ASESOR, h.textoSeguro);
  h = hechos();
  sumarHechosHerramientas(h, [bloque], null, { mensaje: 'cuándo es mi reunión', respuesta: 'x', reuniones: { estado: 'error' } });
  prueba('si no se pudo leer: sigue el asesor', h.textoSeguro === T.MENSAJE_ASESOR);
  const r2 = await leer(EC, imporchat(), imporsuit({ perfil: { mentoria_bloqueada: 1 } }));
  prueba('bloqueada: no hay texto armado (lo ve una persona)', R.textoReunionParaCliente(r2, { pide: 'mentoria' }) === null);

  console.log('\n7. ¿Pregunta por su reunión o su mentoría?');
  for (const [t, e] of [
    ['a qué hora es mi reunión?', 'reunion'],
    ['me pasas el link del meet de mañana', 'reunion'],
    ['cuándo es mi cita con el asesor', 'reunion'],
    ['me pasas el enlace de la reunión?', 'reunion'],
    ['cómo agendo mi implementación', 'mentoria'],
    ['quiero la mentoría para mi campaña', 'mentoria'],
    ['quiero agendar una llamada', null],
    ['cuánto debo', null],
  ]) prueba(`«${t}» → ${e}`, R.pideReunion(t) === e, String(R.pideReunion(t)));

  console.log('\n8. La herramienta en el motor');
  ic = imporchat({ citas: [cita()] });
  is = imporsuit();
  let hs = crearHerramientas({ telefono: EC, canalVerificable: true, agenda: true, idConfiguracionPropia: 265, deps: { consultarImporchat: ic.consultar, consultar: is.consultar, ahora: AHORA } });
  const herr = hs.lista.find((x) => x.definicion.name === 'ver_mi_reunion');
  prueba('con agenda: se ofrece ver_mi_reunion', Boolean(herr));
  prueba('no recibe ningún dato', Object.keys(herr.definicion.input_schema.properties).length === 0);
  const salida = await herr.ejecutar({ telefono: '593999999999' });
  prueba('lee con el número del que escribe y la cuenta propia', /Próxima reunión: martes 27/.test(salida) && ic.sqls[0].rep.cola === '987000111' && ic.sqls[0].rep.cuenta === 265);
  prueba('queda guardado para la guardia', hs.reunionesConsultadas()?.estado === 'leido');
  hs = crearHerramientas({ telefono: EC, canalVerificable: true });
  prueba('sin agenda: no se ofrece', !hs.lista.some((x) => x.definicion.name === 'ver_mi_reunion'));
  hs = crearHerramientas({ telefono: EC, canalVerificable: false, agenda: true, idConfiguracionPropia: 265, deps: { consultarImporchat: ic.consultar, consultar: is.consultar } });
  const antes = ic.sqls.length;
  const fuera = await hs.lista.find((x) => x.definicion.name === 'ver_mi_reunion').ejecutar();
  prueba('canal no verificable: no consulta', /No se pueden consultar reuniones/.test(fuera) && ic.sqls.length === antes);

  console.log('\n9. Ajustes: apagado salvo herramientas + agenda');
  const n = (v) => ajustes.normalizar({ soporte_expertos: v }).soporte_expertos.agenda;
  prueba('sin la clave: apagado', n({ herramientas: true }) === false);
  prueba('agenda sin herramientas: apagado', n({ agenda: true }) === false);
  prueba('herramientas + agenda: encendido', n({ herramientas: true, agenda: true }) === true);
  prueba('true (todo) deja agenda apagada', ajustes.normalizar({ soporte_expertos: true }).soporte_expertos.agenda === false);

  console.log(`\n${fallos ? `HAY FALLAS: ${fallos} fallan, ${ok} pasan` : `TODO BIEN: ${ok} pasan, 0 fallan`}`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
