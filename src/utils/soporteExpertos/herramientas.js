/**
 * Herramientas del bot de soporte de Expertos (tramo 1): consultar la carga
 * del cliente y pasar el caso a una persona.
 *
 * El número del cliente y su mensaje llegan por cierre desde el motor, nunca
 * por lo que pida el modelo: los esquemas no tienen ningún campo de
 * identidad, así que «dame la carga del 0991234567» no puede consultar ese
 * número. Fuera de WhatsApp (chat de prueba del panel, Instagram, Messenger)
 * el número no es verificable y no se consulta nada, igual que en
 * `prepararTurno`. Si la cuenta tiene la carga apagada (`cargas: false`),
 * `ver_mi_carga` no se ofrece.
 */
const { cargasDelTelefono, bloqueCarga, codigosEnMensaje, textoParaCliente } = require('./cargaCliente');
const T = require('./textos');
const { hablaDeCarga } = require('./intencion');

const NO_VERIFICABLE =
  'No se puede consultar la carga por este canal. Pide la marca o el número de cotización y pasa el caso a logística.';

function crearHerramientas({ telefono, mensaje = '', canalVerificable = false, cargas = true, deps = {} } = {}) {
  let ultimaCarga = null;

  const verMiCarga = {
    definicion: {
      name: 'ver_mi_carga',
      description:
        'Lee del sistema de cargas el estado de la carga de ESTE cliente, buscando solo por el número de WhatsApp desde el que escribe. ' +
        'Úsala cuando pregunte por su carga, su contenedor, cuándo llega o en qué va, y no tengas ya el bloque 📦 con su carga. ' +
        'No recibe datos: nunca le pidas su número ni uses el número de otra persona. ' +
        'Si dice que no hay carga o que el número está en varios clientes, no inventes: sigue lo que diga el resultado.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    ejecutar: async () => {
      if (!canalVerificable) return NO_VERIFICABLE;
      const r = await cargasDelTelefono(telefono, { consultar: deps.consultar, hoy: deps.hoy });
      ultimaCarga = r;
      return bloqueCarga(r, { codigos: codigosEnMensaje(String(mensaje || '')), mensajeAsesor: T.MENSAJE_ASESOR });
    },
  };

  const pasarAHumano = {
    definicion: {
      name: 'pasar_a_humano',
      description:
        'Pasa el caso a una persona del equipo. Úsala cuando el caso necesite a alguien (un pago que hay que revisar, un reclamo, una cotización nueva, algo que no está en tu información). ' +
        'Te devuelve el texto exacto que tienes que responder; no agregues nada más.',
      input_schema: {
        type: 'object',
        properties: { motivo: { type: 'string', enum: ['pago', 'reclamo', 'cotizacion', 'otro'] } },
        required: ['motivo'],
        additionalProperties: false,
      },
    },
    ejecutar: async (input = {}) =>
      `Responde exactamente: ${input.motivo === 'reclamo' ? T.MENSAJE_RECLAMO : T.MENSAJE_ASESOR}`,
  };

  return {
    lista: cargas ? [verMiCarga, pasarAHumano] : [pasarAHumano],
    cargaConsultada: () => ultimaCarga,
  };
}

/**
 * Suma a los hechos del turno lo que trajeron las herramientas, antes de la
 * guardia. Fechas y cifras se comparan contra `firme`. Las frases de estado
 * («en tránsito», «en aduana») contra `estado`: si la herramienta trajo la
 * carga, de su estado solo habla lo que trajo (igual que en `prepararTurno`),
 * para que una ficha que explica los pasos no respalde «la tuya está en aduana».
 *
 * Si la guardia rechaza y el texto seguro era «un asesor te escribe», pasa a
 * ser el estado real de la carga, pero solo si el cliente o la respuesta del
 * modelo hablaban de la carga (una pregunta de cobranza sigue yendo al asesor).
 * Lo usan el motor (paso 9.5), el simulador y las pruebas.
 */
function sumarHechosHerramientas(hechos, extraHerramientas = [], cargaConsultada = null, { mensaje = '', respuesta = '' } = {}) {
  if (!extraHerramientas.length || !hechos?.respaldo) return hechos;
  const r = hechos.respaldo;
  const extra = extraHerramientas.join('\n');
  r.firme = `${String(r.firme || '')}\n${extra}`;
  r.estado = cargaConsultada && !hechos.carga
    ? `${Object.values(T.TEXTOS_FIJOS).join('\n')}\n${extra}`
    : `${String(r.estado || '')}\n${extra}`;
  const deCarga = hablaDeCarga(String(mensaje || '')) || hablaDeCarga(String(respuesta || ''));
  if (cargaConsultada?.estado === 'encontradas' && deCarga && hechos.textoSeguro === T.MENSAJE_ASESOR) {
    const t = textoParaCliente(cargaConsultada, T.MENSAJE_ASESOR);
    if (t) hechos.textoSeguro = t;
  }
  return hechos;
}

module.exports = { crearHerramientas, sumarHechosHerramientas, NO_VERIFICABLE };
