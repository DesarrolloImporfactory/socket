'use strict';

/**
 * dropi_novedades_ia.service.js
 *
 * IA en MODO SUGERENCIA para novedades Dropi: lee la conversación con el
 * cliente y propone la solución; NO envía nada a Dropi. El asesor la revisa
 * y la envía desde el modal de solventar.
 *
 * ── Reglas que NO se le dejan al modelo (se aplican en código) ─────────────
 * 1. La solución solo puede afirmar "me comuniqué con el cliente" si el
 *    cliente escribió DESPUÉS de la novedad. Si no respondió, la IA no
 *    propone solución: redacta el mensaje para preguntarle.
 * 2. Reincidencia (el pedido ya se volvió a ofrecer y cayó otra vez en
 *    novedad): siempre la gestiona un asesor.
 * 3. La IA nunca propone devolución ni ajuste de recaudo: una no se puede
 *    deshacer y la otra cambia dinero. Solo "volver a ofrecer".
 *
 * Usa la MISMA api_key_openai del negocio (configuraciones.api_key_openai),
 * igual que la redacción de productos: sin key no corre.
 */

const axios = require('axios');
const { db } = require('../database/config');
const { obtenerApiKeyOpenAI } = require('./producto_descripcion_ia.service');
const { ejecutarTool } = require('./asistente_cuenta.service');

const MODELO = 'gpt-4o-mini';
const TIMEOUT_MS = 45000;
const MAX_MENSAJES = 30;
const MAX_SOLUCION = 200;

const hoyEcuador = () =>
  new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);

const PROMPT_SISTEMA = `Eres el asistente de logística de una tienda que vende contraentrega en Ecuador con Dropi. Un pedido tiene una NOVEDAD (la transportadora no pudo entregarlo) y debes preparar la respuesta para la transportadora a partir de lo que el cliente dijo por WhatsApp.

Trabajas en modo sugerencia: un asesor humano revisa lo que propones antes de enviarlo.

REGLAS
- Usa SOLO lo que el cliente escribió en la conversación. No inventes llamadas, fechas, direcciones ni confirmaciones.
- Solo cuentan los mensajes del cliente marcados [DESPUÉS DE LA NOVEDAD]. Lo que dijo antes no confirma nada sobre esta novedad.
- Tu única solución posible es VOLVER A OFRECER el pedido. Nunca propongas devolución ni cambiar el valor a cobrar: si el caso lo pide, decide "escalar".
- Respeta la guía de la transportadora que se te entrega: si dice que esa novedad NO se soluciona con volver a ofrecer (sin cobertura, novedad operativa, extravío, auditoría), decide "escalar".

DECISIÓN (elige una)
- "proponer": el cliente respondió después de la novedad, quiere recibir el pedido y están los datos que pide la transportadora.
- "pedir_datos": el cliente no ha respondido después de la novedad, o respondió pero falta un dato (día de entrega, dirección completa, referencia, otro número). Redacta el mensaje para pedírselo.
- "escalar": el cliente ya no quiere el pedido, está molesto, pide cambiar el valor, quiere cambiar de ciudad, la guía dice que no aplica volver a ofrecer, o hay algo que no entiendes.

CÓMO ESCRIBIR
- "solucion": texto para la transportadora, máximo 200 caracteres, en primera persona de la tienda, concreto. Ejemplo: "Me he comunicado con el cliente al número 0991234567, confirma que mañana estará en el domicilio y recibirá el pedido." Vacío si no decides "proponer".
- "mensaje_para_cliente": WhatsApp corto y amable para el cliente, que pida exactamente lo que falta. Vacío si decides "proponer".
- "fecha_entrega": YYYY-MM-DD solo si el cliente dijo un día concreto; posterior a hoy. Vacío si no lo dijo.
- "nombre", "telefono", "direccion", "referencia": solo si el cliente dio un dato NUEVO o distinto al del pedido. Vacío si no.
- "confianza": "alta" solo si el cliente fue explícito; "media" si hay que interpretar; "baja" si dudas.
- "motivo": una frase que explique tu decisión al asesor.`;

const ESQUEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'decision',
    'motivo',
    'confianza',
    'solucion',
    'mensaje_para_cliente',
    'fecha_entrega',
    'nombre',
    'telefono',
    'direccion',
    'referencia',
  ],
  properties: {
    decision: { type: 'string', enum: ['proponer', 'pedir_datos', 'escalar'] },
    motivo: { type: 'string' },
    confianza: { type: 'string', enum: ['alta', 'media', 'baja'] },
    solucion: { type: 'string' },
    mensaje_para_cliente: { type: 'string' },
    fecha_entrega: { type: 'string' },
    nombre: { type: 'string' },
    telefono: { type: 'string' },
    direccion: { type: 'string' },
    referencia: { type: 'string' },
  },
};

function errorNegocio(mensaje, codigo) {
  const err = new Error(mensaje);
  err.codigo = codigo;
  return err;
}

/* Últimos mensajes del chat, del más viejo al más nuevo. En mensajes_clientes
   celular_recibe es el id del cliente y rol_mensaje 0 = cliente, 1 = negocio. */
async function leerConversacion({ id_configuracion, idCliente, desde }) {
  if (!idCliente) return { mensajes: [], respuestasTrasNovedad: 0 };
  const filas = await db.query(
    `SELECT rol_mensaje, tipo_mensaje, texto_mensaje, created_at,
            (created_at >= :desde) AS tras_novedad
       FROM mensajes_clientes
      WHERE id_configuracion = :cfg AND celular_recibe = :cliente
      ORDER BY created_at DESC, id DESC
      LIMIT ${MAX_MENSAJES}`,
    {
      replacements: {
        cfg: id_configuracion,
        cliente: idCliente,
        desde: desde || '1970-01-01 00:00:00',
      },
      type: db.QueryTypes.SELECT,
    },
  );
  const mensajes = filas.reverse().map((f) => ({
    deCliente: String(f.rol_mensaje) === '0',
    trasNovedad: Number(f.tras_novedad) === 1,
    texto:
      String(f.texto_mensaje || '').trim().slice(0, 500) ||
      `(${f.tipo_mensaje || 'mensaje sin texto'})`,
    fecha: f.created_at,
  }));
  return {
    mensajes,
    respuestasTrasNovedad: mensajes.filter((m) => m.deCliente && m.trasNovedad)
      .length,
  };
}

async function guiaTransportadora({ novedad, transportadora }) {
  try {
    const r = await ejecutarTool(
      'buscar_ayuda_transportadoras',
      { tema: `novedad ${novedad || ''} ${transportadora || ''}` },
      { idConfiguracion: null, integraciones: {} },
    );
    return (r?.secciones || [])
      .slice(0, 3)
      .map((s) => `### ${s.titulo}\n${s.contenido}`)
      .join('\n\n');
  } catch (_) {
    return '';
  }
}

function construirEntrada({ orden, conversacion, guia, registro, camposRequeridos }) {
  const fmtFecha = (f) =>
    f instanceof Date ? f.toISOString().slice(0, 16).replace('T', ' ') : String(f || '');
  const chat = conversacion.mensajes.length
    ? conversacion.mensajes
        .map(
          (m) =>
            `${m.deCliente ? 'CLIENTE' : 'TIENDA'}${m.deCliente && m.trasNovedad ? ' [DESPUÉS DE LA NOVEDAD]' : ''} (${fmtFecha(m.fecha)}): ${m.texto}`,
        )
        .join('\n')
    : '(no hay conversación con este cliente en ChatCenter)';

  return [
    `HOY: ${hoyEcuador()}`,
    '',
    'PEDIDO',
    `- Orden: ${orden.order_id} | Guía: ${orden.guia || 'sin guía'}`,
    `- Transportadora: ${orden.transportadora || 'desconocida'}`,
    `- Novedad reportada: ${orden.novedad || 'sin detalle'}`,
    `- Fecha de la novedad: ${orden.fechaNovedad || 'desconocida'}`,
    `- Cliente: ${orden.cliente?.nombre || ''} | Tel: ${orden.cliente?.telefono || ''}`,
    `- Dirección del pedido: ${[orden.cliente?.direccion, orden.cliente?.ciudad, orden.cliente?.provincia].filter(Boolean).join(', ')}`,
    `- Productos: ${(orden.productos || []).map((p) => `${p.cantidad}x ${p.nombre}`).join('; ') || 's/d'}`,
    `- Valor a cobrar: ${orden.total ?? 's/d'}`,
    `- Veces que ya se volvió a ofrecer: ${registro.vecesOfrecida}`,
    `- Datos que exige esta transportadora en la solución: ${camposRequeridos.join(', ') || 'solo el texto de la solución'}`,
    '',
    'GUÍA DE LA TRANSPORTADORA PARA ESTA NOVEDAD',
    guia || '(sin información específica)',
    '',
    'CONVERSACIÓN DE WHATSAPP (de la más antigua a la más reciente)',
    chat,
  ].join('\n');
}

/* Datos que el panel de Dropi exige por transportadora (Ecuador). */
function camposPorTransportadora(transportadora) {
  const t = String(transportadora || '').toUpperCase().replace(/\s+/g, '');
  if (t === 'GINTRACOM') return ['posible fecha de entrega (posterior a hoy)'];
  if (t === 'SERVIENTREGA') return ['nombre de quien recibe', 'celular'];
  if (t === 'LAARCOURIER' || t === 'LAAR')
    return ['nombre de quien recibe', 'dirección', 'celular'];
  if (t === 'VELOCES')
    return ['nombre de quien recibe', 'dirección', 'referencia', 'celular'];
  return [];
}

/**
 * Propone qué hacer con la novedad.
 * orden: { order_id, guia, transportadora, novedad, fechaNovedad, cliente,
 *          productos, total }
 * registro: { vecesOfrecida, totalNovedades }
 */
async function sugerirSolucion({ id_configuracion, orden, idCliente, registro }) {
  const apiKey = await obtenerApiKeyOpenAI(id_configuracion);
  if (!apiKey) {
    throw errorNegocio(
      'Este negocio todavía no tiene conectada una API Key de OpenAI. Conéctala en Asistentes para usar las sugerencias.',
      'OPENAI_KEY_MISSING',
    );
  }

  const reincidencia = registro.totalNovedades > 1 || registro.vecesOfrecida > 0;
  const [conversacion, guia] = await Promise.all([
    leerConversacion({
      id_configuracion,
      idCliente,
      desde: orden.fechaNovedad,
    }),
    guiaTransportadora(orden),
  ]);

  let data;
  try {
    ({ data } = await axios.post(
      'https://api.openai.com/v1/responses',
      {
        model: MODELO,
        instructions: PROMPT_SISTEMA,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: construirEntrada({
                  orden,
                  conversacion,
                  guia,
                  registro,
                  camposRequeridos: camposPorTransportadora(orden.transportadora),
                }),
              },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'sugerencia_novedad',
            strict: true,
            schema: ESQUEMA,
          },
        },
        temperature: 0.2,
        max_output_tokens: 700,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: TIMEOUT_MS,
      },
    ));
  } catch (e) {
    const status = e?.response?.status;
    console.error(
      `[NOVEDAD_IA] OpenAI ${status || ''} — ${e?.response?.data?.error?.message || e.message}`,
    );
    if (status === 401)
      throw errorNegocio(
        'Tu API Key de OpenAI no es válida o fue revocada. Revísala en Asistentes.',
        'OPENAI_KEY_INVALID',
      );
    if (status === 429)
      throw errorNegocio(
        'Tu cuenta de OpenAI no tiene saldo o llegó a su límite de uso.',
        'OPENAI_RATE_LIMIT',
      );
    throw errorNegocio(
      'OpenAI no respondió. Intenta de nuevo en un momento.',
      'OPENAI_ERROR',
    );
  }

  const mensaje = (data?.output || []).find((i) => i.type === 'message');
  const texto =
    mensaje?.content?.find((c) => c.type === 'output_text')?.text ||
    data?.output_text ||
    '';
  let ia;
  try {
    ia = JSON.parse(texto);
  } catch (_) {
    throw errorNegocio(
      'La IA devolvió una respuesta que no se pudo leer. Intenta de nuevo.',
      'OPENAI_EMPTY',
    );
  }

  return aplicarReglas({ ia, conversacion, reincidencia, registro });
}

/* Reglas duras sobre lo que dijo el modelo. Separado para poder probarlo. */
function aplicarReglas({ ia, conversacion, reincidencia, registro }) {
  const txt = (v) => String(v ?? '').trim();
  const sug = {
    decision: ['proponer', 'pedir_datos', 'escalar'].includes(ia?.decision)
      ? ia.decision
      : 'escalar',
    motivo: txt(ia?.motivo),
    confianza: ['alta', 'media', 'baja'].includes(ia?.confianza)
      ? ia.confianza
      : 'baja',
    solucion: txt(ia?.solucion).slice(0, MAX_SOLUCION),
    mensaje_para_cliente: txt(ia?.mensaje_para_cliente),
    fecha_entrega: /^\d{4}-\d{2}-\d{2}$/.test(txt(ia?.fecha_entrega))
      ? txt(ia.fecha_entrega)
      : '',
    nombre: txt(ia?.nombre),
    telefono: txt(ia?.telefono),
    direccion: txt(ia?.direccion),
    referencia: txt(ia?.referencia),
    cliente_respondio: conversacion.respuestasTrasNovedad > 0,
    tiene_chat: conversacion.mensajes.length > 0,
    requiere_asesor: false,
    avisos: [],
  };

  if (sug.fecha_entrega && sug.fecha_entrega <= hoyEcuador()) sug.fecha_entrega = '';

  // 1) Sin respuesta del cliente tras la novedad no hay nada que afirmarle a
  //    la transportadora.
  if (sug.decision === 'proponer' && !sug.cliente_respondio) {
    sug.decision = 'pedir_datos';
    sug.solucion = '';
    sug.confianza = 'baja';
    sug.avisos.push(
      'El cliente no ha escrito después de la novedad: no se puede afirmar que confirmó.',
    );
  }
  if (sug.decision === 'proponer' && !sug.solucion) {
    sug.decision = 'pedir_datos';
  }
  if (sug.decision !== 'proponer') sug.solucion = '';

  // 2) Reincidencia: la gestiona un asesor (la propuesta queda como borrador).
  if (reincidencia) {
    sug.requiere_asesor = true;
    sug.avisos.push(
      `Reincidencia: este pedido ya se volvió a ofrecer ${Math.max(registro.vecesOfrecida, registro.totalNovedades - 1, 1)} ${Math.max(registro.vecesOfrecida, registro.totalNovedades - 1, 1) === 1 ? 'vez' : 'veces'} y volvió a novedad. Revísalo a mano antes de ofrecerlo otra vez.`,
    );
  }
  if (sug.decision === 'escalar') sug.requiere_asesor = true;

  return sug;
}

module.exports = { sugerirSolucion, aplicarReglas };
