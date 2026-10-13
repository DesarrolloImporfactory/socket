/* Pruebas del bot de soporte de Expertos, versión 2 (src/utils/soporteExpertos).

   Corren con `node` a secas: sin base de datos, sin red, sin OpenAI y sin
   node_modules. La carga se prueba contra una base DE MENTIRA
   (scripts/soporte_expertos/base_de_mentira.js) y las reglas de «en qué paso
   va» contra lo que devuelve el PHP original de Imporsuit
   (scripts/soporte_expertos/casos_estado_carga.esperado.json).

     node scripts/probar_soporte_expertos.js
*/
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

// `ajustesIA` importa la base solo para leer la fila; aquí no se usa.
const rutaDb = require.resolve(path.join(__dirname, '../src/database/config'));
require.cache[rutaDb] = { id: rutaDb, filename: rutaDb, loaded: true, exports: { db: {}, db_2: {} } };

const { sinTildes, raiz, raices, casiIgual } = require('../src/utils/soporteExpertos/texto');
const { mismoTelefono, comoCoincide, partir, colaCandidatos, paisDelTelefono, paisDeDestino } = require('../src/utils/soporteExpertos/telefono');
const { estadoDeCarga, hoyEcuador, fecha } = require('../src/utils/soporteExpertos/estadoCarga');
const {
  cargasDelTelefono, bloqueCarga, textoParaCliente, codigosEnMensaje, esCorreoDePrueba, consultarImporsuit,
} = require('../src/utils/soporteExpertos/cargaCliente');
const { crearBuscador, buscadorDeArchivo, bloqueFichas, validarFichas, RUTA_FICHAS } = require('../src/utils/soporteExpertos/fichas');
const { leerAdjuntos, PROMPT_VISION_EXPERTOS } = require('../src/utils/soporteExpertos/adjuntos');
const { hablaDeCarga, pideDatosDeOtro } = require('../src/utils/soporteExpertos/intencion');
const { revisarRespuesta } = require('../src/utils/soporteExpertos/guardia');
const { prepararTurno, revisarTurno, hechosDeEmergencia, olvidarTodo } = require('../src/utils/soporteExpertos/turno');
const T = require('../src/utils/soporteExpertos/textos');
const { promptSoporteExpertos } = require('../src/utils/prompt_soporte_expertos.data');
const ajustes = require('../src/utils/ajustesIA');
const { baseDeMentira, DATOS, TEL, HOY } = require('./soporte_expertos/base_de_mentira');
const { CASOS, HOY: HOY_CASOS } = require('./soporte_expertos/casos_estado_carga.entrada.js');
const ESPERADO_PHP = require('./soporte_expertos/casos_estado_carga.esperado.json');

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
const igual = (a, b) => {
  try {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
    return true;
  } catch {
    return false;
  }
};
const cargas = (tel, o = {}) => cargasDelTelefono(tel, { consultar: baseDeMentira(o.datos, o).consultar, hoy: HOY, ...o });
const FECHA = /\b\d{1,2} de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/;

(async () => {
  /* ───────────────────────────────────────────────────────────────────── */
  console.log('1. Texto: raíces, tildes y errores de tipeo');
  prueba('«llegó», «llegaría», «llegar» y «llegue» tienen la misma raíz',
    new Set(['llego', 'llegaria', 'llegar', 'llegue'].map(raiz)).size === 1);
  prueba('«cotización», «cotizaciones», «cotizar» y «cotice» tienen la misma raíz',
    new Set(['cotizacion', 'cotizaciones', 'cotizar', 'cotice'].map(raiz)).size === 1);
  prueba('«busque» y «buscar», «pague» y «pagar»', raiz('busque') === raiz('buscar') && raiz('pague') === raiz('pagar'));
  prueba('las tildes no cuentan: «Cotización» = «cotizacion»', igual(raices('Cotización'), raices('cotizacion')));
  prueba('las palabras vacías se van: «hola, me ayudan por favor» no deja nada', raices('hola, me ayudan por favor').length === 0);
  prueba('un código queda entero: EC-2609112', raices('mi marca EC-2609112').includes('2609112'));
  prueba('tipeo: «cotisacion» casi igual a «cotizacion» (por raíz)', casiIgual(raiz('cotisacion'), raiz('cotizacion')));
  prueba('tipeo: letras invertidas «platafroma»', casiIgual(raiz('platafroma'), raiz('plataforma')));
  prueba('en palabras cortas un cambio de letra es otra palabra («pago» ≠ «paso»)', !casiIgual('pago', 'paso'));
  prueba('sinTildes deja la ñ como n', sinTildes('Año Ñandú') === 'ano nandu');

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n2. Teléfono: ¿es el mismo número?');
  const EC = '593987654321';
  for (const [guardado, esperado] of [
    ['0987654321', true], ['987654321', true], ['593987654321', true], ['+593 98 765 4321', true],
    ['+593 098 765 4321', true], ['00593987654321', true], ['(593) 98-765-4321', true],
    ['0987654322', false], ['', false], [null, false], ['87654321', false], ['0000000000', false],
  ]) {
    prueba(`Ecuador ${EC} contra «${guardado}» → ${esperado ? 'mismo' : 'otro'}`, mismoTelefono(EC, guardado, 'ec') === esperado);
  }
  prueba('México 521… (con el 1) contra el número nacional de 10 dígitos', mismoTelefono('5215512345678', '55 1234 5678', 'mx'));
  prueba('México 52… (sin el 1) contra «+52 1 55 1234 5678»', mismoTelefono('525512345678', '+52 1 55 1234 5678', 'mx'));
  prueba('🔒 la cola de 9 dígitos NO basta: un número de México que termina igual que uno de Ecuador no es el mismo',
    !mismoTelefono('5215987654321', '0987654321', 'ec') && '5215987654321'.slice(-9) === '0987654321'.slice(-9));
  prueba('🔒 el mismo número nacional en otro país no es el mismo (Perú 51 987654321 contra el guardado de Ecuador)',
    !mismoTelefono('51987654321', '0987654321', 'ec') && !mismoTelefono('51987654321', '593987654321', 'ec'));
  prueba('🔒 guardado sin código de país y cotización a México: un número de Ecuador no calza', !mismoTelefono('593987654321', '987654321', 'mx'));
  prueba('🔒 un país que no está en la lista no recibe nada', !mismoTelefono('8613812345678', '13812345678'));
  prueba('🔒 guardado sin código de país y sin saber el destino: no vale (ese número también es un móvil de Perú)', !mismoTelefono('593987654321', '987654321') && !mismoTelefono('593987654321', '0987654321', null) && mismoTelefono('593987654321', '593987654321'));
  prueba('comoCoincide distingue «exacto» (con código) de «nacional» (sin código)', comoCoincide('593987654321', '+593 98 765 4321') === 'exacto' && comoCoincide('593987654321', '0987654321') === 'nacional' && comoCoincide('593987654321', '0987654322') === null && comoCoincide('', '0987654321') === null);
  prueba('partir quita el 1 de México y el 0 de larga distancia', partir('5215512345678').nacional === '5512345678' && partir('5930987654321').nacional === '987654321');
  prueba('cola de candidatos: 9 dígitos; números de relleno no sirven', colaCandidatos('593987654321') === '987654321' && colaCandidatos('0000000000') === null && colaCandidatos('12345') === null);
  prueba('país por el código: 593 → ec, 52 → mx, 57 → co', paisDelTelefono('593987654321') === 'ec' && paisDelTelefono('5215512345678') === 'mx' && paisDelTelefono('573001234567') === 'co');

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n3. En qué paso va una carga: igual que el PHP de Imporsuit (33 casos)');
  const CLAVES = ['paso', 'paso_nombre', 'contenedor', 'otros_contenedores', 'recepcion', 'entregada', 'parcial', 'dato_dudoso', 'texto_cliente', 'avisos'];
  prueba('hay un resultado del PHP por cada caso', CASOS.length === ESPERADO_PHP.length && CASOS.every((c, i) => c.nombre === ESPERADO_PHP[i].nombre));
  CASOS.forEach((c, i) => {
    const js = estadoDeCarga(c.cot, HOY_CASOS, c.abiertoDesde || {});
    const php = ESPERADO_PHP[i].esperado;
    const distinta = CLAVES.find((k) => !igual(js[k], php[k]));
    prueba(`paso ${php.paso} · ${c.nombre}`, !distinta, distinta ? `difiere «${distinta}»: js=${JSON.stringify(js[distinta])} php=${JSON.stringify(php[distinta])}` : '');
  });

  console.log('\n4. Regla de oro: sin fecha en el dato, no hay fecha');
  const conFecha = (texto) => FECHA.test(texto || '') || /\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}/.test(texto || '');
  const sinEstimada = CASOS.filter((c) => {
    const e = estadoDeCarga(c.cot, HOY_CASOS, c.abiertoDesde || {});
    return e.texto_cliente && !e.entregada && e.paso >= 1 && e.paso <= 6 && !e.fecha_estimada_vigente;
  });
  prueba(`ningún texto de los pasos 1 a 6 sin fecha estimada nombra una fecha (${sinEstimada.length} casos)`,
    sinEstimada.length >= 15 && sinEstimada.every((c) => !conFecha(estadoDeCarga(c.cot, HOY_CASOS, c.abiertoDesde || {}).texto_cliente)));
  const enAduana = CASOS.find((c) => c.nombre.startsWith('paso 5 aduana, con estimada'));
  prueba('en aduana no se nombra la fecha estimada aunque exista', !conFecha(estadoDeCarga(enAduana.cot, HOY_CASOS).texto_cliente));
  const enTransito = CASOS.find((c) => c.nombre === 'paso 4 con fecha estimada');
  prueba('en tránsito con fecha: la nombra y dice que es una estimación', /24 de octubre; es una estimación y puede moverse/.test(estadoDeCarga(enTransito.cot, HOY_CASOS).texto_cliente));
  const vencida = estadoDeCarga(enTransito.cot, '2026-10-25', {}, { descartarEstimadaVencida: true });
  prueba('para el bot, una fecha estimada que ya pasó NO se nombra', !conFecha(vencida.texto_cliente) && vencida.estimada_vencida && vencida.fecha_estimada_vigente === null);
  prueba('…y el día mismo de la fecha todavía se nombra', estadoDeCarga(enTransito.cot, '2026-10-24', {}, { descartarEstimadaVencida: true }).fecha_estimada_vigente === '2026-10-24');
  prueba('para el bot el saludo va sin el nombre del cliente', estadoDeCarga(enTransito.cot, HOY_CASOS, {}, { conNombre: false }).texto_cliente.startsWith('Hola, el contenedor'));
  prueba('dato dudoso (contenedor «asignado» hace más de 30 días): no hay texto', estadoDeCarga(CASOS[10].cot, HOY_CASOS, CASOS[10].abiertoDesde).texto_cliente === null);
  prueba('fecha(): «0000-00-00», vacío y basura son «sin fecha»', fecha('0000-00-00') === null && fecha('') === null && fecha(null) === null && fecha('pronto') === null && fecha('2026-10-24 08:00:00') === '2026-10-24');
  prueba('hoy en Ecuador: a las 03:00 UTC todavía es el día anterior', hoyEcuador(new Date('2026-10-13T03:00:00Z')) === '2026-10-12');

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n5. «¿Dónde está mi carga?» por el teléfono del que escribe (base de mentira)');
  let r = await cargas(TEL.transito_con_fecha);
  prueba('en tránsito con fecha: la encuentra y da paso, contenedor y fecha', r.estado === 'encontradas' && r.cargas.length === 1 && r.cargas[0].paso === 4 && r.cargas[0].paso_nombre === 'En tránsito' && r.cargas[0].contenedor === 'EC-PRUEBA-OCT-A' && r.cargas[0].fecha_estimada === '2026-10-24');
  prueba('…con la novedad para el cliente al final del texto', /Última novedad registrada \(9 de octubre\): El buque hizo trasbordo en Panamá\.$/.test(r.cargas[0].texto_cliente) && r.cargas[0].nota_cliente === 'El buque hizo trasbordo en Panamá');
  prueba('…y el texto es el del portal, sin el nombre', r.cargas[0].texto_cliente.startsWith('Hola, el contenedor EC-PRUEBA-OCT-A, donde viaja tu carga EC-9001001, ya está en tránsito hacia Ecuador. La fecha estimada de llegada que tenemos registrada es el 24 de octubre; es una estimación y puede moverse.'));
  r = await cargas(TEL.aduana);
  prueba('en aduana: paso 5 y NINGUNA fecha, aunque el contenedor tenga una estimada (ya vencida)', r.cargas[0].paso === 5 && r.cargas[0].fecha_estimada === null && !conFecha(r.cargas[0].texto_cliente));
  r = await cargas(TEL.fecha_vencida);
  prueba('en tránsito con la fecha estimada vencida: no la da', r.cargas[0].paso === 4 && r.cargas[0].fecha_estimada === null && r.cargas[0].estimada_vencida && /Todavía no tengo una fecha estimada confirmada/.test(r.cargas[0].texto_cliente));
  r = await cargas(TEL.dos_cargas);
  prueba('teléfono que solo está en la plataforma del alumno: encuentra sus dos cargas', r.estado === 'encontradas' && igual(r.cargas.map((c) => c.id_cotizacion), [9003, 9004]) && igual(r.cargas.map((c) => c.paso), [2, 7]));
  prueba('…recibida a medias en China: dice qué marca falta', igual(r.cargas[0].marcas_pendientes, ['EC-9003002']) && /Falta por llegar: EC-9003002/.test(r.cargas[0].texto_cliente));
  prueba('…en bodega de destino con su fecha de llegada', /ya está en nuestra bodega de Ecuador desde el 8 de octubre/.test(r.cargas[1].texto_cliente));
  const dosCargas = r;
  r = await cargas(TEL.mexico_liberado);
  prueba('México, guardado sin código de país: liberado (paso 6)', r.estado === 'encontradas' && r.cargas[0].paso === 6 && r.cargas[0].destino === 'México' && /ya fue liberado de aduana/.test(r.cargas[0].texto_cliente));
  r = await cargas(TEL.contenedor_nuevo);
  prueba('recién asignada a un contenedor: paso 3', r.cargas[0].paso === 3 && r.cargas[0].informable && /ya está asignada al contenedor EC-PRUEBA-OCT-J/.test(r.cargas[0].texto_cliente));
  r = await cargas(TEL.recibida_parcial);
  prueba('1 de 2 marcas recibidas: paso 2', r.cargas[0].paso === 2 && /ya recibimos 1 de tus 2 marcas de envío \(5 cajas\)/.test(r.cargas[0].texto_cliente));
  r = await cargas(TEL.dudoso);
  prueba('contenedor «asignado» hace 53 días: NO se informa (lo confirma logística)', r.estado === 'encontradas' && r.cargas[0].informable === false && r.cargas[0].motivo === 'dato_dudoso' && r.cargas[0].texto_cliente === null && textoParaCliente(r, T.MENSAJE_ASESOR) === null);
  r = await cargas(TEL.sin_marcas);
  prueba('cotización aprobada sin marcas registradas: NO se informa (sin nada recibido en China no es una carga en curso)', r.estado === 'sin_carga' && r.cargas.length === 0 && igual(r.propias.cotizaciones, [9030]));
  r = await cargas(TEL.repartida);
  prueba('carga repartida en dos contenedores: NO se informa («en tránsito» sería cierto solo para una parte)', r.cargas[0].informable === false && r.cargas[0].motivo === 'varios_contenedores' && r.cargas[0].texto_cliente === null && !/28 de octubre|EC-PRUEBA-SEP-K/.test(bloqueCarga(r, { mensajeAsesor: T.MENSAJE_ASESOR })));
  r = await cargas(TEL.sin_carga);
  prueba('sin ninguna cotización: lo dice («sin_carga») y no devuelve nada', r.estado === 'sin_carga' && r.cargas.length === 0);
  r = await cargas(TEL.borrador);
  prueba('solo un borrador: no es una carga', r.estado === 'sin_carga' && igual(r.propias.cotizaciones, [9015]));
  r = await cargas(TEL.solo_vieja);
  prueba('solo una cotización de hace 10 meses que no avanzó: «solo_historicas»', r.estado === 'solo_historicas' && r.cargas.length === 0);
  r = await cargas(TEL.entregada);
  prueba('entregada hace 9 días: la cuenta; la de hace 7 meses, no', r.estado === 'encontradas' && igual(r.cargas.map((c) => c.id_cotizacion), [9010]) && /fue entregada el 3 de octubre/.test(r.cargas[0].texto_cliente));
  r = await cargas(TEL.seis_cargas);
  prueba('seis cargas en curso: lista 4 y avisa que hay 2 más', r.cargas.length === 4 && r.hay_mas === 2 && /otras 2 cargas registradas/.test(textoParaCliente(r, T.MENSAJE_ASESOR)));
  r = await cargas(TEL.cuenta_prueba);
  prueba('cotización de una cuenta de pruebas del equipo: no se muestra', r.estado === 'sin_carga');
  prueba('esCorreoDePrueba: la lista, las variantes y ningún Jara de verdad', esCorreoDePrueba('jeimyjara@hotmail.com') && esCorreoDePrueba('jeim5111235512jara@hotmail.com') && esCorreoDePrueba('desarrollo2imporfactory@gmail.com') && !esCorreoDePrueba('jjara@gmail.com') && !esCorreoDePrueba('maria.jaramillo@gmail.com') && !esCorreoDePrueba(''));

  console.log('\n6. Seguridad: solo la carga del número que escribe');
  r = await cargas(TEL.cola_gemela);
  prueba('🔒 número de México con la misma cola de 9 dígitos que una clienta de Ecuador: NO ve su carga', r.estado === 'sin_carga' && r.cargas.length === 0 && r.propias.cotizaciones.length === 0);
  r = await cargas(TEL.peru_gemelo);
  prueba('🔒 número de Perú con el mismo número nacional: NO ve su carga', r.estado === 'sin_carga' && r.cargas.length === 0);
  r = await cargas(TEL.compartido);
  prueba('🔒 un teléfono que está en cotizaciones de dos clientes distintos: no se informa ninguna', r.estado === 'varios_clientes' && r.cargas.length === 0 && r.propias.marcas.length === 0);
  r = await cargas(TEL.desconocido);
  prueba('🔒 un número que nadie conoce no recibe nada', r.estado === 'sin_carga');
  r = await cargas('12345');
  prueba('🔒 número inservible: no se consulta la base', r.estado === 'telefono_no_valido');
  r = await cargas(TEL.whatsapp_sin_codigo);
  prueba('🔒 WhatsApp del alumno guardado sin código de país: solo ve su carga hacia SU país (la de México no)', r.estado === 'encontradas' && igual(r.cargas.map((c) => c.id_cotizacion), [9042]) && igual(r.propias.cotizaciones, [9042]));
  r = await cargas(TEL.sin_carga);
  prueba('🔒 una cuenta del equipo con ese WhatsApp en su plataforma no entra por el camino del alumno', r.estado === 'sin_carga' && r.propias.cotizaciones.length === 0);
  {
    const todas = new Set();
    for (const tel of Object.values(TEL)) {
      const x = await cargas(tel);
      const propias = DATOS.cotizaciones.filter((c) => x.propias.cotizaciones.includes(c.id_cotizacion));
      // cada cotización devuelta tiene que ser de ese teléfono: por la cotización o por su plataforma
      const ajena = x.cargas.find((c) => !propias.some((p) => p.id_cotizacion === c.id_cotizacion));
      const porSuPlataforma = (p) =>
        DATOS.usuarios.some((u) => {
          if (u.id_users !== p.id_users || ![3, 4, 14, 16, 18].includes(u.id_rol)) return false;
          const como = comoCoincide(tel, u.whatsapp);
          return como === 'exacto' || (como === 'nacional' && paisDeDestino(p.pais_destino) === paisDelTelefono(tel));
        });
      const mal = propias.find((p) => !mismoTelefono(tel, p.telefono, p.pais_destino) && !porSuPlataforma(p));
      if (ajena || mal) todas.add(tel);
    }
    prueba(`🔒 barrido de los ${Object.keys(TEL).length} teléfonos de prueba: ninguno recibe una cotización que no sea suya`, todas.size === 0, [...todas].join(','));
  }
  {
    const { consultar, consultas } = baseDeMentira();
    await cargasDelTelefono(TEL.transito_con_fecha, { consultar, hoy: HOY });
    prueba('solo lectura: todas las consultas son SELECT y ninguna toca pagos ni saldos', consultas.length >= 5 && consultas.every((q) => /^\s*select\b/i.test(q) && !/\b(insert|update|delete|replace|alter|drop)\b/i.test(q) && !/cuenta_por_pagar|cartera_pagos|monto/i.test(q)));
    prueba('el teléfono entra como parámetro, nunca pegado en la consulta', consultas.every((q) => !q.includes('901234501')));
    let rechazo = '';
    await consultarImporsuit('UPDATE cotizadorpro_cargas SET estado = 1').catch((e) => { rechazo = e.message; });
    let rechazo2 = '';
    await consultarImporsuit('SELECT 1; DELETE FROM users').catch((e) => { rechazo2 = e.message; });
    prueba('el adaptador real se niega a ejecutar algo que no sea un SELECT solo', /solo se permiten consultas SELECT/.test(rechazo) && /solo se permiten consultas SELECT/.test(rechazo2));
  }
  r = await cargas(TEL.transito_con_fecha, { falla: 'ECONNREFUSED' });
  prueba('la base no responde: «error», sin datos (el bot pasa a logística)', r.estado === 'error' && r.cargas.length === 0);
  r = await cargas(TEL.transito_con_fecha, { demoraMs: 300, limite_ms: 60 });
  prueba('la base tarda demasiado: se corta y no deja al cliente esperando', r.estado === 'error' && /sin respuesta/.test(r.motivo));
  r = await cargas(TEL.dos_cargas, { sinRegexp: true });
  prueba('base sin REGEXP_REPLACE (MySQL 5.7): cae a la cadena de REPLACE y encuentra igual', r.estado === 'encontradas' && r.cargas.length === 2);
  r = await cargas(TEL.transito_con_fecha, { sinSeguimiento: true, sinEntregas: true });
  prueba('base sin la migración del packing ni la tabla de entregas: igual responde, sin novedad', r.estado === 'encontradas' && r.cargas[0].paso === 4 && r.cargas[0].nota_cliente === null);

  console.log('\n7. El bloque de carga que recibe el modelo');
  r = await cargas(TEL.transito_con_fecha);
  let b = bloqueCarga(r, { mensajeAsesor: T.MENSAJE_ASESOR });
  prueba('una carga: paso, contenedor, fecha estimada, novedad y el texto para el cliente', /Paso 4 de 7: En tránsito/.test(b) && /Contenedor: EC-PRUEBA-OCT-A/.test(b) && /Fecha estimada de llegada registrada: 24 de octubre/.test(b) && /Novedad registrada para el cliente: «El buque hizo trasbordo en Panamá»/.test(b) && /TEXTO PARA EL CLIENTE/.test(b));
  prueba('el bloque no trae nombre, correo, teléfono ni montos', !/\bAna\b|Ejemplo|@|901234501|\$|USD|saldo|\bpagos?\b/.test(b));
  b = bloqueCarga(await cargas(TEL.aduana), { mensajeAsesor: T.MENSAJE_ASESOR });
  prueba('sin fecha: el bloque lo dice con todas las letras', /Fecha: NO hay ninguna fecha que se pueda dar/.test(b) && !FECHA.test(b));
  b = bloqueCarga(dosCargas, { mensajeAsesor: T.MENSAJE_ASESOR });
  prueba('dos cargas: un solo texto con una línea por carga', /con este número tienes 2 cargas registradas:\n- Cotización N\.º 9003: En nuestra bodega de China/.test(b) && /\n- Cotización N\.º 9004: Tu carga EC-9004001 ya está en nuestra bodega/.test(b));
  b = bloqueCarga(await cargas(TEL.dudoso), { mensajeAsesor: T.MENSAJE_ASESOR });
  prueba('dato dudoso: «NO SE PUEDE INFORMAR», sin paso ni contenedor, y va a logística', /NO SE PUEDE INFORMAR/.test(b) && !/Paso \d de 7/.test(b) && !/EC-PRUEBA/.test(b) && /paso a asesor para el área de logística/.test(b));
  b = bloqueCarga(await cargas(TEL.sin_carga), { mensajeAsesor: T.MENSAJE_ASESOR });
  prueba('sin carga: lo dice y prohíbe suponer un estado', /NO hay ninguna carga registrada con este número/.test(b) && /No digas ni supongas ningún estado/.test(b));
  b = bloqueCarga(await cargas(TEL.compartido), { mensajeAsesor: T.MENSAJE_ASESOR });
  prueba('teléfono compartido: no dice por qué, solo que no se informa', /NO SE PUEDE INFORMAR/.test(b) && !/client|compart/i.test(b.split('\n').slice(1).join('\n')));
  b = bloqueCarga(dosCargas, { codigos: codigosEnMensaje('y la EC-9001001 cómo va? y mi cotización 9003'), mensajeAsesor: T.MENSAJE_ASESOR });
  prueba('🔒 una marca ajena escrita en el chat se señala; su propia cotización, no', /El cliente escribió EC-9001001\. Ese código NO figura entre las cargas de este número/.test(b) && !/cotización 9003\b.*NO figura/.test(b));
  prueba('códigos del mensaje: marcas EC/MX y números de cotización', igual(codigosEnMensaje('mi marca es ec 2609112 y MX-2609113, cotización N.º 4521 y cotizacion #4522'), { marcas: ['EC-2609112', 'MX-2609113'], cotizaciones: [4521, 4522] }));
  prueba('…sin falsos positivos: «el valor de 12500», «cotización de 500 unidades», un teléfono', igual(codigosEnMensaje('transferí el valor de 12500, la cotización de 500 unidades, mi número mx 5512345678'), { marcas: [], cotizaciones: [] }));

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n8. Buscador de fichas (sin IA)');
  const mini = crearBuscador([
    { id: 'cbm', tema: 'cotización', pais: 'todos', preguntas: ['que es el cbm', 'como calculo el volumen'], respuesta_base: 'El CBM es el volumen de tu carga en metros cúbicos.', pasos: [], enlace: '', pasar_a: '' },
    { id: 'clase-enlace', tema: 'clases', pais: 'todos', preguntas: ['hoy hay clase', 'me pasan el link de la clase'], respuesta_base: 'El enlace es siempre el mismo.', pasos: ['Abre el enlace.', 'Espera a que abra la sala.'], enlace: 'https://ejemplo.test/clase', pasar_a: '' },
    { id: 'impuestos-ec', tema: 'impuestos', pais: 'ec', preguntas: ['cuanto pago de impuestos'], respuesta_base: 'Depende de la partida.', pasar_a: 'pricing', pedir: 'descripción del producto' },
    { id: 'impuestos-mx', tema: 'impuestos', pais: 'MX', preguntas: ['cuanto pago de impuestos'], respuesta_base: 'En México depende de la fracción.', pasar_a: 'pricing' },
    { id: 'reclamo', tema: 'reclamos', pais: 'todos', preguntas: ['quiero poner un reclamo', 'nadie me atiende'], respuesta_base: '', pasar_a: 'líder comercial', no_decir: ['No ofrecer devoluciones.'] },
    { id: 'carga-estado', tema: 'carga', pais: 'todos', preguntas: ['donde esta mi carga', 'cuando llega mi carga'], respuesta_base: 'Lo revisa el área de logística.', pasar_a: 'logística', pedir: 'marca de envío o número de cotización', no_decir: ['No decir en qué paso está la carga.', 'Ninguna fecha.'] },
    { id: 'rota' }, { tema: 'sin id' },
  ]);
  prueba('descarta las fichas que no sirven (sin id, o sin respuesta ni pase)', mini.total === 6);
  prueba('«Qué es el CBM?» → cbm', mini.buscar('Qué es el CBM?')[0]?.ficha.id === 'cbm');
  prueba('tolerante a tildes y mayúsculas: «HOY HAY CLÁSE?» → clase-enlace', mini.buscar('HOY HAY CLÁSE?')[0]?.ficha.id === 'clase-enlace');
  prueba('por raíz: «ya llegaría mi carga» → carga-estado', mini.buscar('ya llegaría mi carga')[0]?.ficha.id === 'carga-estado');
  prueba('con error de tipeo: «quiero poner un reclamoo» → reclamo', mini.buscar('quiero poner un reclamoo')[0]?.ficha.id === 'reclamo');
  prueba('por país: a un número de Ecuador no le llega la ficha de México', igual(mini.buscar('cuanto pago de impuestos', { pais: 'ec' }).map((x) => x.ficha.id), ['impuestos-ec']));
  prueba('…y a uno de México, la suya', igual(mini.buscar('cuanto pago de impuestos', { pais: 'mx' }).map((x) => x.ficha.id), ['impuestos-mx']));
  prueba('…y con país desconocido, ninguna de las dos', mini.buscar('cuanto pago de impuestos', { pais: null }).length === 0);
  prueba('un saludo o un «gracias» no trae fichas', mini.buscar('hola buenas noches').length === 0 && mini.buscar('ok gracias').length === 0 && mini.buscar('').length === 0);
  prueba('algo que la base no conoce no trae fichas', mini.buscar('xyzzy qwerty').length === 0);
  prueba('devuelve como mucho 3, de la más parecida a la menos', mini.buscar('clase carga cbm reclamo impuestos', { pais: 'ec' }).length <= 3);
  let bf = bloqueFichas(mini.buscar('me pasan el link de la clase'));
  prueba('bloque: respuesta, pasos uno por línea y el enlace tal cual', /Respuesta: El enlace es siempre el mismo\./.test(bf) && /  - Abre el enlace\.\n  - Espera a que abra la sala\./.test(bf) && /Enlace: https:\/\/ejemplo\.test\/clase/.test(bf));
  bf = bloqueFichas(mini.buscar('quiero poner un reclamo'));
  prueba('bloque: el cargo interno sale con el nombre para el cliente («la persona responsable»)', /paso a asesor para la persona responsable, sin pedirle datos/.test(bf) && !/l[ií]der comercial|pricing/i.test(bf) && /No digas: No ofrecer devoluciones\./.test(bf));
  bf = bloqueFichas(mini.buscar('cuanto pago de impuestos', { pais: 'ec' }));
  prueba('bloque: «pricing» sale como «el área de precios» con el dato que hace falta', /paso a asesor para el área de precios\. Dato que hace falta, si todavía no lo dio: descripción del producto/.test(bf));
  bf = bloqueFichas(mini.buscar('donde esta mi carga'), { hayCarga: false });
  prueba('ficha de carga SIN dato real: pide la marca y prohíbe decir el paso', /Dato que hace falta, si todavía no lo dio: marca de envío/.test(bf) && /No decir en qué paso está la carga/.test(bf));
  bf = bloqueFichas(mini.buscar('donde esta mi carga'), { hayCarga: true });
  prueba('ficha de carga CON dato real: cede ante el bloque 📦 y ya no prohíbe decir el paso', /ya tienes su carga real en el bloque 📦/.test(bf) && !/No decir en qué paso/.test(bf) && !/Dato que hace falta/.test(bf) && /Ninguna fecha\./.test(bf));
  const val = validarFichas({ fichas: [{ id: 'a', respuesta_base: 'x', preguntas: ['p'] }, { id: 'a', respuesta_base: 'y' }, { tema: 'z' }] });
  prueba('validar: acepta { fichas: [...] } y avisa de id repetido y de ficha sin id', val.fichas.length === 1 && val.errores.length === 2);
  prueba('validar: un archivo que no es una lista se rechaza', validarFichas({ hola: 1 }).fichas.length === 0 && validarFichas('x').errores.length === 1);
  prueba('acepta la forma de la versión 1 («hecho» en vez de «respuesta_base»)', crearBuscador([{ id: 'v1', tema: 'Qué es la proforma', hecho: 'La proforma es el documento del proveedor.' }]).buscar('que es la proforma')[0]?.ficha.respuesta_base.startsWith('La proforma'));

  console.log(`\n9. Buscador sobre la base real (${path.relative(process.cwd(), RUTA_FICHAS)})`);
  const real = buscadorDeArchivo();
  const crudas = JSON.parse(fs.readFileSync(RUTA_FICHAS, 'utf8'));
  const validacion = validarFichas(crudas);
  prueba(`el archivo carga y todas sus fichas sirven (${real.version})`, real.total >= 50 && validacion.errores.filter((e) => !/sin «preguntas»/.test(e)).length === 0, validacion.errores.slice(0, 3).join(' | '));
  const ids = new Set(real.fichas.map((f) => f.id));
  const ESPERADAS = [
    ['Hola, hoy tenemos clase?', 'clase-en-vivo-enlace'], ['Qué es el CBM?', 'cbm'],
    ['no puedo entrar a la plataforma, me dice usuario incorrecto', 'no-puedo-entrar-plataforma'],
    ['Buen día ya llegaría la mercadería', 'cuando-llega-mi-carga'], ['donde esta mi carga', 'cuando-llega-mi-carga'],
    ['me ayudan con una cotisacion porfa', 'cotizar-datos'], ['esto es una estafa nadie me responde', 'reclamo-general'],
    ['quiero hablar con una persona', 'habla-con-persona-o-robot'], ['se pueden traer vapes?', 'producto-se-puede-traer'],
    ['que es infoaduana', 'infoaduana'], ['mi proveedor no me da el cbm', 'proveedor-no-da-cbm'],
    ['Hola, me interesa el producto SGTE-58 (Altavoz portátil) del catálogo de Ideas de Productos.', 'cotizar-producto-del-catalogo'],
    ['llegaron incompletas mis cajas a china', 'cajas-incompletas-china'], ['que significa fob', 'fob'],
  ].filter(([, id]) => ids.has(id));
  let entre3 = 0;
  const perdidas = [];
  for (const [q, id] of ESPERADAS) {
    if (real.buscar(q, { pais: 'ec' }).some((x) => x.ficha.id === id)) entre3++;
    else perdidas.push(`${q} → ${id}`);
  }
  prueba(`la ficha correcta sale entre las 3 primeras en las ${ESPERADAS.length} frases de la prueba en papel`, ESPERADAS.length >= 10 && entre3 === ESPERADAS.length, perdidas.join(' | '));
  prueba('nunca devuelve más de 3 fichas', ['donde esta mi carga y cuando hay clase y que es el cbm', 'plataforma clase carga pago cotizacion proveedor'].every((q) => real.buscar(q, { pais: 'ec' }).length <= 3));
  const bloqueReal = bloqueFichas(real.buscar('donde esta mi carga y cuando hay clase y que es el cbm', { pais: 'ec' }));
  prueba(`3 fichas reales caben en menos de 4.500 caracteres (${bloqueReal.length})`, bloqueReal.length > 200 && bloqueReal.length < 4500);
  const todosLosBloques = real.fichas.map((f) => bloqueFichas([{ ficha: f }])).join('\n');
  prueba('en ningún bloque sale un cargo interno como destino («para pricing», «para líder comercial»)', !/paso a asesor para (pricing|l[ií]der comercial|supervisor|front)/i.test(todosLosBloques));
  {
    // Si el modelo copia una ficha tal cual, la guardia no puede frenarla.
    const frenadas = [];
    for (const f of real.fichas) {
      const decible = [f.respuesta_base, ...f.pasos, f.enlace, f.pedir].filter(Boolean).join('\n');
      const copia = [f.respuesta_base, ...f.pasos.map((p) => `- ${p}`), f.enlace && !f.respuesta_base.includes(f.enlace) ? f.enlace : ''].filter(Boolean).join('\n');
      if (!copia) continue;
      const rev = revisarRespuesta(copia, { respaldo: { firme: `${Object.values(T.TEXTOS_FIJOS).join('\n')}\n${decible}`, eco: '' } });
      if (rev.cambiada) frenadas.push(`${f.id} (${rev.motivos.join('; ')})`);
    }
    prueba(`una respuesta que copia cualquiera de las ${real.total} fichas tal cual pasa la guardia sin tocarse`, frenadas.length === 0, frenadas.slice(0, 4).join(' | '));
  }
  prueba('«hola buenas noches» y «ok gracias» no traen fichas de la base real', real.buscar('hola buenas noches').length === 0 && real.buscar('ok gracias').length === 0);

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n10. Audios, fotos y archivos');
  let a = leerAdjuntos('cuándo llega mi carga', 'text');
  prueba('texto normal: sin adjuntos y el motor usa su mensaje', a.adjuntos.length === 0 && a.mensajeParaModelo === null && a.textoParaBuscar === 'cuándo llega mi carga');
  a = leerAdjuntos('hola buenas, quería saber si ya llegó mi carga a Guayaquil', 'audio');
  prueba('nota de voz transcrita: se marca como tal y avisa de posibles errores', a.esNotaDeVoz && /\[NOTA DE VOZ del cliente, transcrita automáticamente; puede traer errores/.test(a.mensajeParaModelo) && a.textoParaBuscar.includes('ya llegó mi carga'));
  a = leerAdjuntos('[El cliente envió un audio que no se pudo transcribir]', 'audio');
  prueba('audio que no se pudo transcribir: lo dice y marca «solo ilegible»', a.adjuntos[0].tipo === 'audio' && !a.adjuntos[0].leido && a.soloIlegible && /Nota de voz: NO se pudo transcribir/.test(a.mensajeParaModelo) && /EL CLIENTE NO ESCRIBIÓ NADA MÁS/.test(a.mensajeParaModelo));
  a = leerAdjuntos('[IMAGEN: comprobante_pago] Banco Pichincha, monto 150,00 USD, referencia 889912\nCliente: ahí está el pago de la 4521', 'image');
  prueba('imagen leída con pie: clase de imagen, descripción y lo que escribió el cliente por separado', a.adjuntos[0].clase === 'comprobante_pago' && a.adjuntos[0].leido && a.textoCliente === 'ahí está el pago de la 4521' && /Imagen \(comprobante de pago\), leída automáticamente: «Banco Pichincha/.test(a.mensajeParaModelo) && !a.soloIlegible);
  prueba('…y la descripción entra a la búsqueda de fichas', a.textoParaBuscar.includes('Banco Pichincha') && a.textoParaBuscar.includes('pago de la 4521'));
  a = leerAdjuntos('[El cliente envió una imagen]', 'image');
  prueba('imagen que no se pudo leer', a.adjuntos[0].tipo === 'imagen' && a.soloIlegible && /Imagen: NO se pudo leer/.test(a.mensajeParaModelo));
  a = leerAdjuntos('proforma_final (2).pdf', 'document');
  prueba('documento sin pie: llega el nombre del archivo y no se toma como texto del cliente', a.adjuntos[0].tipo === 'documento' && a.adjuntos[0].nombre === 'proforma_final (2).pdf' && a.textoCliente === '' && a.soloIlegible && /Documento «proforma_final \(2\)\.pdf»: NO lo puedes abrir/.test(a.mensajeParaModelo));
  a = leerAdjuntos('aquí va mi proforma para la cotización', 'document');
  prueba('documento con pie: adjunto + el texto del cliente', a.adjuntos[0].tipo === 'documento' && a.textoCliente === 'aquí va mi proforma para la cotización' && !a.soloIlegible);
  a = leerAdjuntos('', 'video');
  prueba('video sin pie (el motor lo recibía vacío): ahora el modelo sabe que llegó un video', a.adjuntos[0].tipo === 'video' && a.soloIlegible && /Video: NO lo puedes ver/.test(a.mensajeParaModelo));
  a = leerAdjuntos('Sticker recibido y guardado con ID: 4471', 'sticker');
  prueba('sticker: no dice nada, y no cuenta como «algo que no se pudo abrir» (ahí el bot calla)', a.adjuntos[0].tipo === 'sticker' && /Un sticker \(no dice nada\)/.test(a.mensajeParaModelo) && !a.soloIlegible);
  prueba('mensaje eliminado: tampoco pide explicación', !leerAdjuntos('🚫 Mensaje eliminado por el usuario', 'revoke').soloIlegible);
  a = leerAdjuntos('hola\nfactura.pdf\nesa es la factura del proveedor', 'text');
  prueba('ráfaga (texto + archivo + texto): se lee línea por línea', a.adjuntos.length === 1 && a.adjuntos[0].tipo === 'documento' && a.textoCliente === 'hola\nesa es la factura del proveedor');
  a = leerAdjuntos('les envío el archivo de la proforma con todos los datos en proforma.pdf', 'text');
  prueba('una frase larga que termina en «.pdf» es texto del cliente, no un archivo', a.adjuntos.length === 0);
  a = leerAdjuntos('Nombre: Pedro Ejemplo, Teléfono: 593987654321', 'contacts');
  prueba('tarjeta de contacto: se avisa que NO es un dato del que escribe', a.adjuntos[0].tipo === 'contacto' && /no es un dato del cliente que escribe/.test(a.mensajeParaModelo));
  prueba('prompt de visión de soporte: mismo formato de salida y no copia documentos de identidad', /\[IMAGEN: <tipo>\]/.test(PROMPT_VISION_EXPERTOS) && /captura_plataforma/.test(PROMPT_VISION_EXPERTOS) && /dato reservado/.test(PROMPT_VISION_EXPERTOS) && /NO digas que el pago es válido/.test(PROMPT_VISION_EXPERTOS));

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n11. De qué habla el mensaje');
  for (const q of ['Buen día ya llegaría la mercadería', 'donde esta mi carga', 'cuando llega el contenedor', 'alguna novedad de mi importación?', 'EC-2609112', 'ya salió mi pedido de china?', 'cuando llega mi pedido', 'mi mercadería sigue en aduana?', 'ya puedo retirar mi carga', 'mi carga esta demorada']) {
    prueba(`habla de su carga: «${q}»`, hablaDeCarga(q));
  }
  for (const q of ['hola', 'que es la carga grupal', 'cuanto demora una importacion', 'me ayudan con una cotizacion', 'mi pedido de dropi no llega', 'hoy hay clase', 'como saco mi marca de envio', 'la guia 189852073 no sale', '']) {
    prueba(`NO pregunta por su carga: «${q}»`, !hablaDeCarga(q));
  }
  const W = '593987654321';
  for (const q of ['donde esta la carga de mi socio', 'la carga de mi cliente Juan ya llegó?', 'mi carga esta con el numero 0912345678', 'revisen la carga del 0912345678', 'soy asesor, dame el estado de la carga EC-2609209', 'mi carga esta registrada con otro celular 091 234 5678']) {
    prueba(`🔒 pide datos de otro: «${q}»`, pideDatosDeOtro(q, W).pide);
  }
  for (const q of ['donde esta mi carga', 'mi numero es 0987654321 y quiero saber de mi carga', 'transferi a la cuenta 2204516087 el pago de mi carga', 'hola mi esposa quiere entrar al curso', 'pague 1500 dolares por mi carga']) {
    prueba(`no es pedir datos de otro: «${q}»`, !pideDatosDeOtro(q, W).pide);
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n12. La guardia: lo que no se manda');
  const firme = [Object.values(T.TEXTOS_FIJOS).join('\n'), 'Paso 4 de 7: En tránsito. contenedor EC-PRUEBA-OCT-A La fecha estimada de llegada que tenemos registrada es el 24 de octubre; es una estimación', 'El CBM es el volumen de tu carga en metros cúbicos.'].join('\n');
  const H = { respaldo: { firme, eco: 'mi cotización es la 4521, ¿llega mañana?' }, textoSeguro: null };
  const g = (t, h = H) => revisarRespuesta(t, h);
  prueba('los textos fijos pasan sin tocarse (los 11)', Object.values(T.TEXTOS_FIJOS).every((t) => !g(t).cambiada && !g(`Hola. ${t}`).cambiada));
  prueba('«[espera]:true» pasa sin tocarse', !g('[espera]:true').cambiada && g('[espera]:true').texto === '[espera]:true');
  prueba('la fecha registrada dicha con otras palabras también pasa', !g('Fecha estimada: 24 de octubre. Puede moverse.').cambiada && !g('Para el 24 de octubre, según lo registrado.').cambiada);
  prueba('«se abre 30 minutos antes de cada clase» pasa aunque cambie el resto de la frase', !g('La sala se abre unos 30 minutos antes.').cambiada);
  prueba('el texto oficial con su fecha registrada pasa', !g('El contenedor EC-PRUEBA-OCT-A ya está en tránsito. La fecha estimada de llegada que tenemos registrada es el 24 de octubre; es una estimación y puede moverse.').cambiada);
  for (const [nombre, texto, motivo] of [
    ['fecha inventada', 'Tu carga llega el 28 de octubre.', /plazo «28 de octubre»/],
    ['fecha inventada con el día correcto y otro mes', 'Tu carga llega el 24 de noviembre.', /plazo «24 de noviembre»/],
    ['«la próxima semana»', 'Tu carga llega la próxima semana.', /plazo/],
    ['«en unos días»', 'Debe estar llegando en unos días.', /plazo/],
    ['«mañana», aunque el cliente lo haya dicho', 'Sí, mañana te escribe un asesor.', /plazo «mañana»/],
    ['«hoy mismo»', 'Un asesor te escribe hoy mismo.', /plazo/],
    ['«pronto»', 'Te escribimos pronto.', /plazo «pronto»/],
    ['«a fines de mes»', 'Llega a fines de mes.', /plazo/],
    ['día de la semana', 'El lunes te confirmo.', /plazo «lunes»/i],
    ['precio', 'El flete te sale en 250 dólares.', /monto «250 dólares»/],
    ['porcentaje', 'Pagas el 12% de arancel.', /monto «12%»/],
    ['plazo en horas con una cifra que sí está en otro dato (24 de octubre)', 'Te respondemos en 24 horas.', /plazo «24 horas»/],
    ['fecha armada con piezas respaldadas (30 minutos + octubre)', 'Tu carga llega el 30 de octubre.', /plazo «30 de octubre»/],
    ['fecha con barras', 'Llega el 24/10.', /plazo «24\/10»/],
    ['duración que está en otro texto con otro sentido («30 minutos antes de cada clase»)', 'Envíame la foto y en 30 minutos te paso la cotización.', /plazo «30 minutos»/],
    ['monto con una cifra que sí está en otro dato', 'El saldo es de $24.', /monto/],
    ['porcentaje con una cifra respaldada', 'Se paga el 30% al inicio.', /monto «30%»/],
    ['enlace que no está en la base', 'Entra a https://bit.ly/abc', /enlace/],
    ['correo que no está en la base', 'Escríbenos a ventas@otra-empresa.com', /correo/],
    ['estado de carga sin dato: «ya está en aduana»', 'Tu carga ya está en aduana.', /afirmaba «en aduana»/],
    ['estado de carga sin dato: «ya salió»', 'Tranquilo, tu contenedor ya salió.', /afirmaba «ya salio»/],
    ['estado de carga sin dato: «liberada»', 'Tu mercadería fue liberada.', /afirmaba «liberada»/],
    ['estado de carga sin dato: «en nuestra bodega»', 'Ya la tenemos en nuestra bodega.', /afirmaba «en nuestra bodega»/],
    ['se presenta como persona', 'Soy Carla, tu asesora de importaciones.', /persona/],
    ['«te saluda…»', 'Hola, te saluda Andrés.', /persona/],
    ['«soy tu asesor»', 'Hola, soy tu asesor.', /persona/],
    ['marcador sin llenar', 'Hola [nombre], recibí tu mensaje.', /marcador/],
    ['marcador con llaves', 'Tu cotización {{numero}} está registrada.', /marcador/],
    ['respuesta larguísima', 'Recibí tu mensaje. '.repeat(100), /larga/],
  ]) {
    const x = g(texto);
    prueba(`no pasa: ${nombre}`, x.cambiada && !x.corregida && x.texto === T.MENSAJE_ASESOR && motivo.test(x.motivos.join(' ')), `${x.texto.slice(0, 50)} ${JSON.stringify(x.motivos)}`);
  }
  // Huecos que encontró una revisión independiente del código (todos pasaban).
  for (const texto of [
    'Tu carga llega el 30.', 'Tu carga llega el día 7 del mes que viene.', 'Tu carga llega en veinticinco días.', 'Faltan once días.',
    'Tu carga llega la semana que viene.', 'Tu carga llega la semana entrante.', 'Tu carga llega a finales de octubre.',
    'Tu carga llega la primera semana de octubre.', 'Un asesor te escribe en las próximas horas.', 'Un asesor te escribe en el transcurso del día.',
    'Ya casi llega.', 'Llega dentro de poco.', 'El flete te sale en quinientos dólares.', 'Te cuesta mil doscientos dólares.',
    'Tu carga está retenida por la aduana.', 'Tu carga salió ayer de China y llegó al puerto de Guayaquil.',
    'Tu carga fue despachada y está lista para retirar en Quito.', 'El contenedor zarpó la semana pasada.',
    'Puedes rastrearla en tracking.imporfactory.app/mi-carga', 'Hola, soy asesora de IMPORFACTORY y reviso tu caso.', 'Habla Carla, de soporte.',
  ]) {
    const y = g(texto);
    prueba(`no pasa: «${texto}»`, y.cambiada && !y.corregida && y.texto === T.MENSAJE_ASESOR, JSON.stringify(y.motivos));
  }
  {
    const he = { respaldo: { firme, eco: '¿Mi carga llega el 15? ¿y el flete son 850? Mi cotización es la 4521 y quiero 500 unidades' }, textoSeguro: null };
    prueba('🔒 lo que dijo el cliente no respalda un día ni un monto: «sí, llega el 15», «sí, son 850» no pasan', g('Sí, tu carga llega el 15.', he).cambiada && g('Sí, el flete son 850.', he).cambiada && g('Son 850 en total.', he).cambiada);
    prueba('…pero sí se le repite su código y su cantidad: «Cotización 4521, 500 unidades»', !g('Recibido. Lo sumo a tu caso para el asesor. Cotización 4521, 500 unidades.', he).cambiada);
  }
  const oficial = 'El contenedor EC-PRUEBA-OCT-A ya está en tránsito. La fecha estimada de llegada que tenemos registrada es el 24 de octubre; es una estimación y puede moverse.';
  const hOficial = { respaldo: { firme: `${firme}\n${oficial}`, eco: '' }, textoSeguro: null };
  for (const cola of ['¡Hasta pronto!', '¡Buen fin de semana!', 'Feliz domingo.', 'Que tengas un día excelente.', 'Saludos cordiales.']) {
    const y = g(`${oficial} ${cola}`, hOficial);
    prueba(`una despedida al final («${cola}») se quita y lo demás se manda`, y.corregida && y.texto === oficial, y.texto.slice(-60));
  }
  prueba('una despedida sola no se borra (no deja el mensaje vacío)', g('¡Hasta pronto!').texto !== '');
  let x = g('Puedes entrar aquí: [imporfactory.app](https://imporfactory.app)', { respaldo: { firme: `${firme}\n${T.LINKS.plataforma}`, eco: '' } });
  prueba('un enlace en formato markdown se aplana en vez de frenar la respuesta', x.corregida && x.texto === 'Puedes entrar aquí: https://imporfactory.app');
  prueba('«Te atiende Logística apenas abramos» no se confunde con una persona', !g('Te atiende Logística apenas abramos.').cambiada);
  x = g('Tenés que mandar la proforma. Vos podés enviarla acá, contame cuántas unidades querés.');
  prueba('voseo: se corrige a tuteo y se manda', x.corregida && x.texto === 'Tienes que mandar la proforma. Tú puedes enviarla acá, cuéntame cuántas unidades quieres.');
  x = g('Perdés el cupo si no confirmás. Fijate en la plataforma.');
  prueba('voseo: la familia «perdés» también (faltaba en el candado de Imporsuit)', x.corregida && x.texto === 'Pierdes el cupo si no confirmas. Fíjate en la plataforma.');
  prueba('el tuteo correcto no se toca: «tienes», «puedes», «envíame», «estás», «te escribí»', !g('Si tienes la proforma puedes enviarla; envíame la captura. Ya estás registrado, te escribí antes.').cambiada);
  x = g('Te paso con Pricing para que te cotice. El supervisor lo revisa y el líder comercial te escribe apenas abramos.');
  prueba('cargos internos: se cambian por el nombre para el cliente', x.corregida && x.texto === 'Te paso con el área de precios para que te cotice. La persona responsable lo revisa y la persona responsable te escribe apenas abramos.');
  x = g('Lo derivo al área de pricing y al supervisor.');
  prueba('cargos con «al / del»: «al área de precios», «a la persona responsable»', x.corregida && x.texto === 'Lo derivo al área de precios y a la persona responsable.');
  prueba('puede repetir una cifra que escribió el cliente (su número de cotización)', !g('Recibido. Lo sumo a tu caso para el asesor. Cotización 4521.').cambiada);
  prueba('«No soy una persona. Soy el asistente automático…» no se confunde con presentarse', !g(`No soy una persona. ${T.MENSAJE_ROBOT}`).cambiada);
  prueba('«un asesor te atiende apenas abramos» no se confunde con presentarse', !g('Un asesor te atiende apenas abramos.').cambiada);
  prueba('una lista numerada («1. … 2. …») no cuenta como cifra', !g('Recibí tu mensaje.\n1. Envíame la proforma.\n2. Dime cuántas unidades piensas comprar.').cambiada);
  x = revisarRespuesta('Tu carga llega el 30 de octubre.', { ...H, textoSeguro: 'Hola, tu carga EC-1 ya está en tránsito.' });
  prueba('si hay un texto seguro del turno (el estado oficial de la carga), se manda ese', x.cambiada && x.texto === 'Hola, tu carga EC-1 ya está en tránsito.');
  x = g('Tenés que esperar. Llega el 28 de octubre.');
  prueba('voseo + fecha inventada: gana lo grave, no se manda', x.cambiada && !x.corregida && x.texto === T.MENSAJE_ASESOR);
  x = g('Contame qué necesitás.\n[espera]:true');
  prueba('al corregir conserva el tag del final', x.corregida && /^Cuéntame qué necesit/.test(x.texto) && /\[espera\]:true$/.test(x.texto));

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n13. El turno completo (lo que arma el motor antes y después del modelo)');
  const turno = (mensaje, tel, extra = {}) =>
    prepararTurno({
      mensaje, telefono: tel, tipo_mensaje: extra.tipo || 'text', id_configuracion: 265, id_cliente: extra.id_cliente || tel,
      opciones: extra.opciones, deps: { consultar: (extra.base || baseDeMentira()).consultar, hoy: HOY, buscador: real, ahora: extra.ahora },
    });
  olvidarTodo();
  let t = await turno('Buen día ya llegaría la mercadería', TEL.transito_con_fecha);
  prueba('pregunta por su carga: van el bloque 📦 y las fichas', /📦 CARGA DE ESTE CLIENTE/.test(t.bloque) && /📚 FICHAS DE LA BASE/.test(t.bloque) && t.hechos.carga.estado === 'encontradas');
  prueba('…y el texto seguro del turno es el estado oficial de su carga', t.hechos.textoSeguro.startsWith('Hola, el contenedor EC-PRUEBA-OCT-A'));
  prueba('…la ficha «cuando-llega-mi-carga» cede ante el dato real', !/No decir en qué paso está la carga/.test(t.bloque));
  x = revisarTurno('Hola, el contenedor EC-PRUEBA-OCT-A, donde viaja tu carga EC-9001001, ya está en tránsito hacia Ecuador. La fecha estimada de llegada que tenemos registrada es el 24 de octubre; es una estimación y puede moverse. Última novedad registrada (9 de octubre): El buque hizo trasbordo en Panamá.', t.hechos);
  prueba('…la respuesta con el texto oficial pasa la guardia tal cual', !x.cambiada);
  x = revisarTurno('Tu carga ya está en aduana.', t.hechos);
  prueba('…un paso que NO es el suyo (está en tránsito y el modelo dice «en aduana») NO pasa', x.cambiada && x.texto === t.hechos.textoSeguro);
  x = revisarTurno('Tu carga llega el 20 de octubre, en unos 8 días.', t.hechos);
  prueba('…una fecha distinta a la registrada NO pasa: sale el estado oficial', x.cambiada && x.texto === t.hechos.textoSeguro);
  {
    const base = baseDeMentira();
    olvidarTodo();
    await turno('donde esta mi carga', TEL.aduana, { base });
    const n1 = base.consultas.length;
    const t2 = await turno('pero más o menos cuándo?', TEL.aduana, { base });
    prueba('el mensaje siguiente («¿pero cuándo?») conserva el bloque 📦 sin volver a consultar la base', /📦 CARGA DE ESTE CLIENTE/.test(t2.bloque) && base.consultas.length === n1 && /Fecha: NO hay ninguna fecha que se pueda dar/.test(t2.bloque));
    const t3 = await turno('ok y qué es el cbm?', TEL.aduana, { base, ahora: Date.now() + 25 * 60 * 1000 });
    prueba('pasados 20 minutos la carga leída se olvida', !/📦/.test(t3.bloque));
  }
  {
    // Cliente que no deja de escribir: la carga igual se vuelve a leer a los 20 minutos.
    const base = baseDeMentira();
    olvidarTodo();
    const t0 = Date.now();
    await turno('donde esta mi carga', TEL.aduana, { base, ahora: t0 });
    const n1 = base.consultas.length;
    for (const min of [8, 16]) await turno('y ahora?', TEL.aduana, { base, ahora: t0 + min * 60 * 1000 });
    const sinNueva = base.consultas.length === n1;
    await turno('y ahora?', TEL.aduana, { base, ahora: t0 + 24 * 60 * 1000 });
    const sigueElBloque = /📦/.test((await turno('ok', TEL.aduana, { base, ahora: t0 + 25 * 60 * 1000 })).bloque);
    prueba('la carga en memoria vence a los 20 minutos de LEÍDA aunque el cliente siga escribiendo', sinNueva && base.consultas.length > n1 && sigueElBloque);
  }
  {
    const he = hechosDeEmergencia('donde esta mi carga, llega el 20?');
    prueba('si el contexto del turno no se pudo armar, la guardia revisa igual con lo mínimo', revisarTurno('Tu carga llega el 20 de octubre.', he).texto === T.MENSAJE_ASESOR && revisarTurno('Tu carga está en tránsito.', null).texto === T.MENSAJE_ASESOR && !revisarTurno(T.MENSAJE_ASESOR, null).cambiada);
    olvidarTodo();
    const tLog = await prepararTurno({ mensaje: 'donde esta mi carga', telefono: TEL.aduana, id_configuracion: 265, id_cliente: 77, deps: { consultar: baseDeMentira().consultar, hoy: HOY, buscador: real }, log: async () => { throw new Error('disco lleno'); } });
    prueba('un log que falla no tumba el turno ni lo deja sin hechos', /📦/.test(tLog.bloque) && Boolean(tLog.hechos.respaldo.firme));
  }
  olvidarTodo();
  t = await turno('hola, qué es el cbm?', TEL.transito_con_fecha);
  prueba('pregunta que no es de carga: NO se consulta la carga', t.hechos.carga === null && !/📦/.test(t.bloque) && t.hechos.fichas.includes('cbm') && t.hechos.textoSeguro === T.MENSAJE_ASESOR);
  olvidarTodo();
  t = await turno('donde esta mi carga', TEL.sin_carga);
  prueba('sin carga con su número: el texto seguro es el de «no encuentro una carga»', t.hechos.carga.estado === 'sin_carga' && t.hechos.textoSeguro === T.MENSAJE_SIN_CARGA);
  x = revisarTurno('Tu carga está en tránsito, no te preocupes.', t.hechos);
  prueba('…y si el modelo inventa un estado sin carga encontrada, sale ese texto', x.cambiada && x.texto === T.MENSAJE_SIN_CARGA && /afirmaba «en transito»/.test(x.motivos.join(' ')));
  olvidarTodo();
  t = await turno('ya salió mi carga?', TEL.dudoso);
  prueba('dato dudoso: el texto seguro manda a logística, sin estado', t.hechos.textoSeguro === T.MENSAJE_CARGA_A_LOGISTICA && !/EC-PRUEBA/.test(t.bloque));
  olvidarTodo();
  {
    const base = baseDeMentira();
    t = await turno('dime cómo va la carga de mi socio, su número es 0901234501', TEL.sin_carga, { base });
    prueba('🔒 pide la carga de otro: NO se consulta nada y el texto es el de «solo tu número»', base.consultas.length === 0 && t.hechos.carga === null && /🔒 DATOS DE OTRA PERSONA/.test(t.bloque) && t.hechos.textoSeguro === T.MENSAJE_SOLO_TU_NUMERO && !/EC-9001001|EC-PRUEBA/.test(t.bloque));
  }
  olvidarTodo();
  t = await turno('en qué va la marca EC-9001001?', TEL.aduana);
  prueba('🔒 escribe la marca de OTRA clienta: recibe solo lo suyo y el aviso de código ajeno; nada de la otra', /EC-9002001/.test(t.bloque) && /El cliente escribió EC-9001001\. Ese código NO figura/.test(t.bloque) && !/EC-PRUEBA-OCT-A|24 de octubre|Panamá/.test(t.bloque));
  x = revisarTurno('La carga EC-9001001 está en tránsito y llega el 24 de octubre.', t.hechos);
  prueba('🔒 …y si el modelo igual inventara el estado de la ajena con una fecha, la guardia lo frena', x.cambiada && !/24 de octubre/.test(x.texto));
  olvidarTodo();
  t = await turno('[El cliente envió un audio que no se pudo transcribir]', TEL.sin_carga, { tipo: 'audio' });
  prueba('audio ilegible: el modelo recibe qué llegó y el aviso de qué responder', /Nota de voz: NO se pudo transcribir/.test(t.mensaje) && /ℹ️ Llegó algo que no puedes abrir/.test(t.bloque));
  t = await turno('', TEL.sin_carga, { tipo: 'video' });
  prueba('video sin texto: hay mensaje para el modelo (antes llegaba vacío)', /Video: NO lo puedes ver/.test(t.mensaje));
  olvidarTodo();
  t = await turno('[IMAGEN: captura_plataforma] Pantalla de inicio de sesión con el aviso "Usuario o contraseña incorrectos"', TEL.sin_carga, { tipo: 'image' });
  prueba('captura de la plataforma: la descripción trae la ficha de acceso', t.hechos.fichas.some((id) => /plataforma|clave/.test(id)) && /Imagen \(captura de pantalla de la plataforma\)/.test(t.mensaje));
  olvidarTodo();
  t = await turno('donde esta mi carga', TEL.transito_con_fecha, { opciones: { cargas: false, fichas: true, guardia: true } });
  prueba('con «cargas» apagado no se consulta la carga', t.hechos.carga === null && !/📦/.test(t.bloque));
  t = await turno('donde esta mi carga', TEL.transito_con_fecha, { opciones: { cargas: true, fichas: false, guardia: true }, id_cliente: 'otro' });
  prueba('con «fichas» apagado no van fichas', !/📚/.test(t.bloque) && /📦/.test(t.bloque));
  olvidarTodo();
  t = await turno('donde esta mi carga', TEL.transito_con_fecha, { base: baseDeMentira(DATOS, { falla: 'ECONNRESET' }) });
  prueba('la base de cargas caída no tumba el turno: bloque «no se puede informar» y paso a logística', /NO SE PUEDE INFORMAR/.test(t.bloque) && t.hechos.textoSeguro === T.MENSAJE_CARGA_A_LOGISTICA);
  olvidarTodo();
  {
    const tA = await turno('donde esta mi carga', TEL.transito_con_fecha, { id_cliente: 1 });
    const tB = await turno('y la mía?', TEL.sin_carga, { id_cliente: 2 });
    prueba('🔒 la memoria del turno es por cliente: el siguiente que escribe no hereda la carga de otro', /EC-9001001/.test(tA.bloque) && !/EC-9001001|📦/.test(tB.bloque));
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n14. Ajustes de la cuenta y candado antes de leer audios e imágenes');
  const n = ajustes.normalizar;
  prueba('sin el ajuste, `soporte_expertos` es null (ninguna cuenta cambia)', n(null).soporte_expertos === null && n({ espera_rafaga_seg: 20 }).soporte_expertos === null && n({ soporte_expertos: false }).soporte_expertos === null);
  prueba('`true` enciende las tres partes', igual(n({ soporte_expertos: true }).soporte_expertos, { cargas: true, fichas: true, guardia: true }));
  prueba('un objeto apaga solo lo que trae en false', igual(n({ soporte_expertos: { cargas: false } }).soporte_expertos, { cargas: false, fichas: true, guardia: true }));
  prueba('un valor raro no enciende nada', n({ soporte_expertos: 'si' }).soporte_expertos === null && n({ soporte_expertos: [1] }).soporte_expertos === null);
  const ec = (hora) => new Date(`2026-10-12T${hora}:00-05:00`);
  const noche = n({ horario: { desde: '16:00', hasta: '08:00' } });
  prueba('cuenta sin horario ni lista blanca: nunca se salta la lectura', !ajustes.calladoPorHorarioOLista(n(null), '593987654321', ec('12:00')) && !ajustes.calladoPorHorarioOLista(n({ numeros_excluidos: ['0987654321'] }), '593987654321', ec('12:00')));
  prueba('horario 16:00 → 08:00: a mediodía NO se transcribe ni se describe; a las 20:00 sí', ajustes.calladoPorHorarioOLista(noche, '593987654321', ec('12:00')) && !ajustes.calladoPorHorarioOLista(noche, '593987654321', ec('20:00')));
  const lista = n({ horario: { desde: '16:00', hasta: '08:00' }, solo_numeros: ['0987654321'] });
  prueba('en prueba con lista blanca: solo se lee lo del número de la lista', !ajustes.calladoPorHorarioOLista(lista, '593987654321', ec('20:00')) && ajustes.calladoPorHorarioOLista(lista, '593911111222', ec('20:00')));
  prueba('horario mal escrito: el bot calla, así que tampoco se lee', ajustes.calladoPorHorarioOLista(n({ horario: { desde: 'x', hasta: 'y' } }), '593987654321', ec('20:00')));

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n15. El prompt');
  const prompt = promptSoporteExpertos();
  prueba(`cabe holgado en el tope del panel (${prompt.length} de 60.000 caracteres) y es más corto que la versión 1 (28.347)`, prompt.length > 8000 && prompt.length < 28347);
  prueba('trae los 11 textos fijos tal cual', Object.entries(T.TEXTOS_FIJOS).every(([k, v]) => k === 'MENSAJE_FALLBACK' || k === 'MENSAJE_ARCHIVO' || prompt.includes(v) || prompt.includes(v.replace(/\n/g, ' '))));
  prueba('no lleva la base pegada (las fichas viajan por turno)', !/BASE COMPLETA/.test(prompt));
  prueba('con `baseCompleta` sí la pega, para una cuenta sin fichas por turno', /BASE COMPLETA/.test(promptSoporteExpertos({ baseCompleta: real.fichas })) && promptSoporteExpertos({ baseCompleta: real.fichas }).length > prompt.length + 5000);
  prueba('ficha que responde Y pasa: el bloque trae las dos cosas', /Respuesta: Depende de la partida\.\n  Y además lo resuelve una persona: paso a asesor para el área de precios/.test(bloqueFichas(mini.buscar('cuanto pago de impuestos', { pais: 'ec' }))));
  prueba('ficha que solo pasa: el bloque no trae «Respuesta»', !/Respuesta:/.test(bloqueFichas(mini.buscar('quiero poner un reclamo'))) && /  Lo resuelve una persona/.test(bloqueFichas(mini.buscar('quiero poner un reclamo'))));
  prueba('nombra los bloques que arma el código (📦, 📚, adjuntos, 🔒)', ['📦 CARGA DE ESTE CLIENTE', '📚 FICHAS DE LA BASE', '[ADJUNTOS DE ESTE MENSAJE]', 'DATOS DE OTRA PERSONA', 'SIN CARGA CON ESTE NÚMERO'].every((s) => prompt.includes(s)));
  const sinRegla2 = prompt.replace(/NUNCA voseo \([^)]*\)/, '');
  prueba('el prompt no usa voseo (fuera de la regla que lo prohíbe)', !/(?<!\p{L})(vos|ten[eé]s|pod[eé]s|quer[eé]s|sabés|necesitás|mirá|fijate|decime|pasame|mandame|enviame|contame|avisame)(?!\p{L})/iu.test(sinRegla2));
  prueba('los textos fijos no prometen día ni hora, ni usan voseo ni «usted»', Object.values(T.TEXTOS_FIJOS).every((v) => !/\b(hoy|mañana|lunes|martes|miércoles|jueves|viernes|minutos? más|en breve|pronto)\b/i.test(v.replace('30 minutos antes de cada clase', '')) && !/\busted\b|ten[eé]s|pod[eé]s|enviame/i.test(v)));
  prueba('ningún texto fijo nombra a una persona ni se presenta como tal', Object.values(T.TEXTOS_FIJOS).every((v) => !/\bsoy [A-ZÁÉÍÓÚ][a-z]+\b(?<!Soy el)/.test(v.replace('Soy el asistente automático de IMPORFACTORY', ''))));

  console.log(`\n${fallos ? `HAY FALLAS: ${fallos} fallan, ${ok} pasan` : `TODO BIEN: ${ok} pasan, 0 fallan`}`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
