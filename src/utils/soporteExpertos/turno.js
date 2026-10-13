/* Lo que el bot de soporte de Expertos hace alrededor del modelo en cada turno.
   Se enciende por cuenta con `ia_ajustes → soporte_expertos` (utils/ajustesIA);
   una cuenta sin ese ajuste no pasa por aquí.

   ANTES de llamar al modelo — `prepararTurno`:
     1. lee qué llegó además de texto (nota de voz, imagen, documento…);
     2. si el mensaje habla de la carga, la busca por el teléfono del que
        escribe y arma el bloque con su estado real;
     3. trae las fichas de la base que pasan el umbral de cercanía (3 como
        mucho, y ninguna si nada se parece lo suficiente);
     4. marca si está pidiendo datos de otra persona.
   Devuelve el bloque de contexto, el mensaje como lo debe ver el modelo y los
   «hechos» del turno.

   DESPUÉS — `revisarTurno`: pasa la respuesta por la guardia con esos hechos.

   El motor de IMPORCHAT no tiene llamadas a funciones (la única herramienta
   que le pasa a OpenAI es la búsqueda en archivos), así que la carga entra
   como consulta previa inyectada al contexto: el mismo patrón que ya usa para
   la orden de Dropi y el retiro en agencia. */

'use strict';

const { leerAdjuntos } = require('./adjuntos');
const { hablaDeCarga, pideDatosDeOtro } = require('./intencion');
const { cargasDelTelefono, bloqueCarga, textoParaCliente, codigosEnMensaje } = require('./cargaCliente');
const { buscadorDeArchivo, bloqueFichas } = require('./fichas');
const { revisarRespuesta } = require('./guardia');
const { paisDelTelefono } = require('./telefono');
const T = require('./textos');

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

/**
 * @param {object} p
 *   mensaje, telefono, tipo_mensaje, id_configuracion, id_cliente,
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
    bloques.push(bloqueCarga(carga, { codigos: codigosEnMensaje(dicho), mensajeAsesor: T.MENSAJE_ASESOR }));
  }
  const textoCarga = carga?.estado === 'encontradas' ? textoParaCliente(carga, T.MENSAJE_ASESOR) : null;

  // ── Fichas de la base ─────────────────────────────────────────────────
  let fichas = [];
  if (opciones.fichas && dicho.trim()) {
    try {
      const buscador = deps.buscador || buscadorDeArchivo();
      const pais = paisDelTelefono(p.telefono);
      fichas = buscador.buscar(dicho, { pais: pais === 'ec' || pais === 'mx' ? pais : null });
      const bloque = bloqueFichas(fichas, { hayCarga: Boolean(textoCarga) });
      if (bloque) bloques.push(bloque);
    } catch (e) {
      await log(`⚠️ soporte_expertos: no se pudieron leer las fichas (${e.message}); el turno sigue sin ellas`);
    }
  }

  // ── Qué hacer con un adjunto que no se pudo leer y vino solo ──────────
  if (adj.soloIlegible) {
    bloques.push(
      'ℹ️ Llegó algo que no puedes abrir y el cliente no escribió para qué es. Si en la conversación ya se sabe de qué se trata, ' +
        `aplica el caso de los adjuntos de tus instrucciones; si no se sabe, responde exactamente: ${T.MENSAJE_ADJUNTO_SIN_TEXTO}`,
    );
  }

  // ── Hechos del turno: con esto revisa la guardia ──────────────────────
  const fichasVistas = new Map(previo?.fichas || []);
  for (const { ficha } of fichas) fichasVistas.set(ficha.id, ficha);
  guardar(clave, { ts: ahora, telefono: String(p.telefono), carga: carga || null, cargaTs, fichas: fichasVistas });

  /* Fichas que pasan el caso a una persona (`pasar_a`): no pueden cerrar solas.
     La guardia agrega el paso a asesor si el modelo contestó con una y lo omitió. */
  const fichasConPase = [...fichasVistas.values()]
    .filter((f) => f.pasar_a && f.respuesta_base)
    .map((f) => ({ id: f.id, partes: [f.respuesta_base, ...f.pasos] }));

  const bloqueDeCarga = carga ? bloques.find((b) => b.startsWith('📦')) || '' : '';
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
    if (textoCarga) textoSeguro = textoCarga;
    else if (carga.estado === 'sin_carga' || carga.estado === 'solo_historicas') textoSeguro = T.MENSAJE_SIN_CARGA;
    else textoSeguro = T.MENSAJE_CARGA_A_LOGISTICA;
  }

  await log(
    `🎓 soporte_expertos: carga=${carga ? `${carga.estado}${carga.cargas.length ? ` (${carga.cargas.length})` : ''}` : 'no consultada'}` +
      ` · fichas=[${fichas.map((f) => `${f.ficha.id} ${f.cercania ?? ''}`.trim()).join(', ')}]` +
      ` · adjuntos=${adj.adjuntos.map((a) => a.tipo + (a.leido ? '' : '✗')).join(',') || '0'}` +
      (adj.esNotaDeVoz ? ' · nota de voz' : '') +
      (otro.pide ? ` · pide datos ajenos (${otro.motivo})` : ''),
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
    respaldo: { firme: fijos, eco: String(mensaje || ''), estado: fijos },
    textoSeguro: T.MENSAJE_ASESOR,
  };
}

/** Pasa la respuesta del modelo por la guardia con los hechos del turno. */
function revisarTurno(respuesta, hechos) {
  return revisarRespuesta(respuesta, hechos || hechosDeEmergencia());
}

/** Solo para pruebas. */
function olvidarTodo() {
  memoria.clear();
}

module.exports = { prepararTurno, revisarTurno, hechosDeEmergencia, olvidarTodo, MINUTOS_MEMORIA };
