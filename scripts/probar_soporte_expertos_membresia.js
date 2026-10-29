/* Pruebas de «ver_mi_membresia» (membresía de Imporsuit del que escribe):
   estados, fechas, que no pierda un error como «no tiene», la bandera y el
   texto seguro.

   Sin base de datos y sin la API de Claude: la membresía sale de un resolver
   de mentira.

     node scripts/probar_soporte_expertos_membresia.js
*/
'use strict';

const path = require('path');

const rutaDb = require.resolve(path.join(__dirname, '../src/database/config'));
require.cache[rutaDb] = { id: rutaDb, filename: rutaDb, loaded: true, exports: { db: {}, db_2: {} } };

const { membresiaDelAlumno, bloqueMembresia, fecha } = require('../src/utils/soporteExpertos/membresiaAlumno');
const { crearHerramientas, sumarHechosHerramientas, hablaDeMembresia } = require('../src/utils/soporteExpertos/herramientas');
const { normalizar } = require('../src/utils/ajustesIA');
const normalizarSoporteExpertos = (v) => normalizar(JSON.stringify({ soporte_expertos: v })).soporte_expertos;
const T = require('../src/utils/soporteExpertos/textos');
const { SECCION_MEMBRESIA } = require('../src/utils/prompt_soporte_expertos.data');

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

const TEL = '593987654321';
const COLA = '987654321';
const ACTIVA = {
  fecha_suscripcion: '2026-03-12',
  vence_el: '2027-03-12',
  dias_restantes: 136,
  vencida: false,
  plan_actual: 'Club ',
  paquetes: { importacion: true, ecommerce: false, membresia_ecommerce: true, productos: false },
};
const VENCIDA = { ...ACTIVA, fecha_suscripcion: '2025-01-05', vence_el: '2026-01-05', dias_restantes: -295, vencida: true };
const SIN_FECHA = { fecha_suscripcion: null, vence_el: null, dias_restantes: null, vencida: null, plan_actual: null, paquetes: {} };

let pedidos = [];
const resolverCon = (m) => async (celulares, opciones) => {
  pedidos.push({ celulares, opciones });
  return new Map(m ? [[COLA, m]] : []);
};
// El número no está en Imporsuit y tampoco tiene cuenta IMPORCHAT.
const SIN_IMPORCHAT = { correoDelDueno: async () => null };

(async () => {
  console.log('\n— Estados —');
  {
    pedidos = [];
    const r = await membresiaDelAlumno(TEL, { resolver: resolverCon(ACTIVA) });
    prueba('activa', r.estado === 'activa', r.estado);
    prueba('consulta solo el número que escribe', pedidos.length === 1 && pedidos[0].celulares.length === 1 && pedidos[0].celulares[0] === TEL);
    prueba('pide que un error no se trague como «no tiene»', pedidos[0].opciones?.lanzar === true);
    prueba('dice desde, hasta y días', r.texto.includes('12-mar-2026') && r.texto.includes('12-mar-2027') && r.texto.includes('136 días'), r.texto);
    prueba('nombra el plan sin espacios de sobra', r.texto.includes('(plan Club)'), r.texto);
    prueba('nombra lo que incluye', r.texto.includes('importación') && r.texto.includes('membresía ecommerce') && !r.texto.includes('productos'), r.texto);
    prueba('sin llaves sin llenar', !/\{\w+\}/.test(r.texto), r.texto);
    prueba('el bloque lleva la instrucción', bloqueMembresia(r).includes(T.MEMBRESIA.instruccion));
  }
  {
    const r = await membresiaDelAlumno(TEL, { resolver: resolverCon(VENCIDA) });
    prueba('vencida', r.estado === 'vencida' && r.texto.includes('venció el 5-ene-2026') && !r.texto.includes('quedan'), r.texto);
  }
  {
    const r = await membresiaDelAlumno(TEL, { resolver: resolverCon(SIN_FECHA) });
    prueba('sin fecha', r.estado === 'sin_fecha' && !/\{\w+\}/.test(r.texto) && !r.texto.includes('plan'), r.texto);
  }
  {
    const r = await membresiaDelAlumno(TEL, { resolver: resolverCon(null), ...SIN_IMPORCHAT });
    prueba('sin membresía', r.estado === 'sin_membresia' && r.texto === T.MEMBRESIA.sin_membresia);
    prueba('sin membresía no lleva la instrucción de datos', bloqueMembresia(r) === T.MEMBRESIA.sin_membresia);
  }

  console.log('\n— Si el número no está en Imporsuit: por su cuenta IMPORCHAT —');
  {
    let preguntoA = null;
    const r = await membresiaDelAlumno(TEL, {
      resolver: resolverCon(null),
      correoDelDueno: async (t) => (t === TEL ? 'ana@correo.com' : null),
      porCorreo: async (c, op) => {
        preguntoA = { c, op };
        return ACTIVA;
      },
    });
    prueba('lee la membresía por el correo de su cuenta', r.estado === 'activa' && r.por === 'imporchat' && preguntoA?.c === 'ana@correo.com', r.estado);
    prueba('…sin tragarse un error', preguntoA?.op?.lanzar === true);
  }
  {
    const r = await membresiaDelAlumno(TEL, { resolver: resolverCon(ACTIVA), correoDelDueno: async () => { throw new Error('no debía preguntar'); } });
    prueba('si el número ya trae la membresía, no busca por IMPORCHAT', r.estado === 'activa' && r.por === 'numero', r.estado);
  }
  {
    const r = await membresiaDelAlumno(TEL, { resolver: resolverCon(null), correoDelDueno: async () => 'ambiguo', porCorreo: async () => ACTIVA });
    prueba('número en dos cuentas: no dice nada de nadie', r.estado === 'ambiguo' && r.texto === T.MEMBRESIA.error && !r.membresia, r.estado);
  }
  {
    const r = await membresiaDelAlumno(TEL, { resolver: resolverCon(null), correoDelDueno: async () => 'ana@correo.com', porCorreo: async () => null });
    prueba('cuenta IMPORCHAT sin usuario en Imporsuit: sin membresía', r.estado === 'sin_membresia', r.estado);
  }
  {
    const r = await membresiaDelAlumno(TEL, {
      resolver: resolverCon(null),
      correoDelDueno: async () => 'ana@correo.com',
      porCorreo: async () => {
        throw new Error('db_2 caída');
      },
    });
    prueba('si falla la consulta por correo es error', r.estado === 'error', r.estado);
  }
  {
    const r = await membresiaDelAlumno(TEL, {
      resolver: resolverCon(null),
      correoDelDueno: async () => {
        throw new Error('IMPORCHAT caído');
      },
    });
    prueba('si falla la identificación es error, no «no tiene»', r.estado === 'error', r.estado);
  }
  {
    const r = await membresiaDelAlumno(TEL, {
      resolver: async () => {
        throw new Error('db_2 caída');
      },
    });
    prueba('si la base falla es error, no «no tiene»', r.estado === 'error' && r.texto === T.MEMBRESIA.error, r.estado);
  }
  {
    const r = await membresiaDelAlumno(TEL, { resolver: () => new Promise((res) => setTimeout(() => res(new Map()), 500)), limite_ms: 50 });
    prueba('si tarda de más es error', r.estado === 'error', r.estado);
  }
  prueba('fecha corta', fecha('2027-03-12') === '12-mar-2027' && fecha('') === '' && fecha(null) === '');
  prueba('bloque sin resultado = error', bloqueMembresia(null) === T.MEMBRESIA.error);

  console.log('\n— Bandera y herramienta —');
  {
    prueba('apagada por defecto', normalizarSoporteExpertos(true).membresia === false);
    prueba('prende con herramientas + membresia', normalizarSoporteExpertos({ herramientas: true, membresia: true }).membresia === true);
    prueba('sin herramientas no prende', normalizarSoporteExpertos({ herramientas: false, membresia: true }).membresia === false);
    prueba('sin la bandera no prende', normalizarSoporteExpertos({ herramientas: true }).membresia === false);

    const h = crearHerramientas({ telefono: TEL, mensaje: 'hasta cuándo tengo acceso', canalVerificable: true, membresia: true, deps: { membresias: resolverCon(ACTIVA) } });
    const herr = h.lista.find((x) => x.definicion.name === 'ver_mi_membresia');
    prueba('aparece con la bandera', Boolean(herr));
    prueba('no recibe datos del modelo', herr && Object.keys(herr.definicion.input_schema.properties).length === 0);
    prueba('no aparece sin la bandera', !crearHerramientas({ telefono: TEL, canalVerificable: true }).lista.some((x) => x.definicion.name === 'ver_mi_membresia'));
    const salida = await herr.ejecutar({ telefono: '0999999999' });
    prueba('ignora un teléfono que meta el modelo', pedidos[pedidos.length - 1].celulares[0] === TEL);
    prueba('devuelve el texto armado', salida.includes('12-mar-2027'), salida);

    const h2 = crearHerramientas({ telefono: TEL, canalVerificable: false, membresia: true, deps: { membresias: resolverCon(ACTIVA) } });
    const s2 = await h2.lista.find((x) => x.definicion.name === 'ver_mi_membresia').ejecutar({});
    prueba('canal no verificable: no lee', s2 === T.MEMBRESIA.error && h2.membresiaConsultada() === null);
    prueba('la sección del prompt nombra la herramienta', SECCION_MEMBRESIA.includes('ver_mi_membresia'));

    const r = h.membresiaConsultada();
    const hechos = { respaldo: { firme: '', estado: '' }, textoSeguro: T.MENSAJE_ASESOR };
    sumarHechosHerramientas(hechos, [salida], null, { mensaje: '¿Hasta cuándo vence mi membresía?', membresia: r });
    prueba('lo leído entra al respaldo de la guardia', hechos.respaldo.firme.includes('12-mar-2027'));
    prueba('si la guardia rechaza, el texto seguro es lo leído', hechos.textoSeguro === r.texto);
    const hechos2 = { respaldo: { firme: '', estado: '' }, textoSeguro: T.MENSAJE_ASESOR };
    sumarHechosHerramientas(hechos2, [salida], null, { mensaje: 'cuándo llega mi contenedor', membresia: r });
    prueba('si preguntaba otra cosa, se queda el asesor', hechos2.textoSeguro === T.MENSAJE_ASESOR);
    prueba(
      'detecta preguntas de acceso',
      hablaDeMembresia('No puedo entrar a la plataforma') && hablaDeMembresia('¿mi suscripción sigue activa?') && !hablaDeMembresia('mi pedido no llega'),
    );
  }

  console.log(fallos ? `\nFALLAN ${fallos} (pasan ${ok})` : `\nTODO BIEN: ${ok} pasan, 0 fallan`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
