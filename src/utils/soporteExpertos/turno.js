/* Lo que el bot de soporte de Expertos hace alrededor del modelo en cada turno.
   Se enciende por cuenta con `ia_ajustes → soporte_expertos` (utils/ajustesIA);
   una cuenta sin ese ajuste no pasa por aquí.

   ANTES de llamar al modelo — `prepararTurno`:
     1. lee qué llegó además de texto (nota de voz, imagen, documento…);
     2. si el mensaje habla de la carga, la busca por el teléfono del que
        escribe y arma el bloque con su estado real;
     3. trae las fichas de la base que pasan el umbral de cercanía (3 como
        mucho, y ninguna si nada se parece lo suficiente);
     4. marca si está pidiendo datos de otra persona, si reclama y si solo
        saluda (señales para la guardia; ver `senales.js`).
   Devuelve el bloque de contexto, el mensaje como lo debe ver el modelo y los
   «hechos» del turno.

   DESPUÉS — `revisarTurno`: pasa la respuesta por la guardia con esos hechos.

   El motor de IMPORCHAT no tiene llamadas a funciones (la única herramienta
   que le pasa a OpenAI es la búsqueda en archivos), así que la carga entra
   como consulta previa inyectada al contexto: el mismo patrón que ya usa para
   la orden de Dropi y el retiro en agencia. */

'use strict';

const { leerAdjuntos } = require('./adjuntos');
const { sinTildes } = require('./texto');
const { hablaDeCarga, pideDatosDeOtro } = require('./intencion');
const { cargasDelTelefono, bloqueCarga, textoParaCliente, codigosEnMensaje } = require('./cargaCliente');
const { buscadorDeArchivo, bloqueFichas, buscarConRescate } = require('./fichas');
const { revisarRespuesta } = require('./guardia');
const { paisDelTelefono } = require('./telefono');
const { esSoloSaludo, esReclamo, reclamaPorDemora, dioCantidad, esMensajeDeBot, noPideNada } = require('./senales');
const T = require('./textos');
const { equipoAtendiendo, proximaApertura, textoAlHorario } = require('./horario');
const { esColumnaEcommerce } = require('./escalado');

const MINUTOS_MEMORIA = 20; // la carga leída y las fichas mostradas siguen valiendo para los mensajes que siguen
const MAX_MEMORIA = 3000;

/* cfg:cliente → { ts, telefono, carga, cargaTs, fichas: Map(id → ficha) }. En
   memoria, como agruparRafaga y turnosCallados: una sola instancia; un reinicio
   lo borra y a lo sumo se vuelve a consultar. `ts` se renueva con cada mensaje
   (las fichas ya mostradas siguen respaldando la conversación); `cargaTs` no:
   la carga se vuelve a leer a los 20 minutos de haberla leído, aunque el
   cliente no haya dejado de escribir. */
const memoria = new Map();

function recordar(clave, ahora) {
  const m = memoria.get(clave);
  if (m && ahora - m.ts <= MINUTOS_MEMORIA * 60 * 1000) return m;
  return null;
}
function guardar(clave, valor) {
  memoria.delete(clave);
  memoria.set(clave, valor);
  if (memoria.size > MAX_MEMORIA) memoria.delete(memoria.keys().next().value);
}

const decible = (f) => [f.respuesta_base, ...f.pasos, f.enlace, f.pedir].filter(Boolean).join('\n');

/* Pide otra vez el ESTADO de su carga («¿cuándo llega?», «¿cómo va?», «y mi
   carga?»). Ante la duda, SÍ lo pide: callarle el estado a quien lo pide es
   peor que repetírselo. Lo único que no cuenta: un mensaje sin pregunta que
   cuenta algo largo («lo que ya está en bodega lo dejamos para el contenedor
   del 15») o que pregunta por la recepción de la bodega («hasta cuándo
   reciben»): eso es para el asesor de logística. (Revisión del 24-oct: «qué
   día llega?», «cuánto falta?», «llegó ya?», «tracking?», «info de mi carga
   porfa» se quedaban sin respuesta.) */
const RE_PIDE_ESTADO =
  /\b(?:cuando (?:llega\w*|sale|saldria|estaria|arriba)|(?:que|en que) (?:dia|fecha) (?:llega\w*|sale)|cuanto (?:falta|tarda|demora|se demora)|donde (?:esta|va|anda|se encuentra)|como (?:va|vamos|sigue)|en que (?:va|estado)|(?:el )?estado de (?:mi|la|las|mis)|me (?:das|da|dan|pasas|pasan) (?:el )?(?:estado|status)|status|tracking|rastreo|fecha (?:de|estimada de) llegada|novedad\w*|ya (?:llego|salio|arribo)|llego ya|info\w* (?:de|sobre) (?:mi|la|mis)|^y (?:la|mi|el|los|las|mis) (?:marca|cotizacion|carga|mercaderia|mercancia|importacion|pedido|contenedor)s?)\b/;
const RE_RECEPCION = /\b(?:hasta cuando (?:reciben|recibe|reciban)|reciben|recepcion|cierre|cierra|contenedor del)\b/;
const pideEstado = (t) => {
  const l = sinTildes(String(t || '').toLowerCase());
  if (RE_RECEPCION.test(l)) return false;
  if (RE_PIDE_ESTADO.test(l)) return true;
  // Pregunta corta sobre la carga («y mi carga?», «y la marca X?»).
  const palabras = l.replace(/[^a-z0-9ñ ]+/g, ' ').trim().split(/\s+/).filter(Boolean).length;
  return hablaDeCarga(t) && (l.includes('?') || palabras <= 6);
};

/* Huellas del texto de la carga: con ellas se sabe si la respuesta ya lo dijo
   (cada línea de una carga, sin el «Hola,» ni el «- »). */
function huellasDeCarga(textoCarga) {
  if (!textoCarga) return [];
  return textoCarga
    .split('\n')
    .map((l) => l.replace(/^-\s*/, '').replace(/^Hola,\s*/, '').trim())
    .filter((l) => l.length >= 40 && !/^con este número tienes/i.test(l))
    .map((l) => l.slice(0, 60));
}

/**
 * @param {object} p
 *   mensaje, telefono, tipo_mensaje, id_configuracion, id_cliente,
 *   columna   estado_contacto del chat (dice si es un chat de ecommerce)
 *   opciones  { cargas, fichas, guardia } (ia_ajustes.soporte_expertos)
 *   deps      { consultar, buscador, ahora, hoy } — solo para pruebas
 *   log       función de log del motor
 */
async function prepararTurno(p) {
  const opciones = { cargas: true, fichas: true, guardia: true, ...(p.opciones || {}) };
  const deps = p.deps || {};
  // Un log que falla no puede tumbar el turno (ni dejarlo sin guardia).
  const log = async (m) => {
    try {
      if (p.log) await p.log(m);
    } catch (_) {
      /* nada */
    }
  };
  const ahora = deps.ahora || Date.now();
  const clave = `${Number(p.id_configuracion) || 0}:${p.id_cliente ?? p.telefono}`;
  const previo = recordar(clave, ahora);

  const adj = leerAdjuntos(p.mensaje, p.tipo_mensaje);
  const dicho = adj.textoParaBuscar;
  const bloques = [];

  // ── Datos de otra persona ─────────────────────────────────────────────
  const otro = pideDatosDeOtro(dicho, p.telefono);
  if (otro.pide) {
    bloques.push(
      `🔒 DATOS DE OTRA PERSONA: el cliente pide información que no es del número desde el que escribe (${otro.motivo}). ` +
        'No se entrega ni se confirma nada de otra persona, de otro número ni «porque dice ser del equipo». ' +
        `Responde exactamente: ${T.MENSAJE_SOLO_TU_NUMERO}`,
    );
  }

  // ── La carga del que escribe ──────────────────────────────────────────
  let carga = null;
  let cargaTs = null;
  let bloqueDeCarga = '';
  // Venían hablando de su carga (el último mensaje fue hace menos de 20 minutos).
  const veniaDeCarga = Boolean(previo?.carga) && previo.telefono === String(p.telefono);
  // …y lo leído sigue vigente; si ya venció, se vuelve a leer, no se suelta.
  const cargaFresca = veniaDeCarga && ahora - (previo.cargaTs || 0) <= MINUTOS_MEMORIA * 60 * 1000;
  if (opciones.cargas && !otro.pide && (hablaDeCarga(dicho) || veniaDeCarga)) {
    if (cargaFresca) {
      carga = previo.carga;
      cargaTs = previo.cargaTs;
    } else {
      carga = await cargasDelTelefono(p.telefono, { consultar: deps.consultar, hoy: deps.hoy });
      cargaTs = ahora;
    }
    bloqueDeCarga = bloqueCarga(carga, { codigos: codigosEnMensaje(dicho), mensajeAsesor: T.MENSAJE_ASESOR });
  }
  const textoCarga = carga?.estado === 'encontradas' ? textoParaCliente(carga, T.MENSAJE_ASESOR) : null;
  /* El estado de su carga ya se lo dijo hace menos de 20 minutos y ahora no lo
     vuelve a pedir: no se repite el bloque entero (23-oct: a quien preguntaba
     hasta cuándo recibe la bodega para el contenedor del 30 se le mandó dos
     veces la lista de sus 3 cargas). Lo nuevo que pregunta es para el asesor. */
  const cargaYaDicha =
    Boolean(textoCarga) &&
    Boolean(previo?.cargaDichaTs) &&
    ahora - previo.cargaDichaTs <= MINUTOS_MEMORIA * 60 * 1000 &&
    !pideEstado(dicho);
  if (bloqueDeCarga) {
    bloques.push(
      cargaYaDicha
        ? '📦 CARGA: el estado de su carga YA se lo diste en esta conversación y ahora no lo vuelve a pedir. NO lo repitas ni copies sus líneas. ' +
            'Si pregunta algo que ese estado no dice (hasta cuándo recibe la bodega, pasar su mercadería a otro contenedor, una fecha de corte, otra bodega), ' +
            `es para el asesor de logística: responde exactamente: ${T.MENSAJE_ASESOR}`
        : bloqueDeCarga,
    );
  }

  // ── Fichas de la base ─────────────────────────────────────────────────
  let fichas = [];
  if (opciones.fichas && dicho.trim()) {
    try {
      const buscador = deps.buscador || buscadorDeArchivo();
      const pais = paisDelTelefono(p.telefono);
      fichas = buscarConRescate(buscador, dicho, { pais: pais === 'ec' || pais === 'mx' ? pais : null });
      const bloque = bloqueFichas(fichas, { hayCarga: Boolean(textoCarga) });
      if (bloque) bloques.push(bloque);
    } catch (e) {
      await log(`⚠️ soporte_expertos: no se pudieron leer las fichas (${e.message}); el turno sigue sin ellas`);
    }
  }

  // ── Reclamo ───────────────────────────────────────────────────────────
  /* En la prueba en papel un reclamo («pagué y no me enviaron nada, ¿con quién
     hablo?») salió a cobranza pidiendo el comprobante, y a quien reclamaba por
     la demora se le repitió el estado. El aviso se lo dice al modelo; si igual
     lo hace, la guardia lo frena con el texto seguro de más abajo. */
  const reclamo = !otro.pide && esReclamo(dicho);
  const reclamoPorDemora = !otro.pide && Boolean(carga) && reclamaPorDemora(dicho);
  if (reclamo || reclamoPorDemora) {
    bloques.push(
      '⚠️ RECLAMO: el cliente reclama o está molesto. Va a la persona responsable (no a cobranza ni a otra área) y NO se le pide ningún dato ni comprobante. ' +
        'No discutas, no expliques, no justifiques y no repitas el estado de su carga. ' +
        `Responde exactamente: ${reclamoPorDemora ? T.MENSAJE_RECLAMO_CARGA : T.MENSAJE_RECLAMO}`,
    );
  }

  // ── Qué hacer con un adjunto que no se pudo leer y vino solo ──────────
  if (adj.soloIlegible) {
    bloques.push(
      'ℹ️ Llegó algo que no puedes abrir y el cliente no escribió para qué es. Si en esta conversación TÚ le pediste una captura, la proforma o el comprobante, ' +
        'o en sus últimos mensajes habló de un pago, de una cotización o de un proveedor, es eso: NO le preguntes qué necesita. ' +
        `Responde exactamente: «Recibí lo que enviaste. ${T.CIERRE_ASESOR}» (o «${T.MENSAJE_RECIBIDO}» si ya le avisaste que un asesor lo retoma). ` +
        `Si no se sabe de qué se trata, responde exactamente: ${T.MENSAJE_ADJUNTO_SIN_TEXTO}`,
    );
  }

  // ── ¿El equipo está atendiendo? ───────────────────────────────────────
  /* Los textos fijos dicen «apenas abramos»; de día eso es falso. El modelo los
     sigue usando tal cual (la guardia no le deja prometer tiempos) y al final
     del turno revisarTurno cambia «apenas abramos» por «en breve».
     Solo en la cuenta que declara `horario_equipo`: soporte_expertos también
     está en la 10 (WAPP IMPORTSUIT), con otro equipo y otras horas, y a esa no
     se le cambia el texto (revisión del 24-oct). */
  /* Ecommerce también atiende el sábado de 8:00 a 12:00: el chat que está en
     una columna de ecommerce, o cuya pregunta la responde una ficha de
     ecommerce, usa ese horario (si la cuenta lo trae). */
  const pasarA = fichas[0]?.ficha?.pasar_a || '';
  const esEcommerce = esColumnaEcommerce(p.columna) || pasarA === 'ecommerce';
  const horario = (esEcommerce && opciones.horario_ecommerce) || opciones.horario_equipo || null;
  const atendiendo = Boolean(horario) && equipoAtendiendo(deps.ahora, horario);
  /* Fuera de horario, «apenas abramos» dice cuándo abre el equipo («el lunes
     desde las 8:00»), solo con soporte_expertos.decir_apertura. */
  const apertura = opciones.decir_apertura && horario && !atendiendo ? proximaApertura(deps.ahora, horario) : null;
  if (atendiendo) {
    bloques.push(
      '🕘 AHORA EL EQUIPO ESTÁ ATENDIENDO (horario de oficina). No digas que estamos cerrados, que es fuera de horario ni que es de noche o fin de semana. ' +
        'Usa los textos fijos tal cual están escritos: el sistema ajusta solo cuándo te escribe el asesor.',
    );
  }

  // ── Hechos del turno: con esto revisa la guardia ──────────────────────
  const fichasVistas = new Map(previo?.fichas || []);
  for (const { ficha } of fichas) fichasVistas.set(ficha.id, ficha);
  /* Si en esta conversación ya dijo cuántas unidades quiere, se recuerda: una
     ficha de cotización que la guardia complete no se la vuelve a pedir. */
  const cantidadDicha = Boolean(previo?.dioCantidad) || dioCantidad(dicho);
  guardar(clave, {
    ts: ahora,
    telefono: String(p.telefono),
    carga: carga || null,
    cargaTs,
    // Cuándo se le dijo el estado de la carga (lo marca revisarTurno).
    cargaDichaTs: carga ? previo?.cargaDichaTs || null : null,
    fichas: fichasVistas,
    dioCantidad: cantidadDicha,
    // Cuándo el bot terminó su respuesta con una pregunta (lo marca revisarTurno).
    preguntoTs: previo?.preguntoTs || null,
  });

  /* Fichas que pasan el caso a una persona (`pasar_a`): no pueden cerrar solas.
     La guardia agrega el paso a asesor si el modelo contestó con una y lo omitió
     (y, si la ficha pide la cantidad, también la pide cuando falta). */
  const fichasConPase = [...fichasVistas.values()]
    .filter((f) => f.pasar_a && f.respuesta_base)
    .map((f) => ({ id: f.id, partes: [f.respuesta_base, ...f.pasos], pedir: f.pedir || '' }));

  const firme = [
    ...Object.values(T.TEXTOS_FIJOS),
    ...Object.values(T.LINKS),
    bloqueDeCarga,
    ...[...fichasVistas.values()].map(decible),
  ].join('\n');

  /* Con qué se reemplaza una respuesta que la guardia no deja pasar. */
  let textoSeguro = T.MENSAJE_ASESOR;
  if (otro.pide) textoSeguro = T.MENSAJE_SOLO_TU_NUMERO;
  else if (carga && hablaDeCarga(dicho)) {
    if (cargaYaDicha) textoSeguro = T.MENSAJE_ASESOR;
    else if (textoCarga) textoSeguro = textoCarga;
    else if (carga.estado === 'sin_carga' || carga.estado === 'solo_historicas') textoSeguro = T.MENSAJE_SIN_CARGA;
    else textoSeguro = T.MENSAJE_CARGA_A_LOGISTICA;
  }
  // Un reclamo no se contesta con el estado ni con el paso a cobranza.
  if (reclamoPorDemora) textoSeguro = T.MENSAJE_RECLAMO_CARGA;
  else if (reclamo) textoSeguro = T.MENSAJE_RECLAMO;

  /* El primer saludo de la conversación no se queda sin respuesta. «Primero» =
     no hay nada de este cliente en la memoria (20 minutos): si ya venía
     escribiendo, el saludo anterior ya se contestó, o el modelo calla por algo. */
  const saludoSinContestar = !previo && !adj.adjuntos.length && esSoloSaludo(dicho);

  /* Lo escribió el bot de ventas de la tienda del alumno (senales.js): el motor
     no le contesta, así los dos bots no se quedan hablando. Se mira lo que
     escribió, no la descripción de sus adjuntos. Se apaga con
     soporte_expertos.callar_bots = false. */
  const mensajeDeBot = opciones.callar_bots !== false && esMensajeDeBot(String(p.mensaje || ''));

  /* Solo agradece, confirma o avisa que él hará algo («ok», «listo amigo
     gracias», «el lunes te los paso»): no se contesta (senales.noPideNada).
     Con un adjunto sí se mira (el «ok» puede venir con el comprobante). Se
     apaga con soporte_expertos.callar_acuses = false. */
  const sinPedido =
    opciones.callar_acuses !== false &&
    !adj.adjuntos.length &&
    (!p.tipo_mensaje || p.tipo_mensaje === 'text') &&
    !otro.pide &&
    // «dale», «ok» o «de acuerdo» a una pregunta del bot («¿te envío el
    // tutorial?») es un sí: se contesta (revisión del 24-oct).
    !(previo?.preguntoTs && ahora - previo.preguntoTs <= MINUTOS_MEMORIA * 60 * 1000) &&
    noPideNada(String(p.mensaje || ''));

  await log(
    `🎓 soporte_expertos: carga=${carga ? `${carga.estado}${carga.cargas.length ? ` (${carga.cargas.length})` : ''}` : 'no consultada'}` +
      ` · fichas=[${fichas.map((f) => `${f.ficha.id} ${f.cercania ?? ''}`.trim()).join(', ')}]` +
      ` · adjuntos=${adj.adjuntos.map((a) => a.tipo + (a.leido ? '' : '✗')).join(',') || '0'}` +
      (adj.esNotaDeVoz ? ' · nota de voz' : '') +
      (otro.pide ? ` · pide datos ajenos (${otro.motivo})` : '') +
      (reclamoPorDemora ? ' · reclama por la demora' : reclamo ? ' · reclamo' : '') +
      (saludoSinContestar ? ' · primer saludo' : '') +
      (mensajeDeBot ? ' · mensaje de un bot de tienda' : '') +
      (sinPedido ? ' · no pide nada' : '') +
      (cargaYaDicha ? ' · el estado de la carga ya se dijo' : '') +
      (esEcommerce ? ' · ecommerce' : '') +
      (atendiendo ? ' · equipo atendiendo' : apertura ? ` · abre ${apertura}` : ''),
  );

  return {
    bloque: bloques.join('\n\n'),
    mensaje: adj.mensajeParaModelo, // null = el motor usa el suyo
    hechos: {
      carga,
      fichas: fichas.map((f) => f.ficha.id),
      fichasConPase,
      adjuntos: adj.adjuntos,
      pideDatosDeOtro: otro.pide,
      reclamo,
      reclamoPorDemora,
      saludoSinContestar,
      mensajeDeBot,
      noPideNada: sinPedido,
      cargaYaDicha,
      equipoAtendiendo: atendiendo,
      apertura,
      esEcommerce,
      pasarA,
      huellasCarga: huellasDeCarga(textoCarga),
      clave,
      dioCantidad: cantidadDicha,
      respaldo: {
        firme,
        eco: String(p.mensaje || ''),
        // Si se consultó la carga, de su estado solo habla su bloque.
        estado: carga ? `${Object.values(T.TEXTOS_FIJOS).join('\n')}\n${bloqueDeCarga}` : firme,
      },
      textoSeguro,
    },
  };
}

/**
 * Hechos mínimos para cuando `prepararTurno` no pudo correr: la guardia igual
 * tiene que revisar la respuesta. Sin carga ni fichas, lo único que se puede
 * afirmar son los textos fijos; todo lo demás cae al paso a asesor.
 */
function hechosDeEmergencia(mensaje = '') {
  const fijos = [...Object.values(T.TEXTOS_FIJOS), ...Object.values(T.LINKS)].join('\n');
  return {
    carga: null,
    fichas: [],
    fichasConPase: [],
    adjuntos: [],
    pideDatosDeOtro: false,
    reclamo: false,
    reclamoPorDemora: false,
    saludoSinContestar: false,
    mensajeDeBot: false,
    noPideNada: false,
    cargaYaDicha: false,
    equipoAtendiendo: false,
    apertura: null,
    esEcommerce: false,
    pasarA: '',
    huellasCarga: [],
    clave: null,
    dioCantidad: false,
    respaldo: { firme: fijos, eco: String(mensaje || ''), estado: fijos },
    textoSeguro: T.MENSAJE_ASESOR,
  };
}

/* Con el equipo atendiendo, «apenas abramos» → «en breve»; fuera de horario y
   con `apertura`, → «el lunes desde las 8:00» (horario.js). No cuenta como
   respuesta cambiada: es el mismo texto aprobado, ajustado a la hora. */
function alHorario(rev, h) {
  if ((!h.equipoAtendiendo && !h.apertura) || !rev?.texto) return rev;
  return { ...rev, texto: textoAlHorario(rev.texto, h.equipoAtendiendo, h.apertura) };
}

/** Pasa la respuesta del modelo por la guardia con los hechos del turno. */
function revisarTurno(respuesta, hechos, { ahora = Date.now() } = {}) {
  const h = hechos || hechosDeEmergencia();
  const rev = alHorario(revisarRespuesta(respuesta, h), h);
  /* ¿La respuesta trae el estado de la carga? Si ya se le había dicho y no lo
     volvió a pedir, se cambia por el paso a asesor; si no, se anota que ya se
     le dijo (para el próximo mensaje de esta conversación). */
  const enMemoria = h.clave && memoria.get(h.clave);
  if (enMemoria) enMemoria.preguntoTs = /\?/.test(String(rev.texto || '')) ? ahora : null;
  const huellas = h.huellasCarga || [];
  if (huellas.length && huellas.some((x) => String(rev.texto || '').includes(x))) {
    if (h.cargaYaDicha) {
      return alHorario(
        {
          texto: T.MENSAJE_ASESOR,
          cambiada: true,
          corregida: false,
          motivos: [...(rev.motivos || []), 'repetía el estado de la carga que ya se le había dado'],
        },
        h,
      );
    }
    const m = h.clave && memoria.get(h.clave);
    if (m) m.cargaDichaTs = ahora;
  }
  return rev;
}

/** Solo para pruebas. */
function olvidarTodo() {
  memoria.clear();
}

module.exports = { prepararTurno, revisarTurno, hechosDeEmergencia, olvidarTodo, pideEstado, MINUTOS_MEMORIA };
