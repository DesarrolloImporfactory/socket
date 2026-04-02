const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');

/**
 * POST /api/v1/webhook_contactos/inbound
 *
 * Body (JSON):
 *   nombre, apellido, email, celular,
 *   respuesta_1, respuesta_2, respuesta_3,
 *   id_configuracion (opcional, default 265)
 *
 * Header: x-webhook-secret
 */
exports.inbound = async (req, res) => {
  try {
    // // ── 0. Validar secret ──
    // const secret = process.env.WEBHOOK_CONTACTOS_SECRET || '';
    // const headerSecret = req.headers['x-webhook-secret'] || '';

    // if (!secret || headerSecret !== secret) {
    //   return res.status(401).json({ ok: false, error: 'Unauthorized' });
    // }

    // ── 1. Leer body ──
    const {
      nombre = '',
      apellido = '',
      email = '',
      celular = '',
      respuesta_1 = null,
      respuesta_2 = null,
      respuesta_3 = null,
    } = req.body;

    const telefonoLimpio = String(celular)
      .replace(/[^0-9]/g, '')
      .trim();

    if (!telefonoLimpio) {
      return res.status(400).json({ ok: false, error: 'celular es requerido' });
    }

    const ID_CONFIGURACION = Number(req.body.id_configuracion) || 265;

    // Guardar payload crudo tal cual llegó
    const webhookPayload = JSON.stringify(req.body);

    // ── 2. ¿Existe el cliente? ──
    const [existing] = await db.query(
      `SELECT id FROM clientes_chat_center
       WHERE id_configuracion = ? AND celular_cliente = ? AND deleted_at IS NULL
       LIMIT 1`,
      {
        replacements: [ID_CONFIGURACION, telefonoLimpio],
        type: QueryTypes.SELECT,
      },
    );

    let clienteId;
    let accion;

    if (existing) {
      // ── 3a. UPDATE ──
      clienteId = existing.id;
      accion = 'actualizado';

      await db.query(
        `UPDATE clientes_chat_center
         SET nombre_cliente       = COALESCE(NULLIF(?, ''), nombre_cliente),
             apellido_cliente     = COALESCE(NULLIF(?, ''), apellido_cliente),
             email_cliente        = COALESCE(NULLIF(?, ''), email_cliente),
             respuesta_encuesta_1 = COALESCE(?, respuesta_encuesta_1),
             respuesta_encuesta_2 = COALESCE(?, respuesta_encuesta_2),
             respuesta_encuesta_3 = COALESCE(?, respuesta_encuesta_3),
             webhook_payload      = ?,
             updated_at           = NOW()
         WHERE id = ?`,
        {
          replacements: [
            nombre.trim(),
            apellido.trim(),
            email.trim(),
            respuesta_1,
            respuesta_2,
            respuesta_3,
            webhookPayload,
            clienteId,
          ],
          type: QueryTypes.UPDATE,
        },
      );
    } else {
      // ── 3b. INSERT ──
      accion = 'creado';

      const [config] = await db.query(
        `SELECT id_telefono FROM configuraciones WHERE id = ? AND suspendido = 0 LIMIT 1`,
        { replacements: [ID_CONFIGURACION], type: QueryTypes.SELECT },
      );

      const uid_cliente = config?.id_telefono || null;

      await db.query(
        `INSERT INTO clientes_chat_center
           (id_configuracion, uid_cliente, nombre_cliente, apellido_cliente,
            email_cliente, celular_cliente, telefono_limpio,
            respuesta_encuesta_1, respuesta_encuesta_2, respuesta_encuesta_3,
            webhook_payload, source, propietario,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'wa', 0, NOW(), NOW())`,
        {
          replacements: [
            ID_CONFIGURACION,
            uid_cliente,
            nombre.trim(),
            apellido.trim(),
            email.trim(),
            telefonoLimpio,
            telefonoLimpio,
            respuesta_1,
            respuesta_2,
            respuesta_3,
            webhookPayload,
          ],
          type: QueryTypes.INSERT,
        },
      );

      const [{ id: newId }] = await db.query('SELECT LAST_INSERT_ID() AS id', {
        type: QueryTypes.SELECT,
      });
      clienteId = newId;
    }

    // ── 4. Responder ──
    return res.status(200).json({
      ok: true,
      accion,
      cliente_id: clienteId,
      id_configuracion: ID_CONFIGURACION,
    });
  } catch (err) {
    console.error('[webhook_contactos] Error:', err);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
};
