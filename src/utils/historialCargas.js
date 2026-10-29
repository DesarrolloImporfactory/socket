/* Historial de cargas del cliente de un chat, para la barra de Team (Agenda).

   A diferencia de soporteExpertos/cargaCliente.js —que le dice al CLIENTE
   solo lo que está en curso y es seguro informar— esto es para el ASESOR:
   todas las cotizaciones de ese número, también las entregadas y las que no
   avanzaron, con su paso, marcas, contenedor y fechas.

   Mismas reglas de seguridad que cargaCliente: se busca SOLO por el número
   del chat (lo pone el servidor), cada candidata se confirma con el número
   completo, si el número está en cotizaciones de dos clientes no se lista
   nada, se saltan las cuentas de prueba y no se leen montos ni pagos.
   SOLO LECTURA (consultarImporsuit se niega a lo que no sea SELECT). */

'use strict';

const { estadoDeCarga, hoyEcuador, fecha, fechaTexto, SIN_CARGA } = require('./soporteExpertos/estadoCarga');
const { mismoTelefono, comoCoincide, colaCandidatos, paisDeDestino, paisDelTelefono } = require('./soporteExpertos/telefono');
const { consultarImporsuit, esCorreoDePrueba } = require('./soporteExpertos/cargaCliente');

const MAX_HISTORIAL = 25;
const LIMITE_MS = 10000;

const COLA_SQL = (col) => `RIGHT(REGEXP_REPLACE(COALESCE(${col}, ''), '[^0-9]', ''), 9)`;
const F = (col, alias) => `DATE_FORMAT(${col}, '%Y-%m-%d') AS ${alias}`;
const ROLES_ALUMNO = [3, 4, 14, 16, 18];

const SQL_COTIZACIONES = (donde) => `
  SELECT c.id_cotizacion, c.estado, ${F('c.fecha_creacion', 'fecha_creacion')},
         d.pais_destino, d.telefono, d.id_users,
         u.nombre_users AS cliente, u.email_users AS email_cliente,
         a.email_users AS email_asesor
    FROM cotizadorpro_cotizaciones c
    INNER JOIN cotizadorpro_detalle_cot d ON d.id_cotizacion = c.id_cotizacion
    LEFT JOIN users u ON u.id_users = d.id_users
    LEFT JOIN users a ON a.id_users = c.id_asesor
   WHERE ${donde}
   ORDER BY c.fecha_creacion DESC, c.id_cotizacion DESC
   LIMIT 60`;

const SQL_USUARIOS_POR_WHATSAPP = `
  SELECT up.id_usuario AS id_users, p.whatsapp
    FROM plataformas p
    INNER JOIN usuario_plataforma up ON up.id_plataforma = p.id_plataforma
    INNER JOIN users u ON u.id_users = up.id_usuario
   WHERE ${COLA_SQL('p.whatsapp')} = ?
     AND u.id_rol IN (${ROLES_ALUMNO.join(', ')})
     AND up.id_plataforma = (SELECT MIN(x.id_plataforma) FROM usuario_plataforma x
                              WHERE x.id_usuario = up.id_usuario)
   LIMIT 20`;

const SQL_MARCAS = `
  SELECT cp.id_cotizacion, cp.codigo, cp.subestado, cp.numero_cajas AS cajas,
         ${F('cp.fecha_recibida', 'fecha_recibida')}
    FROM cotizadorpro_codigo_proveedores cp
   WHERE cp.id_cotizacion IN (?)
   ORDER BY cp.codigo ASC`;

const SQL_CONTENEDORES = `
  SELECT cc.id_cotizacion, ${F('cc.created_at', 'fecha_asignada')},
         cg.id_carga AS id_contenedor, cg.nombre, cg.destino, cg.estado,
         ${F('cg.fecha_cierre', 'fecha_cierre')}, ${F('cg.fecha_estimada', 'fecha_estimada')},
         ${F('cg.fecha_puerto', 'fecha_puerto')},
         ${F('cg.fecha_bodega_destino', 'fecha_bodega_destino')}, cg.nota_cliente
    FROM cotizacion_carga cc
    INNER JOIN cotizadorpro_cargas cg ON cg.id_carga = cc.id_carga
   WHERE cc.id_cotizacion IN (?)
   ORDER BY cg.id_carga ASC`;

const SQL_ENTREGAS = `
  SELECT id_cotizacion, estado, ${F('fecha_entrega', 'fecha_entrega')}
    FROM cotizacion_entregas
   WHERE id_cotizacion IN (?)`;

const ESTADOS_COTIZACION = {
  generado: 'Generada (sin aprobar)',
  aprobado: 'Aprobada',
  contactado: 'Aprobada',
  bodega: 'En bodega de China',
  carga: 'En contenedor',
  proximo: 'Próxima a salir',
  transito: 'En tránsito',
  entregado: 'Entregada',
};

const agrupar = (filas, clave) => {
  const m = new Map();
  for (const f of filas || []) {
    const k = Number(f[clave]);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(f);
  }
  return m;
};

const conLimite = (promesa, ms) =>
  Promise.race([
    promesa,
    new Promise((_, mal) => {
      const t = setTimeout(() => mal(new Error(`sin respuesta en ${ms} ms`)), ms);
      if (t.unref) t.unref();
    }),
  ]);

const VACIO = (estado) => ({ estado, total: 0, cotizaciones: [] });

/**
 * @param {string} telefono  número del chat (lo pone el servidor)
 * @param {object} [o]  { consultar, hoy } — las pruebas pasan datos de mentira
 * @returns {Promise<{estado:string,total:number,cotizaciones:object[]}>}
 *   estado: encontradas | sin_carga | varios_clientes | telefono_no_valido | error
 */
async function historialDelTelefono(telefono, o = {}) {
  const consultar = o.consultar || consultarImporsuit;
  const hoy = o.hoy || hoyEcuador();
  const cola = colaCandidatos(telefono);
  if (!cola) return VACIO('telefono_no_valido');
  try {
    return await conLimite(buscar(telefono, cola, consultar, hoy), o.limite_ms || LIMITE_MS);
  } catch (e) {
    console.warn('[HISTORIAL_CARGAS]', e.message);
    return VACIO('error');
  }
}

async function buscar(telefono, cola, consultar, hoy) {
  const [porCotizacion, usuarios] = await Promise.all([
    consultar(SQL_COTIZACIONES(`${COLA_SQL('d.telefono')} = ?`), [cola]),
    consultar(SQL_USUARIOS_POR_WHATSAPP, [cola]),
  ]);
  const usuariosDelNumero = new Map();
  for (const u of usuarios || []) {
    const como = comoCoincide(telefono, u.whatsapp);
    const id = Number(u.id_users);
    if (como && id && usuariosDelNumero.get(id) !== 'exacto') usuariosDelNumero.set(id, como);
  }
  const idsUsuario = [...usuariosDelNumero.keys()];
  const porUsuario = idsUsuario.length ? await consultar(SQL_COTIZACIONES('d.id_users IN (?)'), [idsUsuario]) : [];

  const pais = paisDelTelefono(telefono);
  const propias = new Map();
  for (const f of porCotizacion || []) {
    if (mismoTelefono(telefono, f.telefono, f.pais_destino)) propias.set(Number(f.id_cotizacion), f);
  }
  for (const f of porUsuario || []) {
    const como = usuariosDelNumero.get(Number(f.id_users));
    if (como === 'exacto' || (como === 'nacional' && paisDeDestino(f.pais_destino) === pais)) propias.set(Number(f.id_cotizacion), f);
  }
  let filas = [...propias.values()].filter((f) => !esCorreoDePrueba(f.email_asesor) && !esCorreoDePrueba(f.email_cliente));
  if (!filas.length) return VACIO('sin_carga');

  const personas = new Set();
  for (const f of filas) {
    if (!f.id_users) continue;
    personas.add(String(f.email_cliente || '').trim().toLowerCase() || `id:${f.id_users}`);
  }
  if (personas.size > 1) return VACIO('varios_clientes');

  filas = filas
    .filter((f) => !SIN_CARGA.includes(String(f.estado || '').trim().toLowerCase()))
    .sort((a, b) => String(b.fecha_creacion || '').localeCompare(String(a.fecha_creacion || '')) || b.id_cotizacion - a.id_cotizacion);
  if (!filas.length) return VACIO('sin_carga');
  const total = filas.length;
  filas = filas.slice(0, MAX_HISTORIAL);
  const ids = filas.map((f) => Number(f.id_cotizacion));

  const [marcas, contenedores, entregas] = await Promise.all([
    consultar(SQL_MARCAS, [ids]),
    consultar(SQL_CONTENEDORES, [ids]),
    consultar(SQL_ENTREGAS, [ids]).catch(() => []),
  ]);
  const marcasDe = agrupar(marcas, 'id_cotizacion');
  const contDe = agrupar(contenedores, 'id_cotizacion');
  const entregaDe = new Map((entregas || []).map((e) => [Number(e.id_cotizacion), e]));

  const cotizaciones = filas.map((f) => {
    const id = Number(f.id_cotizacion);
    const sus = contDe.get(id) || [];
    const cot = {
      id_cotizacion: id,
      estado: f.estado,
      fecha_creacion: f.fecha_creacion,
      destino: f.pais_destino,
      cliente: { nombre: f.cliente },
      marcas: marcasDe.get(id) || [],
      contenedores: sus,
      parcial: sus.length > 0 && String(f.estado || '').toLowerCase() !== 'carga',
      entrega: entregaDe.get(id) || null,
    };
    const e = estadoDeCarga(cot, hoy, {}, { conNombre: false, descartarEstimadaVencida: true });
    const cont = e.contenedor ? sus.find((c) => String(c.nombre) === e.contenedor.nombre) : sus[sus.length - 1];
    const ms = cot.marcas;
    const st = String(f.estado || '').trim().toLowerCase();
    const fCre = fecha(f.fecha_creacion);
    const fEnt = e.entregada ? fecha(cot.entrega?.fecha_entrega) : null;
    return {
      id_cotizacion: id,
      creada: fCre ? fechaTexto(fCre) : null,
      estado: ESTADOS_COTIZACION[st] || st || null,
      destino: { ec: 'Ecuador', mx: 'México' }[paisDeDestino(f.pais_destino)] || '',
      marcas: ms.slice(0, 10).map((m) => String(m.codigo)),
      cajas: ms.reduce((s, m) => s + (Number(m.cajas) || 0), 0) || null,
      marcas_recibidas: ms.filter((m) => m.fecha_recibida).length,
      paso: e.paso || 0,
      paso_nombre: e.paso_nombre || '',
      entregada: !!e.entregada,
      entregada_el: fEnt ? fechaTexto(fEnt) : null,
      parcial: !!e.parcial,
      contenedor: cont ? String(cont.nombre || '') : null,
      contenedores: sus.length,
      llegada_estimada: e.fecha_estimada_vigente ? fechaTexto(e.fecha_estimada_vigente) : null,
      nota_cliente: cont?.nota_cliente ? String(cont.nota_cliente).replace(/\s+/g, ' ').trim().slice(0, 300) : null,
    };
  });
  // Todas son de la misma persona (si no, se devolvió varios_clientes): su
  // nombre de Imporsuit, para saludarla en la plantilla de «Enviar información».
  const cliente = String(filas.find((f) => f.cliente)?.cliente || '').trim() || null;
  return { estado: 'encontradas', total, cliente, cotizaciones };
}

module.exports = { historialDelTelefono, MAX_HISTORIAL };
