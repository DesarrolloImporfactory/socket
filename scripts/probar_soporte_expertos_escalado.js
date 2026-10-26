/* Pruebas del escalado por área del bot de Expertos (soporteExpertos/escalado.js).
   Sin red ni base: la base es un doble. Uso: node scripts/probar_soporte_expertos_escalado.js */

'use strict';

const path = require('path');
// `ajustesIA` importa la base solo para leer la fila; aquí no se usa.
const rutaDb = require.resolve(path.join(__dirname, '../src/database/config'));
require.cache[rutaDb] = { id: rutaDb, filename: rutaDb, loaded: true, exports: { db: {}, db_2: {} } };

const { EQUIPO, ECOMMERCE, YA_NO_ESTAN, areaDelCaso, asesorEcommerce, decidirEscalado, notaInterna, esPase, escalarCaso } = require('../src/utils/soporteExpertos/escalado');
const H = require('../src/utils/soporteExpertos/horario');
const F = require('../src/utils/soporteExpertos/fichas');
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
const MX = '5215512345678';

/* Base de mentira: un chat con su encargado y lo que se escribe. */
function base(chat) {
  const escrito = { updates: [], historial: [], notas: [] };
  return {
    escrito,
    deps: {
      consultar: async (sql, rep) => {
        if (/^\s*select/i.test(sql)) return chat ? [chat] : [];
        escrito.updates.push({ sql, rep });
        return [];
      },
      crearHistorial: async (d) => escrito.historial.push(d),
      crearNota: async (t) => escrito.notas.push(t),
      emitir: () => {},
    },
  };
}

(async () => {
  console.log('1. El área sale del motivo de la herramienta o del mensaje');
  const casos = [
    [{ motivo: 'reclamo', mensaje: 'esto es una burla' }, 'reclamo'],
    [{ motivo: 'pago', mensaje: 'ya transferí' }, 'pago'],
    [{ motivo: 'pago', mensaje: 'necesito la factura de mi pago' }, 'factura'],
    [{ motivo: 'cotizacion', mensaje: 'quiero traer 500 lámparas' }, 'cotizacion'],
    [{ mensaje: 'Me la envían al WhatsApp o al correo la factura?' }, 'factura'],
    [{ mensaje: 'Transferencia Imporfactory segunda importacion' }, 'pago'],
    [{ mensaje: 'a cuánto saldría con flete y aranceles' }, 'cotizacion'],
    [{ mensaje: 'Hola estoy esperando este envío', hechos: { carga: { estado: 'sin_carga' } } }, 'logistica'],
    [{ mensaje: 'hasta cuándo recibe la bodega de China para el contenedor del 30' }, 'logistica'],
    [{ mensaje: 'Ya estoy en camino para ver las máquinas' }, 'otro'],
    [{ mensaje: 'no sé cómo insertar la foto del producto' }, 'otro'],
    [{ mensaje: 'ya pagué y no me han enviado nada', hechos: { reclamo: true } }, 'reclamo'],
    [{ mensaje: '', hechos: { adjuntos: [{ clase: 'comprobante_pago' }] } }, 'pago'],
    [{ mensaje: '', hechos: { adjuntos: [{ clase: 'cotizacion_proveedor' }] } }, 'cotizacion'],
    // 26-oct: «¿llegó la mercadería?» + captura de la guía iba a pago
    [{ motivo: 'pago', mensaje: 'Buenas, ¿ya llegó la mercadería?', hechos: { adjuntos: [{ clase: 'comprobante_pago' }] } }, 'logistica'],
    [{ mensaje: 'las cajas ya llegaron a la bodega?' }, 'logistica'],
    [{ motivo: 'pago', mensaje: 'ya pagué, ¿cuándo llega la carga?' }, 'pago'],
    [{ mensaje: '¿llegó mi pedido de Dropi?' }, 'ecommerce'],
  ];
  for (const [p, area] of casos) {
    const a = areaDelCaso(p);
    prueba(`«${p.mensaje || p.motivo || 'adjunto'}» → ${area}`, a === area, a);
  }

  console.log('\n2. La persona: Belén cotiza, Viviana logística de Ecuador, Johan lo demás y México');
  const quien = (p) => decidirEscalado(p).destino.id;
  prueba('cotización → Belén (378)', quien({ motivo: 'cotizacion', telefono: EC }) === 378);
  prueba('logística de Ecuador → Viviana (353)', quien({ mensaje: 'dónde está mi carga', telefono: EC }) === 353);
  prueba('logística de México → Johan (377)', quien({ mensaje: 'dónde está mi carga', telefono: MX }) === 377);
  prueba('pago → Johan', quien({ motivo: 'pago', telefono: EC }) === 377);
  prueba('reclamo → Johan', quien({ motivo: 'reclamo', telefono: EC }) === 377);
  prueba('factura → Johan', quien({ mensaje: 'la factura', telefono: EC }) === 377);
  prueba('lo demás → Johan', quien({ mensaje: 'ya voy para allá', telefono: EC }) === 377);
  const destinos = new Set(Object.values(EQUIPO).map((e) => e.id));
  prueba('nunca es destino Ángel (2179) ni David Piedra (379)', YA_NO_ESTAN.every((id) => !destinos.has(id)));

  console.log('\n3. Cuándo se asigna el chat');
  let d = decidirEscalado({ motivo: 'cotizacion', telefono: EC, encargado: null });
  prueba('sin encargado: se asigna', d.asignar === true);
  d = decidirEscalado({ motivo: 'cotizacion', telefono: EC, encargado: { id: 379, activo: true } });
  prueba('lo tiene David Piedra (379): se reasigna', d.asignar === true && /ya no está/.test(d.razon));
  d = decidirEscalado({ motivo: 'pago', telefono: EC, encargado: { id: 2179, activo: true } });
  prueba('lo tiene Ángel (2179): se reasigna', d.asignar === true);
  d = decidirEscalado({ motivo: 'pago', telefono: EC, encargado: { id: 2474, activo: false } });
  prueba('lo tiene alguien suspendido: se reasigna', d.asignar === true);
  d = decidirEscalado({ motivo: 'cotizacion', telefono: EC, encargado: { id: 377, activo: true } });
  prueba('lo atiende Johan (activo) y es una cotización: NO se le quita', d.asignar === false && d.destino.id === 378);
  d = decidirEscalado({ motivo: 'pago', telefono: EC, encargado: { id: 1886, activo: true } });
  prueba('lo atiende Beto (activo): NO se le quita', d.asignar === false);

  console.log('\n4. Qué respuesta cuenta como «pasar a una persona»');
  for (const t of [T.MENSAJE_ASESOR, T.MENSAJE_RECLAMO, T.MENSAJE_CARGA_A_LOGISTICA, T.MENSAJE_RECIBIDO, T.MENSAJE_ARCHIVO, T.MENSAJE_SIN_CARGA, T.MENSAJE_SOLO_TU_NUMERO, 'Recibí tu mensaje. Tu asesor lo revisa y te escribe en breve.', 'Recibí tu comprobante. Las facturas las lleva el área de cobranza.']) {
    prueba(`es pase: «${t.slice(0, 50)}…»`, esPase(t));
  }
  for (const t of [T.MENSAJE_CLASE, T.MENSAJE_SALUDO, 'En Ideas de Productos encuentras productos para traer de China: https://imporfactory.app/ideas-productos', 'Para el flete pídele a tu asesor el número de cotización y revísalo en https://imporfactory.app/seguimiento-carga']) {
    prueba(`no es pase: «${t.slice(0, 50)}…»`, !esPase(t));
  }

  console.log('\n5. escalarCaso: simulado no toca nada; real asigna, guarda historial y deja nota');
  let b = base({ id: 10, id_encargado: 379, suspendido: 1 });
  let logs = [];
  let r = await escalarCaso({ modo: 'simulado', id_configuracion: 265, id_cliente: 10, telefono: EC, motivo: 'cotizacion', mensaje: 'quiero cotizar', log: (m) => logs.push(m), deps: b.deps });
  prueba('simulado: decide (Belén, se asignaría) y lo deja en el log', r.destino.id === 378 && r.asignar && !r.aplicado && /escalar simulado/.test(logs.join()));
  prueba('simulado: no escribe nada en la base', !b.escrito.updates.length && !b.escrito.historial.length && !b.escrito.notas.length);
  b = base({ id: 10, id_encargado: 379, suspendido: 1 });
  r = await escalarCaso({ modo: 'real', id_configuracion: 265, id_cliente: 10, telefono: EC, motivo: 'cotizacion', mensaje: 'quiero cotizar 500 lámparas', deps: b.deps });
  prueba('real: asigna a Belén', r.aplicado && b.escrito.updates.length === 1 && b.escrito.updates[0].rep[0] === 378 && b.escrito.updates[0].rep[2] === 265);
  prueba('real: historial con el encargado anterior y el motivo', b.escrito.historial[0]?.id_encargado_anterior === 379 && b.escrito.historial[0]?.id_encargado_nuevo === 378 && /Bot Expertos/.test(b.escrito.historial[0]?.motivo));
  prueba('real: nota interna con a quién y por qué', /pasó este chat a Belén \(cotización\)/.test(b.escrito.notas[0] || ''), b.escrito.notas[0]);
  b = base({ id: 11, id_encargado: 377, suspendido: 0 });
  r = await escalarCaso({ modo: 'real', id_configuracion: 265, id_cliente: 11, telefono: EC, motivo: 'pago', mensaje: 'ya pagué', deps: b.deps });
  prueba('real: lo atiende Johan → no se toca', r && !r.aplicado && !b.escrito.updates.length);
  b = base(null);
  r = await escalarCaso({ modo: 'real', id_configuracion: 265, id_cliente: 99, telefono: EC, deps: b.deps });
  prueba('el chat no es de esta cuenta: no se hace nada', r === null && !b.escrito.updates.length);
  r = await escalarCaso({ modo: undefined, id_configuracion: 265, id_cliente: 10, deps: base({ id: 10 }).deps });
  prueba('sin modo no corre', r === null);
  logs = [];
  r = await escalarCaso({ modo: 'real', id_configuracion: 265, id_cliente: 10, telefono: EC, log: (m) => logs.push(m), deps: { consultar: async () => { throw new Error('base caída'); } } });
  prueba('si la base falla, no tira: queda en el log', r === null && /base caída/.test(logs.join()));
  prueba('la nota no lleva más de 160 caracteres del cliente', notaInterna(decidirEscalado({ motivo: 'otro', telefono: EC }), 'x'.repeat(500)).length < 400);

  console.log('\n6. Ajustes: apagado salvo «simulado» o «real»');
  const n = (v) => ajustes.normalizar({ soporte_expertos: v }).soporte_expertos.escalar;
  prueba('sin la clave: apagado', n({}) === false);
  prueba('«simulado» se guarda', n({ escalar: 'simulado' }) === 'simulado');
  prueba('«real» se guarda', n({ escalar: 'real' }) === 'real');
  prueba('true (ambiguo) queda apagado', n({ escalar: true }) === false);

  console.log('\n7. Ecommerce → Beto (1886) y Juan Felipe (2474) (Daniel, 25-oct)');
  const area = (o) => areaDelCaso(o);
  prueba('pregunta de Dropi → ecommerce', area({ mensaje: 'no me aparece el producto en dropi' }) === 'ecommerce');
  prueba('«¿hay stock en Dropi? cuánto cuesta» no es cotización (24-oct salió a Belén)', area({ mensaje: 'hay stock en dropi? cuanto cuesta' }) === 'ecommerce');
  prueba('campaña / IMPORCHAT / Shopify → ecommerce', ['mi campaña no gasta', 'el bot de imporchat no responde', 'tengo tienda en shopify'].every((m) => area({ mensaje: m }) === 'ecommerce'));
  prueba('ficha con pasar_a ecommerce → ecommerce', area({ mensaje: 'ayuda', hechos: { pasarA: 'ecommerce' } }) === 'ecommerce');
  prueba('chat en una columna de ecommerce → ecommerce', area({ mensaje: 'tengo una duda', columna: 'primera_venta' }) === 'ecommerce');
  prueba('columna de importación no es ecommerce', area({ mensaje: 'tengo una duda', columna: 'cotizaciones' }) === 'otro');
  prueba('el catálogo del proveedor no es ecommerce', area({ mensaje: 'quiero cotizar del catalogo del proveedor' }) === 'cotizacion');
  prueba('un pago sigue yendo a Johan aunque esté en ecommerce', area({ mensaje: 'ya pagué la cuota', columna: 'imporchat' }) === 'pago');
  prueba('teléfono par → Beto, impar → Juan Felipe', asesorEcommerce('593987000110').id === 1886 && asesorEcommerce('593987000111').id === 2474);
  prueba('los dos de ecommerce están en el equipo', ECOMMERCE.map((e) => e.id).join() === '1886,2474');
  d = decidirEscalado({ mensaje: 'mi campaña no gasta', telefono: '593987000110', encargado: null });
  prueba('sin encargado: se asigna al asesor de ecommerce', d.area === 'ecommerce' && d.asignar && d.destino.id === 1886);
  d = decidirEscalado({ mensaje: 'mi campaña no gasta', telefono: '593987000110', encargado: { id: 2474, activo: true } });
  prueba('lo tiene Juan Felipe y el reparto diría Beto: se queda con Juan Felipe', !d.asignar && /asesor de ecommerce/.test(d.razon));
  d = decidirEscalado({ mensaje: 'mi campaña no gasta', telefono: '593987000110', encargado: { id: 377, activo: true } });
  prueba('lo tiene Johan (activo): no se le quita', !d.asignar);

  console.log('\n8. Reembolso, baja o pausa → caso de escalamiento');
  prueba('«quiero el reembolso» → reembolso', area({ mensaje: 'quiero el reembolso de mi dinero' }) === 'reembolso');
  prueba('«quiero pausar el servicio» → reembolso', area({ mensaje: 'quiero pausar el servicio un mes' }) === 'reembolso');
  prueba('«darme de baja» → reembolso', area({ mensaje: 'quiero darme de baja' }) === 'reembolso');
  prueba('aunque venga como reclamo, es reembolso', area({ mensaje: 'esto es una estafa quiero mi dinero', hechos: { reclamo: true } }) === 'reembolso');
  prueba('la ficha reembolso-o-baja → reembolso', area({ mensaje: 'ya no quiero nada', hechos: { fichas: ['reembolso-o-baja'] } }) === 'reembolso');
  prueba('«reembolso en Alibaba» de un pago normal no es esto', area({ mensaje: 'ya hice el pago' }) === 'pago');
  d = decidirEscalado({ mensaje: 'quiero el reembolso', telefono: EC, encargado: { id: 1886, activo: true }, responsableCaso: { id: 353, nombre: 'Vivi' } });
  prueba('va a quien recibe los escalamientos; abre caso; no le quita el chat a Beto', d.destino.id === 353 && d.caso && !d.asignar);
  d = decidirEscalado({ mensaje: 'quiero el reembolso', telefono: EC, encargado: null });
  prueba('sin destinatario de escalamientos: Johan', d.destino.id === 377 && d.caso);

  /* Base de mentira con casos: responde según la consulta. */
  function baseCasos({ chat, casoAbierto = false }) {
    const w = { sql: [], notas: [], historial: [] };
    return {
      w,
      deps: {
        consultar: async (sql, rep) => {
          w.sql.push({ sql, rep });
          if (/FROM incidencias_casos_destinatarios/.test(sql)) return [{ id: 353, nombre: 'Vivi ImporFactory' }];
          if (/^\s*SELECT id FROM incidencias_chat_center/.test(sql)) return casoAbierto ? [{ id: 5 }] : [];
          if (/^\s*select/i.test(sql)) return [chat];
          if (/^\s*INSERT INTO incidencias_chat_center/.test(sql)) return [777, 1];
          return [];
        },
        crearHistorial: async (h) => w.historial.push(h),
        crearNota: async (t) => w.notas.push(t),
      },
    };
  }
  let bc = baseCasos({ chat: { id: 20, id_encargado: 1886, suspendido: 0, estado_contacto: 'imporchat' } });
  r = await escalarCaso({ modo: 'simulado', id_configuracion: 265, id_cliente: 20, telefono: EC, mensaje: 'quiero el reembolso', deps: bc.deps });
  prueba('simulado: decide el caso pero no escribe', r.caso && !r.aplicado && !bc.w.sql.some((x) => /INSERT|UPDATE/.test(x.sql)));
  bc = baseCasos({ chat: { id: 20, id_encargado: 1886, suspendido: 0, estado_contacto: 'imporchat' } });
  r = await escalarCaso({ modo: 'real', id_configuracion: 265, id_cliente: 20, telefono: EC, mensaje: 'quiero el reembolso', deps: bc.deps });
  const ins = bc.w.sql.find((x) => /INSERT INTO incidencias_chat_center/.test(x.sql));
  prueba('real: abre el caso de escalamiento para Vivi (353), sin resolver', r.casoAbierto && ins && ins.rep[3] === 353 && /'escalamiento'/.test(ins.sql) && /sin_resolver/.test(ins.sql));
  prueba('real: deja el evento «creado» del caso', bc.w.sql.some((x) => /INSERT INTO incidencias_casos_eventos/.test(x.sql) && x.rep[0] === 777));
  prueba('real: no le quita el chat a Beto', !bc.w.sql.some((x) => /UPDATE clientes_chat_center/.test(x.sql)));
  prueba('real: la nota dice que abrió el caso', /Abrió un caso de escalamiento para Vivi/.test(bc.w.notas[0] || ''), bc.w.notas[0]);
  bc = baseCasos({ chat: { id: 20, id_encargado: 1886, suspendido: 0 }, casoAbierto: true });
  r = await escalarCaso({ modo: 'real', id_configuracion: 265, id_cliente: 20, telefono: EC, mensaje: 'quiero el reembolso ya', deps: bc.deps });
  prueba('ya hay un caso sin resolver: no lo duplica ni deja nota', !r.casoAbierto && !bc.w.sql.some((x) => /INSERT/.test(x.sql)) && !bc.w.notas.length);
  bc = baseCasos({ chat: { id: 21, id_encargado: null, suspendido: null, estado_contacto: 'primera_venta' } });
  r = await escalarCaso({ modo: 'real', id_configuracion: 265, id_cliente: 21, telefono: '593987000111', mensaje: 'tengo una duda', deps: bc.deps });
  prueba('real: chat de ecommerce sin encargado → Juan Felipe (por la columna)', r.aplicado && r.destino.id === 2474);
  prueba('«tu caso pasa a la persona responsable» cuenta como pase', esPase('Entiendo tu pedido. Tu caso pasa a la persona responsable.'));

  console.log('\n9. Horario de ecommerce (sábado 8:00-12:00) y próxima apertura');
  const ec = (s) => Date.parse(`${s}-05:00`);
  prueba('sábado 9:00: ecommerce atiende, el resto no', H.equipoAtendiendo(ec('2026-10-24T09:00'), H.HORARIO_ECOMMERCE) && !H.equipoAtendiendo(ec('2026-10-24T09:00')));
  prueba('sábado 12:30: ecommerce ya no atiende', !H.equipoAtendiendo(ec('2026-10-24T12:30'), H.HORARIO_ECOMMERCE));
  prueba('sábado 13:00 → «el lunes desde las 8:00»', H.proximaApertura(ec('2026-10-24T13:00')) === 'el lunes desde las 8:00');
  prueba('viernes 18:00, ecommerce → «mañana desde las 8:00»', H.proximaApertura(ec('2026-10-23T18:00'), H.HORARIO_ECOMMERCE) === 'mañana desde las 8:00');
  prueba('lunes 7:00 → «hoy desde las 8:00»', H.proximaApertura(ec('2026-10-26T07:00')) === 'hoy desde las 8:00');
  prueba('atendiendo: no hay próxima apertura', H.proximaApertura(ec('2026-10-26T10:00')) === null);
  prueba('el sábado suma minutos hábiles en ecommerce', H.minutosHabiles(ec('2026-10-23T17:00'), ec('2026-10-26T09:00')) === 90 && H.minutosHabiles(ec('2026-10-23T17:00'), ec('2026-10-26T09:00'), H.HORARIO_ECOMMERCE) === 330);
  prueba('«apenas abramos» → la apertura, solo si se la pasan', H.textoAlHorario('te escribe apenas abramos.', false, 'el lunes desde las 8:00') === 'te escribe el lunes desde las 8:00.' && H.textoAlHorario('te escribe apenas abramos.', false) === 'te escribe apenas abramos.');
  prueba('un tramo extra mal escrito se ignora', !H.normalizarHorarioEquipo({ ...H.HORARIO_EQUIPO, extra: [{ dias: [6], desde: '12:00', hasta: '08:00' }] }).extra);
  const na = (v) => ajustes.normalizar({ soporte_expertos: v }).soporte_expertos;
  prueba('decir_apertura apagado salvo true; horario_ecommerce pasa tal cual', na({}).decir_apertura === false && na({ decir_apertura: true }).decir_apertura === true && na({ horario_ecommerce: H.HORARIO_ECOMMERCE }).horario_ecommerce.extra.length === 1);

  console.log('\n10. Respuestas de una palabra a las plantillas de «Nutrición»');
  const b2 = F.buscadorDeArchivo();
  const id1 = (m) => F.buscarConRescate(b2, m, { pais: 'ec' })[0]?.ficha.id;
  prueba('«tip» → video de cómo lanzar la campaña', id1('tip') === 'ia-tip-bot-cotiza-solo' && /contenido=737/.test(F.buscarConRescate(b2, 'Tip ✨', {})[0].ficha.respuesta_base));
  prueba('«Sí, tip» / «*tip*» también', id1('Sí, tip') === 'ia-tip-bot-cotiza-solo' && id1('*tip*') === 'ia-tip-bot-cotiza-solo');
  prueba('«seguimientos» y «anuncios» abren las suyas', id1('seguimientos') === 'ia-tip-seguimientos' && id1('Anuncios') === 'ia-tip-anuncios');
  prueba('«el tip de la semana no me sirve» no es la palabra clave', id1('el tip de la semana no me sirve') !== 'ia-tip-bot-cotiza-solo');
  prueba('«estoy en la bodega» → horario de retiros', /lunes a viernes, de 8:00 a 17:00/.test(F.buscarConRescate(b2, 'estoy en la bodega para retirar', { pais: 'ec' })[0]?.ficha.respuesta_base || ''));
  prueba('«quiero empezar a vender sus productos» → catálogo + paso a paso', id1('quiero empezar a vender sus productos') === 'eco-catalogo-y-paso-a-paso');

  console.log(`\n${fallos ? `HAY FALLAS: ${fallos} fallan, ${ok} pasan` : `TODO BIEN: ${ok} pasan, 0 fallan`}`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
