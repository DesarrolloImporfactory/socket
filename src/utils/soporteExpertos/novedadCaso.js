/**
 * «¿Hay novedad de mi caso?» (tramo 4 del 70 %, casos 201 y 203 del 26-oct).
 *
 * Antes el bot no tenía cómo saberlo y pasaba el caso otra vez a un asesor.
 * Ahora lee, SOLO de ese chat y solo lectura:
 *   - la bitácora y los casos del chat (incidencias_chat_center): notas
 *     internas del equipo, estado del caso y los comentarios al ponerlo en
 *     espera o resolverlo. Las filas del propio bot («Bot Expertos») no son
 *     novedad: solo dicen que el bot pasó el caso.
 *   - el último mensaje que una PERSONA del equipo le escribió al cliente
 *     (mensajes_clientes, rol 1, responsable humano), de los últimos 30 días.
 *
 * El modelo recibe esos datos con fecha y la orden de resumirlos sin
 * inventar. Si la guardia rechaza lo que escribió, el texto seguro se arma en
 * código: el mensaje del equipo se cita tal cual (ya se lo mandaron a él); una
 * nota interna nunca se cita, solo se dice que hay una novedad y su fecha.
 */
const { fechaTexto } = require('./estadoCarga');
const { consultarImporchat } = require('./diagnosticoCuenta');
const T = require('./textos');

const DIAS_MENSAJES = 30;
const MAX_ITEMS = 3;
const MAX_CITA = 300;
const LIMITE_MS = 4000;
const PREFIJO_PETICION_DATOS = 'Para confirmar tu pedido, ayúdame con';

const esDelBot = (f) => /^bot expertos/i.test(String(f.autor_nombre || '').trim()) || /^\s*(🤖|bot expertos:)/i.test(String(f.descripcion || ''));

// eslint-disable-next-line global-require
const esHumano = (responsable) => require('../ajustesIA').esResponsableHumano(responsable);

const plano = (t, max = MAX_CITA) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

const CUANDO = (col) => `DATE_FORMAT(${col}, '%Y-%m-%d %H:%i:%s')`;

const SQL_CASOS = `
  SELECT id, descripcion, autor_nombre, ${CUANDO('created_at')} AS cuando, tipo,
         escalado_resuelto, estado_caso,
         resolucion_comentario, ${CUANDO('resolucion_fecha')} AS resolucion_cuando,
         espera_comentario, ${CUANDO('espera_fecha')} AS espera_cuando
    FROM incidencias_chat_center
   WHERE id_cliente_chat_center = :cliente AND deleted_at IS NULL
   ORDER BY id DESC LIMIT 10`;
// Cuentas sin las migraciones de casos: solo la bitácora.
const SQL_BITACORA = `
  SELECT id, descripcion, autor_nombre, ${CUANDO('created_at')} AS cuando
    FROM incidencias_chat_center
   WHERE id_cliente_chat_center = :cliente AND deleted_at IS NULL
   ORDER BY id DESC LIMIT 10`;
const SQL_MENSAJES = `
  SELECT texto_mensaje, responsable, ${CUANDO('created_at')} AS cuando
    FROM mensajes_clientes
   WHERE celular_recibe = :chat AND id_configuracion = :cfg
     AND rol_mensaje = 1 AND deleted_at IS NULL AND tipo_mensaje = 'text'
     AND created_at >= NOW() - INTERVAL ${DIAS_MENSAJES} DAY
   ORDER BY id DESC LIMIT 20`;

const conLimite = (promesa, ms) =>
  Promise.race([promesa, new Promise((_, rej) => setTimeout(() => rej(new Error(`novedadCaso: más de ${ms} ms`)), ms).unref?.())]);

async function leerCasos(cliente, consultar) {
  try {
    return { filas: (await consultar(SQL_CASOS, { cliente })) || [], conCasos: true };
  } catch (err) {
    if (!/unknown column/i.test(String(err?.message || err))) throw err;
    return { filas: (await consultar(SQL_BITACORA, { cliente })) || [], conCasos: false };
  }
}

/**
 * @param {object} p
 * @param {number} p.idCliente        id del chat (clientes_chat_center.id)
 * @param {number} p.idConfiguracion  cuenta de IMPORCHAT del chat
 * @param {Function} [p.consultar]    (sql, {nombrados}) → filas; SELECT
 * @returns {Promise<object>} estado: leida | sin_novedad | sin_chat | error
 *   caso: { estado: sin_resolver | en_espera | resuelto, desde } | null
 *   items: [{ tipo: mensaje | nota | espera | resolucion, cuando, fecha, texto }]
 *   texto: el texto seguro, armado en código
 */
async function novedadDelCaso({ idCliente, idConfiguracion, consultar = consultarImporchat, limite_ms = LIMITE_MS } = {}) {
  const cliente = Number(idCliente) || 0;
  const cfg = Number(idConfiguracion) || 0;
  if (!cliente || !cfg) return { estado: 'sin_chat', caso: null, items: [], texto: null };
  try {
    return await conLimite(leer(cliente, cfg, consultar), limite_ms);
  } catch (err) {
    return { estado: 'error', motivo: String(err?.message || err), caso: null, items: [], texto: null };
  }
}

async function leer(cliente, cfg, consultar) {
  const [{ filas }, mensajes] = await Promise.all([
    leerCasos(cliente, consultar),
    consultar(SQL_MENSAJES, { chat: String(cliente), cfg }),
  ]);

  const items = [];
  // El caso más reciente (abierto por el bot o por una persona) da el estado.
  const ultimoCaso = filas.find((f) => f.tipo);
  let caso = null;
  if (ultimoCaso) {
    const estado = ultimoCaso.estado_caso || (Number(ultimoCaso.escalado_resuelto) === 1 ? 'resuelto' : 'sin_resolver');
    const desde = estado === 'resuelto' ? ultimoCaso.resolucion_cuando : estado === 'en_espera' ? ultimoCaso.espera_cuando : ultimoCaso.cuando;
    caso = { estado, desde: desde || ultimoCaso.cuando };
  }
  for (const f of filas) {
    if (!esDelBot(f) && plano(f.descripcion)) items.push({ tipo: 'nota', cuando: f.cuando, texto: plano(f.descripcion) });
    if (f.tipo && plano(f.espera_comentario) && f.espera_cuando)
      items.push({ tipo: 'espera', cuando: f.espera_cuando, texto: plano(f.espera_comentario) });
    if (f.tipo && plano(f.resolucion_comentario) && f.resolucion_cuando)
      items.push({ tipo: 'resolucion', cuando: f.resolucion_cuando, texto: plano(f.resolucion_comentario) });
  }
  const humano = (mensajes || []).find(
    (m) => esHumano(m.responsable) && plano(m.texto_mensaje) && !String(m.texto_mensaje).startsWith(PREFIJO_PETICION_DATOS),
  );
  if (humano) items.push({ tipo: 'mensaje', cuando: humano.cuando, texto: plano(humano.texto_mensaje) });

  const ordenados = items
    .filter((i) => i.cuando)
    .sort((a, b) => String(b.cuando).localeCompare(String(a.cuando)))
    .slice(0, MAX_ITEMS)
    .map((i) => ({ ...i, fecha: String(i.cuando).slice(0, 10) }));

  const r = { estado: ordenados.length || caso?.estado === 'resuelto' ? 'leida' : 'sin_novedad', caso, items: ordenados };
  r.texto = textoNovedadParaCliente(r);
  return r;
}

/** Texto seguro para el cliente. Nunca cita una nota interna. */
function textoNovedadParaCliente(r) {
  if (!r || (r.estado !== 'leida' && r.estado !== 'sin_novedad')) return null;
  const top = r.items?.[0];
  if (top?.tipo === 'mensaje')
    return `Lo último que te escribió el equipo fue el ${fechaTexto(top.fecha)}: «${top.texto}». Si necesitas algo más sobre eso, cuéntame.`;
  if (r.caso?.estado === 'resuelto')
    return `Tu caso figura como resuelto desde el ${fechaTexto(String(r.caso.desde).slice(0, 10))}. Si todavía te falta algo, cuéntame qué es.`;
  if (top)
    return `Tu caso tiene una novedad registrada el ${fechaTexto(top.fecha)} y sigue con el equipo. Un asesor te escribe con el detalle apenas abramos.`;
  return T.MENSAJE_SIN_NOVEDAD;
}

const NOMBRE_ITEM = {
  mensaje: 'mensaje que le escribió una persona del equipo (ya lo vio el cliente)',
  nota: 'nota interna del equipo (NO es para el cliente)',
  espera: 'comentario interno al poner el caso en espera',
  resolucion: 'comentario interno al resolver el caso',
};
const NOMBRE_ESTADO = { sin_resolver: 'abierto, sin resolver', en_espera: 'en espera', resuelto: 'resuelto' };

/** Bloque para el modelo (resultado de la herramienta). */
function bloqueNovedad(r) {
  const cab = '🗂️ NOVEDAD DEL CASO DE ESTE CLIENTE — leído ahora de su chat (notas del equipo y mensajes que le escribió una persona)';
  if (r?.estado === 'sin_chat' || r?.estado === 'error')
    return `${cab}: NO SE PUDO CONSULTAR. No digas si hay o no novedad: usa pasar_a_humano (motivo otro).`;
  if (r.estado === 'sin_novedad')
    return `${cab}: no hay ninguna novedad registrada por una persona en los últimos ${DIAS_MENSAJES} días. No inventes avances. Responde exactamente: ${T.MENSAJE_SIN_NOVEDAD}`;
  const L = [`${cab}:`];
  if (r.caso) L.push(`Estado del caso: ${NOMBRE_ESTADO[r.caso.estado] || r.caso.estado} (desde el ${fechaTexto(String(r.caso.desde).slice(0, 10))}).`);
  for (const i of r.items) L.push(`- ${fechaTexto(i.fecha)}, ${NOMBRE_ITEM[i.tipo]}: «${i.texto}»`);
  L.push('');
  L.push(
    'Cómo usarlo: dile en 1 o 2 frases lo último que pasó con su caso, con su fecha. Las notas internas no se copian tal cual: ' +
      'cuenta solo el hecho (por ejemplo, que el equipo ya lo revisó o que espera un dato). No nombres a nadie del equipo, ' +
      'no des opiniones ni promesas, y no digas montos, fechas ni plazos que no estén aquí. ' +
      'Si lo que pide no está aquí, usa pasar_a_humano.',
  );
  return L.join('\n');
}

/** ¿Pregunta por la novedad de su caso? */
const RE_NOVEDAD =
  /\b(novedad(?:es)?|noticias?|c[oó]mo va (?:mi|el|la) (?:caso|reclamo|tr[aá]mite|solicitud|reembolso|devoluci[oó]n|baja)|en qu[eé] va (?:mi|el|la) (?:caso|reclamo|tr[aá]mite|solicitud|reembolso|devoluci[oó]n|baja)|ya (?:lo )?revisaron|sigo esperando|alguna respuesta|nadie me (?:responde|contesta|escribe)|qu[eé] pas[oó] con (?:mi|el|la) (?:caso|reclamo|solicitud|reembolso|devoluci[oó]n|baja))\b/i;
const pideNovedad = (texto) => RE_NOVEDAD.test(String(texto || ''));

module.exports = { novedadDelCaso, bloqueNovedad, textoNovedadParaCliente, pideNovedad, DIAS_MENSAJES };
