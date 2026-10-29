/* Bot proactivo de Expertos (tramo 5, aprobado por Daniel el 27-oct).

   Pedido de Daniel: «necesito que el agente se ponga proactivo y ayude a
   resolver qué le hace falta». Medido en la 265 (14 días): 285 pases en 223
   chats, 47 % de los de Johan y 83 % de los de Viviana sin respuesta, y 46
   chats pasados 2 o más veces porque cada acuse volvía a escalar.

   Cuatro cambios, en este orden, solo cuando la respuesta del bot deja el caso
   a una persona (o es el acuse «Recibí tu mensaje»):
     · T5  «¿a las cuentas de la cotización?» → se contesta, no se pasa.
     · T4  datos para la factura → se confirman y se pasan en silencio (nota).
     · P2  el pase no hacía falta (respondió con una herramienta o una ficha,
           sin reclamo ni pedido de persona) → se quita la frase del pase.
     · P4  el chat ya tiene un pase de menos de 24 h sin respuesta → no se
           vuelve a pasar: nota 🔔 para la persona y T8 al cliente (una vez).
     · P1  falta el dato (garantía, comprobante, guía) → se pide una vez y
           el chat se pasa cuando vuelva a escribir.
     · P3  al pasar: «Lo pasé a {nombre}, de {área}. Te escribe … {cuándo}».
     · SM  pide su shipping mark → se le da la marca de su cotización, o se
           pasa a cotizaciones si no está aprobada (va aparte: textos.js).

   Puro: lo que necesita de la base (mensajes, quién tiene el chat) llega por
   parámetro. Lo usa kanban_ia.service con soporte_expertos.proactivo. */

'use strict';

const { sinTildes } = require('./texto');
const { esPase, pidePersona, areaDelCaso } = require('./escalado');
const { cuandoTeEscribe, HORARIO_EQUIPO, HORARIO_ECOMMERCE } = require('./horario');
const { esAutomatico } = require('./seguimiento');
const { esAcuse } = require('./pausaYAcuse');
const { shippingMark, listaDeMarcas } = require('./marcaEnvio');
const T = require('./textos');

const llano = (t) => sinTildes(String(t || '').toLowerCase()).replace(/\s+/g, ' ').trim();
const llenar = (plantilla, v) => String(plantilla).replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m));
const H24 = 24 * 3600 * 1000;
const H72 = 72 * 3600 * 1000;

/* ── Oraciones del texto: el pase se cambia o se quita por oración ── */
const partir = (texto) => String(texto || '').split('\n').map((l) => (l.trim() ? l.split(/(?<=[.!?])\s+/) : []));
const unir = (lineas) =>
  lineas
    .map((os) => os.filter((o) => o.trim()).join(' '))
    .filter((l) => l.trim())
    .join('\n')
    .trim();
// «Si necesitas algo más, un asesor te escribe» no deja el caso a nadie.
const RE_CONDICIONAL = /^(?:si|cuando|en caso|apenas|una vez que|si hace falta)\b/;
const esOracionDePase = (o) => esPase(o) && !RE_CONDICIONAL.test(llano(o));
const esPaseReal = (texto) => partir(texto).some((os) => os.some(esOracionDePase));

/** El texto sin las oraciones del pase. */
function quitarPase(texto) {
  return unir(partir(texto).map((os) => os.filter((o) => !esOracionDePase(o))));
}

/** El texto con la primera oración del pase cambiada por `nuevo` (y las demás quitadas). */
function cambiarPase(texto, nuevo) {
  let puesto = false;
  const lineas = partir(texto).map((os) =>
    os
      .map((o) => {
        if (!esOracionDePase(o)) return o;
        if (puesto) return '';
        puesto = true;
        return nuevo;
      })
      .filter(Boolean),
  );
  const r = unir(lineas);
  return puesto ? r : unir([...lineas, [nuevo]]);
}

/* Textos fijos de las herramientas que pasan el caso porque NO pudieron
   resolverlo («no encuentro una carga en curso…»): ese pase sí hace falta. */
const GENERICOS = new Set([T.CIERRE_ASESOR, T.MENSAJE_ASESOR, T.MENSAJE_RECIBIDO]);
const PASES_FIJOS = Object.values(T.TEXTOS_FIJOS)
  .filter((v) => typeof v === 'string' && esPase(v) && !GENERICOS.has(v))
  .map((v) => llano(v).slice(0, 45));
const traePaseFijo = (texto) => {
  const t = llano(texto);
  return PASES_FIJOS.some((p) => t.includes(p));
};

/* ── P2: el pase no hacía falta ── */
const MIN_RESTO = 80;
function paseInnecesario({ texto, mensaje = '', hechos = {}, motivo = null, resolvio = false } = {}) {
  if (!resolvio || motivo) return false;
  if (hechos.reclamo || hechos.reclamoPorDemora || hechos.objecionPrecio === 'pasar') return false;
  if ((hechos.fichasConPase || []).length) return false;
  if (areaDelCaso({ mensaje, hechos }) === 'reembolso') return false;
  if (pidePersona(mensaje)) return false;
  if ((hechos.adjuntos || []).some((a) => a.clase === 'comprobante_pago' || a.leido === false)) return false;
  if (traePaseFijo(texto)) return false;
  return quitarPase(texto).length >= MIN_RESTO;
}

/* ── Mensajes del chat: [{ id, rol: 0 cliente | 1 nuestro | 3 nota, resp, t (ms), tx, tm }] ── */
const ordenar = (mensajes) => [...(mensajes || [])].filter((m) => m && m.rol !== 3).sort((a, b) => a.t - b.t || a.id - b.id);
const esHumano = (m) => m.rol === 1 && !esAutomatico(m.resp) && m.tm !== 'revoke';
const esDelBot = (m) => m.rol === 1 && /^IA_/i.test(String(m.resp || '')) && !String(m.resp || '').startsWith('IA_Seguimiento');
const PREFIJO_T8 = llano(T.PROACTIVO.sigue_con.split('{')[0]); // «tu caso sigue con»

const DIAS = ['el domingo', 'el lunes', 'el martes', 'el miércoles', 'el jueves', 'el viernes', 'el sábado'];
/** «las 10:15» · «ayer a las 16:30» · «el viernes a las 16:30» (hora de Ecuador o la del horario). */
function formatoDesde(t, ahora, utc = -5) {
  const a = new Date(Number(t) + utc * 3600000);
  const b = new Date(Number(ahora) + utc * 3600000);
  const hora = `las ${a.getUTCHours()}:${String(a.getUTCMinutes()).padStart(2, '0')}`;
  const dias = Math.round((Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())) / 86400000);
  if (dias <= 0) return hora;
  if (dias === 1) return `ayer a ${hora}`;
  return `${DIAS[a.getUTCDay()]} a ${hora}`;
}

/**
 * P4: ¿el chat tiene un pase del bot de menos de 24 h que nadie del equipo
 * contestó? null si no.
 * @returns {{ desde: number, vez: number, t8Enviado: boolean }}
 */
function paseEnEspera({ mensajes = [], ahora = Date.now() } = {}) {
  const ms = ordenar(mensajes);
  let ultimoHumano = -1;
  ms.forEach((m, i) => {
    if (esHumano(m)) ultimoHumano = i;
  });
  const despues = ms.slice(ultimoHumano + 1);
  const i = despues.findIndex((m) => esDelBot(m) && ahora - m.t < H24 && esPase(m.tx));
  if (i < 0) return null;
  const tras = despues.slice(i + 1);
  // Veces que volvió a escribir: cada tanda de mensajes seguidos del cliente.
  let tandas = 0;
  tras.forEach((m, j) => {
    if (m.rol === 0 && (j === 0 || tras[j - 1].rol !== 0)) tandas += 1;
  });
  return {
    desde: despues[i].t,
    vez: Math.max(tandas, 1) + 1,
    t8Enviado: tras.some((m) => esDelBot(m) && llano(m.tx).startsWith(PREFIJO_T8)),
  };
}

/* ── P1: el dato que falta ── */
const RE_GARANTIA =
  /\bgarantia\b|\b(?:llego|llegaron|vino|vinieron|esta|estan|salio|salieron)\s+(?:\w+\s+)?(?:danad\w*|rot[oa]s?|defectuos\w*|fallad\w*|quebrad\w*)\b|\bproductos? (?:danad\w*|defectuos\w*|rot[oa]s?)\b/;
const RE_DROPI = /\b(?:dropi|orden|pedido|cliente final|mi cliente|devolucion)\b/;
const RE_CARGA = /\b(?:carga|contenedor|mercaderia|mercancia|importacion|china|cbm)\b/;
const RE_NUMERO = /\b\d{5,9}\b|\b[a-z]{2,4}\d{6,}\b/;
const RE_FALLA =
  /\b(?:no (?:funciona|prende|enciende|carga|sirve|cierra|abre|calienta|enfria|suena)|rot[oa]s?|quebrad\w*|rajad\w*|danad\w*|defectuos\w*|falla\w*|mancha\w*|fuga|gotea|incomplet\w*|faltan?|faltaba\w*|descosid\w*|despegad\w*|no trae)\b/;
const RE_YA_PAGUE =
  /\b(?:ya (?:pague|deposite|transferi|cancele|hice (?:el|la|mi) (?:pago|transferencia|deposito))|acabo de (?:pagar|depositar|transferir)|(?:realice|hice) (?:el|la|un|una|mi) (?:pago|transferencia|deposito)|ya (?:esta|quedo) (?:pagad[oa]|cancelad[oa]))\b/;
const RE_NO_LLEGA =
  /\b(?:no (?:le |me |nos )?(?:ha |han )?llega\w*|no (?:le |me )?llego|no ha llegado|donde (?:esta|va|anda) (?:mi|el) (?:pedido|paquete)|novedad (?:de|en|con) (?:mi|el|la) (?:pedido|paquete|guia|entrega)|no (?:lo|la) (?:han )?entregad\w*)\b/;
const RE_ENVIO_TIENDA = /\b(?:pedido|paquete|guia|dropi|cliente|courier|servientrega|laar|transportadora)\b/;
const esFotoOVideo = (m) => /^(?:image|imagen|video|sticker)$/i.test(String(m.tm || '')) || /\[imagen:/i.test(String(m.tx || ''));
const esArchivo = (m) => esFotoOVideo(m) || /^(?:document|documento)$/i.test(String(m.tm || ''));

/**
 * P1: ¿falta un dato que la persona va a pedir de todos modos?
 * Se pide UNA vez: si el bot ya lo pidió en 24 h, no se vuelve a pedir.
 * @returns {'pide_garantia'|'pide_comprobante'|'pide_guia'|null}
 */
function datoQueFalta({ mensaje = '', hechos = {}, mensajes = [], ahora = Date.now() } = {}) {
  const ms = ordenar(mensajes).filter((m) => ahora - m.t < H24);
  const pedidos = ['pide_garantia', 'pide_comprobante', 'pide_guia'].map((k) => llano(T.PROACTIVO[k]).split('{')[0].slice(0, 30));
  if (ms.some((m) => esDelBot(m) && pedidos.some((p) => llano(m.tx).startsWith(p)))) return null;
  const delCliente = ms.filter((m) => m.rol === 0);
  const texto = llano([...delCliente.map((m) => m.tx), mensaje].join('\n'));
  const adj = hechos.adjuntos || [];
  const foto = adj.some((a) => a.tipo === 'imagen' || a.tipo === 'video') || delCliente.some(esFotoOVideo);
  const archivo = foto || adj.some((a) => a.tipo === 'documento') || delCliente.some(esArchivo);
  const ahoraDice = llano(mensaje);
  const deTienda = hechos.esEcommerce || RE_DROPI.test(texto);

  if (RE_GARANTIA.test(ahoraDice) && deTienda && !RE_CARGA.test(ahoraDice)) {
    if (!(RE_NUMERO.test(texto) && foto && RE_FALLA.test(texto.replace(/\bgarantia\b/g, '')))) return 'pide_garantia';
    return null;
  }
  if (RE_YA_PAGUE.test(ahoraDice) && !archivo) return 'pide_comprobante';
  if (RE_NO_LLEGA.test(ahoraDice) && (hechos.esEcommerce || RE_ENVIO_TIENDA.test(ahoraDice)) && !RE_CARGA.test(ahoraDice) && !RE_NUMERO.test(texto))
    return 'pide_guia';
  return null;
}

/* ── T4: datos para la factura ── */
const RE_ETIQUETA =
  /^\s*[-•*]?\s*(nombres?(?: completos?| y apellidos?)?|apellidos?|razon social|cedula(?: o ruc| \/ ruc)?|ruc(?: o cedula)?|c\.?\s?i\.?|identificacion|direccion|ciudad|provincia|correo(?: electronico)?|e-?mail|telefono|celular)\s*[:\-=]\s*(.+)$/;
/**
 * @returns {{ datos: string, resumen: string }} o null
 * Solo si alguien habló de la factura en los últimos 3 días (o el cliente
 * ahora): con las mismas etiquetas llegan los datos de una entrega.
 */
function datosFactura({ mensaje = '', mensajes = [], ahora = Date.now() } = {}) {
  const lineas = String(mensaje || '').split('\n');
  const campos = [];
  for (const l of lineas) {
    const m = RE_ETIQUETA.exec(llano(l));
    if (!m) continue;
    const valor = l.slice(l.search(/[:\-=]/) + 1).trim();
    campos.push({ etiqueta: m[1], valor, linea: l.trim() });
  }
  if (campos.length < 3) return null;
  const hablaFactura = /\bfactur/.test(llano(mensaje)) || ordenar(mensajes).some((m) => ahora - m.t < H72 && /\bfactur/.test(llano(m.tx)));
  if (!hablaFactura) return null;
  const nombre = campos.find((c) => /^(?:nombre|razon social)/.test(c.etiqueta));
  const id = campos.find((c) => /^(?:cedula|ruc|c\.?\s?i|identificacion)/.test(c.etiqueta));
  const digitos = id ? (id.valor.replace(/\D/g, '').match(/^\d{10}$|^\d{13}$/) || [])[0] : null;
  if (!nombre || !nombre.valor || !digitos) return null;
  const ciudad = campos.find((c) => c.etiqueta === 'ciudad');
  const datos = `${nombre.valor}, cédula/RUC terminado en ${digitos.slice(-4)}` + (ciudad && ciudad.valor ? `, ${ciudad.valor}` : '');
  return { datos, resumen: campos.map((c) => c.linea).join(' · ').slice(0, 600) };
}

/* ── T5: «¿a las cuentas de la cotización?» ── */
const RE_CUENTAS_COTIZACION =
  /\bcuentas?\b[^?]{0,60}\bcotizacion\b|\bcotizacion\b[^?]{0,60}\bcuentas?\b/;
const RE_NUM_COTIZACION = /cotizaci[oó]n\s*(?:#|n[°º.]?\s*|nro\.?\s*|numero\s*|número\s*)?(\d{3,})/i;
/** El número de la última cotización que le mandamos (3 días), si pregunta por sus cuentas. */
function cuentasDeCotizacion({ mensaje = '', mensajes = [], ahora = Date.now() } = {}) {
  const t = llano(mensaje);
  if (!RE_CUENTAS_COTIZACION.test(t) || !/\b(?:pag\w*|deposit\w*|transfer\w*)\b|\?/.test(t)) return null;
  const nuestros = ordenar(mensajes).filter((m) => m.rol === 1 && ahora - m.t < H72).reverse();
  for (const m of nuestros) {
    const r = RE_NUM_COTIZACION.exec(String(m.tx || ''));
    if (r) return r[1];
  }
  return null;
}

/**
 * Decide qué hace el bot proactivo con la respuesta que va a salir.
 * @param {object} p
 *   texto      lo que el bot va a mandar
 *   mensaje    lo que escribió el cliente (la ráfaga)
 *   hechos     los del turno (turno.js); motivo de pasar_a_humano; resolvio
 *              = una herramienta o una ficha sin pase contestó algo
 *   mensajes   del chat, 3 días; ahora (ms)
 *   horario, horarioEcommerce  los de la cuenta
 *   quien      async (hechosExtra) → { decision, nombre, areaPersona } | null
 * @returns null (sale igual y se escala como siempre) o
 *   { accion, texto, escalar: 'no'|'normal'|'forzar', razon, hechosExtra?, resumen?, nota?, notaSiempre? }
 */
async function decidirProactivo(p) {
  const { texto = '', mensaje = '', hechos = {}, motivo = null, mensajes = [], ahora = Date.now() } = p;
  const horario = p.horario || HORARIO_EQUIPO;
  const horarioEcommerce = p.horarioEcommerce || HORARIO_ECOMMERCE;

  /* SM: pide su shipping mark (FAQ de Daniel, 27-oct). Va antes que el resto
     porque no depende de lo que contestó el modelo: con la marca a la vista
     se le da; si su cotización no está aprobada o no hay marca, se pasa a
     cotizaciones con el pase de P3. Sin el «aprobado» (textos.js), nada. */
  // Solo con su propia carga: nunca si pide datos de otra persona.
  if (T.SHIPPING_MARK_APROBADO === true && !hechos.pideDatosDeOtro) {
    const sm = shippingMark({ mensaje, carga: hechos.carga });
    if (sm && sm.caso === 'marca')
      return { accion: 'SM', texto: llenar(T.SHIPPING_MARK.marca, sm), escalar: 'no', razon: `pide el shipping mark: ${sm.marca} (cotización #${sm.n})` };
    if (sm && sm.caso === 'varias' && T.SHIPPING_MARK_VARIAS_APROBADO === true)
      return {
        accion: 'SM',
        texto: llenar(T.SHIPPING_MARK.varias, { lista: listaDeMarcas(sm.marcas) }),
        escalar: 'no',
        razon: `pide el shipping mark: tiene ${sm.marcas.length} marcas vigentes`,
      };
    if (sm && sm.caso !== 'varias') {
      const extra = { areaForzada: 'cotizacion', shippingMark: sm.caso, ...(sm.n ? { cotizacionShippingMark: sm.n } : {}) };
      let q = null;
      try {
        q = p.quien ? await p.quien(extra) : null;
      } catch (_) {
        q = null;
      }
      const cuando = q && q.nombre ? cuandoTeEscribe(ahora, horario) : null;
      if (cuando) {
        const deArea = T.DE_AREA[q.areaPersona];
        const paseTx = llenar(deArea ? T.PROACTIVO.pase : T.PROACTIVO.pase_sin_area, { nombre: q.nombre, de_area: deArea, cuando });
        return {
          accion: 'SM',
          texto: `${llenar(T.SHIPPING_MARK[sm.caso], sm)} ${paseTx}`,
          escalar: 'forzar',
          hechosExtra: extra,
          notaSiempre: true,
          razon: sm.caso === 'sin_aprobar' ? `pide el shipping mark y la cotización #${sm.n} no está aprobada` : 'pide el shipping mark y no tiene marca registrada',
        };
      }
    }
  }

  const pase = esPase(texto);
  if (!pase && !esAcuse(texto)) return null;

  const n = cuentasDeCotizacion({ mensaje, mensajes, ahora });
  if (n) return { accion: 'T5', texto: llenar(T.PROACTIVO.cuentas_cotizacion, { n }), escalar: 'no', razon: `pregunta si paga a las cuentas de la cotización #${n}` };

  const f = datosFactura({ mensaje, mensajes, ahora });
  if (f)
    return {
      accion: 'T4',
      texto: llenar(T.PROACTIVO.datos_factura, { datos: f.datos }),
      escalar: 'forzar',
      hechosExtra: { areaForzada: 'factura' },
      resumen: f.resumen,
      notaSiempre: true,
      razon: 'mandó sus datos para la factura: se confirman y quedan en la nota',
    };

  if (!pase) return null;
  if (!esPaseReal(texto)) return { accion: 'P2', texto, escalar: 'no', razon: 'el pase era condicional («si…»): no deja el caso a nadie' };
  if (paseInnecesario({ texto, mensaje, hechos, motivo, resolvio: p.resolvio }))
    return { accion: 'P2', texto: quitarPase(texto), escalar: 'no', razon: 'ya respondió con una herramienta o una ficha: no hace falta pasarlo' };

  let q = null;
  try {
    q = p.quien ? await p.quien() : null;
  } catch (_) {
    q = null;
  }
  const nombre = q && q.nombre;
  const utc = Number((horario && horario.utc) != null ? horario.utc : -5);

  const espera = paseEnEspera({ mensajes, ahora });
  if (espera) {
    const desde = formatoDesde(espera.desde, ahora, utc);
    const resto = quitarPase(texto);
    const t8 = !espera.t8Enviado && nombre ? llenar(T.PROACTIVO.sigue_con, { nombre, desde }) : '';
    return {
      accion: 'P4',
      texto: [resto.length >= 40 ? resto : '', t8].filter(Boolean).join('\n\n'),
      escalar: 'no',
      nota: `🔔 El cliente volvió a escribir (${espera.vez}.ª vez) y nadie le responde desde ${desde}.`,
      razon: `ya tiene un pase sin respuesta desde ${desde}: no se vuelve a pasar${espera.t8Enviado ? ' (T8 ya salió)' : ''}`,
    };
  }

  const falta = datoQueFalta({ mensaje, hechos, mensajes, ahora });
  if (falta && (falta === 'pide_comprobante' || nombre))
    return { accion: 'P1', texto: cambiarPase(texto, llenar(T.PROACTIVO[falta], { nombre })), escalar: 'no', razon: `falta el dato (${falta}): se pide una vez antes de pasar` };

  if (!q || !nombre) return null;
  const area = q.decision.area;
  const ecommerce = area === 'ecommerce' || q.areaPersona === 'ecommerce';
  const cuando = cuandoTeEscribe(ahora, ecommerce ? horarioEcommerce : horario);
  if (!cuando) return null;
  const deArea = T.DE_AREA[q.areaPersona];
  const plantilla = area === 'reembolso' ? T.PROACTIVO.pase_directo : deArea ? T.PROACTIVO.pase : T.PROACTIVO.pase_sin_area;
  return {
    accion: 'P3',
    texto: cambiarPase(texto, llenar(plantilla, { nombre, de_area: deArea, cuando })),
    escalar: 'normal',
    notaSiempre: true,
    razon: `pase a ${nombre} con hora (${cuando})`,
  };
}

module.exports = {
  esPaseReal,
  quitarPase,
  cambiarPase,
  paseInnecesario,
  paseEnEspera,
  formatoDesde,
  datoQueFalta,
  datosFactura,
  cuentasDeCotizacion,
  decidirProactivo,
};
