/* «¿Dónde está mi carga?» con datos reales, para el bot de soporte de Expertos.

   Con el teléfono de WhatsApp del que escribe —y SOLO con ese dato— busca sus
   cotizaciones en el sistema de cargas de Imporsuit (segunda conexión, `db_2`)
   y dice en qué paso va cada una, con las reglas de `estadoCarga.js` (las
   mismas del portal «Mi puesto»).

   SOLO LECTURA: este archivo no tiene un solo INSERT, UPDATE ni DELETE, y el
   adaptador de consulta se niega a ejecutar cualquier cosa que no empiece por
   SELECT.

   SEGURIDAD — de quién es la carga:
     · La búsqueda entra por el número de WhatsApp del remitente, que lo
       entrega Meta. Un número, una marca de envío o una cotización que
       alguien ESCRIBA en el chat no se busca aquí: quien pide «la carga del
       099…» o «la marca EC-…» de otra persona no recibe nada.
     · La única otra entrada es `cargasDelDueno`: un alumno que
       identidadPorDato.js ya probó que es el que escribe (su WhatsApp es uno
       de los teléfonos del alumno, o dio su correo y una cotización o marca
       del mismo alumno). Tramo 4 del 70 %, 27-oct.
     · La cola de 9 dígitos solo trae candidatos; cada uno se confirma con
       `mismoTelefono` (número completo, con su código de país).
     · Si el mismo número aparece en cotizaciones de dos clientes distintos, no
       se informa ninguna: lo ve una persona.
     · No se leen ni se devuelven montos, saldos ni pagos.

   QUÉ ES UNA CARGA EN CURSO: una cotización que ya subió a un contenedor, o
   una que alguien aceptó y de la que la bodega de China ya recibió algo. Una
   cotización recién generada, o aprobada pero sin nada recibido, todavía no
   viaja: no se lista. Si no queda ninguna, el bot responde «sin carga» y el
   caso pasa a logística. (En la prueba con conversaciones reales, 21 de las
   44 «cargas» leídas eran cotizaciones de ese tipo, una de marzo.)

   REGLA DE ORO: sin fecha en el dato, no hay fecha. Una fecha estimada que ya
   pasó tampoco se nombra. Un contenedor que lleva más de 30 días «asignado»
   sin salir no se informa (el estado del sistema puede estar viejo), ni una
   carga repartida en varios contenedores. */

'use strict';

const { estadoDeCarga, hoyEcuador, fecha, fechaTexto, diasEntre, SIN_CARGA } = require('./estadoCarga');
const { mismoTelefono, comoCoincide, colaCandidatos, paisDeDestino, paisDelTelefono } = require('./telefono');
const { sinTildes } = require('./texto');

const MAX_CARGAS = 4; // las que se le cuentan al cliente en un mensaje
const MAX_CANDIDATAS = 40; // cotizaciones de un mismo número que se revisan
const LIMITE_MS = 8000; // la consulta no puede dejar al cliente esperando
const DIAS_ENTREGADA = 45; // una entrega más vieja ya no es «mi carga»
const DIAS_COTIZACION_SIN_AVANZAR = 60;
const DIAS_EN_BODEGA_SIN_ENTREGA = 90;

/* Los últimos 9 dígitos de un teléfono guardado. Con REGEXP_REPLACE (MySQL 8,
   como ya hace utils/membresiaImporsuit sobre esta base); si la base no lo
   tiene, con la cadena de REPLACE que usa el PHP de Imporsuit. */
const COLA_SQL = (col, conRegexp = true) =>
  conRegexp
    ? `RIGHT(REGEXP_REPLACE(COALESCE(${col}, ''), '[^0-9]', ''), 9)`
    : `RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col}, ''), ' ', ''), '+', ''), '-', ''), '(', ''), ')', ''), '.', ''), '/', ''), 9)`;

/* Roles de cliente en Imporsuit (PuestoModel::ROLES_ALUMNO). Una cuenta del
   equipo no entra por el camino del WhatsApp de su plataforma. */
const ROLES_ALUMNO = [3, 4, 14, 16, 18];
const F = (col, alias) => `DATE_FORMAT(${col}, '%Y-%m-%d') AS ${alias}`;

const SQL_COTIZACIONES = (donde) => `
  SELECT c.id_cotizacion, c.estado, c.subestado, ${F('c.fecha_creacion', 'fecha_creacion')},
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

/* El teléfono de un alumno no vive en `users`: es el WhatsApp de su plataforma
   más antigua (mismo criterio que PuestoModel::alumnos de Imporsuit). */
const SQL_USUARIOS_POR_WHATSAPP = (conRegexp) => `
  SELECT up.id_usuario AS id_users, p.whatsapp
    FROM plataformas p
    INNER JOIN usuario_plataforma up ON up.id_plataforma = p.id_plataforma
    INNER JOIN users u ON u.id_users = up.id_usuario
   WHERE ${COLA_SQL('p.whatsapp', conRegexp)} = ?
     AND u.id_rol IN (${ROLES_ALUMNO.join(', ')})
     AND up.id_plataforma = (SELECT MIN(x.id_plataforma) FROM usuario_plataforma x
                              WHERE x.id_usuario = up.id_usuario)
   LIMIT 20`;

/* El correo de alumno detrás de un WhatsApp: el de CUALQUIERA de sus
   plataformas (como P1 de identidadPorDato). Lo usa revisar_mi_imporchat
   para hallar la cuenta de IMPORCHAT registrada con otro número. */
const SQL_CORREOS_POR_WHATSAPP = (conRegexp) => `
  SELECT u.email_users AS email, p.whatsapp
    FROM plataformas p
    INNER JOIN usuario_plataforma up ON up.id_plataforma = p.id_plataforma
    INNER JOIN users u ON u.id_users = up.id_usuario
   WHERE ${COLA_SQL('p.whatsapp', conRegexp)} = ?
     AND u.id_rol IN (${ROLES_ALUMNO.join(', ')})
   LIMIT 20`;

const SQL_MARCAS = `
  SELECT cp.id_cotizacion, cp.codigo, cp.subestado, cp.numero_cajas AS cajas,
         ${F('cp.fecha_recibida', 'fecha_recibida')}
    FROM cotizadorpro_codigo_proveedores cp
   WHERE cp.id_cotizacion IN (?)
   ORDER BY cp.codigo ASC`;

/* `conSeguimiento` = columnas de la migración del packing (fecha de llegada a
   la bodega de destino y la novedad que puede leer el cliente). Si la base
   todavía no las tiene se consulta sin ellas, como hace Imporsuit. */
const SQL_CONTENEDORES = (conSeguimiento) => `
  SELECT cc.id_cotizacion, ${F('cc.created_at', 'fecha_asignada')},
         cg.id_carga AS id_contenedor, cg.nombre, cg.destino, cg.estado,
         ${F('cg.fecha_cierre', 'fecha_cierre')}, ${F('cg.fecha_estimada', 'fecha_estimada')},
         ${F('cg.fecha_puerto', 'fecha_puerto')},
         ${
           conSeguimiento
             ? `${F('cg.fecha_bodega_destino', 'fecha_bodega_destino')}, cg.nota_cliente, ${F('cg.nota_cliente_at', 'nota_cliente_fecha')}`
             : 'NULL AS fecha_bodega_destino, NULL AS nota_cliente, NULL AS nota_cliente_fecha'
         }
    FROM cotizacion_carga cc
    INNER JOIN cotizadorpro_cargas cg ON cg.id_carga = cc.id_carga
   WHERE cc.id_cotizacion IN (?)
   ORDER BY cg.id_carga ASC`;

/* Desde cuándo existe cada contenedor: su alta o la primera cotización que se
   le subió, lo más viejo (PuestoModel::abiertoDesde). */
const SQL_ABIERTO_DESDE = `
  SELECT c.id_carga AS id_contenedor,
         DATE_FORMAT(LEAST(c.fecha_creada,
                COALESCE((SELECT MIN(cc.created_at) FROM cotizacion_carga cc
                           WHERE cc.id_carga = c.id_carga), c.fecha_creada)), '%Y-%m-%d') AS desde
    FROM cotizadorpro_cargas c
   WHERE c.id_carga IN (?)`;

const SQL_ENTREGAS = `
  SELECT id_cotizacion, estado, ${F('fecha_entrega', 'fecha_entrega')}
    FROM cotizacion_entregas
   WHERE id_cotizacion IN (?)`;

/** Consulta de solo lectura a la base de Imporsuit. Se carga recién al usarla
    para que las pruebas locales no necesiten la base. */
async function consultarImporsuit(sql, replacements = []) {
  if (!/^\s*select\b/i.test(sql) || /;\s*\S/.test(sql)) {
    throw new Error('cargaCliente: solo se permiten consultas SELECT');
  }
  // eslint-disable-next-line global-require
  const { db_2 } = require('../../database/config');
  return db_2.query(sql, { replacements, type: db_2.QueryTypes.SELECT });
}

/* ── Cuentas de prueba (Class/CuentasPrueba.php de Imporsuit) ─────────────── */
const CORREOS_PRUEBA = [
  'jeimyjara@hotmail.com', 'mpcegames@gmail.com', 'desarrollo1@imporfactoryusa.com',
  'desarrollo1imporfactory@gmail.com', 'desarrollo2imporfactory@gmail.com',
  'desarrollo3imporfactory@gmail.com', 'desarrollo4imporfactory@gmail.com',
  'jeimypruebas@gmail.com', 'jeimypruebas2@gmail.com', 'jeimymotor@gmail.com',
  'jjara@impewqeorfactorylatam.com', 'sebasdev@gmail.com',
];
const BASES_PRUEBA = ['jeimyjara', 'mpcegames'];
const contieneEnOrden = (pajar, aguja) => {
  let i = 0;
  for (let j = 0; j < pajar.length && i < aguja.length; j++) if (pajar[j] === aguja[i]) i++;
  return i === aguja.length;
};
function esCorreoDePrueba(correo) {
  const c = String(correo || '').trim().toLowerCase();
  if (!c) return false;
  if (CORREOS_PRUEBA.includes(c)) return true;
  if (/^desarrollo.*imporfactory/.test(c)) return true;
  const esqueleto = (c.split('@')[0] || '').replace(/[^a-z]/g, '');
  if (!esqueleto) return false;
  return BASES_PRUEBA.some(
    (base) =>
      esqueleto === base ||
      contieneEnOrden(esqueleto, base) ||
      (esqueleto.length >= 7 && contieneEnOrden(base, esqueleto)),
  );
}

/** Correos de alumno (en minúsculas, sin cuentas de prueba) cuya plataforma
    tiene EXACTO este WhatsApp. Un número guardado sin código de país no vale. */
async function correosDelWhatsapp(telefono, { consultar = consultarImporsuit } = {}) {
  const cola = colaCandidatos(telefono);
  if (!cola) return [];
  const filas = await consultar(SQL_CORREOS_POR_WHATSAPP(true), [cola]).catch((e) => {
    if (!/regexp_replace|function .* does not exist/i.test(String(e.message))) throw e;
    return consultar(SQL_CORREOS_POR_WHATSAPP(false), [cola]);
  });
  const correos = (filas || [])
    .filter((f) => comoCoincide(telefono, f.whatsapp) === 'exacto')
    .map((f) => String(f.email || '').trim().toLowerCase())
    .filter((c) => c && !esCorreoDePrueba(c));
  return [...new Set(correos)];
}

const conLimite = (promesa, ms) =>
  Promise.race([
    promesa,
    new Promise((_, rechazar) => {
      const t = setTimeout(() => rechazar(new Error(`sin respuesta en ${ms} ms`)), ms);
      if (t.unref) t.unref();
    }),
  ]);

const agrupar = (filas, clave) => {
  const m = new Map();
  for (const f of filas || []) {
    const k = Number(f[clave]);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(f);
  }
  return m;
};

const nombrePais = (destino) => ({ ec: 'Ecuador', mx: 'México' })[paisDeDestino(destino)] || '';

/* ¿Sigue siendo «mi carga» o ya es historia? Lo dudoso se trata como historia:
   mostrar de menos manda el caso a una persona; mostrar de más le cuenta al
   cliente algo que ya no es cierto. */
function esHistorica(cot, estado, hoy) {
  const ant = (f) => (f ? diasEntre(f, hoy) : null);
  if (estado.entregada) {
    const dias = ant(fecha(cot.entrega?.fecha_entrega));
    return dias === null || dias > DIAS_ENTREGADA;
  }
  if (String(cot.estado || '').toLowerCase() === 'entregado') return true;
  if (estado.paso === 7 && String(estado.contenedor?.estado || '').toLowerCase() === 'finalizado') {
    const cont = (cot.contenedores || []).find((c) => String(c.nombre) === estado.contenedor.nombre);
    const dias = ant(fecha(cont?.fecha_bodega_destino) ?? fecha(cont?.fecha_asignada));
    return dias === null || dias > DIAS_EN_BODEGA_SIN_ENTREGA;
  }
  // Sin nada recibido en China ni contenedor: vence esté en el estado que esté
  // (antes solo vencían las `generado`; una `bodega` de marzo no vencía nunca).
  if (estado.paso === 1) {
    const dias = ant(fecha(cot.fecha_creacion));
    return dias === null || dias > DIAS_COTIZACION_SIN_AVANZAR;
  }
  return false;
}

/* Estados en los que alguien ya aceptó la cotización: los mismos que Imporsuit
   trata como «aceptados» (CotizadorproModel). `generado` no está: es una
   cotización que nadie aprobó todavía. Un estado que no se conoce tampoco. */
const ACEPTADAS = ['aprobado', 'contactado', 'bodega', 'carga', 'proximo', 'transito', 'entregado'];

/* ¿La cotización está de verdad en el flujo de carga? Solo si ya subió a un
   contenedor (paso 3 en adelante), o si alguien la aceptó Y la bodega de China
   ya recibió al menos una de sus marcas (paso 2). El paso 1 —cotización
   registrada, nada recibido— no es una carga: decirle «tu cotización está
   registrada; todavía no llega a China» a quien pregunta por su mercadería
   tapa la carga que sí viaja y puede contradecir lo que le dijo su asesor.
   Ante la duda se muestra de menos: el caso lo ve una persona. */
function enFlujo(cot, estado) {
  if (estado.paso >= 3) return true;
  return estado.paso === 2 && ACEPTADAS.includes(String(cot.estado || '').trim().toLowerCase());
}

const VACIO = (estado, motivo) => ({
  estado,
  motivo,
  cargas: [],
  hay_mas: 0,
  preparacion: [],
  propias: { cotizaciones: [], marcas: [] },
});

/* Cotizaciones que todavía NO viajan (paso 1, de los últimos 60 días): no son
   una carga, pero «¿en qué va mi importación?» tiene respuesta. Tramo 2 del
   70 % (27-oct): 13 de las 117 escalas del lunes eran de cotizaciones así.
   Solo dos casos con texto; lo demás no se informa. */
const MAX_PREPARACION = 3;
function enPreparacion(cot, estado) {
  const st = String(cot.estado || '').trim().toLowerCase();
  const n = `Tu cotización N.º ${cot.id_cotizacion}`;
  if (st === 'generado') return `${n} está lista y falta que la apruebes para avanzar.`;
  if (ACEPTADAS.includes(st) && estado.recepcion.recibidas === 0) {
    return estado.recepcion.marcas > 0
      ? `${n} está aprobada y todavía no llega nada a nuestra bodega de Yiwu (China). Confirma con tu proveedor que envíe las cajas con tu marca de envío.`
      : `${n} está aprobada y todavía no llega nada a nuestra bodega de Yiwu (China).`;
  }
  return null;
}

/**
 * Las cargas en curso del número de WhatsApp que escribe.
 *
 * @param {string} telefono  número del remitente, como lo entrega Meta
 * @param {object} [o]
 * @param {(sql:string, replacements:any[])=>Promise<object[]>} [o.consultar]
 *        consulta de solo lectura (por defecto, la base de Imporsuit). Las
 *        pruebas pasan aquí datos de mentira.
 * @param {string} [o.hoy]  AAAA-MM-DD, solo para pruebas
 * @returns {Promise<{estado:string, motivo:string, cargas:object[], hay_mas:number,
 *                    propias:{cotizaciones:number[], marcas:string[]}}>}
 *   estado: encontradas | sin_carga | solo_historicas | varios_clientes |
 *           telefono_no_valido | error
 */
async function cargasDelTelefono(telefono, o = {}) {
  const consultar = o.consultar || consultarImporsuit;
  const hoy = o.hoy || hoyEcuador();
  const cola = colaCandidatos(telefono);
  if (!cola) return VACIO('telefono_no_valido', 'el número del remitente no sirve para buscar');

  try {
    return await conLimite(buscar(telefono, cola, consultar, hoy), o.limite_ms || LIMITE_MS);
  } catch (err) {
    return VACIO('error', `no se pudo consultar: ${err.message}`);
  }
}

/**
 * Las cargas en curso de un alumno ya identificado por identidadPorDato.js
 * (nunca un id que venga del modelo o del chat). Mismo resultado que
 * `cargasDelTelefono`, con `por: 'dato'`.
 */
async function cargasDelDueno(idUsuario, o = {}) {
  const consultar = o.consultar || consultarImporsuit;
  const hoy = o.hoy || hoyEcuador();
  const id = Number(idUsuario);
  if (!id) return { ...VACIO('error', 'sin alumno identificado'), por: 'dato' };
  try {
    const r = await conLimite(
      (async () => armar(await consultar(SQL_COTIZACIONES('d.id_users = ?'), [id]), consultar, hoy))(),
      o.limite_ms || LIMITE_MS,
    );
    return { ...r, por: 'dato' };
  } catch (err) {
    return { ...VACIO('error', `no se pudo consultar: ${err.message}`), por: 'dato' };
  }
}

async function buscar(telefono, cola, consultar, hoy) {
  // 1. Candidatas por el teléfono de la cotización y por el WhatsApp del alumno.
  const candidatas = (conRegexp) =>
    Promise.all([
      consultar(SQL_COTIZACIONES(`${COLA_SQL('d.telefono', conRegexp)} = ?`), [cola]),
      consultar(SQL_USUARIOS_POR_WHATSAPP(conRegexp), [cola]),
    ]);
  const [porCotizacion, usuarios] = await candidatas(true).catch((e) => {
    if (!/regexp_replace|function .* does not exist/i.test(String(e.message))) throw e;
    return candidatas(false);
  });
  // id del usuario → 'exacto' | 'nacional' (cómo coincide el WhatsApp de su plataforma)
  const usuariosDelNumero = new Map();
  for (const u of usuarios || []) {
    const como = comoCoincide(telefono, u.whatsapp);
    const id = Number(u.id_users);
    if (como && id && usuariosDelNumero.get(id) !== 'exacto') usuariosDelNumero.set(id, como);
  }
  const idsUsuario = [...usuariosDelNumero.keys()];
  const porUsuario = idsUsuario.length
    ? await consultar(SQL_COTIZACIONES('d.id_users IN (?)'), [idsUsuario])
    : [];

  // 2. Confirmar una por una que el número es el mismo, completo.
  const paisDelQueEscribe = paisDelTelefono(telefono);
  const propias = new Map();
  for (const f of porCotizacion || []) {
    if (mismoTelefono(telefono, f.telefono, f.pais_destino)) propias.set(Number(f.id_cotizacion), f);
  }
  for (const f of porUsuario || []) {
    const como = usuariosDelNumero.get(Number(f.id_users));
    /* WhatsApp del alumno guardado sin código de país: solo valen sus
       cotizaciones hacia el país del que escribe (misma regla que arriba). */
    const vale = como === 'exacto' || (como === 'nacional' && paisDeDestino(f.pais_destino) === paisDelQueEscribe);
    if (vale) propias.set(Number(f.id_cotizacion), f);
  }
  return armar([...propias.values()], consultar, hoy);
}

/* Pasos 3 a 6 con las cotizaciones que ya se sabe que son del que escribe. */
async function armar(propiasFilas, consultar, hoy) {
  let filas = (propiasFilas || []).filter(
    (f) => !esCorreoDePrueba(f.email_asesor) && !esCorreoDePrueba(f.email_cliente),
  );
  if (!filas.length) return VACIO('sin_carga', 'ninguna cotización suya');

  // 3. Un mismo número en cotizaciones de dos clientes distintos: no se informa.
  const personas = new Map();
  for (const f of filas) {
    if (!f.id_users) continue;
    const clave = String(f.email_cliente || '').trim().toLowerCase() || sinTildes(f.cliente).trim() || `id:${f.id_users}`;
    const nombre = sinTildes(f.cliente).trim();
    const yaEsta = [...personas.values()].some((p) => p.clave === clave || (nombre && p.nombre === nombre));
    if (!yaEsta) personas.set(Number(f.id_users), { clave, nombre });
  }
  if (personas.size > 1) {
    return VACIO('varios_clientes', `el número aparece en cotizaciones de ${personas.size} clientes`);
  }

  // 4. Lo que todavía no es (o ya no es) una carga no se cuenta.
  const todasLasPropias = filas.map((f) => Number(f.id_cotizacion));
  filas = filas
    .filter((f) => !SIN_CARGA.includes(String(f.estado || '').trim().toLowerCase()))
    .slice(0, MAX_CANDIDATAS);
  if (!filas.length) {
    // El borrador todavía puede aprobarse: cuenta para el shipping mark («aún no está aprobada»).
    const borradores = (propiasFilas || [])
      .filter((f) => String(f.estado || '').trim().toLowerCase() === 'borrador' && todasLasPropias.includes(Number(f.id_cotizacion)))
      .map((f) => ({ id_cotizacion: Number(f.id_cotizacion), fecha_creacion: fecha(f.fecha_creacion), estado: 'borrador', aprobada: false, marcas: [] }))
      .sort((a, b) => String(b.fecha_creacion || '').localeCompare(String(a.fecha_creacion || '')) || b.id_cotizacion - a.id_cotizacion);
    return {
      ...VACIO('sin_carga', 'solo cotizaciones en borrador, anuladas o rechazadas'),
      propias: { cotizaciones: todasLasPropias, marcas: [], detalle: borradores },
    };
  }
  const ids = filas.map((f) => Number(f.id_cotizacion));

  // 5. Marcas, contenedores y entregas de esas cotizaciones.
  const [marcas, contenedores, entregas] = await Promise.all([
    consultar(SQL_MARCAS, [ids]),
    consultar(SQL_CONTENEDORES(true), [ids]).catch((e) => {
      if (!/unknown column/i.test(String(e.message))) throw e;
      return consultar(SQL_CONTENEDORES(false), [ids]);
    }),
    consultar(SQL_ENTREGAS, [ids]).catch(() => []), // la tabla puede no existir todavía
  ]);
  const idsContenedor = [...new Set((contenedores || []).map((c) => Number(c.id_contenedor)).filter(Boolean))];
  const abierto = idsContenedor.length ? await consultar(SQL_ABIERTO_DESDE, [idsContenedor]) : [];
  const abiertoDesde = {};
  for (const a of abierto || []) if (a.desde) abiertoDesde[Number(a.id_contenedor)] = String(a.desde);

  const marcasDe = agrupar(marcas, 'id_cotizacion');
  const contDe = agrupar(contenedores, 'id_cotizacion');
  const entregaDe = new Map((entregas || []).map((e) => [Number(e.id_cotizacion), e]));

  // 6. Estado de cada una, con la regla del portal. Solo quedan las que están
  //    en el flujo de carga; las entregadas hace rato y las que nunca avanzaron, no.
  const activas = [];
  let historicas = 0;
  let fueraDeFlujo = 0;
  const preparacion = [];
  const detalle = [];
  for (const f of filas) {
    const id = Number(f.id_cotizacion);
    const susContenedores = contDe.get(id) || [];
    const cot = {
      id_cotizacion: id,
      estado: f.estado,
      fecha_creacion: f.fecha_creacion,
      destino: f.pais_destino,
      cliente: { nombre: f.cliente },
      marcas: marcasDe.get(id) || [],
      contenedores: susContenedores,
      parcial: susContenedores.length > 0 && String(f.estado || '').toLowerCase() !== 'carga',
      entrega: entregaDe.get(id) || null,
    };
    const e = estadoDeCarga(cot, hoy, abiertoDesde, { conNombre: false, descartarEstimadaVencida: true });
    if (e.paso === 0) continue;
    if (esHistorica(cot, e, hoy)) {
      historicas++;
      continue;
    }
    // Para el shipping mark (marcaEnvio.js): estado y marcas de cada una que sigue viva.
    detalle.push({
      id_cotizacion: id,
      fecha_creacion: fecha(f.fecha_creacion),
      estado: String(f.estado || '').trim().toLowerCase(),
      aprobada: ACEPTADAS.includes(String(f.estado || '').trim().toLowerCase()),
      marcas: cot.marcas.map((m) => String(m.codigo).toUpperCase()),
    });
    if (!enFlujo(cot, e)) {
      fueraDeFlujo++;
      const texto = enPreparacion(cot, e);
      if (texto) preparacion.push({ id_cotizacion: id, fecha_creacion: fecha(f.fecha_creacion), estado: String(f.estado || ''), texto_cliente: texto });
      continue;
    }

    /* Cuándo NO se informa aunque haya dato. Son los casos en que el portal le
       pone un aviso al asesor para que lo interprete o lo confirme antes de
       hablar; el bot no puede hacer eso, así que lo ve una persona:
         - dato_dudoso         contenedor «asignado» hace más de 30 días
         - varios_contenedores la carga va repartida: «está en tránsito» sería
                               cierto solo para una parte
       (La cotización sin marcas registradas ya no llega hasta aquí: sin nada
       recibido en China no está en el flujo.) */
    const repartida = e.otros_contenedores.length > 0 && !e.entregada;
    const motivo = e.dato_dudoso ? 'dato_dudoso' : repartida ? 'varios_contenedores' : null;
    const cont = e.contenedor ? susContenedores.find((c) => String(c.nombre) === e.contenedor.nombre) : null;
    const nota = !motivo && !e.entregada ? String(cont?.nota_cliente || '').replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    const notaFecha = nota ? fecha(cont?.nota_cliente_fecha) : null;

    let texto = motivo ? null : e.texto_cliente;
    if (texto && nota) {
      texto += ` Última novedad registrada${notaFecha ? ` (${fechaTexto(notaFecha)})` : ''}: ${nota}${/[.!?…]$/.test(nota) ? '' : '.'}`;
    }

    activas.push({
      id_cotizacion: id,
      fecha_creacion: fecha(f.fecha_creacion),
      destino: nombrePais(f.pais_destino),
      marcas: cot.marcas.map((m) => String(m.codigo)),
      paso: e.paso,
      paso_nombre: e.paso_nombre,
      entregada: e.entregada,
      parcial: e.parcial,
      contenedor: e.contenedor ? e.contenedor.nombre : null,
      otros_contenedores: e.otros_contenedores,
      fecha_estimada: e.fecha_estimada_vigente,
      fecha_estimada_texto: e.fecha_estimada_vigente ? fechaTexto(e.fecha_estimada_vigente) : null,
      estimada_vencida: e.estimada_vencida,
      marcas_pendientes: e.recepcion.pendientes,
      nota_cliente: nota || null,
      nota_cliente_fecha: notaFecha,
      informable: !motivo,
      motivo,
      texto_cliente: texto,
    });
  }

  const propiasOut = {
    cotizaciones: todasLasPropias,
    marcas: [...new Set((marcas || []).map((m) => String(m.codigo).toUpperCase()))],
    detalle: detalle.sort((a, b) => String(b.fecha_creacion || '').localeCompare(String(a.fecha_creacion || '')) || b.id_cotizacion - a.id_cotizacion),
  };
  preparacion.sort((a, b) => String(b.fecha_creacion || '').localeCompare(String(a.fecha_creacion || '')) || b.id_cotizacion - a.id_cotizacion);
  const prep = preparacion.slice(0, MAX_PREPARACION);
  if (!activas.length) {
    /* Nada en curso. Para el cliente es lo mismo («no encuentro una carga en
       curso» y pasa a logística); el estado solo distingue si lo que hay es
       historia o son cotizaciones que todavía no viajan. */
    return historicas
      ? { ...VACIO('solo_historicas', 'solo cargas entregadas o cotizaciones antiguas'), preparacion: prep, propias: propiasOut }
      : {
          ...VACIO('sin_carga', `solo cotizaciones que todavía no están en el flujo de carga (${fueraDeFlujo}): sin nada recibido en China y sin contenedor`),
          preparacion: prep,
          propias: propiasOut,
        };
  }

  /* Lo que sigue en camino antes que lo entregado; dentro de eso, primero lo
     que se puede informar; después lo más avanzado (una carga en aduana antes
     que una que recién llega a China) y, a igual paso, lo más reciente. */
  activas.sort(
    (a, b) =>
      Number(a.entregada) - Number(b.entregada) ||
      Number(!a.informable) - Number(!b.informable) ||
      (b.paso || 0) - (a.paso || 0) ||
      String(b.fecha_creacion || '').localeCompare(String(a.fecha_creacion || '')) ||
      b.id_cotizacion - a.id_cotizacion,
  );
  return {
    estado: 'encontradas',
    motivo: `${activas.length} carga(s) en curso`,
    cargas: activas.slice(0, MAX_CARGAS),
    hay_mas: Math.max(0, activas.length - MAX_CARGAS),
    preparacion: prep,
    propias: propiasOut,
  };
}

/* ── Lo que se le entrega al modelo ───────────────────────────────────────── */

const rotulo = (c) =>
  `cotización N.º ${c.id_cotizacion}` +
  (c.marcas.length ? ` · marca${c.marcas.length > 1 ? 's' : ''} ${c.marcas.slice(0, 6).join(', ')}` : '');

const sinSaludo = (t) => {
  const s = String(t || '').replace(/^Hola,\s*/, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Un solo texto para el cliente con todas sus cargas, armado en código. */
const minuscula = (t) => t.charAt(0).toLowerCase() + t.slice(1);

/** Las cotizaciones que todavía no viajan, solas o detrás de las cargas. */
function textoPreparacion(prep, { conCargas, donde = 'con este número' }) {
  const ls = prep.map((p) => p.texto_cliente);
  if (!ls.length) return null;
  if (conCargas) return ls.length === 1 ? `Además, ${minuscula(ls[0])}` : `Además:\n${ls.map((l) => `- ${l}`).join('\n')}`;
  return ls.length === 1
    ? `Hola, ${minuscula(ls[0])}`
    : `Hola, ${donde} tienes ${ls.length} cotizaciones que todavía no viajan:\n${ls.map((l) => `- ${l}`).join('\n')}`;
}

function textoParaCliente(resultado, mensajeAsesor) {
  const cs = resultado.cargas || [];
  const prep = resultado.preparacion || [];
  // Encontrado con el dato que escribió (no con su número): «en tu cuenta».
  const donde = resultado.por === 'dato' ? 'en tu cuenta' : 'con este número';
  if (!cs.length) return textoPreparacion(prep, { conCargas: false, donde });
  const pendiente = `el área de logística confirma su estado. ${mensajeAsesor}`;
  let texto;
  if (cs.length === 1) {
    if (!cs[0].informable) return null;
    texto = cs[0].texto_cliente;
  } else {
    if (!cs.some((c) => c.informable)) return null;
    // Si hay más de las que caben, se dice el total y cuáles se muestran: van
    // ordenadas por paso, así que son las más avanzadas, no las más recientes.
    const total = cs.length + (resultado.hay_mas || 0);
    texto =
      (resultado.hay_mas > 0
        ? `Hola, ${donde} tienes ${total} cargas; estas son las ${cs.length} más avanzadas:\n`
        : `Hola, ${donde} tienes ${cs.length} cargas registradas:\n`) +
      cs
        .map((c) => {
          if (!c.informable) return `- Cotización N.º ${c.id_cotizacion}: ${pendiente}`;
          // El texto del portal a veces ya nombra la cotización; si no, se antepone.
          const yaLaNombra = c.texto_cliente.includes(`N.º ${c.id_cotizacion}`);
          return `- ${yaLaNombra ? '' : `Cotización N.º ${c.id_cotizacion}: `}${sinSaludo(c.texto_cliente)}`;
        })
        .join('\n');
  }
  if (resultado.hay_mas > 0) {
    texto += `\n${resultado.hay_mas === 1 ? 'De la otra carga' : `De las otras ${resultado.hay_mas}`}, el área de logística te confirma su estado.`;
  }
  const extra = textoPreparacion(prep, { conCargas: true });
  if (extra) texto += `\n${extra}`;
  return texto;
}

/**
 * Bloque de contexto para el turno. `codigos` son las marcas de envío y los
 * números de cotización que el cliente ESCRIBIÓ: los que no son de este número
 * se señalan, para que el bot no confirme nada sobre la carga de otro.
 */
function bloqueCarga(
  resultado,
  { codigos = { marcas: [], cotizaciones: [] }, mensajeAsesor = '', mensajeSinCargaEnCuenta = '', mensajeSinCargaPideDato = '' } = {},
) {
  const L = [];
  const porDato = resultado.por === 'dato';
  const cab = porDato
    ? '📦 CARGA DE ESTE CLIENTE — leída ahora del sistema de cargas, buscando con el dato que escribió (ya se confirmó que es suyo)'
    : '📦 CARGA DE ESTE CLIENTE — leída ahora del sistema de cargas, buscando SOLO por el número de WhatsApp desde el que escribe';
  const conEste = porDato ? 'en su cuenta' : 'con este número';

  // «MX-002026» puede ser como escribe su cotización N.º 2026: si es suya, no es ajena.
  const esSuCotizacion = (m) => resultado.propias.cotizaciones.includes(Number(String(m).split('-')[1]));
  const ajenasMarcas = codigos.marcas.filter((m) => !resultado.propias.marcas.includes(String(m).toUpperCase()) && !esSuCotizacion(m));
  const ajenasCot = codigos.cotizaciones.filter((n) => !resultado.propias.cotizaciones.includes(Number(n)));
  const ajenos = [...ajenasMarcas, ...ajenasCot.map((n) => `cotización ${n}`)];

  if (resultado.estado === 'encontradas') {
    const cs = resultado.cargas;
    L.push(`${cab}:`);
    L.push(`Tiene ${cs.length === 1 ? '1 carga' : `${cs.length} cargas`} en curso ${conEste}${resultado.hay_mas ? ` (y ${resultado.hay_mas} más que no se listan)` : ''}.`);
    cs.forEach((c, i) => {
      L.push('');
      L.push(`CARGA ${i + 1} — ${rotulo(c)}${c.destino ? ` · destino ${c.destino}` : ''}`);
      if (!c.informable) {
        L.push('  ESTADO: NO SE PUEDE INFORMAR por este chat (el área de logística tiene que confirmarlo). No digas en qué paso va ni por qué.');
        return;
      }
      L.push(`  Paso ${c.paso} de 7: ${c.paso_nombre}${c.entregada ? ' · figura ENTREGADA' : ''}${c.parcial ? ' · solo una parte de la carga' : ''}`);
      if (c.contenedor) L.push(`  Contenedor: ${c.contenedor}`);
      L.push(
        c.fecha_estimada_texto
          ? `  Fecha estimada de llegada registrada: ${c.fecha_estimada_texto} (es una estimación y puede moverse)`
          : '  Fecha: NO hay ninguna fecha que se pueda dar. No des ni calcules ninguna.',
      );
      if (c.marcas_pendientes.length && c.paso === 2) {
        L.push(`  Marcas que todavía no llegan a la bodega de China: ${c.marcas_pendientes.join(', ')} (puedes sugerirle que confirme ese envío con su proveedor)`);
      }
      if (c.nota_cliente) L.push(`  Novedad registrada para el cliente: «${c.nota_cliente}»`);
    });
    const texto = textoParaCliente(resultado, mensajeAsesor);
    L.push('');
    if (texto) {
      L.push('TEXTO PARA EL CLIENTE (si pregunta por el estado de su carga, respóndele con esto, tal cual; si ya saludaste, quita el «Hola,»):');
      L.push(`«${texto}»`);
    } else {
      L.push('No hay texto para el cliente: va el paso a asesor para el área de logística, sin pedirle datos.');
    }
  } else if (resultado.estado === 'sin_carga' || resultado.estado === 'solo_historicas') {
    L.push(`${cab}:`);
    const texto = textoParaCliente(resultado, mensajeAsesor);
    if (texto) {
      L.push(`NO hay ninguna carga viajando ${conEste}, pero tiene cotizaciones que todavía no viajan:`);
      (resultado.preparacion || []).forEach((p) => L.push(`- Cotización N.º ${p.id_cotizacion} (estado ${p.estado}): ${p.texto_cliente}`));
      L.push('');
      L.push('TEXTO PARA EL CLIENTE (si pregunta por su carga, su importación o su cotización, respóndele con esto, tal cual; si ya saludaste, quita el «Hola,»). No agregues fechas, plazos ni montos:');
      L.push(`«${texto}»`);
    } else if (porDato) {
      L.push('NO hay ninguna carga EN CURSO en su cuenta (ni con el dato que escribió).');
      L.push(`No digas ni supongas ningún estado y no le pidas más datos. Si pregunta por su carga, responde exactamente: ${mensajeSinCargaEnCuenta}`);
    } else {
      L.push(
        resultado.estado === 'sin_carga'
          ? 'NO hay ninguna carga registrada con este número. Puede estar registrada con otro teléfono.'
          : 'NO hay ninguna carga EN CURSO con este número (solo cargas ya entregadas o cotizaciones antiguas).',
      );
      L.push(
        mensajeSinCargaPideDato
          ? `No digas ni supongas ningún estado. Si pregunta por su carga, responde exactamente: ${mensajeSinCargaPideDato} Cuando escriba su número de cotización, su marca de envío o su correo, usa ver_mi_carga con ese dato (esto reemplaza el caso «SIN CARGA CON ESTE NÚMERO»).`
          : 'No digas ni supongas ningún estado. Si pregunta por su carga, aplica el caso «SIN CARGA CON ESTE NÚMERO» de tus instrucciones.',
      );
    }
  } else {
    L.push(`${cab}:`);
    L.push('NO SE PUEDE INFORMAR por este chat en este momento. No digas ningún estado ni expliques por qué: va el paso a asesor para el área de logística, sin pedirle datos.');
  }

  if (ajenos.length) {
    L.push('');
    L.push(
      `⚠️ El cliente escribió ${ajenos.join(', ')}. ${ajenos.length > 1 ? 'Esos códigos NO figuran' : 'Ese código NO figura'} entre las cargas ${porDato ? 'de su cuenta' : 'de este número'}: ` +
        `no confirmes ni niegues nada sobre ${ajenos.length > 1 ? 'ellos' : 'él'} y no des ningún estado para ${ajenos.length > 1 ? 'esos códigos' : 'ese código'}. Va el paso a asesor para el área de logística.`,
    );
  }
  return L.join('\n');
}

/**
 * Marcas de envío (EC-2609112, MX-2609112) y números de cotización que trae
 * un mensaje. Estricto a propósito: «el valor de 12500» no es una marca y
 * «cotización de 500 unidades» no es un número de cotización.
 */
function codigosEnMensaje(texto) {
  const t = String(texto || '');
  const marcas = [
    ...new Set(
      (t.match(/\b(?:EC|MX)[- ]?\d{5,9}\b|\b[A-Z]{2}-\d{5,9}\b/gi) || [])
        .filter((m) => /^(?:ec|mx)/i.test(m) || /^[A-Z]{2}-/.test(m))
        .map((m) => m.toUpperCase().replace(/^([A-Z]{2})[- ]?/, '$1-')),
    ),
  ];
  const relleno = '(?:\\s*(?:es|la|el|nro\\.?|numero|num\\.?|n\\.?\\s*[ºo°]\\.?|no\\.?|n\\.|#|:))*';
  const unidad = '(?!\\s*(?:unidad|producto|caja|dolar|usd|kg|kilo|pieza|pcs|cbm|rmb|yuan|%|\\$))';
  const re = new RegExp(`cotizacion(?:es)?${relleno}\\s*(\\d{3,7})\\b${unidad}`, 'g');
  const cotizaciones = [...new Set([...sinTildes(t).matchAll(re)].map((m) => Number(m[1])))];
  return { marcas, cotizaciones };
}

module.exports = {
  enPreparacion,
  cargasDelTelefono,
  cargasDelDueno,
  bloqueCarga,
  textoParaCliente,
  codigosEnMensaje,
  esCorreoDePrueba,
  correosDelWhatsapp,
  esHistorica,
  enFlujo,
  consultarImporsuit,
  MAX_CARGAS,
};
