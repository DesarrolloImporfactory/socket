/* A QUIÉN pasa el bot de Expertos un caso que no puede resolver.

   Hasta ahora «un asesor lo revisa» solo dejaba el chat en la cola de su
   encargado, aunque el encargado ya no estuviera (24-oct: David Piedra,
   suspendido, seguía de encargado de 138 chats con actividad en 14 días).

   Equipo de destino (pedido de Daniel, 24-oct), con lo que cada uno atendió
   del 10 al 24-oct en la 265:
     · Belén (378)    cotizaciones y precios       (cotización: Ángel 207 · Johan 151 · Belén 69)
     · Viviana (353)  logística de Ecuador         (carga y entrega EC: Johan 236 · Ángel 141 · Alejandro 104)
     · Johan (377)    casos y comercial: pagos, facturas, reclamos, logística
                      de México y lo demás        (pago: Johan 224 · Ángel 177 · Belén 108)
     · Beto (1886) y Juan Felipe (2474)  ecommerce: Dropi, IMPORCHAT, campañas,
                      catálogo de ImporShop (Daniel, 25-oct). Del 10 al 24-oct
                      eran los encargados de 287 de los 350 chats de las columnas
                      de ecommerce. Un chat nuevo se reparte por el último
                      dígito del teléfono (par → Beto, impar → Juan Felipe).
     · Reembolso, baja o pausa del servicio: «caso de escalamiento» (Daniel,
                      25-oct), el mismo que crea el botón «Escalar» del chat
                      (incidencias_chat_center, tipo escalamiento). Va a quien
                      la cuenta tenga de destinatario del escalamiento; si no
                      tiene, a Johan.
   Ángel (2179) y David Piedra (379) ya no están: nunca se les asigna nada, y
   un chat que todavía tienen ellos se reasigna.

   Regla: un chat que ya atiende una persona activa del equipo NO se le quita
   (la gestión es suya; el bot solo deja la nota). Se asigna cuando el chat no
   tiene encargado o su encargado ya no está.

   Se enciende con ia_ajustes → soporte_expertos.escalar:
     · 'simulado'  decide y lo deja en el log; no toca el chat.
     · 'real'      además asigna el chat, guarda el historial y deja una nota
                   interna (rol 3, no le llega al cliente).
   Sin el ajuste no corre. Nunca manda nada al cliente. */

'use strict';

const { sinTildes } = require('./texto');
const { paisDelTelefono } = require('./telefono');

const EQUIPO = Object.freeze({
  cotizacion: { id: 378, nombre: 'Belén', area: 'cotizaciones y precios' },
  logistica_ec: { id: 353, nombre: 'Viviana', area: 'logística de Ecuador' },
  casos: { id: 377, nombre: 'Johan', area: 'casos y comercial' },
  ecommerce_beto: { id: 1886, nombre: 'Beto', area: 'ecommerce' },
  ecommerce_juan: { id: 2474, nombre: 'Juan Felipe', area: 'ecommerce' },
});
const ECOMMERCE = Object.freeze([EQUIPO.ecommerce_beto, EQUIPO.ecommerce_juan]);

/* Columnas de ecommerce del tablero principal de la 265 (las de importación
   y las del tablero 7 son de otro equipo). */
const COLUMNAS_ECOMMERCE = Object.freeze(['primeros_pasos', 'imporchat', 'campaña', 'primera_venta', 'escala', 'implementacion_dropi']);
const esColumnaEcommerce = (c) => COLUMNAS_ECOMMERCE.includes(String(c || '').toLowerCase());
// Fichas que son un pedido de reembolso, baja o pausa.
const FICHAS_REEMBOLSO = Object.freeze(['reembolso-o-baja', 'eco-no-vendo-quiero-mi-dinero']);
// Ya no están en el equipo (24-oct). Nunca son destino.
const YA_NO_ESTAN = Object.freeze([2179, 379]);

const llano = (t) => sinTildes(String(t || '').toLowerCase()).replace(/\s+/g, ' ');
const RE_PAGO = /\b(?:pag(?:o|ue|ar|ado|os)|transfer\w*|deposit\w*|comprobante|abono|saldo|cuota|cuenta bancaria|numero de cuenta|reembols\w*)\b/;
const RE_FACTURA = /\bfactur\w*/;
const RE_COTIZA = /\b(?:cotiz\w*|proforma|precio|cuanto (?:cuesta|sale|cobran|me sale|saldria|costaria)|flete|cbm|tarifa|costo de envio)\b/;
const RE_REEMBOLSO =
  /\b(?:reembols\w*|devuelv\w* (?:mi|el|la|mis|los) (?:dinero|plata|pago)|devolucion de(?: mi)? (?:dinero|plata|pago)|quiero mi (?:dinero|plata)|(?:dar|darme|darse) de baja|(?:cancel|anul)\w* (?:mi |el |la |los |las )?(?:membresia|suscripcion|plan|curso|servicio|cobro|club)|(?:pausar|congelar|suspender) (?:mi |el |la )?(?:servicio|plan|membresia|suscripcion|curso))\b/;
const RE_ECOMMERCE =
  /\b(?:dropi|imporchat|campan\w*|anuncio\w*|publicidad|meta ads|facebook ads|business manager|pixel|shopify|landing|dropkiller|tienda (?:online|virtual|web)|pagina web|imporshop|primera venta|dropshipping|bot)\b/;
const RE_LOGISTICA =
  /\b(?:carga|mercaderia|mercancia|contenedor|bodega|marca de envio|shipping mark|guia|tracking|retir(?:o|ar|arla|arlo)|entreg\w*|despach\w*|domicilio|chofer|transporte|fletera|aduana|llega\w*)\b/;
// «¿Llegó mi mercadería?» con la captura de la guía es logística aunque la IA o
// la foto digan pago (26-oct, ****4820 fue a Johan).
const RE_PREGUNTA_LLEGADA =
  /\b(?:lleg\w*|donde (?:esta|va|anda)|ya (?:salio|esta en))\b.*\b(?:carga|mercaderia|mercancia|cajas?|contenedor)\b|\b(?:carga|mercaderia|mercancia|cajas?|contenedor)\b.*\blleg\w*/;

/**
 * ¿De qué área es el caso? El motivo de la herramienta pasar_a_humano manda;
 * si no hubo herramienta, lo dicen las señales del turno y el mensaje.
 * Un reembolso, baja o pausa va primero (aunque venga molesto): es un caso de
 * escalamiento. Ecommerce va antes que cotización: «¿hay stock en Dropi?» no
 * es una cotización (24-oct, salió a Belén).
 * @param columna  estado_contacto del chat (una columna de ecommerce)
 * @returns {'reembolso'|'reclamo'|'pago'|'factura'|'ecommerce'|'cotizacion'|'logistica'|'otro'}
 */
function areaDelCaso({ motivo = null, mensaje = '', hechos = {}, columna = null } = {}) {
  const t = llano(mensaje);
  const fichas = hechos.fichas || [];
  if (RE_REEMBOLSO.test(t) || FICHAS_REEMBOLSO.includes(fichas[0])) return 'reembolso';
  if (hechos.reclamo || hechos.reclamoPorDemora || motivo === 'reclamo') return 'reclamo';
  if (RE_PREGUNTA_LLEGADA.test(t) && !RE_PAGO.test(t) && !RE_FACTURA.test(t) && !RE_ECOMMERCE.test(t)) return 'logistica';
  if (motivo === 'pago') return RE_FACTURA.test(t) ? 'factura' : 'pago';
  if (motivo === 'cotizacion') return 'cotizacion';
  if (RE_FACTURA.test(t)) return 'factura';
  if (RE_PAGO.test(t) || (hechos.adjuntos || []).some((a) => a.clase === 'comprobante_pago')) return 'pago';
  if (hechos.pasarA === 'ecommerce' || hechos.esEcommerce || esColumnaEcommerce(columna) || RE_ECOMMERCE.test(t)) return 'ecommerce';
  if (RE_COTIZA.test(t) || (hechos.adjuntos || []).some((a) => a.clase === 'cotizacion_proveedor')) return 'cotizacion';
  if (hechos.carga || RE_LOGISTICA.test(t)) return 'logistica';
  return 'otro';
}

/** Ecommerce se reparte por el último dígito del teléfono: par → Beto, impar → Juan Felipe. */
function asesorEcommerce(telefono) {
  const d = String(telefono || '').replace(/\D/g, '').slice(-1);
  return d && Number(d) % 2 === 1 ? EQUIPO.ecommerce_juan : EQUIPO.ecommerce_beto;
}

/** La persona del equipo para ese área (la logística de México va a Johan). */
function personaDelArea(area, telefono) {
  if (area === 'cotizacion') return EQUIPO.cotizacion;
  if (area === 'ecommerce') return asesorEcommerce(telefono);
  if (area === 'logistica') return paisDelTelefono(telefono) === 'mx' ? EQUIPO.casos : EQUIPO.logistica_ec;
  return EQUIPO.casos;
}

/**
 * Decide a quién va el caso. Puro: no lee ni escribe nada.
 * @param {object} p
 *   motivo, mensaje, hechos, telefono
 *   encargado        { id, activo } del chat (activo=false si está suspendido o ya no está)
 *   columna          estado_contacto del chat
 *   responsableCaso  { id, nombre } destinatario de los escalamientos de la cuenta
 * @returns {{ area, destino, asignar: boolean, razon, caso: boolean }}
 *   caso = true → además se abre un caso de escalamiento (reembolso, baja, pausa).
 */
function decidirEscalado({ motivo = null, mensaje = '', hechos = {}, telefono = '', encargado = null, columna = null, responsableCaso = null } = {}) {
  const area = areaDelCaso({ motivo, mensaje, hechos, columna });
  // El reembolso va a quien recibe los escalamientos de la cuenta (o a Johan).
  const destino =
    area === 'reembolso' && responsableCaso?.id
      ? { id: Number(responsableCaso.id), nombre: responsableCaso.nombre || 'el responsable de escalamientos', area: 'escalamientos' }
      : personaDelArea(area, telefono);
  const caso = area === 'reembolso';
  const id = Number(encargado?.id) || null;
  const decidir = (asignar, razon) => ({ area, destino, asignar, razon, caso });
  if (!id) return decidir(true, 'el chat no tiene encargado');
  if (YA_NO_ESTAN.includes(id) || encargado.activo === false) return decidir(true, `su encargado (${id}) ya no está en el equipo`);
  if (id === destino.id) return decidir(false, 'ya lo atiende la persona de su área');
  // En ecommerce, si ya lo tiene el otro asesor de ecommerce, se queda con él.
  if (area === 'ecommerce' && ECOMMERCE.some((e) => e.id === id)) return decidir(false, 'ya lo atiende un asesor de ecommerce');
  return decidir(false, `lo atiende una persona activa del equipo (${id}); no se le quita`);
}

const NOMBRE_AREA = {
  reembolso: 'reembolso o baja',
  ecommerce: 'ecommerce',
  reclamo: 'reclamo',
  pago: 'pago',
  factura: 'factura',
  cotizacion: 'cotización',
  logistica: 'logística',
  otro: 'consulta',
};

const extractoDe = (mensaje) => String(mensaje || '').replace(/\s+/g, ' ').trim().slice(0, 160);

/** Nota interna (rol 3) que ve el equipo en la conversación. */
function notaInterna(decision, mensaje, { casoAbierto = false } = {}) {
  const extracto = extractoDe(mensaje);
  const que = decision.asignar
    ? `🤖 El bot pasó este chat a ${decision.destino.nombre} (${NOMBRE_AREA[decision.area] || decision.area}): ${decision.razon}.`
    : `🤖 El bot dejó este chat con su encargado (${NOMBRE_AREA[decision.area] || decision.area}): ${decision.razon}.`;
  return (
    que +
    (casoAbierto ? ` Abrió un caso de escalamiento para ${decision.destino.nombre}.` : '') +
    (extracto ? ` Lo último que escribió el cliente: «${extracto}»` : '')
  );
}

/* ¿La respuesta que sale deja el caso a una persona? (el paso a asesor, el de
   reclamo, el de logística o el de cobranza). Tiene que DEJARLO («un asesor lo
   revisa», «te escribe», «lo sumo a tu caso»): una ficha que solo nombra al
   asesor («pídele a tu asesor…») o el saludo («si hace falta un asesor…») no
   cuenta (revisión del 24-oct). */
const RE_PASE =
  /\b(?:(?:un|tu) asesor (?:(?:lo|la|los|las) )?revis\w*|asesor (?:te|le) escrib\w*|lo sumo a tu caso|tu caso pasa a|el area de [a-z]+ (?:revisa|lleva|te escribe)|las lleva el area)\b/;
const esPase = (texto) => RE_PASE.test(llano(texto));

/* Caso de escalamiento, igual que el botón «Escalar» del chat
   (incidencias_chat_center.controller.js → crearCaso): sin resolver, para el
   destinatario, con su evento «creado». Si el chat ya tiene uno sin resolver,
   no se duplica. Devuelve true si lo abrió. */
async function abrirCaso({ id_configuracion, id_cliente, decision, mensaje, consultar }) {
  const abiertos = await consultar(
    `SELECT id FROM incidencias_chat_center
      WHERE id_cliente_chat_center = ? AND tipo = 'escalamiento'
        AND escalado_resuelto = 0 AND deleted_at IS NULL
      LIMIT 1`,
    [id_cliente],
  );
  if (abiertos.length) return false;
  const descripcion = `Bot Expertos: pide ${NOMBRE_AREA[decision.area]}. «${extractoDe(mensaje)}»`.slice(0, 2000);
  const res = await consultar(
    `INSERT INTO incidencias_chat_center
       (id_cliente_chat_center, id_configuracion, id_sub_usuario, autor_nombre,
        descripcion, tipo, id_sub_usuario_destino, escalado_resuelto, estado_caso, created_at)
     VALUES (?, ?, NULL, 'Bot Expertos', ?, 'escalamiento', ?, 0, 'sin_resolver', NOW())`,
    [id_cliente, id_configuracion, descripcion, decision.destino.id],
  );
  const idCaso = Array.isArray(res) ? Number(res[0]) || null : null;
  if (idCaso) {
    await consultar(
      `INSERT INTO incidencias_casos_eventos (id_incidencia, accion, comentario, id_sub_usuario, autor_nombre, created_at)
       VALUES (?, 'creado', ?, NULL, 'Bot Expertos', NOW())`,
      [idCaso, descripcion],
    ).catch(() => {});
  }
  return true;
}

/**
 * Lee el chat, decide y (en modo 'real') asigna. Nunca tira: un error queda
 * en el log y el turno sigue.
 * @param {object} p
 *   modo 'simulado' | 'real'; id_configuracion, id_cliente, telefono, mensaje,
 *   motivo, hechos, log; deps { consultar(sql, reemplazos), crearHistorial,
 *   crearNota, emitir } — en producción salen de la base (ver kanban_ia).
 */
async function escalarCaso(p) {
  const { modo, id_configuracion, id_cliente, deps = {} } = p;
  const log = async (m) => {
    try {
      if (p.log) await p.log(m);
    } catch (_) {
      /* nada */
    }
  };
  if (modo !== 'simulado' && modo !== 'real') return null;
  try {
    const [chat] = await deps.consultar(
      `SELECT c.id, c.id_encargado, c.estado_contacto, s.suspendido
         FROM clientes_chat_center c
         LEFT JOIN sub_usuarios_chat_center s ON s.id_sub_usuario = c.id_encargado
        WHERE c.id = ? AND c.id_configuracion = ? LIMIT 1`,
      [id_cliente, id_configuracion],
    );
    if (!chat) return null;
    const encargado = chat.id_encargado
      ? { id: Number(chat.id_encargado), activo: chat.suspendido == null ? false : Number(chat.suspendido) !== 1 }
      : null;
    // Quién recibe los escalamientos de la cuenta (lo usa el reembolso).
    const [resp] = await deps.consultar(
      `SELECT d.id_sub_usuario AS id, s.nombre_encargado AS nombre
         FROM incidencias_casos_destinatarios d
         JOIN sub_usuarios_chat_center s ON s.id_sub_usuario = d.id_sub_usuario
        WHERE d.id_configuracion = ? AND d.tipo = 'escalamiento' LIMIT 1`,
      [id_configuracion],
    ).catch(() => []);
    const responsableCaso = resp ? { id: Number(resp.id), nombre: String(resp.nombre || '').trim().split(/\s+/)[0] || null } : null;
    const decision = decidirEscalado({ ...p, encargado, columna: chat.estado_contacto, responsableCaso });
    await log(
      `🧭 soporte_expertos (escalar ${modo}): ${NOMBRE_AREA[decision.area]} → ${decision.destino.nombre} (${decision.destino.id}) · ` +
        `${decision.asignar ? 'SE ASIGNA' : 'no se asigna'}: ${decision.razon}` +
        `${decision.caso ? ' · CASO DE ESCALAMIENTO' : ''} (cliente=${id_cliente})`,
    );
    if (modo !== 'real' || (!decision.asignar && !decision.caso)) return { ...decision, aplicado: false };

    if (decision.asignar) {
      await deps.consultar('UPDATE clientes_chat_center SET id_encargado = ?, chat_cerrado = 0 WHERE id = ? AND id_configuracion = ?', [
        decision.destino.id,
        id_cliente,
        id_configuracion,
      ]);
      await deps.crearHistorial({
        id_cliente_chat_center: id_cliente,
        id_encargado_anterior: encargado?.id ?? null,
        id_encargado_nuevo: decision.destino.id,
        motivo: `Bot Expertos: ${NOMBRE_AREA[decision.area]} — ${decision.razon}`,
      });
    }
    let casoAbierto = false;
    if (decision.caso) casoAbierto = await abrirCaso({ id_configuracion, id_cliente, decision, mensaje: p.mensaje, consultar: deps.consultar });
    if (decision.asignar || casoAbierto) {
      await deps.crearNota(notaInterna(decision, p.mensaje, { casoAbierto }));
      if (deps.emitir) deps.emitir();
    }
    return { ...decision, aplicado: true, casoAbierto };
  } catch (e) {
    await log(`⚠️ soporte_expertos (escalar): ${e.message}; el chat queda como estaba`);
    return null;
  }
}

module.exports = {
  EQUIPO,
  ECOMMERCE,
  YA_NO_ESTAN,
  COLUMNAS_ECOMMERCE,
  esColumnaEcommerce,
  areaDelCaso,
  asesorEcommerce,
  personaDelArea,
  decidirEscalado,
  notaInterna,
  esPase,
  escalarCaso,
};
