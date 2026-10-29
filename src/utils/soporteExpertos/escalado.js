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
     · Objeción de precio que insiste (objecionPrecio.js, 27-oct): a Johan,
                      líder comercial, con nota «objeción de precio» y el
                      resumen de la cotización. El bot nunca baja el precio.
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
// Ya no están en el equipo (24-oct). Nunca son destino.
const YA_NO_ESTAN = Object.freeze([2179, 379]);

const llano = (t) => sinTildes(String(t || '').toLowerCase()).replace(/\s+/g, ' ');
const RE_PAGO = /\b(?:pag(?:o|ue|ar|ado|os)|transfer\w*|deposit\w*|comprobante|abono|saldo|cuota|cuenta bancaria|numero de cuenta|reembols\w*)\b/;
const RE_FACTURA = /\bfactur\w*/;
const RE_COTIZA = /\b(?:cotiz\w*|proforma|precio|cuanto (?:cuesta|sale|cobran|me sale|saldria|costaria)|flete|cbm|tarifa|costo de envio)\b/;
const RE_REEMBOLSO =
  /\b(?:reembols(?!able)\w*|devuelv\w* (?:mi|el|la|mis|los) (?:dinero|plata|pago)|devolucion del? (?:mi |mis )?(?:dinero|plata|pago|inversion)|quiero mi (?:dinero|plata)|(?:dar|darme|darse) de baja|(?:cancel|anul)\w* (?:mi |el |la |los |las )?(?:membresia|suscripcion|plan|curso|servicio|cobro|club)|(?:pausar|congelar|suspender) (?:mi |el |la )?(?:servicio|plan|membresia|suscripcion|curso))\b/;
/* Lo que el cliente escribió, sin la descripción de sus adjuntos ([IMAGEN: …]
   la escribe la IA que mira la foto) ni el aviso «Tipo de mensaje no
   reconocido»: «molde no reembolsable» de una proforma china y el
   «reembolso» de un correo de Alibaba abrieron casos de baja (26-oct).
   La ráfaga trae un mensaje por línea (adjuntos.js lee igual). */
const RE_NO_ES_DEL_CLIENTE = /^\s*(?:\[imagen:|tipo de mensaje no reconocido\.?\s*$)/i;
const palabrasDelCliente = (m) =>
  String(m || '')
    .split('\n')
    .filter((l) => !RE_NO_ES_DEL_CLIENTE.test(l))
    .join('\n');
// Las fichas de baja también responden frases sueltas («esto no funciona», «ya
// no quiero el curso»): solo es baja si el cliente habla de su dinero, su
// plan o su baja (26-oct, 4 quejas de «no funciona»; 27-oct, «no quiero
// cometer errores… en ese curso» abrió un caso).
const FICHAS_BAJA = Object.freeze(['reembolso-o-baja', 'eco-no-vendo-quiero-mi-dinero']);
const RE_SU_DINERO =
  /\b(?:dinero|plata|devuelv\w*|devolucion|reembols(?!able)\w*|baja|cancel\w*|anul\w*|paus\w*|congel\w*|suspend\w*|cobr\w*|membresia|suscripcion|ya no quiero)\b/;
/* La devolución que cuenta es con un TERCERO (su proveedor, Dropi, la tienda,
   un compañero), no con nosotros: «ya hice el proceso de devolución de dinero
   y espero que me devuelvan porque no cumplió el proveedor» (27-oct, ••••3484)
   se abrió como baja. Solo es reembolso si habla de lo nuestro, o si no nombra
   a ningún tercero. */
const RE_TERCERO =
  /\b(?:proveedor\w*|compa(?:ñ|n)er\w*|compa\b|fabrica\w*|vendedor\w*|alibaba|1688|aliexpress|temu|shein|amazon|dropi|tienda|transportador\w*|courier|servientrega|laar|paqueteria|no (?:me )?cumpli\w*|el chino|la china)\b/;
const RE_LO_NUESTRO =
  /\b(?:membresia|suscripcion|club|plan|curso|mensualidad|imporfactory|imporchat|imporsuit|asesoria|ustedes|les pague|les di|su servicio|el servicio)\b/;
const conUnTercero = (t) => RE_TERCERO.test(t) && !RE_LO_NUESTRO.test(t);
const pideReembolso = (t, fichas) => !conUnTercero(t) && (RE_REEMBOLSO.test(t) || (FICHAS_BAJA.includes(fichas[0]) && RE_SU_DINERO.test(t)));
const RE_ECOMMERCE =
  /\b(?:dropi|imporchat|campan\w*|anuncio\w*|publicidad|meta ads|facebook ads|business manager|pixel|shopify|landing|dropkiller|tienda (?:online|virtual|web)|pagina web|imporshop|primera venta|dropshipping|bot)\b/;
const RE_LOGISTICA =
  /\b(?:carga|mercaderia|mercancia|contenedor|bodega|marca de envio|shipping mark|guia|tracking|retir(?:o|ar|arla|arlo)|entreg\w*|despach\w*|domicilio|chofer|transporte|fletera|aduana|llega\w*)\b/;
// «¿Llegó mi mercadería?» con la captura de la guía es logística aunque la IA o
// la foto digan pago (26-oct, ****4820 fue a Johan).
const RE_PREGUNTA_LLEGADA =
  /\b(?:lleg\w*|donde (?:esta|va|anda)|ya (?:salio|esta en))\b.*\b(?:carga|mercaderia|mercancia|cajas?|contenedor)\b|\b(?:carga|mercaderia|mercancia|cajas?|contenedor)\b.*\blleg\w*/;

// Señales de ecommerce (las fichas «eco-», «ia-», «camp-», «ped-» son de la tienda del alumno).
const esDeEcommerce = ({ t, hechos, columna, fichas }) =>
  hechos.pasarA === 'ecommerce' ||
  Boolean(hechos.esEcommerce) ||
  esColumnaEcommerce(columna) ||
  RE_ECOMMERCE.test(t) ||
  fichas.some((f) => /^(?:eco|ia|camp|ped)-/.test(String(f)));

/**
 * ¿De qué área es el caso? El motivo de la herramienta pasar_a_humano manda;
 * si no hubo herramienta, lo dicen las señales del turno y el mensaje.
 * Un reembolso, baja o pausa va primero (aunque venga molesto): es un caso de
 * escalamiento. Ecommerce va antes que cotización: «¿hay stock en Dropi?» no
 * es una cotización (24-oct, salió a Belén).
 * @param columna  estado_contacto del chat (una columna de ecommerce)
 * La objeción de precio que insiste va antes que el reclamo: el que reclama
 * por el precio también va a Johan, y la nota dice qué es.
 * @returns {'reembolso'|'objecion_precio'|'reclamo'|'pago'|'factura'|'ecommerce'|'cotizacion'|'logistica'|'otro'}
 */
function areaDelCaso({ motivo = null, mensaje = '', hechos = {}, columna = null } = {}) {
  const t = llano(mensaje);
  const fichas = hechos.fichas || [];
  // El bot proactivo ya sabe el área (datos de factura, tramo 5).
  if (hechos.areaForzada && NOMBRE_AREA[hechos.areaForzada]) return hechos.areaForzada;
  if (pideReembolso(llano(palabrasDelCliente(mensaje)), fichas)) return 'reembolso';
  if (hechos.objecionPrecio === 'pasar') return 'objecion_precio';
  /* El reclamo de un alumno de ecommerce por SU venta (un cliente suyo le
     reclama un producto) va a ecommerce, no a casos (27-oct, ••••1940: «una
     clienta me reclama que el cepillo está en mal estado» fue a Vivi). El
     reclamo por la demora de una carga sigue siendo reclamo. */
  const esReclamo = hechos.reclamo || hechos.reclamoPorDemora || motivo === 'reclamo';
  if (esReclamo && !hechos.reclamoPorDemora && esDeEcommerce({ t, hechos, columna, fichas })) return 'ecommerce';
  if (esReclamo) return 'reclamo';
  if (RE_PREGUNTA_LLEGADA.test(t) && !RE_PAGO.test(t) && !RE_FACTURA.test(t) && !RE_ECOMMERCE.test(t)) return 'logistica';
  if (motivo === 'pago') return RE_FACTURA.test(t) ? 'factura' : 'pago';
  if (motivo === 'cotizacion') return 'cotizacion';
  if (RE_FACTURA.test(t)) return 'factura';
  if (RE_PAGO.test(t) || (hechos.adjuntos || []).some((a) => a.clase === 'comprobante_pago')) return 'pago';
  if (esDeEcommerce({ t, hechos, columna, fichas: [] })) return 'ecommerce';
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
  if (area === 'objecion_precio') return EQUIPO.casos; // líder comercial
  if (area === 'cotizacion') return EQUIPO.cotizacion;
  if (area === 'ecommerce') return asesorEcommerce(telefono);
  if (area === 'logistica') return paisDelTelefono(telefono) === 'mx' ? EQUIPO.casos : EQUIPO.logistica_ec;
  return EQUIPO.casos;
}

/* Además del equipo de Expertos, quien hereda alumnos de un asesor que se fue
   (Wendy, Customer Success, recibió los de Ángel el 27-oct). Solo estas
   personas pueden recibir el chat por ser su asesor o por haberle escrito:
   nunca la cuenta dueña (274) ni una silla compartida (2703). */
const ASESORES_EXTRA = Object.freeze({ 2987: 'Wendy' });
const MIN_RECIENTE = 7 * 24 * 60; // le escribió en los últimos 7 días
const MIN_LE_ESCRIBIO = 24 * 60;
const AREAS_CON_ESPECIALISTA = Object.freeze(['cotizacion', 'logistica', 'ecommerce']); // quien tiene el chat le escribió hace menos de 24 h
const puedeRecibir = (p) => {
  const id = Number(p?.id) || 0;
  return Boolean(id) && !YA_NO_ESTAN.includes(id) && p.activo !== false && (EQUIPO_POR_ID[id] || ASESORES_EXTRA[id]);
};
const primerNombre = (p) => String(p?.nombre || EQUIPO_POR_ID[Number(p?.id)]?.nombre || ASESORES_EXTRA[Number(p?.id)] || '').trim().split(/\s+/)[0] || null;
const horas = (min) => (min < 60 ? `${min} min` : `${Math.round(min / 60)} h`);

/**
 * Decide a quién va el caso. Puro: no lee ni escribe nada.
 *
 * Orden (27-oct, 4 chats mal pasados: al reabrirse, el chat pierde su
 * encargado y el bot lo repartía por área sin mirar al asesor):
 *   1. Reembolso, baja o pausa: al destinatario de escalamientos (caso).
 *   2. Sin encargado (o el suyo ya no está): a su ASESOR (el chip de Team);
 *      si no tiene, a quien del equipo le escribió en los últimos 7 días;
 *      si nadie, a la persona del área.
 *   3. Con encargado: se queda si es del área, si es su asesor, si le
 *      escribió hace menos de 24 h o si no hay un área clara. Si no, pasa a su
 *      asesor o a la persona del área (la nota interna lo dice).
 * @param {object} p
 *   motivo, mensaje, hechos, telefono
 *   encargado        { id, activo } del chat (activo=false si está suspendido o ya no está)
 *   columna          estado_contacto del chat
 *   responsableCaso  { id, nombre } destinatario de los escalamientos de la cuenta
 * @returns {{ area, destino, asignar: boolean, razon, caso: boolean }}
 *   caso = true → además se abre un caso de escalamiento (reembolso, baja, pausa).
 */
function decidirEscalado({
  motivo = null,
  mensaje = '',
  hechos = {},
  telefono = '',
  encargado = null,
  columna = null,
  responsableCaso = null,
  asesor = null,
  personas = [],
} = {}) {
  const area = areaDelCaso({ motivo, mensaje, hechos, columna });
  const caso = area === 'reembolso';
  const id = Number(encargado?.id) || null;
  const sinEncargado = !id || YA_NO_ESTAN.includes(id) || encargado.activo === false;
  const motivoSin = !id ? 'el chat no tiene encargado' : `su encargado (${id}) ya no está en el equipo`;
  // 1. El reembolso va a quien recibe los escalamientos de la cuenta (o a Johan).
  if (caso) {
    const destino = responsableCaso?.id
      ? { id: Number(responsableCaso.id), nombre: responsableCaso.nombre || 'el responsable de escalamientos', area: 'escalamientos' }
      : personaDelArea(area, telefono);
    if (sinEncargado) return { area, destino, asignar: true, razon: motivoSin, caso };
    if (id === destino.id) return { area, destino, asignar: false, razon: 'ya lo atiende la persona de su área', caso };
    return { area, destino, asignar: false, razon: `lo atiende una persona activa del equipo (${id}); no se le quita`, caso };
  }
  const delArea = personaDelArea(area, telefono);
  const suAsesor = puedeRecibir(asesor) ? { id: Number(asesor.id), nombre: primerNombre(asesor), area: 'su asesor' } : null;
  const reciente = (personas || [])
    .filter((p) => puedeRecibir(p) && Number(p.haceMin) >= 0 && Number(p.haceMin) <= MIN_RECIENTE)
    .sort((a, b) => a.haceMin - b.haceMin)[0];
  const decidir = (destino, asignar, razon, por = null) => ({ area, destino, asignar, razon, caso, por });

  // 2. Sin encargado: su asesor, quien le escribió hace poco o el área.
  if (sinEncargado) {
    if (suAsesor) return decidir(suAsesor, true, `${motivoSin}; va a su asesor`, 'asesor');
    if (reciente) {
      const destino = { id: Number(reciente.id), nombre: primerNombre(reciente), area: 'le escribió hace poco' };
      return decidir(destino, true, `${motivoSin}; va a quien le escribió hace ${horas(Number(reciente.haceMin))}`, 'reciente');
    }
    return decidir(delArea, true, motivoSin);
  }

  // 3. Con encargado activo.
  if (id === delArea.id) return decidir(delArea, false, 'ya lo atiende la persona de su área');
  if (suAsesor && id === suAsesor.id) return decidir(suAsesor, false, 'ya lo atiende su asesor', 'asesor');
  // En ecommerce, si ya lo tiene el otro asesor de ecommerce, se queda con él.
  if (area === 'ecommerce' && ECOMMERCE.some((e) => e.id === id)) return decidir(delArea, false, 'ya lo atiende un asesor de ecommerce');
  const suyo = (personas || []).find((p) => Number(p.id) === id);
  if (suyo && Number(suyo.haceMin) >= 0 && Number(suyo.haceMin) < MIN_LE_ESCRIBIO) {
    return decidir(delArea, false, `lo atiende una persona activa del equipo (${id}) que le escribió hace ${horas(Number(suyo.haceMin))}; no se le quita`);
  }
  // Solo se le quita en las áreas que tienen su especialista (cotización,
  // logística, ecommerce); un pago, un reclamo o una objeción siguen con quien
  // lo atiende y la nota se la deja a esa persona.
  if (!AREAS_CON_ESPECIALISTA.includes(area)) return decidir(delArea, false, `lo atiende una persona activa del equipo (${id}); no se le quita`);
  const nuevo = suAsesor || delArea;
  return decidir(
    nuevo,
    true,
    `lo tenía ${primerNombre({ id, nombre: encargado.nombre }) || id} (${id}), que no es de ${NOMBRE_AREA[area] || area} ni le escribió en 24 h` +
      (suAsesor ? '; va a su asesor' : ''),
    suAsesor ? 'asesor' : null,
  );
}

const NOMBRE_AREA = {
  reembolso: 'reembolso o baja',
  objecion_precio: 'objeción de precio',
  ecommerce: 'ecommerce',
  reclamo: 'reclamo',
  pago: 'pago',
  factura: 'factura',
  cotizacion: 'cotización',
  logistica: 'logística',
  otro: 'consulta',
};

/* POR QUÉ el bot pasó el chat (Daniel, 27-oct: «agrega un comentario de por
   qué escalas»). Va en la nota interna para que la persona sepa qué le toca
   sin leer todo el chat. Sale de las mismas señales que eligieron el área. */
const RE_PIDE_PERSONA =
  /\b(?:(?:hablar|comunicar\w*|contactar\w*) con (?:una persona|un humano|un asesor|alguien|tu jefe|un encargado|un supervisor)|(?:quiero|necesito|pasame|pasenme|comunicame) (?:con )?(?:una persona|un humano|un asesor|alguien real)|no (?:quiero hablar con|eres) (?:un )?(?:bot|robot|maquina)|me (?:llamen|puedes llamar|pueden llamar)|una llamada)\b/;
const pidePersona = (mensaje) => RE_PIDE_PERSONA.test(llano(palabrasDelCliente(mensaje)));
const MOTIVO_HERRAMIENTA = {
  pago: 'la IA lo pasó con su herramienta por un tema de pago',
  cotizacion: 'la IA lo pasó con su herramienta para cotizar',
  reclamo: 'la IA lo pasó con su herramienta por un reclamo',
};
function porQueEscala({ area, motivo = null, mensaje = '', hechos = {}, resumen = null } = {}) {
  const adj = hechos.adjuntos || [];
  if (area === 'reembolso') return 'pide reembolso, baja o pausa del servicio';
  if (area === 'objecion_precio') return 'insiste en que el precio es alto (2.ª objeción); el bot no puede bajarlo';
  if (area === 'factura' && hechos.areaForzada === 'factura') return 'mandó sus datos para la factura';
  if (hechos.shippingMark === 'sin_aprobar')
    return `pide el shipping mark para su proveedor y su cotización${hechos.cotizacionShippingMark ? ` #${hechos.cotizacionShippingMark}` : ''} todavía no está aprobada`;
  if (hechos.shippingMark === 'sin_marca') return 'pide el shipping mark para su proveedor y no tiene una marca registrada';
  if (hechos.reclamoPorDemora) return 'reclama por la demora';
  if (hechos.reclamo) return 'es un reclamo';
  if (pidePersona(mensaje)) return 'pidió hablar con una persona';
  if (adj.some((a) => a.clase === 'comprobante_pago')) return 'mandó un comprobante de pago para verificar';
  if (area === 'cotizacion' && String(resumen || '').trim()) return 'ya juntó los datos para la cotización';
  if (motivo && MOTIVO_HERRAMIENTA[motivo]) return MOTIVO_HERRAMIENTA[motivo];
  if (motivo) return `la IA lo pasó con su herramienta (${motivo})`;
  const conPase = hechos.fichasConPase || [];
  if (conPase.length) return `la ficha «${conPase[0]}» dice que esto lo atiende una persona`;
  if (adj.some((a) => a.leido === false)) return 'mandó un archivo que el bot no puede abrir';
  return 'el bot no encontró la respuesta en sus herramientas ni en las fichas';
}

const extractoDe = (mensaje) => String(mensaje || '').replace(/\s+/g, ' ').trim().slice(0, 160);

/** Nota interna (rol 3) que ve el equipo en la conversación. */
function notaInterna(decision, mensaje, { casoAbierto = false, resumen = null, porQue = null } = {}) {
  const extracto = extractoDe(mensaje);
  const datos = String(resumen || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  const que = decision.asignar
    ? `🤖 El bot pasó este chat a ${decision.destino.nombre} (${NOMBRE_AREA[decision.area] || decision.area}): ${decision.razon}.`
    : `🤖 El bot dejó este chat con su encargado (${NOMBRE_AREA[decision.area] || decision.area}): ${decision.razon}.`;
  const etiqueta =
    decision.area === 'objecion_precio' ? ' 💰 ' : decision.area === 'factura' ? ' 🧾 Datos para la factura: ' : ' Datos que juntó el bot para la cotización: ';
  return (
    que +
    (porQue ? ` Por qué lo pasó: ${porQue}.` : '') +
    (casoAbierto ? ` Abrió un caso de escalamiento para ${decision.destino.nombre}.` : '') +
    (extracto ? ` Lo último que escribió el cliente: «${extracto}»` : '') +
    (datos ? `${etiqueta}${datos}` : '')
  );
}

/* ¿La respuesta que sale deja el caso a una persona? (el paso a asesor, el de
   reclamo, el de logística o el de cobranza). Tiene que DEJARLO («un asesor lo
   revisa», «te escribe», «lo sumo a tu caso»): una ficha que solo nombra al
   asesor («pídele a tu asesor…») o el saludo («si hace falta un asesor…») no
   cuenta (revisión del 24-oct). */
const RE_PASE =
  /\b(?:(?:un|tu) asesor (?:(?:lo|la|los|las) )?revis\w*|asesor (?:te|le) escrib\w*|lo sumo a tu caso|tu caso pasa a|el area de [a-z]+ (?:revisa|lleva|te escribe)|las lleva el area|te prepara la cotizacion|lo pase a|ya tiene tu caso)\b/;
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

/* El chat y el destinatario de escalamientos, leídos de la base (los usan
   escalarCaso y quienAtiende). */
async function leerChat({ id_configuracion, id_cliente, consultar }) {
  const [chat] = await consultar(
    `SELECT c.id, c.id_encargado, c.estado_contacto, s.suspendido, s.nombre_encargado
       FROM clientes_chat_center c
       LEFT JOIN sub_usuarios_chat_center s ON s.id_sub_usuario = c.id_encargado
      WHERE c.id = ? AND c.id_configuracion = ? LIMIT 1`,
    [id_cliente, id_configuracion],
  );
  if (!chat) return null;
  const encargado = chat.id_encargado
    ? {
        id: Number(chat.id_encargado),
        activo: chat.suspendido == null ? false : Number(chat.suspendido) !== 1,
        nombre: String(chat.nombre_encargado || '').trim().split(/\s+/)[0] || null,
      }
    : null;
  // Quién recibe los escalamientos de la cuenta (lo usa el reembolso).
  const [resp] = await consultar(
    `SELECT d.id_sub_usuario AS id, s.nombre_encargado AS nombre
       FROM incidencias_casos_destinatarios d
       JOIN sub_usuarios_chat_center s ON s.id_sub_usuario = d.id_sub_usuario
      WHERE d.id_configuracion = ? AND d.tipo = 'escalamiento' LIMIT 1`,
    [id_configuracion],
  ).catch(() => []);
  const responsableCaso = resp ? { id: Number(resp.id), nombre: String(resp.nombre || '').trim().split(/\s+/)[0] || null } : null;
  const { asesor, personas } = await leerAsesorYPersonas({ id_configuracion, id_cliente, consultar });
  return { chat, encargado, responsableCaso, asesor, personas };
}

/* El asesor del chip de Team (clientes_chat_center.id_etiqueta_asesor: el
   nombre tal cual de la persona en la cuenta) y quién del equipo le escribió
   al cliente en los últimos 7 días (mensajes_clientes.responsable también
   es ese nombre). Si algo falla, nada: se reparte por área como antes. */
async function leerAsesorYPersonas({ id_configuracion, id_cliente, consultar }) {
  const dueño = 'SELECT id_usuario FROM configuraciones WHERE id = ?';
  const [a] = await consultar(
    `SELECT s.id_sub_usuario AS id_persona, s.nombre_encargado AS nombre_persona
       FROM clientes_chat_center c
       JOIN etiquetas_custom_chat_center ea ON ea.id = c.id_etiqueta_asesor AND ea.deleted_at IS NULL
       JOIN sub_usuarios_chat_center s ON TRIM(s.nombre_encargado) = TRIM(ea.nombre) AND s.suspendido = 0
      WHERE c.id = ? AND c.id_configuracion = ? AND s.id_usuario = (${dueño})
      LIMIT 1`,
    [id_cliente, id_configuracion, id_configuracion],
  ).catch(() => []);
  const asesor = a && a.id_persona ? { id: Number(a.id_persona), nombre: String(a.nombre_persona || ''), activo: true } : null;
  const filas = await consultar(
    `SELECT s.id_sub_usuario AS id_persona, s.nombre_encargado AS nombre_persona,
            TIMESTAMPDIFF(MINUTE, MAX(m.created_at), NOW()) AS hace_min
       FROM mensajes_clientes m
       JOIN sub_usuarios_chat_center s ON s.nombre_encargado = m.responsable AND s.suspendido = 0
      WHERE m.celular_recibe = ? AND m.id_configuracion = ? AND m.rol_mensaje = 1 AND m.deleted_at IS NULL
        AND m.created_at >= NOW() - INTERVAL 7 DAY AND s.id_usuario = (${dueño})
      GROUP BY s.id_sub_usuario, s.nombre_encargado`,
    [String(id_cliente), id_configuracion, id_configuracion],
  ).catch(() => []);
  const personas = (filas || [])
    .filter((f) => f && f.id_persona && f.hace_min != null)
    .map((f) => ({ id: Number(f.id_persona), nombre: String(f.nombre_persona || ''), haceMin: Number(f.hace_min), activo: true }));
  return { asesor, personas };
}

const EQUIPO_POR_ID = Object.freeze(Object.fromEntries(Object.entries(EQUIPO).map(([k, e]) => [e.id, { ...e, clave: k }])));
// El área de cada persona del equipo, para decirle al cliente «Lo pasé a Belén, de cotizaciones».
const AREA_DE_PERSONA = Object.freeze({ cotizacion: 'cotizacion', logistica_ec: 'logistica', casos: 'otro', ecommerce_beto: 'ecommerce', ecommerce_juan: 'ecommerce' });

/**
 * Quién tendrá el chat después del pase, para nombrarlo ANTES de mandar la
 * respuesta (bot proactivo, tramo 5). Solo lee. Mismas reglas que escalarCaso:
 * si el chat lo tiene una persona activa, sigue con ella.
 * @returns {{ decision, nombre: string|null, areaPersona: string|null }} o null
 */
async function quienAtiende(p) {
  const leido = await leerChat({ id_configuracion: p.id_configuracion, id_cliente: p.id_cliente, consultar: p.deps.consultar });
  if (!leido) return null;
  const { chat, encargado, responsableCaso, asesor, personas } = leido;
  const decision = decidirEscalado({ ...p, encargado, columna: chat.estado_contacto, responsableCaso, asesor, personas });
  const queda = decision.asignar || decision.caso ? decision.destino : encargado;
  const delEquipo = queda?.id ? EQUIPO_POR_ID[queda.id] : null;
  // Con un caso (reembolso) o una asignación por área, el área es la del caso;
  // si va a su asesor o el chat sigue con su encargado, la de esa persona (si
  // es del equipo): «Lo pasé a Juan, de ecommerce», no «de cotizaciones».
  const porArea = (decision.asignar || decision.caso) && !decision.por;
  const areaPersona = porArea ? decision.area : delEquipo ? AREA_DE_PERSONA[delEquipo.clave] : null;
  return { decision, nombre: (delEquipo && delEquipo.nombre) || queda?.nombre || null, areaPersona };
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
    const leido = await leerChat({ id_configuracion, id_cliente, consultar: deps.consultar });
    if (!leido) return null;
    const { chat, encargado, responsableCaso, asesor, personas } = leido;
    const decision = decidirEscalado({ ...p, encargado, columna: chat.estado_contacto, responsableCaso, asesor, personas });
    await log(
      `🧭 soporte_expertos (escalar ${modo}): ${NOMBRE_AREA[decision.area]} → ${decision.destino.nombre} (${decision.destino.id}) · ` +
        `${decision.asignar ? 'SE ASIGNA' : 'no se asigna'}: ${decision.razon}` +
        `${decision.caso ? ' · CASO DE ESCALAMIENTO' : ''} (cliente=${id_cliente})`,
    );
    // Bandeja de Team (26-oct): el chat que el bot deja a una persona pasa a
    // «Te toca» y el bot se calla ahí (bot_openia = 0) hasta que el asesor lo
    // devuelve con «Devolver al bot». Solo con soporte_expertos.callar_al_pasar.
    let callado = false;
    if (modo === 'real' && p.callar === true) {
      await deps.consultar('UPDATE clientes_chat_center SET bot_openia = 0 WHERE id = ? AND id_configuracion = ? AND bot_openia = 1', [
        id_cliente,
        id_configuracion,
      ]);
      callado = true;
      await log(`🤫 soporte_expertos: el bot se calla en este chat hasta que un asesor lo devuelva (cliente=${id_cliente})`);
    }
    // Con el resumen de una cotización (o de la objeción de precio) la nota va
    // SIEMPRE, aunque el chat siga con su encargado.
    const resumen = String(p.resumen || '').trim() || (decision.area === 'objecion_precio' ? String(p.hechos?.resumenObjecion || '').trim() : '');
    const conResumen = Boolean(resumen);
    const porQue = porQueEscala({ area: decision.area, motivo: p.motivo, mensaje: p.mensaje, hechos: p.hechos || {}, resumen });
    await log(`🧭 soporte_expertos: por qué lo pasa: ${porQue}`);
    // Con el bot proactivo (p.notaSiempre) la nota va aunque el chat siga con su
    // encargado: así esa persona sabe que el bot le dejó el caso y por qué.
    const conNota = conResumen || p.notaSiempre === true;
    if (modo !== 'real' || (!decision.asignar && !decision.caso && !conNota)) return { ...decision, aplicado: false, callado, porQue };

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
    if (decision.asignar || casoAbierto || conNota) {
      await deps.crearNota(notaInterna(decision, p.mensaje, { casoAbierto, resumen, porQue }));
      // Cotización de México en borrador (cotizacionMexico.js): va en su propia nota, completa.
      if (String(p.borrador || '').trim()) await deps.crearNota(String(p.borrador).slice(0, 4000));
      if (deps.emitir) deps.emitir();
    }
    return { ...decision, aplicado: true, casoAbierto, callado, porQue };
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
  porQueEscala,
  pidePersona,
  esPase,
  quienAtiende,
  escalarCaso,
};
