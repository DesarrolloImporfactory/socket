/* Pruebas de «mis pagos y mi factura» del bot de Expertos
   (soporteExpertos/pagosCliente.js + ver_mis_pagos en herramientas.js).
   Sin red ni base: la base es un doble. Uso: node scripts/probar_soporte_expertos_pagos.js */

'use strict';

const path = require('path');
const rutaDb = require.resolve(path.join(__dirname, '../src/database/config'));
require.cache[rutaDb] = { id: rutaDb, filename: rutaDb, loaded: true, exports: { db: {}, db_2: {} } };

const { pagosDelTelefono, bloquePagos, textoPagosParaCliente, variantesDeMontos, pidePagos, monto } = require('../src/utils/soporteExpertos/pagosCliente');
const { crearHerramientas, sumarHechosHerramientas } = require('../src/utils/soporteExpertos/herramientas');
const { revisarTurno } = require('../src/utils/soporteExpertos/turno');
const { consultarImporsuit } = require('../src/utils/soporteExpertos/cargaCliente');
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

/* Base de mentira. `usuarios`: filas de plataformas; `cuotas`, `pagos`, `facturas` por tabla. */
function base({ usuarios = [], cuotas = [], pagos = [], facturas = [], falla = null } = {}) {
  const sqls = [];
  return {
    sqls,
    consultar: async (sql, rep) => {
      sqls.push({ sql, rep });
      if (falla) throw new Error(falla);
      if (/FROM plataformas/.test(sql)) return usuarios;
      if (/FROM carteras/.test(sql)) return cuotas.filter((c) => rep[0].includes(c.id_users));
      if (/FROM cartera_pagos/.test(sql)) return pagos.filter((p) => rep[0].includes(p.id_cpp));
      if (/FROM facturas_electronicas/.test(sql)) {
        // Solo las columnas que pide el SELECT: si falta una, la prueba lo ve.
        const cols = [...sql.split('FROM')[0].matchAll(/f\.(\w+)/g)].map((m) => m[1]);
        return facturas
          .filter((f) => rep[0].includes(f.id_users))
          .map((f) => Object.fromEntries(Object.entries({ fecha: f.fecha, ...f }).filter(([k]) => cols.includes(k) || k === 'fecha')));
      }
      return [];
    },
  };
}
const cuota = (o) => ({
  id_cpp: 1, id_users: 50, concepto: 'Programa Expertos', estado: 0, monto_original: 500, monto_pendiente: 500,
  fecha_limite: '2026-11-05', num_cuota: 2, total_cuotas: 6, id_cotizacion: null, moneda: 'USD', ...o,
});
const ALUMNA = { id_users: 50, whatsapp: '+593 98 700 0111', email: 'ana@gmail.com' };

(async () => {
  console.log('1. Quién es: solo el número del que escribe');
  let b = base({ usuarios: [ALUMNA], cuotas: [cuota({})] });
  let r = await pagosDelTelefono(EC, { consultar: b.consultar });
  prueba('encuentra la cartera de la alumna', r.estado === 'encontrado' && r.pendientes.length === 1, JSON.stringify(r));
  prueba('busca por la cola de 9 dígitos del remitente', b.sqls[0].rep[0] === '987000111');
  r = await pagosDelTelefono('123', { consultar: b.consultar });
  prueba('número que no sirve: no consulta', r.estado === 'telefono_no_valido');
  b = base({ usuarios: [ALUMNA, { id_users: 51, whatsapp: '0987000111', email: 'otro@gmail.com' }], cuotas: [cuota({}), cuota({ id_cpp: 2, id_users: 51 })] });
  r = await pagosDelTelefono(EC, { consultar: b.consultar });
  prueba('el número es de dos alumnos: no se informa nada', r.estado === 'varios_clientes' && !r.pendientes.length);
  b = base({ usuarios: [ALUMNA, { id_users: 51, whatsapp: '+593987000111', email: 'otro@gmail.com' }], cuotas: [] });
  r = await pagosDelTelefono(EC, { consultar: b.consultar });
  prueba('dos personas pero ninguna tiene cuotas ni facturas: sin_cartera', r.estado === 'sin_cartera', r.estado);
  b = base({
    usuarios: [{ ...ALUMNA, nombre: 'Ana María Pérez' }, { id_users: 54, whatsapp: '+593987000111', email: 'ana.vieja@gmail.com', nombre: 'ANA MARÍA' }],
    cuotas: [cuota({}), cuota({ id_cpp: 9, id_users: 54, monto_pendiente: 100, fecha_limite: '2026-12-01' })],
  });
  r = await pagosDelTelefono(EC, { consultar: b.consultar });
  prueba('dos cuentas de la misma persona: se suman', r.estado === 'encontrado' && r.pendientes.length === 2 && r.totales[0].total === 600, JSON.stringify(r.totales));
  b = base({
    usuarios: [{ ...ALUMNA, nombre: 'Ana Pérez' }, { id_users: 55, whatsapp: '+593987000111', email: 'luis@gmail.com', nombre: 'Luis Pérez' }],
    cuotas: [cuota({})],
  });
  r = await pagosDelTelefono(EC, { consultar: b.consultar });
  prueba('número en cuentas de dos personas y una con cuotas: no se informa', r.estado === 'varios_clientes');
  b = base({ usuarios: [{ id_users: 52, whatsapp: '987000111', email: 'x@gmail.com' }], cuotas: [cuota({ id_users: 52, moneda: 'MXN' })] });
  r = await pagosDelTelefono(EC, { consultar: b.consultar });
  prueba('guardado sin código y cuotas en pesos, escribe de Ecuador: no vale', r.estado === 'sin_cartera', r.estado);
  b = base({ usuarios: [{ id_users: 52, whatsapp: '0987000111', email: 'x@gmail.com' }], cuotas: [cuota({ id_users: 52 })] });
  r = await pagosDelTelefono(EC, { consultar: b.consultar });
  prueba('guardado sin código y cuotas en dólares, escribe de Ecuador: vale', r.estado === 'encontrado');
  b = base({ usuarios: [{ id_users: 53, whatsapp: '+593987000111', email: 'jeimypruebas@gmail.com' }], cuotas: [cuota({ id_users: 53 })] });
  r = await pagosDelTelefono(EC, { consultar: b.consultar });
  prueba('cuenta de prueba: no cuenta', r.estado === 'sin_cartera');
  b = base({ usuarios: [], cuotas: [] });
  r = await pagosDelTelefono(EC, { consultar: b.consultar });
  prueba('sin alumno: sin_cartera', r.estado === 'sin_cartera');
  b = base({ falla: 'base caída' });
  r = await pagosDelTelefono(EC, { consultar: b.consultar });
  prueba('base caída: error, sin tirar', r.estado === 'error' && /base caída/.test(r.motivo));
  r = await pagosDelTelefono(EC, { consultar: () => new Promise((ok) => setTimeout(() => ok([]), 400)), limite_ms: 50 });
  prueba('base colgada: corta a tiempo', r.estado === 'error' && /sin respuesta/.test(r.motivo));

  console.log('\n2. Qué se lee');
  b = base({
    usuarios: [ALUMNA],
    cuotas: [
      cuota({ id_cpp: 1, estado: 1, monto_pendiente: 0, num_cuota: 1, fecha_limite: '2026-10-05' }),
      cuota({ id_cpp: 2, monto_pendiente: 250, num_cuota: 2, fecha_limite: '2026-11-05' }),
      cuota({ id_cpp: 3, num_cuota: 3, fecha_limite: '2026-12-05' }),
      cuota({ id_cpp: 4, estado: 2, monto_pendiente: 0, concepto: 'Anulada' }),
    ],
    pagos: [
      { id_cpp: 1, monto_pagado: 500, moneda: 'USD', fecha: '2026-10-03', con_comprobante: 1 },
      { id_cpp: 2, monto_pagado: 250, moneda: null, fecha: '2026-10-20', con_comprobante: 0 },
    ],
    facturas: [
      { id_users: 50, id_cpp: 1, estado: 'autorizada', establecimiento: '001', punto_emision: '002', secuencial: 345, datil_id: 'abc123XYZ', fecha: '2026-10-04' },
      { id_users: 50, id_cotizacion: 4521, estado: 'procesando', establecimiento: '001', punto_emision: '002', secuencial: null, datil_id: null },
    ],
  });
  r = await pagosDelTelefono(EC, { consultar: b.consultar });
  prueba('2 pendientes (la anulada no cuenta), 1 pagada', r.pendientes.length === 2 && r.pagadas === 1, JSON.stringify(r.pendientes));
  prueba('saldo total 750 USD', r.totales.length === 1 && r.totales[0].total === 750 && r.totales[0].moneda === 'USD');
  prueba('la próxima va primero (5 de noviembre)', r.pendientes[0].fecha_limite === '2026-11-05');
  prueba('pago sin moneda toma la de su cuota', r.pagos.find((p) => p.monto === 250)?.moneda === 'USD');
  prueba('factura autorizada: número de 9 dígitos y PDF de Dátil', r.facturas[0].numero === '001-002-000000345' && r.facturas[0].pdf === 'https://app.datil.co/ver/abc123XYZ/pdf');
  prueba('factura en proceso: sin número ni PDF', r.facturas[1].estado === 'procesando' && !r.facturas[1].pdf);
  const sqlTodo = b.sqls.map((s) => s.sql).join('\n');
  prueba('no lee imagen del comprobante, referencia ni asesor', !/cp\.imagenes\s*(?:,|AS)|referencia|id_asesor|ua\./.test(sqlTodo.replace(/JSON_LENGTH\(IFNULL\(cp\.imagenes/g, '')));
  prueba('solo consultas SELECT', b.sqls.every((s) => /^\s*select/i.test(s.sql)));
  let rechazo = null;
  await consultarImporsuit('UPDATE cuenta_por_pagar SET estado = 1').catch((e) => (rechazo = e.message));
  prueba('el adaptador rechaza lo que no es SELECT', /solo se permiten/.test(rechazo || ''));

  console.log('\n3. Lo que ve el modelo');
  const bloque = bloquePagos(r, { hoy: '2026-10-25' });
  prueba('cuota con fecha ya pasada: «venció el…»', /venció el 5 de noviembre/.test(bloquePagos(r, { hoy: '2026-11-10' })) && /; venció el 5 de noviembre/.test(textoPagosParaCliente(r, { hoy: '2026-11-10' })));
  prueba('trae el saldo y la próxima cuota con fecha', /Saldo pendiente: 750,00 USD/.test(bloque) && /cuota 2\/6\): debe 250,00 USD de 500,00 USD, fecha límite 5 de noviembre/.test(bloque), bloque);
  prueba('trae la factura con su PDF', /factura N\.º 001-002-000000345/.test(bloque) && /app\.datil\.co\/ver\/abc123XYZ\/pdf/.test(bloque));
  prueba('dice si el pago traía comprobante', /con comprobante/.test(bloque) && /sin comprobante adjunto/.test(bloque));
  prueba('le dice que un pago que no aparece NO es «no pagó»', /NO le digas que no pagó/.test(bloque));
  prueba('varios alumnos: sin montos', !/\d/.test(bloquePagos({ estado: 'varios_clientes' }).replace(/💳/, '')));
  prueba('sin cartera: no dice que no debe', /No digas que no debe/.test(bloquePagos({ estado: 'sin_cartera' })));
  prueba('monto con miles a la ecuatoriana', monto(1250.5, 'USD') === '1.250,50 USD');

  console.log('\n4. La guardia: respalda los montos leídos en cualquier forma, y nada más');
  const variantes = variantesDeMontos(r);
  const hechos = () => ({ respaldo: { firme: T.MENSAJE_ASESOR, estado: '' }, textoSeguro: T.MENSAJE_ASESOR, carga: null, adjuntos: [] });
  const revisar = (respuesta, mensaje = '¿cuánto debo?') => {
    const h = hechos();
    sumarHechosHerramientas(h, [bloque], null, { mensaje, respuesta, pagos: r });
    return revisarTurno(respuesta, h);
  };
  for (const t of [
    'Hola, tu saldo pendiente es 750,00 USD. La próxima cuota es de 250,00 USD y vence el 5 de noviembre.',
    'Hola, debes $750 en total. Tu próxima cuota es de $250 con fecha límite 5 de noviembre.',
    'Tu saldo es de 750 dólares.',
    'Tu factura es la N.º 001-002-000000345: https://app.datil.co/ver/abc123XYZ/pdf',
  ]) {
    const rev = revisar(t);
    prueba(`pasa: «${t.slice(0, 60)}…»`, !rev.cambiada, (rev.motivos || []).join('; '));
  }
  let rev = revisar('Tu saldo pendiente es de $900.');
  prueba('un monto que no se leyó: se frena', rev.cambiada, (rev.motivos || []).join('; '));
  rev = revisar('Tu factura está aquí: https://app.datil.co/ver/OTRA999/pdf');
  prueba('un PDF que no se leyó: se frena', rev.cambiada);
  prueba('las variantes no van a ningún texto del cliente', !bloque.includes('Montos leídos') && !String(textoPagosParaCliente(r)).includes('usd'));
  prueba('variantes: «$1.250» respalda 1250 leído', variantesDeMontos({ estado: 'encontrado', totales: [{ total: 1250 }], pendientes: [], pagos: [] }).includes('$1.250 '));

  console.log('\n5. Texto seguro si la guardia rechaza');
  let h = hechos();
  sumarHechosHerramientas(h, [bloque], null, { mensaje: 'hola, cuánto me falta por pagar?', respuesta: 'x', pagos: r });
  prueba('«cuánto me falta»: el saldo armado en código', /tu saldo pendiente es 750,00 USD/.test(h.textoSeguro) && /5 de noviembre/.test(h.textoSeguro), h.textoSeguro);
  h = hechos();
  sumarHechosHerramientas(h, [bloque], null, { mensaje: 'me puedes enviar mi factura?', respuesta: 'x', pagos: r });
  prueba('«mi factura»: el número y el PDF', /001-002-000000345/.test(h.textoSeguro) && /pdf/.test(h.textoSeguro));
  h = hechos();
  sumarHechosHerramientas(h, [bloque], null, { mensaje: 'ya pagué, aquí está el comprobante', respuesta: 'x', pagos: r });
  prueba('«ya pagué + comprobante»: sigue el asesor (cobranza)', h.textoSeguro === T.MENSAJE_ASESOR);
  h = hechos();
  sumarHechosHerramientas(h, [bloque], null, { mensaje: 'cuánto debo', respuesta: 'x', pagos: { estado: 'varios_clientes' } });
  prueba('varios alumnos: sigue el asesor', h.textoSeguro === T.MENSAJE_ASESOR);
  prueba('factura que no existe: null (lo ve una persona)', textoPagosParaCliente({ ...r, facturas: [] }, { pideFactura: true }) === null);
  prueba('sin pendientes: «no tienes cuotas pendientes»', /no tienes cuotas pendientes/.test(textoPagosParaCliente({ ...r, pendientes: [], totales: [] })));

  console.log('\n6. ¿Pregunta por su saldo o su factura?');
  for (const [t, e] of [
    ['cuánto debo todavía?', 'saldo'],
    ['cuál es mi saldo', 'saldo'],
    ['cuándo tengo que pagar la próxima cuota', 'saldo'],
    ['ya les llegó mi pago?', 'saldo'],
    ['necesito la factura', 'factura'],
    ['ya pagué', null],
    ['te mando el comprobante', null],
    ['quiero cotizar 500 lámparas', null],
  ]) prueba(`«${t}» → ${e}`, pidePagos(t) === e, String(pidePagos(t)));

  console.log('\n7. La herramienta en el motor');
  b = base({ usuarios: [ALUMNA], cuotas: [cuota({})] });
  let hs = crearHerramientas({ telefono: EC, mensaje: 'cuánto debo', canalVerificable: true, pagos: true, deps: { consultar: b.consultar } });
  const vmp = hs.lista.find((x) => x.definicion.name === 'ver_mis_pagos');
  prueba('con pagos: true se ofrece ver_mis_pagos', Boolean(vmp));
  prueba('sin campos de identidad en el esquema', vmp && Object.keys(vmp.definicion.input_schema.properties).length === 0);
  const out = vmp ? await vmp.ejecutar({ telefono: MX }) : '';
  prueba('aunque el modelo mande otro número, busca el del remitente', b.sqls[0]?.rep[0] === '987000111' && /Saldo pendiente/.test(out));
  prueba('queda guardado para la guardia', hs.pagosConsultados()?.estado === 'encontrado');
  hs = crearHerramientas({ telefono: EC, canalVerificable: true });
  prueba('sin la bandera no se ofrece', !hs.lista.some((x) => x.definicion.name === 'ver_mis_pagos'));
  hs = crearHerramientas({ telefono: EC, canalVerificable: false, pagos: true, deps: { consultar: b.consultar } });
  const fuera = await hs.lista.find((x) => x.definicion.name === 'ver_mis_pagos').ejecutar({});
  prueba('fuera de WhatsApp no consulta', /No se pueden consultar pagos/.test(fuera) && !/\d/.test(fuera));

  console.log('\n8. Ajustes: apagado salvo herramientas + pagos');
  const n = (v) => ajustes.normalizar({ soporte_expertos: v }).soporte_expertos.pagos;
  prueba('sin la clave: apagado', n({ herramientas: true }) === false);
  prueba('pagos sin herramientas: apagado', n({ pagos: true }) === false);
  prueba('herramientas + pagos: encendido', n({ herramientas: true, pagos: true }) === true);
  prueba('true (todo) deja pagos apagado', ajustes.normalizar({ soporte_expertos: true }).soporte_expertos.pagos === false);

  console.log(`\n${fallos ? `HAY FALLAS: ${fallos} fallan, ${ok} pasan` : `TODO BIEN: ${ok} pasan, 0 fallan`}`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
