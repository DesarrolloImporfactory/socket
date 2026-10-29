/* «Mi carga está con otro número»: buscar por el N.º de cotización, la marca
   de envío o el correo de registro, sin entregar nada de otra persona.

   Tramo 4 del 70 % (27-oct). El 26-oct, 6 casos (113, 140, 182, 206, 208,
   209) escribían desde un teléfono que no era el de su registro: el bot les
   pedía la marca o la cotización y, con el dato en la mano, pasaba el caso a
   una persona. Aquí ese dato se convierte en el DUEÑO (un alumno de
   Imporsuit, `users.id_users`) y, si se prueba que el que escribe es ese
   dueño, ver_mi_carga y ver_mis_pagos buscan con él.

   SOLO LECTURA: usa el mismo adaptador de Imporsuit que cargaCliente (se
   niega a correr lo que no empiece por SELECT).

   SEGURIDAD — por qué un dato solo no basta:
     · El N.º de cotización es correlativo y la marca (EC-25010001) también:
       se adivinan. El correo se consigue. Ninguno prueba solo que el que
       escribe es el dueño.
     · Vale el dueño si se cumple una de dos:
         P1  el WhatsApp del que escribe es UNO de los teléfonos del dueño:
             cualquiera de sus plataformas (no solo la más antigua) o el de
             cualquiera de sus cotizaciones (exacto, o el número nacional sin
             código de país);
         P2  dio su correo Y un N.º de cotización o una marca, y los dos son
             del mismo alumno.
       Si no, se le pide el dato que falta con el MISMO texto exista o no lo
       que escribió: la respuesta no confirma que una cotización o un correo
       existen. Con dos datos de clientes distintos (o uno que no existe):
       «no puedo confirmar» y lo ve una persona.
     · El dato tiene que estar en lo que el cliente escribió en este turno (el
       modelo no puede inventarlo ni sacarlo del historial). Los datos ya
       escritos se recuerdan 30 minutos por número, para juntar el correo de un
       mensaje con la cotización del siguiente.
     · Cada número prueba como mucho MAX_DATOS datos distintos al día (repetir
       el mismo no gasta).
     · Cuentas de prueba, cotizaciones sin alumno y correos de dos alumnos no
       dan dueño.
     · El dueño probado se recuerda 30 minutos por número y lo comparten las
       dos herramientas («¿y cuánto debo?» después de la carga no vuelve a
       pedir nada).
   En memoria del proceso, como `diagnosticoCuenta.datosProbados`: un
   reinicio la vacía y está bien. */

'use strict';

const { consultarImporsuit, esCorreoDePrueba } = require('./cargaCliente');
const { comoCoincide, paisDeDestino } = require('./telefono');
const { sinTildes } = require('./texto');

const ROLES_ALUMNO = [3, 4, 14, 16, 18];
const MAX_DATOS = 3; // datos distintos que un número puede probar por día
const VENTANA_DATOS_MS = 24 * 60 * 60 * 1000;
const MEMORIA_MS = 30 * 60 * 1000; // datos escritos y dueño probado
const LIMPIAR_DESDE = 1000;

const ES_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RE_CORREOS = /[^\s<>()[\],;:"'«»]+@[^\s<>()[\],;:"'«»]+/g;
const RE_MARCA = /\b([A-Z]{2})[ -]?(\d{4,9})\b/gi;

/* ── Qué escribió ─────────────────────────────────────────────────────────── */

const normalizarMarca = (pais, digitos) => `${String(pais).toUpperCase()}-${digitos}`;

/** Lo que pasó el modelo → { tipo: 'correo' | 'marca' | 'cotizacion', valor } o null. */
function leerDato(dato) {
  const t = String(dato || '').trim();
  if (!t) return null;
  if (t.includes('@')) {
    const correo = t.toLowerCase().replace(/^mailto:/, '').replace(/[.]+$/, '');
    return ES_CORREO.test(correo) && correo.length <= 120 ? { tipo: 'correo', valor: correo } : null;
  }
  const m = t.match(/^([A-Za-z]{2})[ -]?(\d{4,9})$/);
  if (m) return { tipo: 'marca', valor: normalizarMarca(m[1], m[2]) };
  const n = sinTildes(t).replace(/^(?:cotizacion|n\.?\s*[ºo°]\.?|nro\.?|no\.?|#)\s*/i, '').trim();
  if (/^\d{3,7}$/.test(n) && Number(n) > 0) return { tipo: 'cotizacion', valor: String(Number(n)) };
  return null;
}

/** Correos y marcas que trae un mensaje (los números sueltos no: «1867» solo
    vale si el modelo lo pasa como dato, porque el bot se lo acaba de pedir). */
function datosEnMensaje(mensaje) {
  const m = String(mensaje || '');
  const correos = (m.toLowerCase().match(RE_CORREOS) || [])
    .map((x) => x.replace(/^mailto:/, '').replace(/[.]+$/, ''))
    .filter((x) => ES_CORREO.test(x));
  const marcas = [...m.matchAll(RE_MARCA)]
    .filter((x) => /^(ec|mx)$/i.test(x[1]) || /-/.test(x[0]))
    .map((x) => normalizarMarca(x[1], x[2]));
  return [
    ...[...new Set(correos)].map((valor) => ({ tipo: 'correo', valor })),
    ...[...new Set(marcas)].map((valor) => ({ tipo: 'marca', valor })),
  ];
}

/** ¿El dato está en lo que escribió el cliente? Completo, con sus bordes. */
function datoEscrito(leido, mensaje) {
  const m = String(mensaje || '');
  if (leido.tipo === 'correo' || leido.tipo === 'marca') {
    return datosEnMensaje(m).some((d) => d.tipo === leido.tipo && d.valor === leido.valor);
  }
  return new RegExp(`(?<![\\d.,])0*${leido.valor}(?![\\d.,]\\d|\\d)`).test(m);
}

/* ── Memoria por número ───────────────────────────────────────────────────── */

const probados = new Map(); // telefono → Map(valor → cuándo)   (tope diario)
const escritos = new Map(); // telefono → Map(clave → { dato, ts }) (30 min)
const duenos = new Map(); // telefono → { idUsuario, ts }

function barrer(mapa, ventana, ahoraMs) {
  if (mapa.size < LIMPIAR_DESDE) return;
  for (const [tel, v] of mapa) {
    if (v instanceof Map) {
      for (const [k, x] of v) if (ahoraMs - (x.ts ?? x) > ventana) v.delete(k);
      if (!v.size) mapa.delete(tel);
    } else if (ahoraMs - v.ts > ventana) mapa.delete(tel);
  }
}

function puedeProbar(telefono, valor, ahoraMs) {
  barrer(probados, VENTANA_DATOS_MS, ahoraMs);
  const propios = probados.get(telefono) || new Map();
  for (const [v, t] of propios) if (ahoraMs - t > VENTANA_DATOS_MS) propios.delete(v);
  if (!propios.has(valor) && propios.size >= MAX_DATOS) return false;
  propios.set(valor, propios.get(valor) || ahoraMs);
  probados.set(telefono, propios);
  return true;
}

function datosRecordados(telefono, ahoraMs) {
  const propios = escritos.get(telefono);
  if (!propios) return [];
  for (const [k, x] of propios) if (ahoraMs - x.ts > MEMORIA_MS) propios.delete(k);
  return [...propios.values()].map((x) => x.dato);
}

function recordarDato(telefono, dato, ahoraMs) {
  barrer(escritos, MEMORIA_MS, ahoraMs);
  const propios = escritos.get(telefono) || new Map();
  propios.set(`${dato.tipo}:${dato.valor}`, { dato, ts: ahoraMs });
  escritos.set(telefono, propios);
}

/** El dueño ya probado para este número (30 min), o null. */
function duenoRecordado(telefono, ahoraMs = Date.now()) {
  const d = duenos.get(String(telefono));
  if (!d || ahoraMs - d.ts > MEMORIA_MS) return null;
  return d.idUsuario;
}

/* ── De quién es cada dato ────────────────────────────────────────────────── */

const SQL_POR_CORREO = `
  SELECT u.id_users, u.email_users
    FROM users u
   WHERE u.email_users = ? AND u.id_rol IN (${ROLES_ALUMNO.join(', ')})
   LIMIT 5`;

const SQL_DUENO_COTIZACION = `
  SELECT d.id_cotizacion, d.id_users, d.pais_destino, u.email_users, u.id_rol
    FROM cotizadorpro_detalle_cot d
    LEFT JOIN users u ON u.id_users = d.id_users
   WHERE d.id_cotizacion IN (?)
   LIMIT 10`;

const SQL_MARCA = `
  SELECT cp.id_cotizacion
    FROM cotizadorpro_codigo_proveedores cp
   WHERE cp.codigo = ?
   LIMIT 5`;

/* Todos los teléfonos del alumno: el WhatsApp de CADA plataforma y el de cada
   cotización suya (P1). */
const SQL_TELEFONOS_PLATAFORMAS = `
  SELECT p.whatsapp AS telefono
    FROM plataformas p
    INNER JOIN usuario_plataforma up ON up.id_plataforma = p.id_plataforma
   WHERE up.id_usuario = ?
   LIMIT 50`;
const SQL_TELEFONOS_COTIZACIONES = `
  SELECT d.telefono
    FROM cotizadorpro_detalle_cot d
   WHERE d.id_users = ?
   LIMIT 200`;

/** Un solo alumno (no de prueba) entre las filas, o null. */
function unAlumno(filas) {
  const ids = new Set();
  for (const f of filas || []) {
    const id = Number(f.id_users);
    if (!id) return null; // una cotización sin alumno no da dueño
    if (esCorreoDePrueba(f.email_users)) return null;
    if (f.id_rol !== undefined && f.id_rol !== null && !ROLES_ALUMNO.includes(Number(f.id_rol))) return null;
    ids.add(id);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

async function duenoDeCotizacion(ids, consultar, pais = null) {
  const filas = ((await consultar(SQL_DUENO_COTIZACION, [ids])) || []).filter(
    (f) => !pais || paisDeDestino(f.pais_destino) === pais,
  );
  return filas.length ? unAlumno(filas) : null;
}

/** id_users del dueño de un dato, o null (no existe, es ambiguo o de prueba). */
async function duenoDe(dato, consultar) {
  if (dato.tipo === 'correo') return unAlumno(await consultar(SQL_POR_CORREO, [dato.valor]));
  if (dato.tipo === 'cotizacion') return duenoDeCotizacion([Number(dato.valor)], consultar);
  // Marca: primero como código de marca; si no existe y es corta, «MX-002026»
  // es la cotización 2026 hacia México (así la escriben algunos alumnos).
  const cps = (await consultar(SQL_MARCA, [dato.valor])) || [];
  const ids = [...new Set(cps.map((c) => Number(c.id_cotizacion)).filter(Boolean))];
  if (ids.length) return duenoDeCotizacion(ids, consultar);
  const [pref, digitos] = dato.valor.split('-');
  const pais = paisDeDestino(pref);
  if (pais && digitos.length <= 7 && Number(digitos) > 0) return duenoDeCotizacion([Number(digitos)], consultar, pais);
  return null;
}

async function telefonoEsDelDueno(telefono, idUsuario, consultar) {
  const [plats, cots] = await Promise.all([
    consultar(SQL_TELEFONOS_PLATAFORMAS, [idUsuario]),
    consultar(SQL_TELEFONOS_COTIZACIONES, [idUsuario]),
  ]);
  return [...(plats || []), ...(cots || [])].some((f) => Boolean(comoCoincide(telefono, f.telefono)));
}

/**
 * ¿De quién es lo que escribió el cliente, y es él?
 *
 * @param {string} telefono  WhatsApp del que escribe (lo entrega Meta)
 * @param {object} o
 * @param {string} [o.dato]     lo que pasó el modelo (cotización, marca o correo)
 * @param {string} [o.mensaje]  lo que escribió el cliente en este turno
 * @param {Function} [o.consultar]
 * @param {number} [o.ahora]    ms, solo para pruebas
 * @returns {Promise<{estado: string, idUsuario?: number, por?: string, falta?: string}>}
 *   estado: verificado | sin_dato | pide_otro | no_coincide | dato_invalido |
 *           dato_no_escrito | limite | error
 *   por (verificado): telefono | dos_datos | memoria
 *   falta (pide_otro): correo | cotizacion
 */
async function duenoPorDato(telefono, o = {}) {
  const consultar = o.consultar || consultarImporsuit;
  const ahora = Number(o.ahora) || Date.now();
  const tel = String(telefono || '');
  const recordado = duenoRecordado(tel, ahora);

  // 1. Los datos de este turno: el que pasó el modelo y los que trae el mensaje.
  const nuevos = [];
  if (String(o.dato || '').trim()) {
    const leido = leerDato(o.dato);
    if (!leido) return { estado: 'dato_invalido' };
    if (!datoEscrito(leido, o.mensaje)) return { estado: 'dato_no_escrito' };
    nuevos.push(leido);
  }
  for (const d of datosEnMensaje(o.mensaje)) {
    if (!nuevos.some((x) => x.tipo === d.tipo && x.valor === d.valor)) nuevos.push(d);
  }
  if (!nuevos.length) {
    if (recordado) return { estado: 'verificado', idUsuario: recordado, por: 'memoria' };
    return { estado: 'sin_dato' };
  }
  const anteriores = datosRecordados(tel, ahora).filter((d) => !nuevos.some((x) => x.tipo === d.tipo && x.valor === d.valor));
  for (const d of nuevos) {
    if (!puedeProbar(tel, `${d.tipo}:${d.valor}`, ahora)) return { estado: 'limite' };
    recordarDato(tel, d, ahora);
  }

  // 2. De quién es cada uno.
  let datos;
  try {
    datos = await Promise.all([...nuevos, ...anteriores].map(async (d) => ({ ...d, id: await duenoDe(d, consultar) })));
  } catch (err) {
    return { estado: 'error', motivo: String(err?.message || err) };
  }
  const resueltos = datos.filter((d) => d.id);
  const ids = [...new Set(resueltos.map((d) => d.id))];
  const hayCorreo = datos.some((d) => d.tipo === 'correo');
  const hayCodigo = datos.some((d) => d.tipo !== 'correo');
  const falta = hayCorreo ? 'cotizacion' : 'correo';

  // 3. ¿Es él?
  if (ids.length > 1) return { estado: 'no_coincide' };
  if (ids.length === 1) {
    const id = ids[0];
    const porDosDatos =
      resueltos.some((d) => d.tipo === 'correo') && resueltos.some((d) => d.tipo !== 'correo');
    let por = porDosDatos ? 'dos_datos' : null;
    if (!por) {
      try {
        if (await telefonoEsDelDueno(tel, id, consultar)) por = 'telefono';
      } catch (err) {
        return { estado: 'error', motivo: String(err?.message || err) };
      }
    }
    if (por) {
      duenos.set(tel, { idUsuario: id, ts: ahora });
      return { estado: 'verificado', idUsuario: id, por };
    }
  }
  // Sin prueba. Con los dos tipos de dato ya dados, no hay más que pedir.
  if (hayCorreo && hayCodigo) return { estado: 'no_coincide' };
  return { estado: 'pide_otro', falta };
}

/* ── Lo que se le dice al modelo cuando no se pudo buscar con el dato ──────
   Un texto por estado; ninguno dice si el dato existe. */
function bloqueSinDueno(r, { area = 'logística', TX }) {
  const cab = '🔐 BÚSQUEDA CON EL DATO QUE ESCRIBIÓ — sin entregar nada de otra persona';
  switch (r.estado) {
    case 'pide_otro':
      return `${cab}: todavía no se puede confirmar que ese dato es suyo. No digas si la cotización, la marca o el correo existen. Responde exactamente: ${r.falta === 'correo' ? TX.MENSAJE_DATO_PIDE_CORREO : TX.MENSAJE_DATO_PIDE_CODIGO}`;
    case 'dato_invalido':
    case 'dato_no_escrito':
      return `${cab}: el dato no se pudo leer o no está en lo que escribió. Pídele que escriba aquí su número de cotización, su marca de envío o el correo con el que se registró, tal cual. No inventes ni completes datos.`;
    case 'no_coincide':
      return `${cab}: con esos datos no se puede confirmar su cuenta. No digas cuál de los datos falla ni si existen. Responde exactamente: ${area === 'cobranza' ? TX.MENSAJE_DATO_NO_COINCIDE_PAGOS : TX.MENSAJE_DATO_NO_COINCIDE}`;
    case 'limite':
      return `${cab}: ya probó varios datos hoy. No busques más. Responde exactamente: ${area === 'cobranza' ? TX.MENSAJE_DATO_NO_COINCIDE_PAGOS : TX.MENSAJE_DATO_NO_COINCIDE}`;
    default:
      return `${cab}: NO SE PUDO CONSULTAR. No digas ningún estado ni monto: usa pasar_a_humano.`;
  }
}

module.exports = {
  duenoPorDato,
  duenoRecordado,
  bloqueSinDueno,
  leerDato,
  datosEnMensaje,
  datoEscrito,
  MAX_DATOS,
  // para las pruebas
  olvidarTodo: () => {
    probados.clear();
    escritos.clear();
    duenos.clear();
  },
};
