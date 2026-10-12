/* Una base de cargas DE MENTIRA para probar el bot de soporte de Expertos sin
   tocar la base de Imporsuit. Responde las mismas consultas que hace
   src/utils/soporteExpertos/cargaCliente.js, filtrando en memoria.

   Todos los teléfonos, nombres, cotizaciones y contenedores son inventados
   (los números usan el bloque 090 123 45xx, que no es de ninguna operadora).
   «Hoy» es el 12 de octubre de 2026 en todas las pruebas. */

'use strict';

const HOY = '2026-10-12';
const cola = (v) => String(v ?? '').replace(/\D/g, '').slice(-9);

/* Quién escribe (número de WhatsApp, como lo entrega Meta). */
const TEL = {
  transito_con_fecha: '593901234501', // Ana: en tránsito, con fecha estimada y novedad
  aduana: '593901234502', // Bruno: en aduana, sin fecha
  dos_cargas: '593901234503', // Carla: dos cargas; su teléfono solo está en la plataforma
  dudoso: '593901234504', // Diego: contenedor «asignado» hace 53 días
  sin_carga: '593901234505', // Elena: no tiene ninguna cotización
  mexico_liberado: '5215501234506', // Fabián (México): liberado; guardado sin código de país
  cola_gemela: '5215901234501', // número de México con la MISMA cola de 9 dígitos que Ana
  compartido: '593901234508', // un teléfono en cotizaciones de dos clientes distintos
  entregada: '593901234510', // Irene: una entregada hace 9 días y otra hace 7 meses
  solo_vieja: '593901234511', // Julio: solo una cotización «generado» de hace 10 meses
  cuenta_prueba: '593901234512', // cotización de una cuenta de pruebas del equipo
  fecha_vencida: '593901234513', // Lucía: en tránsito con una fecha estimada que ya pasó
  borrador: '593901234514', // Mario: solo un borrador
  seis_cargas: '593901234515', // Nora: seis cargas en curso
  sin_marcas: '593901234516', // Pablo: cotización aprobada sin marcas registradas
  contenedor_nuevo: '593901234517', // Rosa: recién asignada a un contenedor
  recibida_parcial: '593901234518', // Saúl: llegó 1 de 2 marcas a China
  repartida: '593901234519', // Tomás: una cotización repartida en dos contenedores
  whatsapp_sin_codigo: '593901234520', // Úrsula: WhatsApp de alumno sin código de país; una carga a Ecuador y otra a México
  peru_gemelo: '51901234501', // número de Perú con el mismo número nacional que Ana
  desconocido: '593901234599',
};

const c = (id, estado, telefono, id_users, cliente, extra = {}) => ({
  id_cotizacion: id, estado, subestado: null, fecha_creacion: '2026-09-01', pais_destino: 'ec',
  telefono, id_users, cliente, email_cliente: `cliente${id_users}@ejemplo.test`,
  email_asesor: 'asesor@ejemplo.test', ...extra,
});
const m = (id_cotizacion, codigo, fecha_recibida = null, cajas = null) => ({
  id_cotizacion, codigo, subestado: fecha_recibida ? 'recibida' : 'pendiente', cajas, fecha_recibida,
});
const k = (id_cotizacion, id_contenedor, nombre, estado, extra = {}) => ({
  id_cotizacion, id_contenedor, nombre, destino: 'ec', estado, fecha_asignada: '2026-10-01',
  fecha_cierre: null, fecha_estimada: null, fecha_puerto: null, fecha_bodega_destino: null,
  nota_cliente: null, nota_cliente_fecha: null, desde: '2026-09-28', ...extra,
});

const DATOS = {
  cotizaciones: [
    c(9001, 'transito', '0901234501', 701, 'Ana Ejemplo'),
    c(9002, 'transito', '+593 90 123 4502', 702, 'Bruno Ejemplo'),
    c(9003, 'bodega', '', 703, 'Carla Ejemplo', { fecha_creacion: '2026-09-20' }),
    c(9004, 'proximo', null, 703, 'Carla Ejemplo', { fecha_creacion: '2026-07-15' }),
    c(9005, 'carga', '0901234504', 704, 'Diego Ejemplo'),
    c(9006, 'proximo', '55 0123 4506', 706, 'Fabián Ejemplo', { pais_destino: 'mx' }),
    c(9008, 'transito', '0901234508', 708, 'Hugo Uno'),
    c(9009, 'transito', '593901234508', 709, 'Hilda Dos'),
    c(9010, 'entregado', '0901234510', 710, 'Irene Ejemplo', { fecha_creacion: '2026-06-01' }),
    c(9011, 'entregado', '0901234510', 710, 'Irene Ejemplo', { fecha_creacion: '2025-12-01' }),
    c(9012, 'generado', '0901234511', 711, 'Julio Ejemplo', { fecha_creacion: '2025-12-10' }),
    c(9013, 'transito', '0901234512', 712, 'Cuenta De Pruebas', { email_asesor: 'jeimyjara@hotmail.com' }),
    c(9014, 'transito', '0901234513', 713, 'Lucía Ejemplo'),
    c(9015, 'borrador', '0901234514', 714, 'Mario Ejemplo'),
    ...[9021, 9022, 9023, 9024, 9025, 9026].map((id, i) =>
      c(id, 'transito', '0901234515', 715, 'Nora Ejemplo', { fecha_creacion: `2026-09-${String(10 + i).padStart(2, '0')}` }),
    ),
    c(9030, 'aprobado', '0901234516', 716, 'Pablo Ejemplo'),
    c(9031, 'carga', '0901234517', 717, 'Rosa Ejemplo'),
    c(9032, 'bodega', '0901234518', 718, 'Saúl Ejemplo'),
    c(9033, 'bodega', '0901234519', 719, 'Tomás Ejemplo'),
    c(9040, 'transito', '', 790, 'Cuenta Del Equipo'),
    c(9041, 'transito', '', 720, 'Úrsula Ejemplo', { pais_destino: 'mx' }),
    c(9042, 'transito', '', 720, 'Úrsula Ejemplo', { pais_destino: 'ec' }),
  ],
  // WhatsApp de la plataforma más antigua de cada usuario
  usuarios: [
    { id_users: 703, whatsapp: '+593 901 234 503', id_rol: 3 },
    { id_users: 701, whatsapp: '0901234501', id_rol: 3 },
    // Cuenta del EQUIPO con el mismo WhatsApp que una clienta: no entra por este camino.
    { id_users: 790, whatsapp: '+593 901 234 505', id_rol: 1 },
    // Alumno con el WhatsApp guardado SIN código de país y una cotización a México.
    { id_users: 720, whatsapp: '0901234520', id_rol: 4 },
  ],
  marcas: [
    m(9001, 'EC-9001001', '2026-09-10', 14),
    m(9002, 'EC-9002001', '2026-08-20', 6),
    m(9003, 'EC-9003001', '2026-10-02', 9), m(9003, 'EC-9003002'),
    m(9004, 'EC-9004001', '2026-07-30', 20),
    m(9005, 'EC-9005001', '2026-08-01', 4),
    m(9006, 'MX-9006001', '2026-08-01', 11),
    m(9008, 'EC-9008001', '2026-09-01', 3), m(9009, 'EC-9009001', '2026-09-01', 3),
    m(9010, 'EC-9010001', '2026-06-20', 5), m(9011, 'EC-9011001', '2026-01-05', 5),
    m(9012, 'EC-9012001'),
    m(9013, 'EC-9013001', '2026-09-01', 2),
    m(9014, 'EC-9014001', '2026-08-25', 7),
    ...[9021, 9022, 9023, 9024, 9025, 9026].map((id) => m(id, `EC-${id}001`, '2026-09-15', 2)),
    m(9031, 'EC-9031001', '2026-10-03', 8),
    m(9032, 'EC-9032001', '2026-10-06', 5), m(9032, 'EC-9032002'),
    m(9033, 'EC-9033001', '2026-09-05', 30),
    m(9040, 'EC-9040001', '2026-09-05', 3), m(9041, 'MX-9041001', '2026-09-05', 3), m(9042, 'EC-9042001', '2026-09-05', 3),
  ],
  contenedores: [
    k(9001, 501, 'EC-PRUEBA-OCT-A', 'entransito', {
      fecha_estimada: '2026-10-24', nota_cliente: 'El buque hizo trasbordo en Panamá', nota_cliente_fecha: '2026-10-09',
    }),
    k(9002, 502, 'EC-PRUEBA-SEP-B', 'aduana', { fecha_estimada: '2026-10-05' }),
    k(9004, 504, 'EC-PRUEBA-AGO-C', 'bodega_destino', { fecha_bodega_destino: '2026-10-08' }),
    k(9005, 505, 'EC-PRUEBA-AGO-D', 'cerrado', { fecha_asignada: '2026-10-08', desde: '2026-08-20' }),
    k(9006, 506, 'MX-PRUEBA-SEP-E', 'liberado', { destino: 'mx' }),
    k(9008, 508, 'EC-PRUEBA-OCT-A', 'entransito'), k(9009, 508, 'EC-PRUEBA-OCT-A', 'entransito'),
    k(9010, 510, 'EC-PRUEBA-JUL-F', 'finalizado'), k(9011, 511, 'EC-PRUEBA-ENE-G', 'finalizado'),
    k(9013, 513, 'EC-PRUEBA-OCT-A', 'entransito'),
    k(9014, 514, 'EC-PRUEBA-SEP-H', 'entransito', { fecha_estimada: '2026-10-01' }),
    ...[9021, 9022, 9023, 9024, 9025, 9026].map((id) => k(id, 520, 'EC-PRUEBA-OCT-I', 'entransito')),
    k(9031, 531, 'EC-PRUEBA-OCT-J', 'generado', { fecha_asignada: '2026-10-07', desde: '2026-10-05' }),
    k(9033, 533, 'EC-PRUEBA-SEP-K', 'entransito', { fecha_asignada: '2026-09-20', fecha_estimada: '2026-10-28' }),
    k(9033, 534, 'EC-PRUEBA-OCT-L', 'generado', { fecha_asignada: '2026-10-06', desde: '2026-10-04' }),
    k(9040, 540, 'EC-PRUEBA-OCT-M', 'entransito'), k(9041, 541, 'MX-PRUEBA-OCT-N', 'entransito', { destino: 'mx' }),
    k(9042, 542, 'EC-PRUEBA-OCT-O', 'entransito'),
  ],
  entregas: [
    { id_cotizacion: 9010, estado: 'entregada', fecha_entrega: '2026-10-03' },
    { id_cotizacion: 9011, estado: 'entregada', fecha_entrega: '2026-03-02' },
  ],
};

/**
 * @param {object} [datos]  por defecto, DATOS
 * @param {object} [o]      { sinSeguimiento, sinEntregas, sinRegexp, falla, demoraMs } para
 *                          simular una base sin la migración del packing, sin
 *                          REGEXP_REPLACE (MySQL 5.7), caída o lenta
 * @returns {{consultar:Function, consultas:string[]}}
 */
function baseDeMentira(datos = DATOS, o = {}) {
  const consultas = [];
  const consultar = async (sql, rep = []) => {
    consultas.push(sql);
    if (!/^\s*select\b/i.test(sql)) throw new Error('la base de mentira solo acepta SELECT');
    if (o.falla) throw new Error(o.falla);
    if (o.demoraMs) await new Promise((r) => setTimeout(r, o.demoraMs));

    if (o.sinRegexp && /REGEXP_REPLACE/.test(sql)) throw new Error('FUNCTION imporsuit.REGEXP_REPLACE does not exist');
    if (/FROM plataformas p/.test(sql)) {
      const roles = (/id_rol IN \(([\d, ]+)\)/.exec(sql)?.[1] || '').split(',').map((x) => Number(x.trim())).filter(Boolean);
      return datos.usuarios
        .filter((u) => cola(u.whatsapp) === rep[0] && (!roles.length || roles.includes(u.id_rol)))
        .map(({ id_rol, ...u }) => ({ ...u }));
    }
    if (/FROM cotizadorpro_cotizaciones c/.test(sql)) {
      const filas = /d\.id_users IN \(\?\)/.test(sql)
        ? datos.cotizaciones.filter((x) => rep[0].includes(x.id_users))
        : datos.cotizaciones.filter((x) => cola(x.telefono) === rep[0] && cola(x.telefono).length === 9);
      return [...filas]
        .sort((a, b) => String(b.fecha_creacion).localeCompare(String(a.fecha_creacion)) || b.id_cotizacion - a.id_cotizacion)
        .map((x) => ({ ...x }));
    }
    if (/FROM cotizadorpro_codigo_proveedores cp/.test(sql)) {
      return datos.marcas.filter((x) => rep[0].includes(x.id_cotizacion)).map((x) => ({ ...x }));
    }
    if (/FROM cotizacion_carga cc\s+INNER JOIN cotizadorpro_cargas cg/.test(sql)) {
      if (/cg\.nota_cliente/.test(sql) && o.sinSeguimiento) {
        throw new Error("Unknown column 'cg.fecha_bodega_destino' in 'field list'");
      }
      return datos.contenedores
        .filter((x) => rep[0].includes(x.id_cotizacion))
        .map(({ desde, ...x }) => (o.sinSeguimiento ? { ...x, fecha_bodega_destino: null, nota_cliente: null, nota_cliente_fecha: null } : { ...x }));
    }
    if (/FROM cotizadorpro_cargas c\b/.test(sql)) {
      const vistos = new Map();
      for (const x of datos.contenedores) if (rep[0].includes(x.id_contenedor)) vistos.set(x.id_contenedor, x.desde);
      return [...vistos].map(([id_contenedor, desde]) => ({ id_contenedor, desde }));
    }
    if (/FROM cotizacion_entregas/.test(sql)) {
      if (o.sinEntregas) throw new Error("Table 'cotizacion_entregas' doesn't exist");
      return datos.entregas.filter((x) => rep[0].includes(x.id_cotizacion)).map((x) => ({ ...x }));
    }
    throw new Error(`consulta no prevista en la base de mentira: ${sql.trim().slice(0, 70)}`);
  };
  return { consultar, consultas };
}

module.exports = { baseDeMentira, DATOS, TEL, HOY };
