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
 * `ver_mi_carga` no se ofrece. Con `diagnostico: true` se ofrece además
 * `revisar_mi_imporchat`, que revisa la cuenta de IMPORCHAT de ese mismo
 * número (diagnosticoCuenta.js). Es la única con un dato: si ese número no
 * tiene cuenta, el alumno puede escribir el número o el correo con que se
 * registró, y solo vale si está en su mensaje de este turno. Con `pagos: true`
 * se ofrece `ver_mis_pagos`: cuotas, saldo, pagos registrados y facturas del
 * alumno de ese mismo número (pagosCliente.js), solo lectura.
 */
const { cargasDelTelefono, bloqueCarga, codigosEnMensaje, textoParaCliente } = require('./cargaCliente');
const T = require('./textos');
const { hablaDeCarga, hablaDeImporchat } = require('./intencion');
const { diagnosticarCuenta } = require('./diagnosticoCuenta');
const { pagosDelTelefono, bloquePagos, textoPagosParaCliente, variantesDeMontos, pidePagos } = require('./pagosCliente');

const NO_VERIFICABLE =
  'No se puede consultar la carga por este canal. Pide la marca o el número de cotización y pasa el caso a logística.';

function crearHerramientas({
  telefono,
  mensaje = '',
  canalVerificable = false,
  cargas = true,
  diagnostico = false,
  pagos = false,
  idConfiguracionPropia = null,
  deps = {},
} = {}) {
  let ultimaCarga = null;
  let ultimoDiagnostico = null;
  let ultimosPagos = null;
  let ultimoPase = null; // motivo de pasar_a_humano (lo usa el escalado por área)

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

  const revisarMiImporchat = {
    definicion: {
      name: 'revisar_mi_imporchat',
      description:
        'Revisa la cuenta de IMPORCHAT de ESTE cliente y dice qué está fallando y qué tutorial lo resuelve: WhatsApp desconectado, bot apagado, llave de OpenAI sin saldo o inválida, plan suspendido, columnas sin IA. ' +
        'Úsala cuando diga que su IMPORCHAT, su bot o su asistente no responde, no funciona, se desconectó o da error. Primero úsala SIN dato: busca por el número desde el que escribe. ' +
        'Si responde que no encontró la cuenta y pide el número o el correo con que se registró, transmite eso; cuando el cliente lo escriba, vuelve a usarla con ese dato tal cual lo escribió. ' +
        'Nunca pongas un dato que el cliente no escribió en su último mensaje. Responde con lo que devuelve, con sus enlaces, sin agregar fallas que no estén ahí.',
      input_schema: {
        type: 'object',
        properties: {
          dato: {
            type: 'string',
            description: 'Solo si la revisión anterior no encontró su cuenta: el número de WhatsApp o el correo con el que el cliente dice que se registró, copiado de su último mensaje. Si no, no lo pongas.',
          },
        },
        additionalProperties: false,
      },
    },
    ejecutar: async (input = {}) => {
      if (!canalVerificable) return T.DIAGNOSTICO_FRASES.no_verificable;
      // Base de IMPORCHAT: clave aparte de deps.consultar, que es la de Imporsuit (ver_mi_carga).
      const r = await diagnosticarCuenta(telefono, {
        consultar: deps.consultarImporchat,
        verificarAcceso: deps.verificarAcceso,
        ahora: deps.ahora,
        estadosReconectar: deps.estadosReconectar,
        ajustesIA: deps.ajustesIA,
        propia: idConfiguracionPropia,
        dato: typeof input?.dato === 'string' ? input.dato : '',
        mensaje,
      });
      ultimoDiagnostico = r;
      return r.texto;
    },
  };

  const verMisPagos = {
    definicion: {
      name: 'ver_mis_pagos',
      description:
        'Lee de la cartera las cuotas, el saldo pendiente, los pagos registrados y las facturas (número y PDF) de ESTE cliente, buscando solo por el número de WhatsApp desde el que escribe. ' +
        'Úsala cuando pregunte cuánto debe, su saldo, su próxima cuota o fecha de pago, si se registró un pago, o pida su factura. ' +
        'No recibe datos: nunca le pidas su número ni uses el de otra persona. ' +
        'Responde solo con lo que devuelve, con los montos escritos tal cual. Un comprobante que acaba de mandar no lo confirmas: lo registra cobranza.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    ejecutar: async () => {
      if (!canalVerificable)
        return 'No se pueden consultar pagos por este canal. No digas montos: pasa el caso a cobranza con pasar_a_humano (motivo pago).';
      const r = await pagosDelTelefono(telefono, { consultar: deps.consultar });
      ultimosPagos = r;
      return bloquePagos(r);
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
    ejecutar: async (input = {}) => {
      ultimoPase = ['pago', 'reclamo', 'cotizacion', 'otro'].includes(input.motivo) ? input.motivo : 'otro';
      return `Responde exactamente: ${input.motivo === 'reclamo' ? T.MENSAJE_RECLAMO : T.MENSAJE_ASESOR}`;
    },
  };

  return {
    lista: [
      ...(cargas ? [verMiCarga] : []),
      ...(diagnostico ? [revisarMiImporchat] : []),
      ...(pagos ? [verMisPagos] : []),
      pasarAHumano,
    ],
    cargaConsultada: () => ultimaCarga,
    diagnosticoConsultado: () => ultimoDiagnostico,
    pagosConsultados: () => ultimosPagos,
    paseConsultado: () => ultimoPase,
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
 *
 * Lo mismo con el diagnóstico de IMPORCHAT: si la cuenta se revisó y se
 * encontró algo concreto, el texto seguro es ese diagnóstico (sale del
 * catálogo fijo y ya trae sus enlaces) en vez de «un asesor te escribe». Con
 * `sin_causa` o un error se queda el asesor.
 *
 * Con los pagos: cada monto leído entra al respaldo también en las formas en
 * que lo puede escribir el modelo («$1.250», «1250 USD»). Si la guardia
 * rechaza y el cliente preguntaba su saldo o su factura (no «ya pagué»), el
 * texto seguro es el armado en código con la cartera.
 * Lo usan el motor (paso 9.5), el simulador y las pruebas.
 */
function sumarHechosHerramientas(
  hechos,
  extraHerramientas = [],
  cargaConsultada = null,
  { mensaje = '', respuesta = '', diagnostico = null, pagos = null } = {},
) {
  if (!extraHerramientas.length || !hechos?.respaldo) return hechos;
  const r = hechos.respaldo;
  const extra = extraHerramientas.join('\n');
  r.firme = `${String(r.firme || '')}\n${extra}`;
  if (pagos?.estado === 'encontrado') r.firme += `\n${variantesDeMontos(pagos)}`;
  r.estado = cargaConsultada && !hechos.carga
    ? `${Object.values(T.TEXTOS_FIJOS).join('\n')}\n${extra}`
    : `${String(r.estado || '')}\n${extra}`;
  const deCarga = hablaDeCarga(String(mensaje || '')) || hablaDeCarga(String(respuesta || ''));
  if (cargaConsultada?.estado === 'encontradas' && deCarga && hechos.textoSeguro === T.MENSAJE_ASESOR) {
    const t = textoParaCliente(cargaConsultada, T.MENSAJE_ASESOR);
    if (t) hechos.textoSeguro = t;
  }
  // Si se buscó con el número o el correo que escribió, ese mensaje es un dato
  // suelto («ana@gmail.com») y no habla de IMPORCHAT, pero la pregunta sí lo era.
  const deImporchat =
    diagnostico?.por === 'dato' ||
    hablaDeImporchat(String(mensaje || '')) ||
    hablaDeImporchat(String(respuesta || ''));
  if (
    diagnostico?.estado === 'revisada' &&
    diagnostico.resultado !== 'sin_causa' &&
    deImporchat &&
    hechos.textoSeguro === T.MENSAJE_ASESOR &&
    String(diagnostico.texto || '').length <= 1400
  ) {
    hechos.textoSeguro = diagnostico.texto;
  }
  // Si no encontró la cuenta, el texto fijo pide el número o el correo: si la
  // guardia rechaza cómo lo dijo el modelo, se manda ese y no el «un asesor».
  if (
    ['sin_cuenta', 'pide_dato', 'limite', 'ambiguo'].includes(diagnostico?.estado) &&
    hechos.textoSeguro === T.MENSAJE_ASESOR &&
    String(diagnostico.texto || '').length <= 1400
  ) {
    hechos.textoSeguro = diagnostico.texto;
  }
  const pide = pidePagos(String(mensaje || ''));
  if (pide && hechos.textoSeguro === T.MENSAJE_ASESOR) {
    const t = textoPagosParaCliente(pagos, { pideFactura: pide === 'factura' });
    if (t) hechos.textoSeguro = t;
  }
  return hechos;
}

module.exports = { crearHerramientas, sumarHechosHerramientas, NO_VERIFICABLE };
