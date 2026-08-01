// services/kanban_ia.service.js
// Función genérica que reemplaza todo el switch ventas/eventos/imporfactory.
// Lee el assistant_id y las acciones desde kanban_columnas + kanban_acciones,
// ejecuta el asistente OpenAI y procesa todas las acciones configuradas.
// ─────────────────────────────────────────────────────────────

const axios = require('axios');
const flatted = require('flatted');
const { db } = require('../database/config');
const { verificarAccesoAutomatizaciones } = require('../utils/planAcceso');
const { construirContextoColumna } = require('../utils/contextoColumna');
const { limpiarColetillas } = require('../utils/limpiarColetillas');
const { humanizarFechas } = require('../utils/humanizarFechas');
const { limpiarMarkdown } = require('../utils/formatoWhatsapp');

const {
  enviarMensajeWhatsapp,
} = require('../utils/webhook_whatsapp/enviarMensajes');

const {
  sanitizarRespuestaAgente,
} = require('../utils/openia/sanitizador_agente');

// Envío de la respuesta repartida en 2-3 mensajes (gated por configuración)
const {
  enviarEnBloques,
  nuevoTurno,
} = require('../utils/openia/envioEnBloques');

// Tope para mandar el catálogo dentro de las instrucciones en vez de usar
// file_search.
//
// ⏸️ EN PAUSA (0 = desactivado): todas las columnas usan file_search, igual
// que antes.
//
// La generación del texto inline también está en pausa, del otro lado:
// GENERAR_CATALOGO_INLINE en syncCatalogoKanbanColumna.service.js. Para
// reactivar hacen falta las TRES cosas, en este orden:
//   1. GENERAR_CATALOGO_INLINE = true en el sync
//   2. re-sincronizar los catálogos (si no, kanban_columnas.catalogo_inline
//      está vacío o con texto viejo y esto igual cae a file_search)
//   3. subir este tope
//
// Valores de referencia, medidos sobre los catálogos actuales:
//   16000 → 233 de 238 conexiones usan inline (punto de equilibrio con
//           file_search, que inyecta ~16.000 tokens por llamada)
//   30000 → 237 de 238 (entran cfg 285, 403, 277 y 666)
//   Infinity → las 238 (cfg 261, con 181 productos, costaría ~3x más)
const TOPE_CATALOGO_INLINE = 0;

// Auto-creación de órdenes en Dropi cuando el bot confirma la venta
const {
  autoCrearOrdenDropi,
  autoActualizarOrdenDropi,
} = require('./dropiAutoOrder.service');

// ══════════════════════════════════════════════════════════════
// fetchAssistantInfo — Trae el prompt REAL cargado en OpenAI
// Solo para debugging. Permite confirmar si Platform tiene
// el prompt que crees que tiene.
// ══════════════════════════════════════════════════════════════
async function fetchAssistantInfo(id_columna) {
  const [col] = await db.query(
    `SELECT instrucciones, modelo FROM kanban_columnas 
     WHERE id = ? AND activo = 1 LIMIT 1`,
    { replacements: [id_columna], type: db.QueryTypes.SELECT },
  );
  return {
    instructions: col?.instrucciones || '',
    model: col?.modelo || 'gpt-4o-mini',
    instructions_length: (col?.instrucciones || '').length,
    tools: '',
    name: 'asistente',
  };
}

const {
  enviarMedioWhatsapp,
} = require('../utils/webhook_whatsapp/enviarMultimedia');

const {
  obtenerUltimoResponseId,
  guardarResponseId,
} = require('../services/obtener_response.service');

const servicioAppointments = require('../services/appointments.service');

const logsDir = require('path').join(process.cwd(), './src/logs/logs_meta');
const fs = require('fs').promises;

function esSinSaldo(err) {
  const status = err?.response?.status;
  const code = err?.response?.data?.error?.code;
  const msg = err?.response?.data?.error?.message || '';
  return (
    (status === 429 && code === 'insufficient_quota') ||
    status === 402 ||
    msg.toLowerCase().includes('exceeded your current quota') ||
    msg.toLowerCase().includes('insufficient_quota')
  );
}

// La Responses API acumula historial vía previous_response_id; con muchos
// turnos + file_search el contexto puede superar la ventana del modelo.
function esContextoExcedido(err) {
  const code = err?.response?.data?.error?.code;
  const msg = err?.response?.data?.error?.message || err?.message || '';
  return (
    code === 'context_length_exceeded' ||
    /context window|context_length|maximum context/i.test(msg)
  );
}

// Reconstruye un transcript compacto de la conversación desde NUESTRA BD.
// Se usa para re-sembrar el contexto cuando se resetea el hilo por
// context_length_exceeded, de modo que el asistente NO pierda de qué producto
// se habló ni los datos del cliente (nombre, dirección, etapa de la venta).
// Lo que infla el contexto son los trozos de file_search, no este diálogo.
async function construirRecapConversacion(id_cliente, maxMsgs = 30) {
  try {
    const limite = Number(maxMsgs) || 30;
    const rows = await db.query(
      `SELECT rol_mensaje, texto_mensaje
         FROM mensajes_clientes
        WHERE celular_recibe = ?
          AND texto_mensaje IS NOT NULL
          AND texto_mensaje <> ''
          AND deleted_at IS NULL
        ORDER BY id DESC
        LIMIT ${limite}`,
      { replacements: [String(id_cliente)], type: db.QueryTypes.SELECT },
    );
    if (!rows.length) return '';
    return rows
      .reverse()
      .map((m) => {
        const quien = Number(m.rol_mensaje) === 1 ? 'Asistente' : 'Cliente';
        const txt = String(m.texto_mensaje || '')
          .slice(0, 500)
          .trim();
        return txt ? `${quien}: ${txt}` : null;
      })
      .filter(Boolean)
      .join('\n');
  } catch (_) {
    return '';
  }
}

async function marcarOpenAIInactivo(id_configuracion, motivo) {
  try {
    await db.query(
      `UPDATE configuraciones
       SET openai_activo = 0,
           openai_error_at = NOW(),
           openai_error_msg = ?
       WHERE id = ?`,
      {
        replacements: [
          motivo?.slice(0, 500) || 'Error desconocido',
          id_configuracion,
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
    await log(`🔴 OpenAI marcado INACTIVO para config=${id_configuracion}`);
  } catch (err) {
    await log(`⚠️ No se pudo marcar openai_activo=0: ${err.message}`);
  }
}

async function marcarOpenAIActivo(id_configuracion) {
  try {
    await db.query(
      `UPDATE configuraciones
       SET openai_activo = 1,
           openai_error_at = NULL,
           openai_error_msg = NULL
       WHERE id = ? AND openai_activo = 0`,
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.UPDATE,
      },
    );
  } catch (err) {
    await log(`⚠️ No se pudo marcar openai_activo=1: ${err.message}`);
  }
}

async function log(msg) {
  await fs.mkdir(logsDir, { recursive: true });
  await fs.appendFile(
    require('path').join(logsDir, 'debug_log.txt'),
    `[${new Date().toISOString()}] [kanban_ia] ${msg}\n`,
  );
}

// ─────────────────────────────────────────────────────────────
// procesarMensajeKanban
// Punto de entrada único desde el webhook.
//
// @param {object} params
//   id_configuracion, id_cliente, telefono, mensaje,
//   estado_contacto, api_key_openai,
//   business_phone_id, accessToken
//
// @returns {object} { ok, respuesta_enviada }
// ─────────────────────────────────────────────────────────────
async function procesarMensajeKanban(params) {
  const {
    id_configuracion,
    id_cliente,
    telefono,
    mensaje,
    estado_contacto,
    api_key_openai,
    business_phone_id,
    accessToken,
    bloque_producto_referral,
  } = params;

  // ── Canal de salida ───────────────────────────────────────
  // Por defecto = WhatsApp (mismo comportamiento estable de siempre).
  // Otros canales (Instagram, Messenger…) inyectan su propio adaptador
  // vía params.canal para reutilizar TODO el cerebro de la IA kanban.
  //   canal.enviarTexto({ texto, responsable, total_tokens })
  //   canal.enviarMedia({ tipo: 'image'|'video', url, responsable })
  const canal = params.canal || {
    source: 'wa',
    enviarTexto: async ({ texto, responsable, total_tokens }) =>
      enviarMensajeWhatsapp({
        phone_whatsapp_to: telefono,
        texto_mensaje: texto,
        business_phone_id,
        accessToken,
        id_configuracion,
        responsable,
        total_tokens,
      }),
    enviarMedia: async ({ tipo, url, responsable }) =>
      enviarMedioWhatsapp({
        tipo,
        url_archivo: url,
        phone_whatsapp_to: telefono,
        business_phone_id,
        accessToken,
        id_configuracion,
        responsable,
      }),
  };

  // ── 0. Corta-fuegos por plan ──────────────────────────────
  // El webhook de Meta no pasa por checkPlanActivo (lo llama Meta, no el
  // cliente), así que este es el único punto donde se puede cortar el bot.
  // Es punto de entrada único de los 3 canales (WA, MS e IG lo reusan), así
  // que con este gate queda cubierto todo el cerebro de la IA y, de paso, las
  // auto-órdenes de Dropi que dispara. El mensaje entrante YA se guardó antes
  // de llegar aquí: el cliente no pierde la conversación, solo deja de
  // responderse solo.
  const acceso = await verificarAccesoAutomatizaciones(id_configuracion);
  if (!acceso.permitido) {
    await log(
      `🚫 Automatizaciones cortadas para config=${id_configuracion} (${acceso.motivo}). No se ejecuta la IA.`,
    );
    return { ok: false, motivo: `plan_bloqueado:${acceso.motivo}` };
  }

  /* ── 0.05 Interruptor general del bot ─────────────────────
     El switch de la pantalla de Asistentes. Existía y no hacía nada para las
     cuentas con tablero: apagarlo ahí no callaba al bot, había que entrar
     columna por columna a bajar la IA. Ahora manda sobre todas.

     Una cuenta recién creada NO tiene fila, y eso significa apagado: el bot
     empieza en silencio y habla recién cuando el cliente lo enciende. Nadie
     quiere que un bot se ponga a contestarle a sus clientes antes de que él
     revise el prompt. Las cuentas que ya estaban respondiendo cuando esto se
     implementó recibieron su fila encendida, así que a nadie se le calló el bot
     de un día para otro. */
  const [interruptor] = await db.query(
    `SELECT activo FROM openai_assistants
      WHERE id_configuracion = ? AND tipo = 'ventas' AND deleted_at IS NULL
      LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (!interruptor || Number(interruptor.activo) === 0) {
    await log(
      `🔌 Bot apagado para config=${id_configuracion} (${interruptor ? 'apagado desde Asistentes' : 'nunca se activó'}). No se ejecuta la IA.`,
    );
    return { ok: false, motivo: 'bot_apagado' };
  }

  // ── 0.1 Decidir qué API usar ──────────────────────────────
  const USAR_RESPONSES_API = [10].includes(Number(id_configuracion));

  // Llegó un mensaje nuevo de este cliente: invalida cualquier ráfaga que
  // haya quedado pendiente de la respuesta anterior.
  const turno = nuevoTurno(id_cliente);

  // ── 1. Obtener configuración de la columna activa ─────────
  const [columna] = await db.query(
    `SELECT kc.id, kc.nombre, kc.assistant_id, kc.activa_ia,
            kc.max_tokens, kc.vector_store_id, kc.es_dropi_principal,
            kc.catalogo_inline, kc.catalogo_inline_tokens
     FROM   kanban_columnas kc
     WHERE  kc.id_configuracion = ?
       AND  LOWER(kc.estado_db) = LOWER(?)
       AND  kc.activo = 1
     LIMIT 1`,
    {
      replacements: [id_configuracion, estado_contacto],
      type: db.QueryTypes.SELECT,
    },
  );

  if (!columna) {
    await log(
      `⚠️ Sin columna para estado=${estado_contacto} config=${id_configuracion}`,
    );
    return { ok: false, motivo: 'sin_columna' };
  }

  if (!columna.activa_ia || !columna.assistant_id) {
    await log(
      `ℹ️ IA inactiva para columna "${columna.nombre}" (activa_ia=${columna.activa_ia})`,
    );
    return { ok: false, motivo: 'ia_inactiva' };
  }

  // 🔍 DEBUG: ver qué assistant está corriendo REALMENTE
  const assistantInfo = await fetchAssistantInfo(columna.id);
  await log(
    `🤖 DEBUG ASSISTANT — columna="${columna.nombre}" id=${columna.assistant_id} name="${assistantInfo.name}" model="${assistantInfo.model}" tools=[${assistantInfo.tools}] instructions_len=${assistantInfo.instructions_length}`,
  );
  await log(`📝 Instructions len=${assistantInfo.instructions_length}`);

  /* Columna con IA prendida pero SIN prompt: sería un modelo desnudo hablándole
     al cliente —inventa precios, promete horarios y nunca escribe los tags, así
     que la ficha además se queda atascada. Solo aplica al camino de Responses,
     que es el único donde el prompt sale de la BD; por el camino viejo el prompt
     vive en el assistant de OpenAI y `instrucciones` es apenas una copia local
     que en varias cuentas antiguas nunca se llenó. */
  if (USAR_RESPONSES_API && !String(assistantInfo.instructions || '').trim()) {
    await log(
      `🚫 Columna "${columna.nombre}" (id=${columna.id}, config=${id_configuracion}) tiene IA activa pero el prompt está VACÍO. No se ejecuta: se deja para atención humana.`,
    );
    return { ok: false, motivo: 'sin_instrucciones' };
  }

  // ── 2. Obtener acciones configuradas para esta columna ────
  const acciones = await db.query(
    `SELECT tipo_accion, config, orden
     FROM   kanban_acciones
     WHERE  id_kanban_columna = ? AND activo = 1
     ORDER  BY orden ASC`,
    { replacements: [columna.id], type: db.QueryTypes.SELECT },
  );

  const tieneAccion = (tipo) => acciones.some((a) => a.tipo_accion === tipo);
  const getAcciones = (tipo) => acciones.filter((a) => a.tipo_accion === tipo);
  const parseConfig = (a) => {
    try {
      let cfg = a?.config;

      if (!cfg) return {};

      // Intentar deserializar mientras siga siendo string JSON
      while (typeof cfg === 'string') {
        cfg = JSON.parse(cfg);
      }

      return cfg && typeof cfg === 'object' ? cfg : {};
    } catch (error) {
      return {};
    }
  };

  // ── 3. Obtener contexto del cliente según API ─────────────
  let previous_response_id = null;
  let id_thread = null;
  let headers_assistants = null;

  if (USAR_RESPONSES_API) {
    previous_response_id = await obtenerUltimoResponseId(id_cliente);
    await log(
      previous_response_id
        ? `🔗 Encadenando con previous_response_id=${previous_response_id}`
        : `🆕 Primer mensaje del cliente, sin previous_response_id`,
    );
  } else {
    const {
      obtenerOCrearThreadId,
    } = require('../services/obtener_thread.service');
    id_thread = await obtenerOCrearThreadId(id_cliente, api_key_openai);
    if (!id_thread) {
      await log(`⚠️ No se pudo obtener thread para id_cliente=${id_cliente}`);
      return { ok: false, motivo: 'sin_thread' };
    }
    headers_assistants = {
      Authorization: `Bearer ${api_key_openai}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'assistants=v2',
    };
    await log(`🧵 Thread obtenido: ${id_thread}`);
  }

  let bloqueContexto = '';
  let total_tokens = 0;
  let mensajeFinal = mensaje;

  // ── 4. ACCIÓN: separador_productos (pre-procesamiento) ────
  /* if (tieneAccion('separador_productos')) {
    const [acSep] = getAcciones('separador_productos');
    const cfg = parseConfig(acSep);
    const sep_asst = cfg.assistant_id || null;

    if (sep_asst) {
      try {
        const sepResult = await ejecutarAsistente({
          id_thread,
          assistant_id: sep_asst,
          mensaje,
          max_tokens: 100,
          headers,
        });
        if (sepResult.respuesta) {
          bloqueContexto += `📦 Productos mencionados en el mensaje:\n${sepResult.respuesta}\n\n`;
          total_tokens += sepResult.total_tokens;
          await log(`✅ Separador productos: ${sepResult.respuesta}`);
        }
      } catch (err) {
        await log(`⚠️ Error separador_productos: ${err.message}`);
      }
    }
  } */

  // ── 5. ACCIÓN: contexto_productos ─────────────────────────
  if (tieneAccion('contexto_productos') && bloqueContexto) {
    // El catálogo ya está en el vector_store del asistente (file_search).
    // Aquí solo inyectamos el bloque del separador como mensaje de contexto.
    // Si no hay separador, el file_search del asistente ya tiene el catálogo completo.
    await log(
      `ℹ️ contexto_productos activo — catálogo en vector_store="${columna.vector_store_id}"`,
    );
  }

  // ── 6. ACCIONES: contexto_establecimientos + contexto_calendario ──
  // Lo arma construirContextoColumna(), compartido con el chat de prueba para
  // que la prueba responda con la misma información que producción.
  bloqueContexto += await construirContextoColumna(
    id_configuracion,
    acciones,
    log,
    // El mensaje sirve para elegir qué productos mandar cuando el catálogo es
    // grande: los que la persona nombró. El id_cliente, para entregarle el
    // teléfono desde el que escribe en vez de que se lo pregunte.
    { mensaje, id_cliente },
  );

  // ── 6.5 Columna principal Dropi: inyectar la orden ya existente ──
  // La plantilla de confirmación se envió por fuera del thread, así que el
  // asistente no la ve. Le pasamos los datos reales de la orden (del cache)
  // para que confirme/edite sin inventar y pueda responder "¿qué dirección
  // tengo?".
  if (columna.es_dropi_principal) {
    try {
      const tel9 = String(telefono || '')
        .replace(/\D/g, '')
        .slice(-9);
      if (tel9.length >= 9) {
        const [ord] = await db.query(
          `SELECT name, surname, phone, city, provincia, total_order,
                  product_names, order_data
             FROM dropi_orders_cache
            WHERE id_configuracion = ?
              AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', ''), 9) = ?
              AND UPPER(status) = 'PENDIENTE CONFIRMACION'
            ORDER BY order_created_at DESC LIMIT 1`,
          {
            replacements: [id_configuracion, tel9],
            type: db.QueryTypes.SELECT,
          },
        );
        if (ord) {
          let dir = '';
          try {
            dir = JSON.parse(ord.order_data || '{}').dir || '';
          } catch (_) {}
          let prod = ord.product_names || '';
          try {
            const a = JSON.parse(ord.product_names || '[]');
            if (Array.isArray(a)) prod = a.join(', ');
          } catch (_) {}
          bloqueContexto +=
            `📦 Pedido del cliente (ya registrado, en Pendiente confirmación):\n` +
            `- Nombre: ${[ord.name, ord.surname].filter(Boolean).join(' ')}\n` +
            `- Teléfono: ${ord.phone || ''}\n` +
            `- Ciudad: ${ord.city || ''}\n` +
            `- Provincia: ${ord.provincia || ''}\n` +
            `- Dirección: ${dir}\n` +
            `- Producto: ${prod}\n` +
            `- Valor a pagar: ${ord.total_order || ''}\n\n`;
          await log(`📦 Contexto orden Dropi inyectado cliente=${id_cliente}`);
        } else {
          await log(
            `ℹ️ Sin orden PENDIENTE CONFIRMACION en cache cliente=${id_cliente}`,
          );
        }
      }
    } catch (e) {
      await log(`⚠️ Error inyectando contexto orden Dropi: ${e.message}`);
    }
  }

  // ── 7. Construir input / enviar al thread ─────────────────
  let inputFinal = mensajeFinal;

  if (USAR_RESPONSES_API) {
    if (bloqueContexto.trim()) {
      inputFinal = `🧾 Contexto adicional:\n\n${bloqueContexto.trim()}\n\n${mensajeFinal}`;
    }
  } else {
    if (bloqueContexto.trim()) {
      await axios
        .post(
          `https://api.openai.com/v1/threads/${id_thread}/messages`,
          {
            role: 'user',
            content: `🧾 Contexto adicional:\n\n${bloqueContexto.trim()}`,
          },
          { headers: headers_assistants },
        )
        .catch(async (err) =>
          log(`⚠️ Error enviando contexto: ${err.message}`),
        );
    }
    await axios
      .post(
        `https://api.openai.com/v1/threads/${id_thread}/messages`,
        { role: 'user', content: mensajeFinal },
        { headers: headers_assistants },
      )
      .catch(async (err) => log(`⚠️ Error enviando mensaje: ${err.message}`));
  }

  // ── Producto del anuncio: blindar precio en TODOS los turnos ──
  // Si el webhook ya mandó el bloque (primer mensaje del click), se usa.
  // Si no vino (mensajes siguientes), se reconstruye desde ultimo_producto_ad.
  let instruccionesProducto = bloque_producto_referral || null;

  /* if (
    !instruccionesProducto &&
    (id_configuracion == 10 ||
      id_configuracion == 277 ||
      id_configuracion == 392 ||
      id_configuracion == 569 ||
      id_configuracion == 360 ||
      id_configuracion == 324 ||
      id_configuracion == 476)
  ) { */
  const [cli] = await db.query(
    `SELECT ultimo_producto_ad FROM clientes_chat_center WHERE id = ? LIMIT 1`,
    { replacements: [id_cliente], type: db.QueryTypes.SELECT },
  );
  const ultimoProductoAd = (cli?.ultimo_producto_ad || '').trim();

  if (ultimoProductoAd) {
    const {
      buscarProductoPorReferral,
    } = require('../utils/webhook_whatsapp/buscar_producto_referral');

    const bloqueProd = await buscarProductoPorReferral(
      id_configuracion,
      ultimoProductoAd,
    );

    if (bloqueProd) {
      instruccionesProducto = `[CONTEXTO: el cliente llegó por un anuncio del producto "${ultimoProductoAd}"]

          ${bloqueProd}

          INSTRUCCIÓN: Usa SOLO estos precios y URLs para este producto. Si el cliente pregunta por CUALQUIER OTRO producto distinto, usa tu catálogo (file_search) normalmente.`;
      await log(
        `📎 Producto reinyectado desde ultimo_producto_ad="${ultimoProductoAd}"`,
      );
    }
  }

  // ── 9. Ejecutar ───────────────────────────────────────────
  let resultado;
  try {
    if (USAR_RESPONSES_API) {
      await log(`🚨 entro sin polling NUEVO SISTEMA`);

      // ── Catálogo: inline vs file_search ────────────────────
      // file_search trocea el catálogo en fragmentos de 800 tokens con 400 de
      // solapamiento y por defecto devuelve hasta 20, así que termina
      // inyectando el catálogo entero DUPLICADO. Medido en config 10: 16.230
      // tokens por llamada, contra 2.221 del mismo catálogo en texto plano.
      //
      // Por eso, si el catálogo en texto cabe holgadamente se manda inline:
      // sale más barato Y el modelo ve el catálogo COMPLETO, sin depender de
      // que la búsqueda semántica acierte. Solo los catálogos que superan el
      // punto de equilibrio siguen con file_search, donde sí conviene.
      //
      // Subir TOPE_CATALOGO_INLINE a Infinity fuerza inline para todos.
      const catalogoInline = (columna.catalogo_inline || '').trim();
      const inlineTokens = Number(columna.catalogo_inline_tokens || 0);
      const usarInline =
        !!catalogoInline && inlineTokens > 0 && inlineTokens <= TOPE_CATALOGO_INLINE;

      let instruccionesFinales = assistantInfo.instructions;
      if (usarInline) {
        instruccionesFinales = `${assistantInfo.instructions}\n\n${catalogoInline}`;
        await log(
          `📄 Catálogo INLINE (${inlineTokens} tokens) — sin file_search`,
        );
      } else if (columna.vector_store_id) {
        await log(
          `🔎 Catálogo por file_search (inline=${inlineTokens || 'n/d'} tokens, tope=${TOPE_CATALOGO_INLINE})`,
        );
      }

      resultado = await ejecutarConResponsesAPI({
        previous_response_id,
        instructions: instruccionesFinales,
        additional_instructions: instruccionesProducto || null,
        input: inputFinal,
        model: assistantInfo.model,
        max_tokens: columna.max_tokens || 500,
        vector_store_id: usarInline ? null : columna.vector_store_id || null,
        api_key_openai,
      });
    } else {
      await log(`🚨 entro con polling VIEJO SISTEMA`);
      resultado = await ejecutarAsistente({
        id_thread,
        assistant_id: columna.assistant_id,
        mensaje: null,
        max_tokens: columna.max_tokens || 500,
        headers: headers_assistants,
        skip_send_message: true,
        additional_instructions: instruccionesProducto || null,
      });
    }
  } catch (err) {
    if (esSinSaldo(err) || err.code === 'sin_saldo_openai') {
      await log(`🚨 SIN SALDO OPENAI para config=${id_configuracion}`);
      await marcarOpenAIInactivo(
        id_configuracion,
        err?.response?.data?.error?.message || 'Sin saldo OpenAI',
      );
      return { ok: false, motivo: 'sin_saldo_openai' };
    }

    // Contexto excedido (solo Responses API): reintentar UNA vez SIN encadenar,
    // pero RE-SEMBRANDO el hilo con un resumen de la conversación (desde nuestra
    // BD) para no perder el producto ni los datos del cliente. Se auto-cura.
    if (USAR_RESPONSES_API && previous_response_id && esContextoExcedido(err)) {
      const recap = await construirRecapConversacion(id_cliente);
      await log(
        `♻️ context_length_exceeded — reset de hilo con recap (${recap.length} chars) cliente=${id_cliente}`,
      );

      const inputConRecap = recap
        ? `[CONTEXTO DE LA CONVERSACIÓN PREVIA — retómala, NO saludes de nuevo ni pidas datos ya dados]\n${recap}\n\n[MENSAJE ACTUAL DEL CLIENTE]\n${inputFinal}`
        : inputFinal;

      try {
        resultado = await ejecutarConResponsesAPI({
          previous_response_id: null,
          instructions: assistantInfo.instructions,
          additional_instructions: instruccionesProducto || null,
          input: inputConRecap,
          model: assistantInfo.model,
          max_tokens: columna.max_tokens || 500,
          vector_store_id: columna.vector_store_id || null,
          api_key_openai,
        });
      } catch (err2) {
        if (esSinSaldo(err2)) {
          await marcarOpenAIInactivo(
            id_configuracion,
            err2?.response?.data?.error?.message || 'Sin saldo OpenAI',
          );
          return { ok: false, motivo: 'sin_saldo_openai' };
        }
        await log(`❌ Error tras reset de hilo: ${err2.message}`);
        throw err2;
      }
    } else {
      await log(`❌ Error ejecutando asistente: ${err.message}`);
      throw err;
    }
  }

  if (!resultado || !resultado.respuesta) {
    await log(`⚠️ Asistente sin respuesta para columna="${columna.nombre}"`);
    return { ok: false, motivo: 'sin_respuesta_asistente' };
  }

  // Guardar contexto según API
  if (USAR_RESPONSES_API) {
    await guardarResponseId(id_cliente, resultado.response_id);
    await log(`💾 response_id guardado: ${resultado.response_id}`);
  }

  total_tokens += resultado.total_tokens;
  const respuestaCruda = resultado.respuesta;
  const respuestaRaw = sanitizarRespuestaAgente(respuestaCruda);

  // Log solo si el sanitizador modificó algo
  if (respuestaCruda !== respuestaRaw) {
    await log(
      `🧹 Sanitizador aplicado. Antes: ${respuestaCruda.slice(0, 200)}`,
    );
    await log(`🧹 Después: ${respuestaRaw.slice(0, 200)}`);
  }

  /* await log(
    `✅ Respuesta asistente columna="${columna.nombre}": ${respuestaRaw.slice(0, 120)}...`,
  ); */

  await log(
    `✅ Respuesta asistente columna="${columna.nombre}" (FULL):\n----INICIO----\n${respuestaRaw}\n----FIN----`,
  );

  await log(`🧪 Acciones cargadas: ${JSON.stringify(acciones)}`);
  await log(
    `🧪 Acciones cambiar_estado: ${JSON.stringify(getAcciones('cambiar_estado'))}`,
  );

  /* ── 9.9 Quien pregunta por un PRODUCTO va a su columna ────
     Enrutar no puede depender de que el modelo se acuerde de escribir un tag.
     Medido en la 818: ante "quiero comprar la máquina cortadora", el asistente
     de contacto inicial unas veces no marcaba nada y otras contestaba "te paso
     con la agenda" —mandándolo a agendar una cita para comprar un aparato—.

     Un producto del catálogo nombrado en el mensaje, con intención de compra,
     es una señal que el código puede leer solo. La columna destino tiene que
     existir y estar configurada en el tablero, así que esto no se activa en
     cuentas que no venden productos. */
  const accionProducto = getAcciones('cambiar_estado')
    .map((ac) => parseConfig(ac))
    .find((c) => c.estado_destino === 'venta_producto');

  if (accionProducto && !respuestaRaw.includes('[venta_producto]:true')) {
    const RE_COMPRA =
      /\b(compr|quiero la|quiero el|me la llevo|me lo llevo|cu[aá]nto (cuesta|vale|sale)|precio|venden|tienen|c[oó]mo la consigo)/i;

    if (RE_COMPRA.test(mensaje)) {
      const productos = await db.query(
        `SELECT nombre FROM productos_chat_center
          WHERE id_configuracion = ? AND eliminado = 0
            AND LOWER(COALESCE(tipo, '')) NOT LIKE 'servicio%'`,
        { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
      );

      const norm = (s) =>
        String(s || '')
          .toLowerCase()
          .normalize('NFD')
          .replace(/\p{M}/gu, '')
          .replace(/[^a-z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

      const palabras = norm(mensaje).split(' ').filter((p) => p.length > 3);

      /* Se pide que coincidan DOS palabras del nombre, no una: "profesional" o
         "facial" sueltas aparecen en medio catálogo y mandarían a la columna
         equivocada a quien pregunta por un tratamiento. */
      const nombrado = productos.find((p) => {
        const tokens = norm(p.nombre)
          .split(' ')
          .filter((t) => t.length > 3);
        const aciertos = tokens.filter((t) => palabras.includes(t)).length;
        return aciertos >= Math.min(2, tokens.length);
      });

      if (nombrado) {
        await db.query(
          `UPDATE clientes_chat_center SET estado_contacto = 'venta_producto'
            WHERE id = ?`,
          { replacements: [id_cliente], type: db.QueryTypes.UPDATE },
        );
        await log(
          `🛍️ "${nombrado.nombre}" es un producto y el mensaje muestra intención de compra: cliente ${id_cliente} movido a "venta_producto" sin depender del tag`,
        );
      }
    }
  }

  // ── 10. ACCIÓN: cambiar_estado ────────────────────────────
  for (const ac of getAcciones('cambiar_estado')) {
    const cfg = parseConfig(ac);
    const trigger = cfg.trigger || '';
    const estadoDestino = cfg.estado_destino || '';
    if (!trigger || !estadoDestino) continue;

    const coincide = respuestaRaw.toLowerCase().includes(trigger.toLowerCase());
    if (coincide) {
      await db.query(
        `UPDATE clientes_chat_center SET estado_contacto = ? WHERE id = ?`,
        {
          replacements: [estadoDestino, id_cliente],
          type: db.QueryTypes.UPDATE,
        },
      );
      await log(
        `🔄 Estado cambiado a "${estadoDestino}" (trigger="${trigger}")`,
      );

      //  Auto-orden Dropi: el trigger movió al cliente a generar_guia.
      // Se extraen los datos del resumen del bot con regex (emoji opcional);
      // si faltan campos, dropiAutoOrder.service los completa con un
      // extractor IA sobre la conversación (usa la api_key del cliente).
      // Cualquier resultado queda en dropi_auto_ordenes_log.
      // Ruta según origen: si el cliente confirma desde la columna principal
      // de Dropi (pendiente_confirmacion), la orden YA existe → se ACTUALIZA a
      // PENDIENTE; en cualquier otra columna (contacto_inicial) se CREA nueva.
      if (estadoDestino === 'generar_guia') {
        try {
          const g = (re) => respuestaRaw.match(re)?.[1]?.trim() || '';
          const datosBot = {
            nombre: g(/🧑?\s*Nombre:\s*(.+)/i),
            telefono: g(/📞?\s*Tel[eé]fono:\s*(.+)/i) || telefono,
            // Acepta el término regional según el país (provincia EC/PA,
            // departamento CO/PE/GT, estado MX, región CL).
            provincia: g(
              /📍?\s*(?:Provincia|Departamento|Depto\.?|Estado|Regi[oó]n):\s*(.+)/i,
            ),
            ciudad: g(/📍?\s*Ciudad:\s*(.+)/i),
            direccion: g(/🏡?\s*Direcci[oó]n:\s*(.+)/i),
            producto: g(/📦?\s*Producto:\s*(.+)/i),
            precio: g(/💰?\s*Precio total:\s*(.+)/i),
            cantidad: g(/🔢?\s*Cantidad:\s*(.+)/i) || '',
            // Modalidad de envío (opcional): "domicilio" o "agencia
            // servientrega". Si el bot la incluye, el auto-orden fuerza
            // Servientrega cuando es agencia.
            modalidad_envio:
              g(/🚚?\s*Env[ií]o:\s*(.+)/i) ||
              g(/📦?\s*Modalidad:\s*(.+)/i) ||
              '',
            // Variedad elegida en productos variables (talla/color). Sin esto
            // el auto-orden no sabe qué variante subir y Dropi rechaza la
            // orden. Se aceptan varios rótulos porque el prompt de cada
            // cliente los escribe distinto.
            variedad:
              g(/🎨?\s*Variedad:\s*(.+)/i) ||
              g(/🎨?\s*Variante:\s*(.+)/i) ||
              g(/🎨?\s*Color:\s*(.+)/i) ||
              g(/📏?\s*Talla:\s*(.+)/i) ||
              '',
          };

          // Datos que el cliente pudo corregir (para el flujo de actualizar).
          const cambios = {
            nombre: g(/🧑?\s*Nombre:\s*(.+)/i),
            telefono: g(/📞?\s*Tel[eé]fono:\s*(.+)/i),
            ciudad: g(/📍?\s*Ciudad:\s*(.+)/i),
            direccion: g(/🏡?\s*Direcci[oó]n:\s*(.+)/i),
          };

          // MODELO PER-COLUMNA (full pro): la acción Dropi de la columna decide
          // qué hacer y su `activo` es el gate. Si la columna no tiene ninguna
          // acción Dropi → FALLBACK al modelo viejo (flag config + es_dropi_principal),
          // para no romper configs no migradas.
          const dropiAcc = await db.query(
            `SELECT tipo_accion, activo FROM kanban_acciones
             WHERE id_kanban_columna = ?
               AND tipo_accion IN ('crear_orden_dropi','actualizar_orden_dropi')
             ORDER BY id DESC LIMIT 1`,
            { replacements: [columna.id], type: db.QueryTypes.SELECT },
          );
          const acc = dropiAcc[0];

          if (acc) {
            // Nuevo modelo: la acción es el gate (force salta el flag config).
            if (Number(acc.activo) === 1) {
              if (acc.tipo_accion === 'actualizar_orden_dropi') {
                autoActualizarOrdenDropi({
                  id_configuracion,
                  id_cliente,
                  telefono,
                  cambios,
                  force: true,
                }).catch(() => {});
                await log(
                  `🔁 Actualizar orden Dropi (acción columna) cliente=${id_cliente}`,
                );
              } else {
                autoCrearOrdenDropi({
                  id_configuracion,
                  id_cliente,
                  api_key_openai,
                  datosBot,
                  force: true,
                }).catch(() => {});
                await log(
                  `🛒 Crear orden Dropi (acción columna) cliente=${id_cliente}`,
                );
              }
            } else {
              await log(
                `⏸️ Acción Dropi apagada en la columna, sin acción cliente=${id_cliente}`,
              );
            }
          } else if (columna.es_dropi_principal) {
            // Fallback viejo: columna principal Dropi → actualizar (gate: flag).
            autoActualizarOrdenDropi({
              id_configuracion,
              id_cliente,
              telefono,
              cambios,
            }).catch(() => {});
            await log(
              `🔁 Actualización orden Dropi (fallback flag) cliente=${id_cliente}`,
            );
          } else {
            // Fallback viejo: cualquier otra columna → crear (gate: flag).
            autoCrearOrdenDropi({
              id_configuracion,
              id_cliente,
              api_key_openai,
              datosBot,
            }).catch(() => {});
            await log(
              `🛒 Auto-orden Dropi (fallback flag) cliente=${id_cliente}`,
            );
          }
        } catch (e) {
          await log(`⚠️ Error disparando auto-orden: ${e.message}`);
        }
      }
      // No break — puede haber múltiples cambios de estado (poco común pero posible)
    }
  }

  // ── 11. ACCIÓN: agendar_cita ──────────────────────────────
  // Se declara afuera porque el control de "conversación que no avanza" (11.5)
  // también lo mira: escribir el bloque ES avanzar, aunque falte el tag.
  let escribioBloqueCita = false;

  if (tieneAccion('agendar_cita')) {
    const [acCita] = getAcciones('agendar_cita');
    const cfg = parseConfig(acCita);
    const trigger = cfg.trigger || '[cita_confirmada]: true';

    /* El tag es la señal, pero no se puede depender solo de él: el modelo
       escribe el bloque completo, le dice al cliente "tu cita quedó agendada" y
       a veces se olvida de la última línea. Ahí no se creaba nada, la tarjeta se
       quedaba quieta y nadie se enteraba hasta que la persona llegaba al local.
       Si el bloque está entero —con fecha de inicio y de fin— se agenda igual:
       el bloque ES la confirmación. */
    const escribioBloque =
      /Fecha y hora(?: de inicio)?\s*:/i.test(respuestaRaw) &&
      /Servicio que desea\s*:/i.test(respuestaRaw);
    escribioBloqueCita = escribioBloque;

    const tieneTag = respuestaRaw
      .toLowerCase()
      .includes(trigger.toLowerCase());

    if (!tieneTag && escribioBloque) {
      await log(
        `⚠️ agendar_cita: el bot escribió el bloque de confirmación SIN el tag ${trigger}; se agenda igual`,
      );
    }

    if (tieneTag || escribioBloque) {
      const res = await procesarAgendarCita(
        respuestaRaw,
        id_configuracion,
        id_cliente,
      ).catch(async (err) => {
        await log(`⚠️ Error agendar_cita: ${err.message}`);
        return { ok: false, motivo: err.message };
      });

      /* Si la cita no se creó, la tarjeta NO se puede quedar en "Cita
         agendada": cambiar_estado ya corrió (paso 10) y la movió igual, así que
         quedaba una cita fantasma — visible en el tablero, inexistente en la
         agenda, y sin nada que lo delate hasta que el cliente llega al local.
         Pasa de verdad: si el horario choca con otra cita del mismo encargado,
         createAppointment responde 409 y el error se quedaba en un log.
         Va a "asesor" porque el cliente ya recibió un mensaje diciéndole que su
         cita quedó confirmada: eso lo tiene que resolver una persona. */
      /* Sin tag, `cambiar_estado` (paso 10) tampoco corrió: la cita quedaría
         creada y la tarjeta parada en la columna anterior. Se mueve acá con el
         mismo destino que tiene configurada esa acción. */
      if (res?.ok && !tieneTag) {
        const destino = getAcciones('cambiar_estado')
          .map((ac) => parseConfig(ac))
          .find(
            (c) =>
              String(c.trigger || '').toLowerCase() === trigger.toLowerCase(),
          )?.estado_destino;

        if (destino) {
          await db.query(
            `UPDATE clientes_chat_center SET estado_contacto = ? WHERE id = ?`,
            { replacements: [destino, id_cliente], type: db.QueryTypes.UPDATE },
          );
          await log(
            `🔄 Estado cambiado a "${destino}" por el bloque de cita (sin tag)`,
          );
        }
      }

      if (res && res.ok === false) {
        const [colAsesor] = await db.query(
          `SELECT id FROM kanban_columnas
            WHERE id_configuracion = ? AND estado_db = 'asesor' AND activo = 1
            LIMIT 1`,
          { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
        );
        if (colAsesor) {
          await db.query(
            `UPDATE clientes_chat_center SET estado_contacto = 'asesor' WHERE id = ?`,
            { replacements: [id_cliente], type: db.QueryTypes.UPDATE },
          );
          await log(
            `🚨 La cita NO se creó (${res.motivo}) pero el bot ya la confirmó al cliente ${id_cliente}: movido a "asesor" para que lo resuelva una persona`,
          );
        } else {
          await log(
            `🚨 La cita NO se creó (${res.motivo}) y la configuración ${id_configuracion} no tiene columna "asesor": la tarjeta queda en "cita_agendada" sin cita real`,
          );
        }
      }
    }
  }

  /* ── 11.5 Conversación que no avanza ──────────────────────
     Una columna con IA puede dar vueltas para siempre: el bot contesta bien,
     el cliente contesta bien, y nadie escribe ningún tag. La ficha se queda
     quieta y nadie se entera hasta que alguien revisa el tablero a mano.
     Después de N respuestas seguidas sin disparar NINGUNA acción, el caso pasa
     a un asesor. No es un error del bot: es admitir que esta conversación
     necesita una persona.

     El contador se reinicia solo cuando algo avanza, así que una charla larga
     que sí progresa nunca escala. */
  const LIMITE_TURNOS_SIN_AVANCE = 10;

  const triggersColumna = acciones
    .map((ac) => parseConfig(ac).trigger)
    .filter(Boolean);

  const avanzo =
    triggersColumna.some((t) =>
      respuestaRaw.toLowerCase().includes(String(t).toLowerCase()),
    ) || escribioBloqueCita;

  if (avanzo) {
    await db.query(
      `UPDATE clientes_chat_center SET turnos_sin_avance = 0 WHERE id = ?`,
      { replacements: [id_cliente], type: db.QueryTypes.UPDATE },
    );
  } else if (triggersColumna.length) {
    const [{ turnos } = { turnos: 0 }] = await db.query(
      `UPDATE clientes_chat_center SET turnos_sin_avance = turnos_sin_avance + 1
        WHERE id = ?`,
      { replacements: [id_cliente], type: db.QueryTypes.UPDATE },
    ).then(() =>
      db.query(
        `SELECT turnos_sin_avance AS turnos FROM clientes_chat_center WHERE id = ?`,
        { replacements: [id_cliente], type: db.QueryTypes.SELECT },
      ),
    );

    if (Number(turnos) >= LIMITE_TURNOS_SIN_AVANCE) {
      const [colAsesor] = await db.query(
        `SELECT id FROM kanban_columnas
          WHERE id_configuracion = ? AND estado_db = 'asesor' AND activo = 1
          LIMIT 1`,
        { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
      );

      if (colAsesor) {
        await db.query(
          `UPDATE clientes_chat_center
              SET estado_contacto = 'asesor', turnos_sin_avance = 0
            WHERE id = ?`,
          { replacements: [id_cliente], type: db.QueryTypes.UPDATE },
        );
        await log(
          `🚨 ${turnos} respuestas en "${columna.nombre}" sin que la conversación avance: cliente ${id_cliente} movido a "asesor"`,
        );
      } else {
        await log(
          `⚠️ ${turnos} respuestas sin avance en "${columna.nombre}" y la configuración ${id_configuracion} no tiene columna "asesor"`,
        );
      }
    } else if (Number(turnos) >= LIMITE_TURNOS_SIN_AVANCE - 3) {
      await log(
        `⏳ ${turnos}/${LIMITE_TURNOS_SIN_AVANCE} respuestas sin avance en "${columna.nombre}" (cliente ${id_cliente})`,
      );
    }
  }

  // ── 12. enviar_media — siempre activo ────────────────────
  let soloTexto = respuestaRaw;
  const { texto, imagenes, videos } = extraerMedia(respuestaRaw);
  soloTexto = texto;

  for (const url of imagenes) {
    await canal
      .enviarMedia({
        tipo: 'image',
        url,
        responsable: `IA_${columna.nombre}`,
      })
      .catch(async (err) => log(`⚠️ Error enviando imagen: ${err.message}`));
  }
  for (const url of videos) {
    await log(`🎥 Intentando enviar video URL: ${url}`);
    try {
      const headRes = await axios.head(url);
      const bytes = headRes.headers['content-length'];
      const mb = bytes ? (bytes / 1024 / 1024).toFixed(2) : 'desconocido';
      await log(`📦 Tamaño video: ${mb} MB`);
    } catch (e) {
      await log(`⚠️ No se pudo verificar tamaño: ${e.message}`);
    }
    await canal
      .enviarMedia({
        tipo: 'video',
        url,
        responsable: `IA_${columna.nombre}`,
      })
      .catch(async (err) =>
        log(`⚠️ Error enviando video URL=${url}: ${err.message}`),
      );
  }

  // ── 13. Enviar texto final ────────────────────────────────
  // Limpiar tags de acciones del texto
  soloTexto = limpiarTagsAcciones(soloTexto).trim();

  /* Y las coletillas de relleno ("no dudes en escribirme", "aquí estoy para
     ayudarte"). Están prohibidas en el prompt y el modelo las escribe igual;
     son lo que hace que la conversación se sienta de robot. */
  const antesColetillas = soloTexto;
  soloTexto = limpiarColetillas(soloTexto);
  if (soloTexto !== antesColetillas) {
    await log(`🧹 Coletilla de relleno eliminada del mensaje`);
  }

  /* Y las fechas pasan a lenguaje de persona. El bloque de agendamiento las
     lleva en formato de sistema porque así las parsea el backend sin
     ambigüedad, pero ese bloque también le llega al cliente: leer
     "2026-08-01 10:00" en un WhatsApp delata la máquina. Se traduce acá, ya
     usadas: "mañana sábado 1 de agosto, 10:00". */
  soloTexto = humanizarFechas(soloTexto);

  /* Y el Markdown que WhatsApp no entiende: los ** llegan como asteriscos a
     la vista. Está prohibido en el prompt y el modelo lo escribe igual. */
  soloTexto = limpiarMarkdown(soloTexto);

  if (soloTexto) {
    // Si la conexión tiene el split activo, la respuesta sale en 2-3 mensajes
    // naturales. Si no, se mantiene el envío de siempre en un solo bloque.
    const [cfgSplit] = await db.query(
      `SELECT ia_split_mensajes FROM configuraciones WHERE id = ? LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );

    if (cfgSplit?.ia_split_mensajes) {
      const r = await enviarEnBloques({
        canal,
        texto: soloTexto,
        responsable: `IA_${columna.nombre}`,
        total_tokens,
        id_cliente,
        turno,
        log,
      });
      await log(
        `✉️ Respuesta enviada en ${r.bloques} mensaje(s)` +
          (r.enSegundoPlano ? ` (${r.enSegundoPlano} en segundo plano)` : ''),
      );
    } else {
      await canal.enviarTexto({
        texto: soloTexto,
        responsable: `IA_${columna.nombre}`,
        total_tokens,
      });
    }
  }

  // ✅ Si llegó hasta aquí, OpenAI está funcionando
  await marcarOpenAIActivo(id_configuracion);

  return { ok: true, respuesta_enviada: soloTexto, total_tokens };
}

// ══════════════════════════════════════════════════════════════
// limpiarCitasFileSearch
// Borra las citas 【X:Y†source】 que OpenAI inyecta automáticamente
// cuando el asistente usa file_search. Dos capas: annotations
// (método oficial por índices) + regex de respaldo.
// ══════════════════════════════════════════════════════════════
function limpiarCitasFileSearch(textBlock) {
  if (!textBlock?.value) return '';
  let texto = textBlock.value;
  const anns = textBlock.annotations || [];

  // Capa 1: borrar por índices exactos (de atrás hacia adelante
  // para no desfasar las posiciones restantes)
  for (let i = anns.length - 1; i >= 0; i--) {
    const a = anns[i];
    if (
      typeof a?.start_index === 'number' &&
      typeof a?.end_index === 'number'
    ) {
      texto = texto.slice(0, a.start_index) + texto.slice(a.end_index);
    }
  }

  // Capa 2: regex de respaldo por si algún formato cambia
  texto = texto
    .replace(/【[^】]*】/g, '')
    .replace(/\[\d+:\d+†[^\]]*\]/g, '')
    .replace(/\[source\]/gi, '')
    .replace(/\[doc\d+\]/gi, '');

  // Limpiar espacios y puntuación que quedaron colgando
  return (
    texto
      // quita espacios horizontales (NO enters) antes de puntuación
      .replace(/[ \t]+([.,;:!?])/g, '$1')
      // colapsa SOLO espacios/tabs horizontales repetidos, deja los \n
      .replace(/[ \t]{2,}/g, ' ')
      // opcional: máximo 2 saltos de línea seguidos (evita huecos enormes)
      .replace(/\n{3,}/g, '\n\n')
      // limpia espacios al final de cada línea
      .replace(/[ \t]+$/gm, '')
      .trim()
  );
}

function limpiarCitasResponsesAPI(text, annotations = []) {
  if (!text) return '';
  let texto = text;

  const sortedAnns = [...annotations].sort(
    (a, b) => (b.start_index || 0) - (a.start_index || 0),
  );
  for (const a of sortedAnns) {
    if (
      typeof a?.start_index === 'number' &&
      typeof a?.end_index === 'number'
    ) {
      texto = texto.slice(0, a.start_index) + texto.slice(a.end_index);
    }
  }

  texto = texto
    .replace(/【[^】]*】/g, '')
    .replace(/\[\d+:\d+†[^\]]*\]/g, '')
    .replace(/\[source\]/gi, '')
    .replace(/\[doc\d+\]/gi, '');

  return texto
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

// ══════════════════════════════════════════════════════════════
// ejecutarAsistente — polling OpenAI
// ══════════════════════════════════════════════════════════════
async function ejecutarAsistente({
  id_thread,
  assistant_id,
  mensaje,
  max_tokens = 500,
  headers,
  skip_send_message = false,
  additional_instructions = null,
}) {
  try {
    if (!skip_send_message && mensaje) {
      await axios.post(
        `https://api.openai.com/v1/threads/${id_thread}/messages`,
        { role: 'user', content: mensaje },
        { headers },
      );
    }

    const runBody = { assistant_id, max_completion_tokens: max_tokens };
    if (additional_instructions) {
      runBody.additional_instructions = additional_instructions;
      await log(
        `📎 additional_instructions inyectado (${additional_instructions.length} chars)`,
      );
      await log(
        `📎 additional_instructions inyectado 2: (${additional_instructions})`,
      );
    }

    const runRes = await axios.post(
      `https://api.openai.com/v1/threads/${id_thread}/runs`,
      runBody,
      { headers },
    );
    const run_id = runRes?.data?.id;
    if (!run_id) throw new Error('No se pudo crear run');

    let statusRun = 'queued';
    let attempts = 0;
    let total_tokens = 0;

    while (
      statusRun !== 'completed' &&
      statusRun !== 'failed' &&
      attempts < 45
    ) {
      await new Promise((r) => setTimeout(r, 2000));
      attempts++;
      const statusRes = await axios.get(
        `https://api.openai.com/v1/threads/${id_thread}/runs/${run_id}`,
        { headers },
      );
      statusRun = statusRes.data.status;
      if (statusRes.data.usage) {
        total_tokens = statusRes.data.usage.total_tokens || 0;
      }
      await log(`run ${run_id} intento=${attempts} status=${statusRun}`);

      if (statusRun === 'failed') {
        const lastErr = statusRes.data.last_error;
        throw new Error(`Run falló: ${JSON.stringify(lastErr)}`);
      }
    }

    if (statusRun !== 'completed')
      throw new Error(`Run no completó (status=${statusRun})`);

    const messagesRes = await axios.get(
      `https://api.openai.com/v1/threads/${id_thread}/messages`,
      { headers },
    );
    const mensajes = messagesRes.data.data || [];
    const textBlock = mensajes
      .reverse()
      .find((m) => m.role === 'assistant' && m.run_id === run_id)
      ?.content?.[0]?.text;

    const respuesta = limpiarCitasFileSearch(textBlock);
    return { respuesta, total_tokens };
  } catch (err) {
    if (esSinSaldo(err)) {
      await log(
        `🚨 SIN SALDO OPENAI: ${err?.response?.data?.error?.message || err.message}`,
      );
      const e = new Error('sin_saldo_openai');
      e.code = 'sin_saldo_openai';
      throw e;
    }
    throw err;
  }
}

async function ejecutarConResponsesAPI({
  previous_response_id,
  instructions,
  additional_instructions,
  input,
  model,
  max_tokens,
  vector_store_id,
  api_key_openai,
}) {
  const headers = {
    Authorization: `Bearer ${api_key_openai}`,
    'Content-Type': 'application/json',
  };

  let finalInstructions = instructions || '';
  if (additional_instructions) {
    finalInstructions += '\n\n' + additional_instructions;
  }

  const tools = [];
  if (vector_store_id) {
    tools.push({ type: 'file_search', vector_store_ids: [vector_store_id] });
  }

  const body = {
    model: model || 'gpt-4o-mini',
    instructions: finalInstructions,
    input,
    store: true,
    max_output_tokens: max_tokens || 500,
  };

  if (previous_response_id) {
    body.previous_response_id = previous_response_id;
  }

  if (tools.length > 0) {
    body.tools = tools;
  }

  const res = await axios.post('https://api.openai.com/v1/responses', body, {
    headers,
    timeout: 60000,
  });

  const response_id = res.data.id;
  const total_tokens = res.data.usage?.total_tokens || 0;

  const outputItems = res.data.output || [];
  const messageItem = outputItems.find((item) => item.type === 'message');
  const textContent = messageItem?.content?.find(
    (c) => c.type === 'output_text',
  );

  const rawText = textContent?.text || '';
  const annotations = textContent?.annotations || [];

  const respuesta = limpiarCitasResponsesAPI(rawText, annotations);

  return { respuesta, response_id, total_tokens };
}

// ══════════════════════════════════════════════════════════════
// Helpers de procesamiento de respuesta
// ══════════════════════════════════════════════════════════════

function extraerMedia(texto) {
  const imagenes = (
    texto.match(
      /\[(producto_imagen_url|servicio_imagen_url|upsell_imagen_url)\]:\s*(https?:\/\/[^\s]+)/gi,
    ) || []
  )
    .map((s) => {
      const m = s.match(/\]:\s*(https?:\/\/[^\s]+)/i);
      return m ? m[1] : null;
    })
    .filter(Boolean);

  const videos = (
    texto.match(
      /\[(producto_video_url|servicio_video_url)\]:\s*(https?:\/\/[^\s]+)/gi,
    ) || []
  )
    .map((s) => {
      const m = s.match(/\]:\s*(https?:\/\/[^\s]+)/i);
      return m ? m[1] : null;
    })
    .filter(Boolean);

  let textoLimpio = texto
    .replace(
      /\[(producto_imagen_url|servicio_imagen_url|upsell_imagen_url)\]:\s*https?:\/\/[^\s]+/gi,
      '',
    )
    .replace(
      /\[(producto_video_url|servicio_video_url)\]:\s*https?:\/\/[^\s]+/gi,
      '',
    );

  return { texto: textoLimpio, imagenes, videos };
}

function limpiarTagsAcciones(texto) {
  return texto
    .replace(/\[pedido_confirmado\]:\s*(true|false)/gi, '')
    .replace(/\[cita_confirmada\]:\s*(true|false)/gi, '')
    .replace(/\[asesor_confirmado\]:\s*(true|false)/gi, '')
    .replace(/\[atencion_urgente\]:\s*(true|false)/gi, '')
    .replace(/\[[^\]]+\]:\s*(true|false)/gi, '') // cualquier tag booleano
    .trim();
}

/**
 * Elige a quién le toca la cita entre los profesionales de la sede.
 *
 * Devuelve el id, `null` si la sede no tiene profesionales cargados (y entonces
 * todo funciona como antes), o `{ error }` si no queda nadie libre.
 *
 * Si el bot escribió una línea "Atiende: <nombre>" —porque la clienta la pidió—
 * se respeta o se falla: cambiarla en silencio por otra persona es peor que no
 * agendar, la clienta llegaría esperando a alguien que no la va a atender.
 */
async function elegirProfesionalLibre({
  id_configuracion,
  establecimiento,
  calendarId,
  inicio_utc,
  fin_utc,
  pedido,
}) {
  if (!establecimiento?.id) return null;

  const profesionales = await db.query(
    `SELECT id, nombre FROM profesionales_chat_center
      WHERE id_configuracion = ? AND id_establecimiento = ?
        AND activo = 1 AND eliminado = 0
      ORDER BY orden ASC, id ASC`,
    {
      replacements: [id_configuracion, establecimiento.id],
      type: db.QueryTypes.SELECT,
    },
  );
  if (!profesionales.length) return null;

  // Ocupados en ese rango. 'Bloqueado' sin profesional cierra el local entero.
  const ocupados = await db.query(
    `SELECT DISTINCT id_profesional FROM appointments
      WHERE calendar_id = ?
        AND status IN ('Agendado', 'Confirmado', 'Bloqueado')
        AND start_utc < ? AND end_utc > ?
        AND id_profesional IS NOT NULL`,
    {
      replacements: [calendarId, fin_utc, inicio_utc],
      type: db.QueryTypes.SELECT,
    },
  );
  const ocupadosSet = new Set(ocupados.map((o) => Number(o.id_profesional)));

  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/\s+/g, ' ')
      .trim();

  if (pedido) {
    const buscado = norm(pedido);
    const elegido =
      profesionales.find((p) => norm(p.nombre) === buscado) ||
      profesionales.find(
        (p) =>
          norm(p.nombre).includes(buscado) || buscado.includes(norm(p.nombre)),
      );
    if (!elegido) {
      return { error: `no existe "${pedido}" entre quienes atienden en la sede` };
    }
    if (ocupadosSet.has(Number(elegido.id))) {
      return { error: `${elegido.nombre} ya tiene una cita a esa hora` };
    }
    return elegido.id;
  }

  const libre = profesionales.find((p) => !ocupadosSet.has(Number(p.id)));
  if (!libre) {
    return {
      error: `no queda nadie libre en "${establecimiento.nombre}" a esa hora (${profesionales.length} atienden)`,
    };
  }
  return libre.id;
}

async function procesarAgendarCita(mensajeGPT, id_configuracion, id_cliente) {
  const moment = require('moment-timezone');

  /* El bloque llega tal como lo escribió el modelo, y el modelo pone negritas
     cuando le parece: "🧑 **Nombre:** Ana". Con el emoji y los asteriscos
     obligatorios en el patrón, ese bloque no matcheaba NADA — la cita se creaba
     con los campos vacíos y una fecha inválida, sin un solo error a la vista.
     Se quita el énfasis antes de leer y el emoji queda opcional. */
  const limpio = String(mensajeGPT || '').replace(/[*_]{1,2}/g, '');
  const campo = (etiqueta) =>
    limpio
      .match(new RegExp(`${etiqueta}\\s*:\\s*(.+)`, 'i'))?.[1]
      ?.trim() || '';

  const nombre = campo('Nombre');
  const correo = campo('Correo');
  const servicio = campo('Servicio que desea');

  /* El teléfono NO se lee del bloque: el que vale es el número desde el que la
     persona escribe, que llega en el webhook. El modelo lo inventaba, lo pedía
     de nuevo o escribía "no registra", y la cita quedaba sin forma de llamar a
     nadie. Solo si el contacto no tuviera número se usa lo que haya escrito. */
  const [contacto] = await db.query(
    `SELECT celular_cliente FROM clientes_chat_center WHERE id = ? LIMIT 1`,
    { replacements: [id_cliente], type: db.QueryTypes.SELECT },
  );
  const telefonoBloque = campo('Tel[eé]fono');
  const telefono =
    contacto?.celular_cliente ||
    (/no registra/i.test(telefonoBloque) ? '' : telefonoBloque);
  /* La hora de fin ya no se le pide al modelo: el resumen que ve el cliente era
     larguísimo y esa línea no le dice nada. Se calcula con la duración que tiene
     el servicio en el catálogo. Se sigue leyendo si viene, para no romper las
     cuentas cuyo prompt todavía la incluye. */
  const fechaIni = campo('Fecha y hora de inicio') || campo('Fecha y hora');
  const fechaFin = campo('Fecha y hora de fin');

  const mIni = moment.tz(fechaIni, 'YYYY-MM-DD HH:mm', 'America/Guayaquil');

  if (!mIni.isValid()) {
    await log(
      `❌ agendar_cita: fecha ilegible en el bloque (inicio="${fechaIni}"); la cita NO se creó`,
    );
    return { ok: false, motivo: 'fecha ilegible en el bloque' };
  }

  let mFin = fechaFin
    ? moment.tz(fechaFin, 'YYYY-MM-DD HH:mm', 'America/Guayaquil')
    : null;

  if (!mFin || !mFin.isValid() || !mFin.isAfter(mIni)) {
    const [servicioCat] = await db.query(
      `SELECT duracion FROM productos_chat_center
        WHERE id_configuracion = ? AND eliminado = 0 AND duracion > 0
          AND ? LIKE CONCAT('%', nombre, '%')
        ORDER BY CHAR_LENGTH(nombre) DESC LIMIT 1`,
      {
        replacements: [id_configuracion, servicio || ''],
        type: db.QueryTypes.SELECT,
      },
    );

    const minutos = Number(servicioCat?.duracion) > 0 ? Number(servicioCat.duracion) : 60;
    mFin = mIni.clone().add(minutos, 'minutes');
    await log(
      `🕒 agendar_cita: hora de fin calculada (${minutos} min de "${servicio || 'sin servicio'}")`,
    );
  }

  const inicio_utc = mIni.utc().format();
  const fin_utc = mFin.utc().format();

  /* Un producto no se agenda, se entrega. El bot igual arma citas de "recogida"
     cuando la clienta quiere comprar algo, y eso le ocupa un cupo real de la
     agenda a un tratamiento. Se corta acá y no solo en el prompt: si lo que
     escribió en "Servicio" es un producto del catálogo, no hay cita y el caso
     pasa a un asesor, que es quien cierra la venta. */
  if (servicio) {
    const catalogo = await db.query(
      `SELECT nombre, tipo FROM productos_chat_center
        WHERE id_configuracion = ? AND eliminado = 0`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );

    const norm = (s) =>
      String(s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/\s+/g, ' ')
        .trim();

    const pedido = norm(servicio);
    const esProducto = catalogo.some((p) => {
      if (String(p.tipo || '').toLowerCase() === 'servicio') return false;
      const n = norm(p.nombre);
      return n.length > 3 && (pedido.includes(n) || n.includes(pedido));
    });

    if (esProducto) {
      await log(
        `⛔ agendar_cita: "${servicio}" es un producto del catálogo, no un servicio; la cita NO se creó`,
      );
      return {
        ok: false,
        motivo: `"${servicio}" es un producto: se vende y se entrega, no se agenda`,
      };
    }
  }

  /* Sede elegida por el bot. Si la cuenta tiene varias sucursales, la cita va al
     calendario de ESA sede; si no, al único que exista. Antes siempre se tomaba
     el primer calendario de la cuenta (LIMIT 1 sin orden), así que una cuenta
     con dos sedes agendaba todo en la misma agenda. */
  /* El bloque ahora lleva "Sede La Carolina — Av. Amazonas 123" porque al
     cliente la dirección le sirve y el nombre solo no. Para buscar la sede se
     usa lo que va antes del guion. */
  const sedeNombre = campo('Sede').split(/\s+[—–-]\s+/)[0].trim();

  const sedes = await db.query(
    `SELECT id, nombre, ciudad, direccion, id_calendario
       FROM establecimientos_chat_center
      WHERE id_configuracion = ? AND eliminado = 0 AND activo = 1
      ORDER BY orden ASC, id ASC`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  let establecimiento = null;

  if (sedes.length === 1) {
    // Con una sola sede no hay nada que elegir, escriba lo que escriba el bot.
    establecimiento = sedes[0];
  } else if (sedeNombre && sedes.length) {
    // Sin tildes ni dobles espacios: "Sede La Carolína" y "la carolina" son la misma.
    const norm = (s) =>
      String(s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
    const buscado = norm(sedeNombre);

    /* Coincidencia flexible a propósito: el bot abrevia ("La Carolina" por
       "Sede La Carolina"). Con igualdad exacta eso caía al calendario por
       defecto y una cuenta de varias sedes agendaba en la sucursal equivocada
       sin avisar. */
    establecimiento =
      sedes.find((s) => norm(s.nombre) === buscado) ||
      sedes.find(
        (s) =>
          norm(s.nombre).includes(buscado) || buscado.includes(norm(s.nombre)),
      ) ||
      null;

    if (!establecimiento) {
      await log(
        `⚠️ agendar_cita: el bot mencionó la sede "${sedeNombre}" y no coincide con ninguna de la configuración ${id_configuracion}`,
      );
    }
  }

  const [usuario] = await db.query(
    `SELECT sb.id_sub_usuario, sb.id_usuario
     FROM configuraciones c
     INNER JOIN sub_usuarios_chat_center sb ON sb.id_usuario = c.id_usuario
     WHERE c.id = ? AND sb.rol = 'administrador' LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (!usuario) {
    await log(
      `❌ agendar_cita: la configuración ${id_configuracion} no tiene sub-usuario administrador; la cita NO se creó`,
    );
    return { ok: false, motivo: 'sin sub-usuario administrador' };
  }

  /* La agenda se crea al vuelo si no existe.
     Antes esto se abandonaba con un log y la cita no se creaba nunca. Y como la
     acción `cambiar_estado` corre por separado, la tarjeta igual se movía a
     "Cita agendada": quedaba una cita fantasma, visible en el tablero e
     inexistente en el calendario, sin ningún error a la vista.
     Pasaba siempre en cuentas recién montadas, porque la fila de `calendars`
     solo nacía cuando alguien abría la pantalla de Calendario (/calendars/ensure). */
  let calendarId = null;

  if (establecimiento?.id_calendario) {
    const [c] = await db.query(`SELECT id FROM calendars WHERE id = ? LIMIT 1`, {
      replacements: [establecimiento.id_calendario],
      type: db.QueryTypes.SELECT,
    });
    calendarId = c?.id || null;
  }

  if (!calendarId) {
    const [c] = await db.query(
      `SELECT id FROM calendars WHERE account_id = ? AND is_active = 1
        ORDER BY id ASC LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    calendarId = c?.id || null;
  }

  if (!calendarId) {
    try {
      const { ensureDefaultCalendar } = require('./calendars.service');
      const creado = await ensureDefaultCalendar({
        account_id: Number(id_configuracion),
        name: 'Agenda principal',
        created_by: usuario.id_usuario,
      });
      calendarId = creado?.id || null;
      await log(
        `📅 agendar_cita: la configuración ${id_configuracion} no tenía agenda; se creó la ${calendarId}`,
      );
    } catch (e) {
      await log(`❌ agendar_cita: no se pudo crear la agenda: ${e.message}`);
      return { ok: false, motivo: `no se pudo crear la agenda: ${e.message}` };
    }
  }

  /* ── Quién atiende ────────────────────────────────────────────────
     Sin esto el bot mandaba todas las citas al mismo sub-usuario administrador,
     así que un centro con tres esteticistas solo podía recibir UNA cita por
     hora: la segunda moría con "el encargado ya tiene una cita".
     Con profesionales cargados, la capacidad la da cuánta gente atiende. Si la
     sede no tiene ninguno, todo sigue como antes. */
  const idProfesional = await elegirProfesionalLibre({
    id_configuracion,
    establecimiento,
    calendarId,
    inicio_utc,
    fin_utc,
    pedido: campo('Atiende'),
  });

  if (idProfesional && idProfesional.error) {
    await log(`❌ agendar_cita: ${idProfesional.error}`);
    return { ok: false, motivo: idProfesional.error };
  }

  /* Cita repetida. El bot vuelve a escribir el bloque cuando la persona
     responde "sí" o "perfecto" después de confirmada —pasa sobre todo en la
     columna "Cita agendada", que también puede agendar para reprogramar— y eso
     creaba una segunda cita idéntica: dos cupos ocupados y la sede esperando a
     alguien dos veces. Si ya existe una en ese mismo horario para este contacto,
     se da por hecha. */
  const [yaExiste] = await db.query(
    `SELECT ap.id
       FROM appointments ap
       JOIN appointment_invitees inv ON inv.appointment_id = ap.id
      WHERE ap.calendar_id = ?
        AND ap.start_utc = ?
        AND ap.status IN ('Agendado', 'Confirmado')
        AND RIGHT(REGEXP_REPLACE(inv.phone, '[^0-9]', ''), 9)
            = RIGHT(REGEXP_REPLACE(?, '[^0-9]', ''), 9)
      LIMIT 1`,
    {
      replacements: [
        calendarId,
        moment.utc(inicio_utc).format('YYYY-MM-DD HH:mm:ss'),
        telefono || '',
      ],
      type: db.QueryTypes.SELECT,
    },
  );

  if (yaExiste) {
    await log(
      `♻️ agendar_cita: ${nombre} ya tenía la cita ${yaExiste.id} a esa misma hora; no se duplica`,
    );
    return { ok: true, id: yaExiste.id, repetida: true };
  }

  const payload = {
    assigned_user_id: usuario.id_sub_usuario,
    id_profesional: idProfesional || null,
    booked_tz: 'America/Guayaquil',
    calendar_id: calendarId,
    create_meet: true,
    created_by_user_id: usuario.id_usuario,
    description: '',
    end: fin_utc,
    invitees: [{ name: nombre, email: correo, phone: telefono }],
    // Para un servicio presencial la ubicación es la sede, no "online".
    location_text: establecimiento
      ? [
          establecimiento.nombre,
          establecimiento.direccion,
          establecimiento.ciudad,
        ]
          .filter(Boolean)
          .join(' — ')
          .slice(0, 255)
      : 'online',
    meeting_url: null,
    start: inicio_utc,
    status: 'Agendado',
    title: `${nombre} - ${servicio}`,
  };

  const cita = await servicioAppointments.createAppointment(
    payload,
    usuario.id_usuario,
  );

  // La sede se guarda aparte: createAppointment no la conoce y no vale la pena
  // meterle un campo que solo usa este flujo.
  if (establecimiento?.id && cita?.id) {
    await db.query(
      `UPDATE appointments SET id_establecimiento = ? WHERE id = ?`,
      {
        replacements: [establecimiento.id, cita.id],
        type: db.QueryTypes.UPDATE,
      },
    );
  }

  await log(
    `✅ Cita agendada: ${nombre} - ${servicio} - ${inicio_utc}${establecimiento ? ` · sede "${establecimiento.nombre}"` : ''}`,
  );

  return { ok: true, id: cita?.id || null };
}

/**
 * Columnas donde el seguimiento NO se apaga porque el cliente conteste.
 *
 * En las columnas de venta, una respuesta significa "ya reaccionó, deja de
 * perseguirlo" y por eso cancelarRemarketingKanban apaga enviar_remarketing.
 * En retiro en agencia significa lo contrario: el paquete sigue físicamente en
 * la agencia y "mañana paso" no es haberlo retirado. Aquí el seguimiento solo
 * termina cuando el contacto SALE de la columna — porque el bot confirmó el
 * retiro (y lo movió a entregada), porque pasó a un asesor, o porque Dropi
 * cambió el estado del envío.
 *
 * El cron respeta ese límite por su lado: si el estado_contacto ya no coincide
 * con el de la fila, la cancela sin enviar.
 */
const COLUMNAS_SEGUIMIENTO_PERSISTENTE = new Set(['retiro_agencia']);

// ══════════════════════════════════════════════════════════════
// cancelarRemarketingKanban
// Se llama SIEMPRE que el cliente envía un mensaje en modo kanban
// ══════════════════════════════════════════════════════════════
async function cancelarRemarketingKanban(id_cliente, id_configuracion) {
  try {
    // 1) Verificar si YA se le envió un remarketing a este cliente
    //    (para saber si está respondiendo a un remarketing o iniciando conversación)
    const [remarketingEnviado] = await db.query(
      `SELECT id FROM remarketing_pendientes
       WHERE id_cliente_chat_center = ?
         AND id_configuracion = ?
         AND enviado = 1
         AND cancelado = 0
       LIMIT 1`,
      {
        replacements: [id_cliente, id_configuracion],
        type: db.QueryTypes.SELECT,
      },
    );

    // 2) Cancelar los remarketings pendientes (los que aún no salieron)
    await db.query(
      `UPDATE remarketing_pendientes
       SET cancelado = 1
       WHERE id_cliente_chat_center = ?
         AND id_configuracion = ?
         AND enviado = 0
         AND cancelado = 0`,
      {
        replacements: [id_cliente, id_configuracion],
        type: db.QueryTypes.UPDATE,
      },
    );

    // 3) Si ya se le había enviado remarketing → el cliente está respondiendo
    //    a ese remarketing → apagar flag para no seguir persiguiéndolo.
    //    Si no había enviado nada → dejar el flag como está.
    if (remarketingEnviado) {
      await db.query(
        `UPDATE clientes_chat_center
         SET enviar_remarketing = 0
         WHERE id = ?`,
        {
          replacements: [id_cliente],
          type: db.QueryTypes.UPDATE,
        },
      );
      await log(
        `✅ Remarketing cancelado + enviar_remarketing=0 (respondió a RMK id=${remarketingEnviado.id}) cliente=${id_cliente}`,
      );
    } else {
      await log(
        `✅ Remarketing pendientes cancelados (sin envío previo, flag no tocado) cliente=${id_cliente}`,
      );
    }
  } catch (err) {
    await log(`⚠️ Error cancelando remarketing: ${err.message}`);
  }
}

// ══════════════════════════════════════════════════════════════
// programarRemarketingKanban
// Se llama SIEMPRE después de procesar el mensaje (con o sin IA)
// ══════════════════════════════════════════════════════════════
async function programarRemarketingKanban({
  id_configuracion,
  id_cliente,
  telefono,
  estado_contacto,
  // Valores del body de la plantilla, YA resueltos. Se reciben aquí porque
  // quien agenda (p. ej. el notifier de Dropi) tiene el pedido a la vista;
  // el cron dispara horas después, cuando ese contexto ya no existe.
  // Array de strings en el orden de {{1}}, {{2}}, {{3}}…
  template_parameters = null,
}) {
  try {
    // 🚫 Verificar si el cliente tiene el remarketing desactivado
    const [clienteRM] = await db.query(
      `SELECT enviar_remarketing FROM clientes_chat_center WHERE id = ? LIMIT 1`,
      { replacements: [id_cliente], type: db.QueryTypes.SELECT },
    );

    const persistente = COLUMNAS_SEGUIMIENTO_PERSISTENTE.has(estado_contacto);

    if (clienteRM && Number(clienteRM.enviar_remarketing) === 0) {
      if (!persistente) {
        await log(
          `🚫 SKIP programarRemarketing — cliente=${id_cliente} tiene enviar_remarketing=0`,
        );
        return;
      }
      // Columna de seguimiento persistente: hay que volver a encenderlo. Lo
      // apagó cancelarRemarketingKanban hace un instante, al ver que el cliente
      // respondía a un recordatorio ya enviado — y el cron descarta las filas de
      // clientes con el flag en 0, así que sin esto el seguimiento moriría con
      // la primera respuesta, incluso si fue "mañana paso a retirarlo".
      await db.query(
        `UPDATE clientes_chat_center SET enviar_remarketing = 1 WHERE id = ?`,
        { replacements: [id_cliente], type: db.QueryTypes.UPDATE },
      );
      await log(
        `🔁 enviar_remarketing reactivado (columna persistente "${estado_contacto}") cliente=${id_cliente}`,
      );
    }

    const [configRM] = await db.query(
      `SELECT tiempo_espera_horas, tiempo_espera_minutos, nombre_template, language_code,
              estado_destino, header_format, header_media_url,
              header_media_name, header_parameters,
              id_template_rapido, usar_respuesta_rapida,
              metodo_dentro_24h, prompt_ia
       FROM configuracion_remarketing
       WHERE id_configuracion = ? AND estado_contacto = ? AND secuencia = 1 AND activo = 1
       LIMIT 1`,
      {
        replacements: [id_configuracion, estado_contacto],
        type: db.QueryTypes.SELECT,
      },
    );

    if (!configRM) return;

    // Si quien reagenda no trae parámetros (el bot, que no conoce el pedido)
    // se heredan los del último pendiente de ESTA MISMA columna. Sin esto, una
    // respuesta del cliente en la columna de agencia reinicia la secuencia sin
    // nombre/agencia/guía, y Meta rechaza el siguiente envío por número de
    // parámetros (132000).
    //
    // NO se filtra por enviado/cancelado a propósito: el webhook llama a
    // cancelarRemarketingKanban ANTES de reprogramar, así que para cuando se
    // llega aquí la fila que tiene los datos ya quedó en cancelado=1 —
    // filtrarla dejaría el heredado siempre en null.
    //
    // Sí se filtra por columna: cada secuencia usa su propia plantilla y
    // heredar los parámetros de otra rompería igual el conteo de variables.
    // La ventana evita revivir datos de un pedido viejo (guía ya entregada).
    let paramsHeredados = null;
    if (!Array.isArray(template_parameters) || !template_parameters.length) {
      const [previo] = await db.query(
        `SELECT template_parameters FROM remarketing_pendientes
          WHERE id_cliente_chat_center = ? AND id_configuracion = ?
            AND estado_contacto_origen = ?
            AND template_parameters IS NOT NULL
            AND creado_en > NOW() - INTERVAL 30 DAY
          ORDER BY id DESC LIMIT 1`,
        {
          replacements: [id_cliente, id_configuracion, estado_contacto],
          type: db.QueryTypes.SELECT,
        },
      );
      paramsHeredados = previo?.template_parameters || null;
    }

    await db.query(
      `UPDATE remarketing_pendientes
       SET cancelado = 1
       WHERE id_cliente_chat_center = ?
         AND id_configuracion = ?
         AND enviado = 0
         AND cancelado = 0`,
      {
        replacements: [id_cliente, id_configuracion],
        type: db.QueryTypes.UPDATE,
      },
    );

    const [cfg] = await db.query(
      `SELECT telefono FROM configuraciones WHERE id = ? LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );

    const telefono_configuracion = cfg?.telefono ? String(cfg.telefono) : null;
    if (!telefono_configuracion) return;

    const minutos =
      configRM.tiempo_espera_minutos != null
        ? Number(configRM.tiempo_espera_minutos)
        : Number(configRM.tiempo_espera_horas || 0) * 60;

    const tiempoDisparo = new Date(Date.now() + minutos * 60 * 1000);

    const headerMediaUrl = configRM.header_media_url
      ? configRM.header_media_url.replace(/&amp;/g, '&')
      : null;

    await db.query(
      `INSERT INTO remarketing_pendientes
       (telefono, telefono_configuracion, id_cliente_chat_center,
        id_configuracion, estado_contacto_origen, nombre_template,
        language_code, tiempo_disparo, estado_destino,
        header_format, header_media_url, header_media_name, header_parameters,
        id_template_rapido, usar_respuesta_rapida,
        metodo_dentro_24h, prompt_ia, template_parameters,
        enviado, cancelado, secuencia)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1)`,
      {
        replacements: [
          telefono,
          telefono_configuracion,
          id_cliente,
          id_configuracion,
          estado_contacto,
          configRM.nombre_template,
          configRM.language_code,
          tiempoDisparo,
          configRM.estado_destino || null,
          configRM.header_format || null,
          headerMediaUrl,
          configRM.header_media_name || null,
          configRM.header_parameters || null,
          configRM.id_template_rapido || null,
          configRM.usar_respuesta_rapida ? 1 : 0,
          configRM.metodo_dentro_24h || 'ninguno',
          configRM.prompt_ia || null,
          Array.isArray(template_parameters) && template_parameters.length
            ? JSON.stringify(template_parameters.map((v) => String(v ?? '')))
            : paramsHeredados,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
    await log(
      `📅 Remarketing programado en ${minutos}min — estado=${estado_contacto} método=${configRM.metodo_dentro_24h || 'ninguno'}`,
    );
  } catch (err) {
    await log(`⚠️ Error programando remarketing: ${err.message}`);
  }
}

module.exports = {
  procesarMensajeKanban,
  cancelarRemarketingKanban,
  programarRemarketingKanban,
  // Exportados para reutilizar la generación IA desde el remarketing de IG
  // (no cambian el comportamiento de WhatsApp; son helpers puros de OpenAI).
  ejecutarAsistente,
  ejecutarConResponsesAPI,
  // Lo usa el cron de remarketing: los mensajes que redacta con el asistente de
  // una columna pueden traer tags de acción, y ahí nadie los interpretaba ni los
  // limpiaba (ver cron/remarketing.js → generarMensajeRemarketingIA).
  limpiarTagsAcciones,
  // Expuesta para poder verificar el agendamiento sin levantar toda la
  // conversación: es el camino donde una falla no se ve (la tarjeta se mueve
  // igual aunque la cita no se cree).
  procesarAgendarCita,
};
