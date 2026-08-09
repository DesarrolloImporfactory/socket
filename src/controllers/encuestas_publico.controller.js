/**
 * encuestas_publico.controller.js
 *
 * Endpoints PÚBLICOS (sin auth) para la encuesta que ve el cliente final.
 * - GET  /publica/:idEncuesta?cid=123  → datos de la encuesta + nombre del cliente
 * - POST /publica/:idEncuesta/responder → guardar respuesta
 *
 * Hay dos formas de abrir el mismo formulario:
 *
 *  1. Con `?cid=` — el link se generó desde el chat o desde una plantilla, así
 *     que ya sabemos a qué cliente pertenece la respuesta.
 *  2. Sin `?cid=` (link público que el usuario comparte por donde quiera) — no
 *     hay forma de saber quién responde, así que el formulario **exige**
 *     teléfono + código de país. Con ese número se busca o se crea el contacto
 *     en `clientes_chat_center` (mismo camino que el webhook de leads, con
 *     round robin incluido) y la respuesta queda asociada al chat.
 */

const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');
const {
  normalizarPreguntas,
  validarRespuestasRequeridas,
} = require('../utils/encuestaPreguntas');
const { ensureUnifiedClient } = require('../utils/unified/ensureUnifiedClient');
const {
  asignarRoundRobinClienteExistente,
} = require('../utils/webhook_whatsapp/round_robin');

/** Parse tolerante de las columnas JSON (pueden venir string u objeto). */
function parseJsonSeguro(valor) {
  if (!valor) return {};
  if (typeof valor === 'object') return valor;
  try {
    const parsed = JSON.parse(valor);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Conexión (id_configuracion) a la que pertenece la encuesta, más los datos de
 * la configuración que necesita el round robin al crear el contacto.
 *
 * ORDER BY explícito: una encuesta debería tener una sola conexión activa, pero
 * si algún día tiene dos, el LIMIT 1 sin orden elegiría una al azar y la
 * respuesta caería en la cuenta equivocada.
 */
async function resolverConexionEncuesta(idEncuesta) {
  const [conn] = await db.query(
    `SELECT ec.id_configuracion,
            cfg.id_usuario AS id_usuario_dueno,
            cfg.permiso_round_robin,
            cfg.id_telefono AS business_phone_id
       FROM encuestas_conexiones ec
       JOIN configuraciones cfg ON cfg.id = ec.id_configuracion
      WHERE ec.id_encuesta = :enc
        AND ec.activa = 1
        AND cfg.suspendido = 0
      ORDER BY ec.id ASC
      LIMIT 1`,
    { replacements: { enc: idEncuesta }, type: QueryTypes.SELECT },
  );

  return conn || null;
}

/**
 * Une código de país + número local en el formato que guarda la plataforma
 * (solo dígitos, con código de país al frente: 593987654321).
 *
 * Tolera lo que la gente escribe de verdad: "0987 654 321", "(09) 8765-4321"
 * e incluso el número ya con el código de país repetido adelante.
 *
 * @returns {string|null} null si no es un número plausible.
 */
function normalizarTelefonoPublico(codigoPais, telefono) {
  const cc = String(codigoPais || '').replace(/\D/g, '');
  let local = String(telefono || '').replace(/\D/g, '');

  if (!cc || !local) return null;

  // "0987654321" → "987654321": el 0 es de marcación nacional, no del número.
  local = local.replace(/^0+/, '');

  // El cliente ya escribió el código de país dentro del campo del número.
  // El margen de 5 dígitos evita recortar números que casualmente empiezan
  // con los mismos dígitos que su código de país.
  if (local.startsWith(cc) && local.length > cc.length + 5) {
    local = local.slice(cc.length);
  }

  const completo = cc + local;

  // Rango de la E.164 (con algo de holgura hacia abajo).
  if (completo.length < 8 || completo.length > 15) return null;

  return completo;
}

/**
 * Busca o crea el contacto a partir del teléfono que escribió el cliente en el
 * formulario público. Mismo camino que el webhook de leads: `ensureUnifiedClient`
 * aplica round robin si tiene que crearlo.
 *
 * `asignarRR` solo se activa en encuestas de tipo lead. En satisfacción NO se
 * puede: `asignarRoundRobinClienteExistente` pone `chat_cerrado = 0`, y esa
 * encuesta se responde justamente después de cerrar el chat — reabriría el que
 * el asesor acaba de cerrar.
 */
async function resolverClienteDesdeTelefono({
  conexion,
  telefono,
  nombre,
  apellido,
  asignarRR = false,
}) {
  // El nombre es opcional en el formulario. Si no lo escribe, se guarda el
  // número: la lista de chats resuelve el nombre con `??`, que NO atrapa el
  // string vacío, así que un contacto sin nombre aparecería en blanco.
  const nombreLimpio = String(nombre || '').trim();

  const cliente = await ensureUnifiedClient({
    id_configuracion: conexion.id_configuracion,
    id_usuario_dueno: conexion.id_usuario_dueno,
    source: 'wa',
    business_phone_id: conexion.business_phone_id,
    phone: telefono,
    nombre_cliente: nombreLimpio || telefono,
    apellido_cliente: String(apellido || '').trim(),
    motivo: 'auto_round_robin_encuesta_publica',
    permiso_round_robin: conexion.permiso_round_robin,
  });

  if (!cliente?.id) return null;

  if (asignarRR && !cliente.id_encargado) {
    try {
      const nuevoEncargado = await asignarRoundRobinClienteExistente({
        id_cliente: cliente.id,
        id_configuracion: conexion.id_configuracion,
        id_usuario_dueno: conexion.id_usuario_dueno,
        permiso_round_robin: conexion.permiso_round_robin,
        motivo: 'auto_round_robin_encuesta_publica',
      });

      if (nuevoEncargado) cliente.id_encargado = nuevoEncargado;
    } catch (rrErr) {
      // Que no haya asesor asignado no invalida la respuesta: se guarda igual.
      console.error(
        '[encuestas_publico] Error aplicando RR al contacto:',
        rrErr.message,
      );
    }
  }

  return cliente;
}

/**
 * GET /api/v1/encuestas_publico/publica/:idEncuesta?cid=123
 */
exports.obtenerEncuestaPublica = async (req, res) => {
  try {
    const { idEncuesta } = req.params;
    const cid = req.query.cid || null;

    if (!idEncuesta) {
      return res.status(400).json({ ok: false, error: 'Falta id de encuesta' });
    }

    // Obtener encuesta
    const [encuesta] = await db.query(
      `
      SELECT id, tipo, nombre, descripcion, preguntas, umbral_escalacion
      FROM encuestas
      WHERE id = :id AND activa = 1 AND deleted_at IS NULL
      LIMIT 1
    `,
      {
        replacements: { id: idEncuesta },
        type: QueryTypes.SELECT,
      },
    );

    if (!encuesta) {
      return res
        .status(404)
        .json({ ok: false, error: 'Encuesta no encontrada o inactiva' });
    }

    // Parsear + normalizar preguntas (garantiza el shape que espera el front)
    const preguntas = normalizarPreguntas(encuesta.preguntas);

    // ── Preview mode ──
    if (cid === 'preview') {
      return res.json({
        ok: true,
        ya_respondida: false,
        preview: true,
        requiere_telefono: false,
        encuesta: {
          id: encuesta.id,
          tipo: encuesta.tipo,
          nombre: encuesta.nombre,
          descripcion: encuesta.descripcion,
          preguntas,
        },
        cliente: {
          id: 0,
          nombre: 'Cliente de ejemplo',
          telefono: '+593900000000',
        },
        encargado: { nombre: 'Asesor de ejemplo' },
      });
    }

    // ── Link público (sin cid) ──
    // No sabemos quién responde: el formulario tiene que pedir el teléfono.
    // Se comprueba la conexión aquí para no dejar que llene todo el formulario
    // y recién al enviar descubra que la encuesta no está conectada.
    if (!cid) {
      const conexion = await resolverConexionEncuesta(idEncuesta);
      if (!conexion) {
        return res.status(404).json({
          ok: false,
          error: 'Esta encuesta no está disponible en este momento',
        });
      }

      return res.json({
        ok: true,
        ya_respondida: false,
        requiere_telefono: true,
        encuesta: {
          id: encuesta.id,
          tipo: encuesta.tipo,
          nombre: encuesta.nombre,
          descripcion: encuesta.descripcion,
          preguntas,
        },
        cliente: null,
        encargado: null,
      });
    }

    // Obtener datos del cliente si viene cid
    let cliente = null;
    let encargado = null;

    const [cli] = await db.query(
      `
      SELECT c.id, c.nombre_cliente, c.apellido_cliente, c.celular_cliente,
             c.id_configuracion, c.id_encargado
      FROM clientes_chat_center c
      WHERE c.id = :cid AND c.deleted_at IS NULL
      LIMIT 1
    `,
      {
        replacements: { cid },
        type: QueryTypes.SELECT,
      },
    );

    if (cli) {
      cliente = {
        id: cli.id,
        nombre:
          [cli.nombre_cliente, cli.apellido_cliente]
            .filter(Boolean)
            .join(' ')
            .trim() || 'Cliente',
        telefono: cli.celular_cliente,
      };

      if (cli.id_encargado) {
        const [enc] = await db.query(
          `
          SELECT nombre_encargado FROM sub_usuarios_chat_center
          WHERE id_sub_usuario = :id LIMIT 1
        `,
          {
            replacements: { id: cli.id_encargado },
            type: QueryTypes.SELECT,
          },
        );
        if (enc) {
          encargado = { nombre: enc.nombre_encargado };
        }
      }
    }

    // Verificar si la respuesta PENDIENTE más reciente ya fue respondida
    // Solo bloqueamos si no hay ninguna respuesta 'enviada' pendiente
    const [pendiente] = await db.query(
      `
      SELECT id, estado FROM encuestas_respuestas
      WHERE id_encuesta = :enc AND id_cliente_chat_center = :cid
      ORDER BY created_at DESC LIMIT 1
    `,
      {
        replacements: { enc: idEncuesta, cid },
        type: QueryTypes.SELECT,
      },
    );

    // Solo marcar como ya respondida si la MÁS RECIENTE está respondida
    // Si hay una 'enviada' pendiente, dejar pasar
    if (pendiente && pendiente.estado === 'respondida') {
      return res.json({
        ok: true,
        ya_respondida: true,
        requiere_telefono: false,
        encuesta: {
          id: encuesta.id,
          nombre: encuesta.nombre,
          tipo: encuesta.tipo,
        },
        cliente,
      });
    }

    return res.json({
      ok: true,
      ya_respondida: false,
      requiere_telefono: false,
      encuesta: {
        id: encuesta.id,
        tipo: encuesta.tipo,
        nombre: encuesta.nombre,
        descripcion: encuesta.descripcion,
        preguntas,
      },
      cliente,
      encargado,
    });
  } catch (err) {
    console.error('[encuestas_publico] ERROR obtener:', err);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
};

/**
 * POST /api/v1/encuestas_publico/publica/:idEncuesta/responder
 *
 * Body: { cid, score, respuestas: { key: value, ... } }
 * Desde el link público, sin cid: { telefono, codigo_pais, nombre?, ... }
 */
exports.responderEncuestaPublica = async (req, res) => {
  try {
    const { idEncuesta } = req.params;
    const { score, respuestas, telefono, codigo_pais, nombre, apellido } =
      req.body;
    let { cid } = req.body;

    if (!idEncuesta) {
      return res.status(400).json({ ok: false, error: 'Falta id de encuesta' });
    }

    // Bloquear envíos desde preview
    if (cid === 'preview' || cid === '0') {
      return res.json({
        ok: true,
        preview: true,
        message: 'Preview mode - no se guardó',
      });
    }

    const [encuesta] = await db.query(
      `
      SELECT id, tipo, umbral_escalacion, preguntas, cooldown_horas,
             mensaje_dentro_24h, template_fuera_24h, template_parameters
      FROM encuestas
      WHERE id = :id AND activa = 1 AND deleted_at IS NULL
      LIMIT 1
    `,
      {
        replacements: { id: idEncuesta },
        type: QueryTypes.SELECT,
      },
    );

    if (!encuesta) {
      return res
        .status(404)
        .json({ ok: false, error: 'Encuesta no encontrada' });
    }

    // Validar preguntas obligatorias del lado servidor (el front ya valida,
    // pero el endpoint es público y hay que blindarlo)
    const faltantes = validarRespuestasRequeridas(encuesta.preguntas, respuestas);
    if (faltantes.length > 0) {
      return res.status(400).json({
        ok: false,
        error: 'Faltan respuestas obligatorias',
        faltantes,
      });
    }

    let idConfiguracion = null;
    let idEncargado = null;
    let telefonoPublico = null;

    // ── Link público: el teléfono es la única forma de saber quién responde ──
    if (!cid) {
      telefonoPublico = normalizarTelefonoPublico(codigo_pais, telefono);

      if (!telefonoPublico) {
        return res.status(400).json({
          ok: false,
          error:
            'Necesitamos tu número de WhatsApp con el código de país para registrar tu respuesta',
          campo: 'telefono',
        });
      }

      const conexion = await resolverConexionEncuesta(idEncuesta);
      if (!conexion) {
        return res
          .status(400)
          .json({ ok: false, error: 'No se pudo determinar la conexión' });
      }

      const cliente = await resolverClienteDesdeTelefono({
        conexion,
        telefono: telefonoPublico,
        nombre,
        apellido,
        // Un lead que llega por el link público espera que alguien lo atienda;
        // uno de satisfacción ya fue atendido y su chat está cerrado.
        asignarRR: encuesta.tipo === 'webhook_lead',
      });

      if (!cliente?.id) {
        console.error(
          `[encuestas_publico] No se pudo resolver el contacto para tel=${telefonoPublico} cfg=${conexion.id_configuracion}`,
        );
        return res.status(500).json({
          ok: false,
          error: 'No pudimos registrar tus datos, intenta de nuevo',
        });
      }

      cid = cliente.id;
      idConfiguracion = conexion.id_configuracion;
      idEncargado = cliente.id_encargado || null;

      console.log(
        `[encuestas_publico] Link público → contacto ${cid} (tel=${telefonoPublico}) encuesta=${idEncuesta} cfg=${idConfiguracion}`,
      );

      // Cooldown: sin cid no hay cómo avisarle antes de que llene el
      // formulario, así que se comprueba aquí, ya con el contacto resuelto.
      const cooldown = Number(encuesta.cooldown_horas || 0);
      if (cooldown > 0) {
        const [reciente] = await db.query(
          `SELECT id FROM encuestas_respuestas
            WHERE id_encuesta = :enc AND id_cliente_chat_center = :cid
              AND estado = 'respondida'
              AND created_at >= DATE_SUB(NOW(), INTERVAL :horas HOUR)
            ORDER BY created_at DESC LIMIT 1`,
          {
            replacements: { enc: idEncuesta, cid, horas: cooldown },
            type: QueryTypes.SELECT,
          },
        );

        if (reciente) {
          return res.json({
            ok: true,
            ya_respondida: true,
            id_respuesta: reciente.id,
          });
        }
      }
    }

    if (!idConfiguracion && cid) {
      const [cli] = await db.query(
        `
        SELECT id_configuracion, id_encargado FROM clientes_chat_center
        WHERE id = :cid AND deleted_at IS NULL LIMIT 1
      `,
        {
          replacements: { cid },
          type: QueryTypes.SELECT,
        },
      );

      if (cli) {
        idConfiguracion = cli.id_configuracion;
        idEncargado = cli.id_encargado;
      }
    }

    if (!idConfiguracion) {
      const conexion = await resolverConexionEncuesta(idEncuesta);
      if (conexion) idConfiguracion = conexion.id_configuracion;
    }

    if (!idConfiguracion) {
      return res
        .status(400)
        .json({ ok: false, error: 'No se pudo determinar la conexión' });
    }

    const scoreNum = score ? Number(score) : null;
    const escalado =
      scoreNum && scoreNum <= (encuesta.umbral_escalacion || 2) ? 1 : 0;
    const respuestasNuevas =
      respuestas && typeof respuestas === 'object' ? respuestas : {};

    // Solo el link público aporta datos de contacto propios (los tecleó el
    // cliente). Con cid ya vienen del registro del chat.
    const datosContacto = telefonoPublico
      ? JSON.stringify({
          nombre: nombre || null,
          apellido: apellido || null,
          telefono: telefonoPublico,
          origen: 'link_publico',
        })
      : null;

    let idRespuesta = null;

    // Buscar la fila abierta MÁS RECIENTE de este cliente:
    //  - 'enviada'  → satisfacción: se mandó el link al cerrar el chat
    //  - 'recibida' → webhook_lead: el lead entró por el webhook y ahora
    //                 llena el formulario. Se fusiona en la MISMA fila para
    //                 no partir en dos el registro del mismo contacto.
    if (cid) {
      const [pendiente] = await db.query(
        `
        SELECT id, id_encargado, respuestas FROM encuestas_respuestas
        WHERE id_encuesta = :enc AND id_cliente_chat_center = :cid
          AND estado IN ('enviada', 'recibida')
        ORDER BY created_at DESC LIMIT 1
      `,
        {
          replacements: { enc: idEncuesta, cid },
          type: QueryTypes.SELECT,
        },
      );

      if (pendiente) {
        // Conservar lo que ya trajo el webhook y superponer lo del formulario
        const respuestasPrevias = parseJsonSeguro(pendiente.respuestas);
        const respuestasFusionadas = {
          ...respuestasPrevias,
          ...respuestasNuevas,
        };

        // Usar el encargado que cerró ese chat específico (no el actual)
        await db.query(
          `
          UPDATE encuestas_respuestas
          SET score = :score, respuestas = :resp, estado = 'respondida',
              escalado = :escalado,
              datos_contacto = COALESCE(:datos, datos_contacto),
              updated_at = NOW()
          WHERE id = :id
        `,
          {
            replacements: {
              score: scoreNum,
              resp: JSON.stringify(respuestasFusionadas),
              escalado,
              datos: datosContacto,
              id: pendiente.id,
            },
            type: QueryTypes.UPDATE,
          },
        );

        idRespuesta = pendiente.id;
      }
    }

    if (!idRespuesta) {
      const [insertId] = await db.query(
        `
        INSERT INTO encuestas_respuestas
          (id_encuesta, id_configuracion, id_cliente_chat_center, id_encargado,
           source, score, respuestas, datos_contacto, estado, escalado)
        VALUES (:enc, :cfg, :cid, :encargado, 'link', :score, :resp, :datos, 'respondida', :escalado)
      `,
        {
          replacements: {
            enc: idEncuesta,
            cfg: idConfiguracion,
            cid: cid || null,
            encargado: idEncargado,
            score: scoreNum,
            resp: JSON.stringify(respuestasNuevas),
            datos: datosContacto,
            escalado,
          },
          type: QueryTypes.INSERT,
        },
      );

      idRespuesta = insertId;
    }

    console.log(
      `[encuestas_publico] ✅ Respuesta guardada: id=${idRespuesta} encuesta=${idEncuesta} cliente=${cid || 'sin_cid'} score=${scoreNum} escalado=${escalado}`,
    );

    // ── Mensaje de bienvenida, SOLO para el link público ──
    // Con ?cid= el cliente ya venía de una conversación (o de la plantilla que
    // le mandó el asesor): ahí no se manda nada, igual que antes.
    // Fire-and-forget después de responder: el cliente no tiene por qué
    // esperar a que Meta conteste.
    if (telefonoPublico) {
      enviarMensajeBienvenida({
        idCliente: cid,
        idConfiguracion,
        idEncuesta,
        telefono: telefonoPublico,
        encuestaCfg: {
          mensaje_dentro_24h: encuesta.mensaje_dentro_24h,
          template_fuera_24h: encuesta.template_fuera_24h,
          template_parameters: encuesta.template_parameters,
        },
        contacto: {
          nombre: nombre || null,
          apellido: apellido || null,
          telefono: telefonoPublico,
        },
        responsable: 'Encuesta Link Público',
        logPrefix: '[encuestas_publico]',
        // Acaba de llenar la encuesta: si el mensaje configurado es el que
        // manda el link para llenarla, no se envía.
        omitirSiPideEncuesta: true,
      }).then((result) => {
        console.log('[encuestas_publico] Resultado envío bienvenida:', result);
      });
    }

    return res.json({
      ok: true,
      id_respuesta: idRespuesta,
      escalado: escalado === 1,
    });
  } catch (err) {
    console.error('[encuestas_publico] ERROR responder:', err);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
};
