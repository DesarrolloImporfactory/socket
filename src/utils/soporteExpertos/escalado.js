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
});
// Ya no están en el equipo (24-oct). Nunca son destino.
const YA_NO_ESTAN = Object.freeze([2179, 379]);

const llano = (t) => sinTildes(String(t || '').toLowerCase()).replace(/\s+/g, ' ');
const RE_PAGO = /\b(?:pag(?:o|ue|ar|ado|os)|transfer\w*|deposit\w*|comprobante|abono|saldo|cuota|cuenta bancaria|numero de cuenta|reembols\w*)\b/;
const RE_FACTURA = /\bfactur\w*/;
const RE_COTIZA = /\b(?:cotiz\w*|proforma|precio|cuanto (?:cuesta|sale|cobran|me sale|saldria|costaria)|flete|cbm|tarifa|costo de envio)\b/;
const RE_LOGISTICA =
  /\b(?:carga|mercaderia|mercancia|contenedor|bodega|marca de envio|shipping mark|guia|tracking|retir(?:o|ar|arla|arlo)|entreg\w*|despach\w*|domicilio|chofer|transporte|fletera|aduana|llega\w*)\b/;

/**
 * ¿De qué área es el caso? El motivo de la herramienta pasar_a_humano manda;
 * si no hubo herramienta, lo dicen las señales del turno y el mensaje.
 * @returns {'reclamo'|'pago'|'factura'|'cotizacion'|'logistica'|'otro'}
 */
function areaDelCaso({ motivo = null, mensaje = '', hechos = {} } = {}) {
  if (hechos.reclamo || hechos.reclamoPorDemora || motivo === 'reclamo') return 'reclamo';
  const t = llano(mensaje);
  if (motivo === 'pago') return RE_FACTURA.test(t) ? 'factura' : 'pago';
  if (motivo === 'cotizacion') return 'cotizacion';
  if (RE_FACTURA.test(t)) return 'factura';
  if (RE_PAGO.test(t) || (hechos.adjuntos || []).some((a) => a.clase === 'comprobante_pago')) return 'pago';
  if (RE_COTIZA.test(t) || (hechos.adjuntos || []).some((a) => a.clase === 'cotizacion_proveedor')) return 'cotizacion';
  if (hechos.carga || RE_LOGISTICA.test(t)) return 'logistica';
  return 'otro';
}

/** La persona del equipo para ese área (la logística de México va a Johan). */
function personaDelArea(area, telefono) {
  if (area === 'cotizacion') return EQUIPO.cotizacion;
  if (area === 'logistica') return paisDelTelefono(telefono) === 'mx' ? EQUIPO.casos : EQUIPO.logistica_ec;
  return EQUIPO.casos;
}

/**
 * Decide a quién va el caso. Puro: no lee ni escribe nada.
 * @param {object} p
 *   motivo, mensaje, hechos, telefono
 *   encargado  { id, activo } del chat (activo=false si está suspendido o ya no está)
 * @returns {{ area, destino, asignar: boolean, razon }}
 */
function decidirEscalado({ motivo = null, mensaje = '', hechos = {}, telefono = '', encargado = null } = {}) {
  const area = areaDelCaso({ motivo, mensaje, hechos });
  const destino = personaDelArea(area, telefono);
  const id = Number(encargado?.id) || null;
  if (!id) return { area, destino, asignar: true, razon: 'el chat no tiene encargado' };
  if (YA_NO_ESTAN.includes(id) || encargado.activo === false)
    return { area, destino, asignar: true, razon: `su encargado (${id}) ya no está en el equipo` };
  if (id === destino.id) return { area, destino, asignar: false, razon: 'ya lo atiende la persona de su área' };
  return { area, destino, asignar: false, razon: `lo atiende una persona activa del equipo (${id}); no se le quita` };
}

const NOMBRE_AREA = {
  reclamo: 'reclamo',
  pago: 'pago',
  factura: 'factura',
  cotizacion: 'cotización',
  logistica: 'logística',
  otro: 'consulta',
};

/** Nota interna (rol 3) que ve el equipo en la conversación. */
function notaInterna(decision, mensaje) {
  const extracto = String(mensaje || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return (
    `🤖 El bot pasó este chat a ${decision.destino.nombre} (${NOMBRE_AREA[decision.area] || decision.area}): ${decision.razon}.` +
    (extracto ? ` Lo último que escribió el cliente: «${extracto}»` : '')
  );
}

/* ¿La respuesta que sale deja el caso a una persona? (el paso a asesor, el de
   reclamo, el de logística o el de cobranza). */
const RE_PASE = /\b(?:un asesor|tu asesor|el area de|lo sumo a tu caso)\b/;
const esPase = (texto) => RE_PASE.test(llano(texto));

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
      `SELECT c.id, c.id_encargado, s.suspendido
         FROM clientes_chat_center c
         LEFT JOIN sub_usuarios_chat_center s ON s.id_sub_usuario = c.id_encargado
        WHERE c.id = ? AND c.id_configuracion = ? LIMIT 1`,
      [id_cliente, id_configuracion],
    );
    if (!chat) return null;
    const encargado = chat.id_encargado
      ? { id: Number(chat.id_encargado), activo: chat.suspendido == null ? false : Number(chat.suspendido) !== 1 }
      : null;
    const decision = decidirEscalado({ ...p, encargado });
    await log(
      `🧭 soporte_expertos (escalar ${modo}): ${NOMBRE_AREA[decision.area]} → ${decision.destino.nombre} (${decision.destino.id}) · ` +
        `${decision.asignar ? 'SE ASIGNA' : 'no se asigna'}: ${decision.razon} (cliente=${id_cliente})`,
    );
    if (modo !== 'real' || !decision.asignar) return { ...decision, aplicado: false };

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
    await deps.crearNota(notaInterna(decision, p.mensaje));
    if (deps.emitir) deps.emitir();
    return { ...decision, aplicado: true };
  } catch (e) {
    await log(`⚠️ soporte_expertos (escalar): ${e.message}; el chat queda como estaba`);
    return null;
  }
}

module.exports = { EQUIPO, YA_NO_ESTAN, areaDelCaso, personaDelArea, decidirEscalado, notaInterna, esPase, escalarCaso };
