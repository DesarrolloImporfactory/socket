/*  Prueba del historial de cargas de Team (utils/historialCargas.js) con datos
 *  de mentira: nada sale a la base. Números inventados.
 *    node scripts/probar_historial_cargas.js
 */
const path = require('path');
const assert = require('assert');

const dbf = require.resolve(path.join(__dirname, '..', 'src/database/config'));
require.cache[dbf] = { id: dbf, filename: dbf, loaded: true, exports: { db: {}, db_2: {} } };
const { historialDelTelefono } = require(path.join(__dirname, '..', 'src/utils/historialCargas'));

const CEL = '593991234567';
const HOY = '2026-10-27';
let cotizaciones = [];
let pedidas = [];
const consultar = async (sql, rep) => {
  pedidas.push({ sql, rep });
  if (/FROM cotizadorpro_cotizaciones c/.test(sql) && /d\.telefono/.test(sql)) return cotizaciones;
  if (/FROM cotizadorpro_cotizaciones c/.test(sql)) return [];
  if (/FROM plataformas p/.test(sql)) return [];
  if (/FROM cotizadorpro_codigo_proveedores/.test(sql)) {
    return [
      { id_cotizacion: 101, codigo: 'ANA22', subestado: 'recibido', cajas: 4, fecha_recibida: '2026-09-01' },
      { id_cotizacion: 102, codigo: 'ANA30', subestado: 'recibido', cajas: 2, fecha_recibida: '2026-03-10' },
    ];
  }
  if (/FROM cotizacion_carga cc/.test(sql)) {
    return [
      { id_cotizacion: 101, fecha_asignada: '2026-09-20', id_contenedor: 9, nombre: 'GRUPAL 45', destino: 'ec', estado: 'transito', fecha_cierre: '2026-09-25', fecha_estimada: '2026-11-20', fecha_puerto: null, fecha_bodega_destino: null, nota_cliente: 'Zarpó, llamar al 0991234567' },
      { id_cotizacion: 102, fecha_asignada: '2026-03-20', id_contenedor: 5, nombre: 'GRUPAL 30', destino: 'ec', estado: 'finalizado', fecha_cierre: '2026-03-25', fecha_estimada: '2026-05-01', fecha_puerto: '2026-05-02', fecha_bodega_destino: '2026-05-10', nota_cliente: null },
    ];
  }
  if (/FROM cotizacion_entregas/.test(sql)) return [{ id_cotizacion: 102, estado: 'entregada', fecha_entrega: '2026-05-15' }];
  return [];
};
const cot = (id, estado, fecha, extra = {}) => ({ id_cotizacion: id, estado, fecha_creacion: fecha, pais_destino: 'ec', telefono: '+593 99 123 4567', id_users: 7, cliente: 'Ana', email_cliente: 'ana@x.com', email_asesor: 'asesor@x.com', ...extra });

let fallos = 0;
async function caso(nombre, fn) {
  try {
    await fn();
    console.log('  ok  ', nombre);
  } catch (e) {
    fallos += 1;
    console.log('  MAL ', nombre, '\n      ', e.message);
  }
}

(async () => {
  console.log('Historial de cargas');
  await caso('lista todas: la que viaja y la entregada, la más nueva primero, sin montos', async () => {
    cotizaciones = [cot(102, 'entregado', '2026-03-01'), cot(101, 'transito', '2026-08-15'), cot(103, 'borrador', '2026-10-01')];
    const r = await historialDelTelefono(CEL, { consultar, hoy: HOY });
    assert.equal(r.estado, 'encontradas', JSON.stringify(r));
    assert.equal(r.total, 2, 'el borrador no cuenta');
    assert.deepEqual(r.cotizaciones.map((c) => c.id_cotizacion), [101, 102]);
    const [viaja, vieja] = r.cotizaciones;
    assert.equal(viaja.contenedor, 'GRUPAL 45');
    assert.deepEqual(viaja.marcas, ['ANA22']);
    assert.equal(viaja.cajas, 4);
    assert.ok(viaja.paso >= 3, JSON.stringify(viaja));
    assert.equal(viaja.entregada, false);
    assert.equal(vieja.entregada, true, JSON.stringify(vieja));
    assert.ok(vieja.entregada_el, 'fecha de entrega');
    assert.equal(viaja.destino, 'Ecuador');
    const texto = JSON.stringify(r);
    assert.ok(!/precio|monto|saldo|pago|email|telefono/i.test(texto), texto);
  });
  await caso('busca por la cola del número, nunca por lo que diga el chat', async () => {
    pedidas = [];
    cotizaciones = [cot(101, 'transito', '2026-08-15')];
    await historialDelTelefono(CEL, { consultar, hoy: HOY });
    assert.deepEqual(pedidas[0].rep, ['991234567']);
    assert.ok(pedidas.every((p) => /^\s*SELECT/i.test(p.sql)));
  });
  await caso('otro número con la misma cola no entra', async () => {
    cotizaciones = [cot(101, 'transito', '2026-08-15', { telefono: '+52 99 123 4567', pais_destino: 'mx' })];
    const r = await historialDelTelefono(CEL, { consultar, hoy: HOY });
    assert.equal(r.estado, 'sin_carga');
  });
  await caso('el número en cotizaciones de dos clientes → no lista nada', async () => {
    cotizaciones = [cot(101, 'transito', '2026-08-15'), cot(102, 'entregado', '2026-03-01', { id_users: 8, email_cliente: 'otro@x.com', cliente: 'Otro' })];
    const r = await historialDelTelefono(CEL, { consultar, hoy: HOY });
    assert.equal(r.estado, 'varios_clientes');
    assert.equal(r.cotizaciones.length, 0);
  });
  await caso('cuentas de prueba fuera', async () => {
    cotizaciones = [cot(101, 'transito', '2026-08-15', { email_asesor: 'jeimyjara@hotmail.com' })];
    const r = await historialDelTelefono(CEL, { consultar, hoy: HOY });
    assert.equal(r.estado, 'sin_carga');
  });
  await caso('si la base falla → estado error, no revienta', async () => {
    const r = await historialDelTelefono(CEL, { consultar: async () => { throw new Error('ECONNREFUSED'); }, hoy: HOY });
    assert.equal(r.estado, 'error');
  });
  await caso('número que no sirve → telefono_no_valido sin consultar', async () => {
    pedidas = [];
    const r = await historialDelTelefono('12', { consultar, hoy: HOY });
    assert.equal(r.estado, 'telefono_no_valido');
    assert.equal(pedidas.length, 0);
  });
  console.log(fallos ? `\n${fallos} FALLAS` : '\nTodo en verde');
  process.exit(fallos ? 1 : 0);
})();
