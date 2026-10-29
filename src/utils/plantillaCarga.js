/*  Botón «Enviar información» de Team: le manda al cliente la plantilla
 *  aprobada `carga_novedad_contenedor` con los datos de su carga más reciente
 *  que ya está en un contenedor (pedido de Daniel, 27-oct-2026: «que se mande
 *  una plantilla automática», opción A).
 *
 *  Aquí van solo las piezas sin base de datos: elegir la carga, armar los
 *  4 datos, el texto tal como lo ve el cliente y el envío a Meta. El control
 *  de quién puede mandarla está en equipo.controller.js. */

'use strict';

const NOMBRE = 'carga_novedad_contenedor';
const IDIOMA = 'es';
// La plantilla está aprobada en la cuenta de WhatsApp de esta línea
// (Soporte Importaciones Expertos); en otra línea Meta la rechazaría.
const LINEA = Number(process.env.PLANTILLA_CARGA_LINEA || 265);
// Texto aprobado por Meta (leído de la API el 27-oct-2026).
const CUERPO =
  'Hola {{1}} 👋 Te escribe el equipo de Importaciones.\n\n' +
  'Hay una novedad de tu carga en el contenedor {{2}}:\n\n' +
  '📢 {{3}}\n\n' +
  '📅 Fecha estimada de llegada: {{4}}\n\n' +
  'Si tienes dudas, respóndenos por este chat.';
const MAX_DATO = 300;

/*  Meta rechaza un dato de plantilla con saltos de línea, tabulaciones o más
 *  de 4 espacios seguidos, y uno vacío. */
function limpiar(v, max = MAX_DATO) {
  const t = String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Primer nombre con mayúscula inicial («MARÍA josé» → «María»); '' si no hay letras. */
function primerNombre(nombre) {
  const m = String(nombre || '').match(/\p{L}+/u);
  if (!m) return '';
  const p = m[0].toLocaleLowerCase('es');
  return p.charAt(0).toLocaleUpperCase('es') + p.slice(1);
}

/** ¿Se puede informar de esta carga? Ya en un contenedor y sin entregar. */
const informable = (c) => !!c && !c.entregada && !!String(c.contenedor || '').trim();

/**
 * La carga de la que se informa: la elegida (si se pide una) o la más
 * reciente informable. El historial viene del más nuevo al más viejo.
 * @returns {object|null}
 */
function elegirCarga(cotizaciones, idCotizacion = null) {
  const lista = Array.isArray(cotizaciones) ? cotizaciones : [];
  if (idCotizacion != null) {
    const c = lista.find((x) => Number(x.id_cotizacion) === Number(idCotizacion));
    return informable(c) ? c : null;
  }
  return lista.find(informable) || null;
}

/** Los 4 datos de la plantilla, ya limpios. */
function parametros(carga, nombreCliente) {
  const nota = limpiar(carga.nota_cliente);
  const paso = limpiar(carga.paso_nombre, 120);
  return {
    1: primerNombre(nombreCliente) || 'Importador',
    2: limpiar(carga.contenedor, 60),
    3: nota || (paso ? `Tu carga está en: ${paso}.` : 'Tu carga ya está en el contenedor.'),
    4: limpiar(carga.llegada_estimada, 60) || 'por confirmar',
  };
}

/** El mensaje tal como le llega al cliente. */
const textoFinal = (p) => CUERPO.replace(/\{\{(\d)\}\}/g, (_, n) => p[n] ?? '');

/*  Manda la plantilla por la línea (mismo endpoint y llave que ChatService).
 *  Devuelve el wamid; lanza un Error con el mensaje de Meta si la rechaza. */
async function enviar({ dataAdmin, to, p }) {
  const r = await fetch(`https://graph.facebook.com/${process.env.GRAPH_VERSION}/${dataAdmin.id_telefono}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dataAdmin.token}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: NOMBRE,
        language: { code: IDIOMA },
        components: [{ type: 'body', parameters: [1, 2, 3, 4].map((n) => ({ type: 'text', text: p[n] })) }],
      },
    }),
    signal: AbortSignal.timeout(30000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error?.message || `Meta ${r.status}`);
  return { wamid: d.messages?.[0]?.id || null, estado: d.messages?.[0]?.message_status || null };
}

module.exports = { NOMBRE, IDIOMA, LINEA, CUERPO, limpiar, primerNombre, informable, elegirCarga, parametros, textoFinal, enviar };
