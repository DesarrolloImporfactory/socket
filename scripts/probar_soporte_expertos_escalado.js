/* Pruebas del escalado por área del bot de Expertos (soporteExpertos/escalado.js).
   Sin red ni base: la base es un doble. Uso: node scripts/probar_soporte_expertos_escalado.js */

'use strict';

const path = require('path');
// `ajustesIA` importa la base solo para leer la fila; aquí no se usa.
const rutaDb = require.resolve(path.join(__dirname, '../src/database/config'));
require.cache[rutaDb] = { id: rutaDb, filename: rutaDb, loaded: true, exports: { db: {}, db_2: {} } };

const { EQUIPO, YA_NO_ESTAN, areaDelCaso, decidirEscalado, notaInterna, esPase, escalarCaso } = require('../src/utils/soporteExpertos/escalado');
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

  console.log(`\n${fallos ? `HAY FALLAS: ${fallos} fallan, ${ok} pasan` : `TODO BIEN: ${ok} pasan, 0 fallan`}`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
