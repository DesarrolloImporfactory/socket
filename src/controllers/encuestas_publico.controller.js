/**
 * encuestas_publico.controller.js
 *
 * Endpoints PÚBLICOS (sin auth) para la encuesta que ve el cliente final.
 * - GET  /publica/:idEncuesta?cid=123  → datos de la encuesta + nombre del cliente
 * - POST /publica/:idEncuesta/responder → guardar respuesta
 */

const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');

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

    // Parsear preguntas
    let preguntas = [];
    try {
      preguntas =
        typeof encuesta.preguntas === 'string'
          ? JSON.parse(encuesta.preguntas)
          : encuesta.preguntas;
    } catch (_) {}

    // ── Preview mode ──
    if (cid === 'preview') {
      return res.json({
        ok: true,
        ya_respondida: false,
        preview: true,
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

    // Obtener datos del cliente si viene cid
    let cliente = null;
    let encargado = null;

    if (cid) {
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
          encuesta: {
            id: encuesta.id,
            nombre: encuesta.nombre,
            tipo: encuesta.tipo,
          },
          cliente,
        });
      }
    }

    return res.json({
      ok: true,
      ya_respondida: false,
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
 */
exports.responderEncuestaPublica = async (req, res) => {
  try {
    const { idEncuesta } = req.params;
    const { cid, score, respuestas } = req.body;

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
      SELECT id, tipo, umbral_escalacion
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

    let idConfiguracion = null;
    let idEncargado = null;

    if (cid) {
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
      const [conn] = await db.query(
        `
        SELECT id_configuracion FROM encuestas_conexiones
        WHERE id_encuesta = :enc AND activa = 1 LIMIT 1
      `,
        {
          replacements: { enc: idEncuesta },
          type: QueryTypes.SELECT,
        },
      );
      if (conn) idConfiguracion = conn.id_configuracion;
    }

    if (!idConfiguracion) {
      return res
        .status(400)
        .json({ ok: false, error: 'No se pudo determinar la conexión' });
    }

    const scoreNum = score ? Number(score) : null;
    const escalado =
      scoreNum && scoreNum <= (encuesta.umbral_escalacion || 2) ? 1 : 0;
    const respuestasJson = JSON.stringify(respuestas || {});

    let idRespuesta = null;

    // Buscar la respuesta pendiente MÁS RECIENTE (estado = 'enviada')
    if (cid) {
      const [pendiente] = await db.query(
        `
        SELECT id, id_encargado FROM encuestas_respuestas
        WHERE id_encuesta = :enc AND id_cliente_chat_center = :cid AND estado = 'enviada'
        ORDER BY created_at DESC LIMIT 1
      `,
        {
          replacements: { enc: idEncuesta, cid },
          type: QueryTypes.SELECT,
        },
      );

      if (pendiente) {
        // Usar el encargado que cerró ese chat específico (no el actual)
        await db.query(
          `
          UPDATE encuestas_respuestas
          SET score = :score, respuestas = :resp, estado = 'respondida',
              escalado = :escalado, updated_at = NOW()
          WHERE id = :id
        `,
          {
            replacements: {
              score: scoreNum,
              resp: respuestasJson,
              escalado,
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
           source, score, respuestas, estado, escalado)
        VALUES (:enc, :cfg, :cid, :encargado, 'link', :score, :resp, 'respondida', :escalado)
      `,
        {
          replacements: {
            enc: idEncuesta,
            cfg: idConfiguracion,
            cid: cid || null,
            encargado: idEncargado,
            score: scoreNum,
            resp: respuestasJson,
            escalado,
          },
          type: QueryTypes.INSERT,
        },
      );

      idRespuesta = insertId;
    }

    console.log(
      `[encuestas_publico] ✅ Respuesta guardada: id=${idRespuesta} encuesta=${idEncuesta} score=${scoreNum} escalado=${escalado}`,
    );

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
