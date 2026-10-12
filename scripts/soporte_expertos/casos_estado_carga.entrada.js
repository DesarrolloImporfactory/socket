/* Casos de «en qué paso va una carga» con datos de mentira. Con ellos se
   compara estadoCarga.js contra el original Class/EstadoCargaCliente.php de
   Imporsuit (ver comparar_con_php.php). Hoy = 2026-10-12 en todos. */
'use strict';

const HOY = '2026-10-12';
const marca = (codigo, recibida = null, cajas = null, subestado = null) => ({
  codigo, subestado: subestado ?? (recibida ? 'recibida' : 'pendiente'), cajas, fecha_recibida: recibida,
});
const cont = (id, nombre, estado, extra = {}) => ({
  id_contenedor: id, nombre, destino: 'ec', estado, cbm_asignado: 1.2,
  fecha_asignada: '2026-10-01 10:00:00', fecha_cierre: null, fecha_estimada: null, fecha_puerto: null,
  fecha_salida: null, fecha_bodega_destino: null, nota_cliente: null, ...extra,
});
const cot = (id, estado, extra = {}) => ({
  id_cotizacion: id, estado, destino: 'ec', cliente: { nombre: 'Marta Pruebas' },
  marcas: [], contenedores: [], parcial: false, entrega: null, pago: { estado: 'sin_facturar' }, ...extra,
});

const CASOS = [
  { nombre: 'borrador: no es una carga', cot: cot(101, 'borrador') },
  { nombre: 'anulada', cot: cot(102, 'anulado', { marcas: [marca('EC-1020001')] }) },
  { nombre: 'paso 1 sin marcas', cot: cot(103, 'generado') },
  { nombre: 'paso 1 con una marca sin recibir', cot: cot(104, 'aprobado', { marcas: [marca('EC-1040001')] }) },
  { nombre: 'paso 1 con dos marcas sin recibir', cot: cot(105, 'contactado', { marcas: [marca('EC-1050001'), marca('EC-1050002')] }) },
  { nombre: 'paso 2 completa, una marca con cajas', cot: cot(106, 'bodega', { marcas: [marca('EC-1060001', '2026-10-05 09:00:00', 12)] }) },
  { nombre: 'paso 2 completa, una caja', cot: cot(107, 'bodega', { marcas: [marca('EC-1070001', '2026-10-05', 1)] }) },
  { nombre: 'paso 2 incompleta', cot: cot(108, 'bodega', { marcas: [marca('EC-1080001', '2026-10-05', 8), marca('EC-1080002'), marca('EC-1080003')] }) },
  { nombre: 'paso 2 recibida por subestado, sin fecha', cot: cot(109, 'bodega', { marcas: [marca('EC-1090001', null, 3, 'recibida')] }) },
  { nombre: 'paso 3 contenedor nuevo', cot: cot(110, 'carga', { marcas: [marca('EC-1100001', '2026-09-28', 5)], contenedores: [cont(1, 'EC-PRUEBA-01', 'generado')] }), abiertoDesde: { 1: '2026-10-01' } },
  { nombre: 'paso 3 contenedor viejo (dato dudoso)', cot: cot(111, 'carga', { marcas: [marca('EC-1110001', '2026-08-01', 5)], contenedores: [cont(2, 'EC-PRUEBA-02', 'cerrado', { fecha_asignada: '2026-10-08 10:00:00' })] }), abiertoDesde: { 2: '2026-08-20' } },
  { nombre: 'paso 3 a los 30 días justos (todavía no es dudoso)', cot: cot(112, 'carga', { marcas: [marca('EC-1120001', '2026-09-01', 5)], contenedores: [cont(3, 'EC-PRUEBA-03', 'borrador', { fecha_asignada: '2026-09-12 08:00:00' })] }) },
  { nombre: 'paso 3 a los 31 días sin fecha del contenedor (usa la de asignación)', cot: cot(113, 'carga', { marcas: [marca('EC-1130001', '2026-09-01', 5)], contenedores: [cont(4, 'EC-PRUEBA-04', 'generado', { fecha_asignada: '2026-09-11 08:00:00' })] }) },
  { nombre: 'paso 3 parcial', cot: cot(114, 'bodega', { parcial: true, marcas: [marca('EC-1140001', '2026-09-28', 5), marca('EC-1140002', '2026-09-29', 2)], contenedores: [cont(5, 'EC-PRUEBA-05', 'generado')] }), abiertoDesde: { 5: '2026-10-02' } },
  { nombre: 'paso 4 con fecha estimada', cot: cot(115, 'carga', { marcas: [marca('EC-1150001', '2026-09-01', 5)], contenedores: [cont(6, 'EC-PRUEBA-06', 'entransito', { fecha_estimada: '2026-10-24' })] }) },
  { nombre: 'paso 4 sin fecha estimada', cot: cot(116, 'transito', { marcas: [marca('EC-1160001', '2026-09-01', 5)], contenedores: [cont(7, 'EC-PRUEBA-07', 'entransito')] }) },
  { nombre: 'paso 4 con fecha 0000', cot: cot(117, 'transito', { marcas: [marca('EC-1170001', '2026-09-01', 5)], contenedores: [cont(8, 'EC-PRUEBA-08', 'entransito', { fecha_estimada: '0000-00-00' })] }) },
  { nombre: 'paso 4 a México, varias marcas', cot: cot(118, 'transito', { destino: 'mx', marcas: [marca('MX-1180001', '2026-09-01', 5), marca('MX-1180002', '2026-09-02', 4)], contenedores: [cont(9, 'MX-PRUEBA-09', 'entransito', { destino: 'mx', fecha_estimada: '2026-11-03 00:00:00' })] }) },
  { nombre: 'paso 5 aduana, con estimada (no se nombra)', cot: cot(119, 'transito', { marcas: [marca('EC-1190001', '2026-08-01', 5)], contenedores: [cont(10, 'EC-PRUEBA-10', 'aduana', { fecha_estimada: '2026-10-15' })] }) },
  { nombre: 'paso 5 aduana sin estimada y saldo vencido', cot: cot(120, 'proximo', { pago: { estado: 'vencida' }, marcas: [marca('EC-1200001', '2026-08-01', 5)], contenedores: [cont(11, 'EC-PRUEBA-11', 'aduana')] }) },
  { nombre: 'paso 6 liberado', cot: cot(121, 'proximo', { pago: { estado: 'pendiente' }, marcas: [marca('EC-1210001', '2026-08-01', 5)], contenedores: [cont(12, 'EC-PRUEBA-12', 'liberado')] }) },
  { nombre: 'paso 7 en bodega con fecha', cot: cot(122, 'proximo', { marcas: [marca('EC-1220001', '2026-08-01', 5)], contenedores: [cont(13, 'EC-PRUEBA-13', 'bodega_destino', { fecha_bodega_destino: '2026-10-09' })] }) },
  { nombre: 'paso 7 finalizado sin fecha', cot: cot(123, 'entregado', { marcas: [marca('EC-1230001', '2026-07-01', 5)], contenedores: [cont(14, 'EC-PRUEBA-14', 'finalizado')] }) },
  { nombre: 'entregada con fecha', cot: cot(124, 'entregado', { entrega: { estado: 'entregada', fecha_entrega: '2026-10-03' }, marcas: [marca('EC-1240001', '2026-07-01', 5)], contenedores: [cont(15, 'EC-PRUEBA-15', 'finalizado')] }) },
  { nombre: 'entregada sin fecha', cot: cot(125, 'entregado', { entrega: { estado: 'entregada', fecha_entrega: null }, marcas: [marca('EC-1250001', '2026-07-01', 5), marca('EC-1250002', '2026-07-01', 5)], contenedores: [cont(16, 'EC-PRUEBA-16', 'bodega_destino')] }) },
  { nombre: 'lista para retirar (no es entregada)', cot: cot(126, 'proximo', { entrega: { estado: 'lista_para_retirar', fecha_entrega: null }, marcas: [marca('EC-1260001', '2026-07-01', 5)], contenedores: [cont(17, 'EC-PRUEBA-17', 'bodega_destino', { fecha_bodega_destino: '2026-10-10' })] }) },
  { nombre: 'dos contenedores: manda el más avanzado', cot: cot(127, 'carga', { marcas: [marca('EC-1270001', '2026-08-01', 5)], contenedores: [cont(18, 'EC-PRUEBA-18', 'generado', { fecha_asignada: '2026-10-05 10:00:00' }), cont(19, 'EC-PRUEBA-19', 'entransito', { fecha_asignada: '2026-09-20 10:00:00', fecha_estimada: '2026-10-30' })] }) },
  { nombre: 'dos contenedores en el mismo paso: el asignado más tarde', cot: cot(128, 'carga', { marcas: [marca('EC-1280001', '2026-08-01', 5)], contenedores: [cont(20, 'EC-PRUEBA-20', 'entransito', { fecha_asignada: '2026-09-20 10:00:00' }), cont(21, 'EC-PRUEBA-21', 'entransito', { fecha_asignada: '2026-09-25 10:00:00', fecha_estimada: '2026-11-01' })] }) },
  { nombre: 'estado de contenedor desconocido (cae al paso 3)', cot: cot(129, 'carga', { marcas: [marca('EC-1290001', '2026-10-01', 5)], contenedores: [cont(22, 'EC-PRUEBA-22', 'raro')] }), abiertoDesde: { 22: '2026-10-05' } },
  { nombre: 'viejo pero ya entregada (sí hay texto)', cot: cot(130, 'entregado', { entrega: { estado: 'entregada', fecha_entrega: '2026-10-01' }, marcas: [marca('EC-1300001', '2026-06-01', 5)], contenedores: [cont(23, 'EC-PRUEBA-23', 'cerrado')] }), abiertoDesde: { 23: '2026-06-10' } },
  { nombre: 'nombre con código HTML y destino sin dato', cot: cot(131, 'aprobado', { destino: '', cliente: { nombre: 'JOS&Eacute; avi&ntilde;a' }, marcas: [marca('EC-1310001')] }) },
  { nombre: 'nombre que es un correo (va sin nombre)', cot: cot(132, 'aprobado', { cliente: { nombre: 'cliente@correo.com' }, marcas: [marca('EC-1320001')] }) },
  { nombre: 'rechazada con contenedor (el contenedor manda)', cot: cot(133, 'rechazado', { marcas: [marca('EC-1330001', '2026-09-01', 2)], contenedores: [cont(24, 'EC-PRUEBA-24', 'entransito')] }) },
];

module.exports = { HOY, CASOS };
