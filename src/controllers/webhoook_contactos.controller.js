/**
 * webhook_contactos.controller.js
 *
 * Sistema Centralizado de Encuestas - IMPORCHAT
 *
 * POST /api/v1/webhook_contactos/inbound
 *   → Recibe respuestas de formularios externos (webhook_lead)
 *   → Busca encuesta activa por webhook_secret o id_configuracion
 *   → Busca/crea cliente en clientes_chat_center
 *   → Guarda respuesta en encuestas_respuestas
 */

const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');

// ── Helpers ──────────────────────────────────────────────────

/**
 * Limpia teléfono: quita todo excepto dígitos
 */
function limpiarTelefono(raw) {
  return String(raw || '').replace(/\D/g, '');
}

/**
 * Campos que se consideran "datos de contacto" y no respuestas.
 * Se excluyen del JSON de respuestas.
 */
const CAMPOS_CONTACTO = new Set([
  'nombre',
  'name',
  'first_name',
  'last_name',
  'correo',
  'email',
  'mail',
  'telefono',
  'phone',
  'celular',
  'whatsapp',
  'id_configuracion',
  'config_id',
  'apellido',
  'surname',
]);

/**
 * Separa el body en { datosContacto, respuestas }
 */
function separarDatos(body) {
  const datosContacto = {};
  const respuestas = {};

  for (const [key, val] of Object.entries(body)) {
    if (CAMPOS_CONTACTO.has(key.toLowerCase())) {
      datosContacto[key] = val;
    } else {
      respuestas[key] = val;
    }
  }

  return { datosContacto, respuestas };
}

/**
 * Extrae nombre, email, teléfono del body con múltiples keys posibles
 */
function extraerContacto(body) {
  const nombre = body.nombre || body.name || body.first_name || '';
  const apellido = body.apellido || body.surname || body.last_name || '';
  const email = body.correo || body.email || body.mail || '';
  const telRaw =
    body.telefono || body.phone || body.celular || body.whatsapp || '';
  const telLimpio = limpiarTelefono(telRaw);

  return { nombre, apellido, email, telRaw, telLimpio };
}

// ── Controller principal ─────────────────────────────────────

exports.inbound = async (req, res) => {
  const body = req.body || {};
  const secret = req.headers['x-webhook-secret'] || '';
  const ts = new Date().toISOString();

  console.log(`[webhook_contactos ${ts}] BODY:`, JSON.stringify(body));

  try {
    // ── 1. Extraer datos del contacto ──
    const { nombre, apellido, email, telRaw, telLimpio } =
      extraerContacto(body);

    if (!telLimpio && !email) {
      console.log(`[webhook_contactos] Rechazado: sin teléfono ni email`);
      return res.status(400).json({
        ok: false,
        error:
          'Se requiere al menos teléfono o email para identificar al contacto',
      });
    }

    // ── 2. Buscar encuesta activa ──
    //    Prioridad: webhook_secret > id_configuracion del body > ninguna
    let idEncuesta = null;
    let idConfiguracion = null;
    let nombreEncuesta = null;

    // 2a. Intentar por webhook_secret
    if (secret) {
      const [conn] = await db.query(
        `
        SELECT ec.id_encuesta, ec.id_configuracion, e.nombre AS nombre_encuesta
        FROM encuestas_conexiones ec
        JOIN encuestas e ON e.id = ec.id_encuesta
        WHERE ec.webhook_secret = :secret
          AND ec.activa = 1
          AND e.activa = 1
          AND e.deleted_at IS NULL
        LIMIT 1
      `,
        {
          replacements: { secret },
          type: QueryTypes.SELECT,
        },
      );

      if (conn) {
        idEncuesta = conn.id_encuesta;
        idConfiguracion = conn.id_configuracion;
        nombreEncuesta = conn.nombre_encuesta;
      }
    }

    // 2b. Fallback: buscar por id_configuracion del body
    if (!idEncuesta) {
      const cfgFromBody = Number(body.id_configuracion) || null;

      if (cfgFromBody) {
        const [conn] = await db.query(
          `
          SELECT ec.id_encuesta, ec.id_configuracion, e.nombre AS nombre_encuesta
          FROM encuestas_conexiones ec
          JOIN encuestas e ON e.id = ec.id_encuesta
          WHERE ec.id_configuracion = :cfg
            AND ec.activa = 1
            AND e.activa = 1
            AND e.tipo = 'webhook_lead'
            AND e.deleted_at IS NULL
          LIMIT 1
        `,
          {
            replacements: { cfg: cfgFromBody },
            type: QueryTypes.SELECT,
          },
        );

        if (conn) {
          idEncuesta = conn.id_encuesta;
          idConfiguracion = conn.id_configuracion;
          nombreEncuesta = conn.nombre_encuesta;
        }
      }
    }

    // 2c. Si no encontró nada → responder OK pero logear warning
    if (!idEncuesta) {
      console.log(
        `[webhook_contactos] WARNING: No hay encuesta configurada (secret="${secret}", body.id_configuracion=${body.id_configuracion})`,
      );
      return res.status(200).json({
        ok: true,
        warning: 'No hay encuesta activa configurada para este webhook',
        recibido: true,
      });
    }

    console.log(
      `[webhook_contactos] Encuesta encontrada: id=${idEncuesta} "${nombreEncuesta}" → config=${idConfiguracion}`,
    );

    // ── 3. Buscar o crear cliente en clientes_chat_center ──
    let idCliente = null;
    let clienteNuevo = false;

    if (telLimpio) {
      // Intentar match por teléfono limpio
      const [existente] = await db.query(
        `
        SELECT id FROM clientes_chat_center
        WHERE telefono_limpio = :tel
          AND id_configuracion = :cfg
          AND deleted_at IS NULL
        LIMIT 1
      `,
        {
          replacements: { tel: telLimpio, cfg: idConfiguracion },
          type: QueryTypes.SELECT,
        },
      );

      if (existente) {
        idCliente = existente.id;
        console.log(`[webhook_contactos] Cliente existente: id=${idCliente}`);
      }
    }

    // Si no encontró por teléfono, intentar por email
    if (!idCliente && email) {
      const [existente] = await db.query(
        `
        SELECT id FROM clientes_chat_center
        WHERE email_cliente = :email
          AND id_configuracion = :cfg
          AND deleted_at IS NULL
        LIMIT 1
      `,
        {
          replacements: { email, cfg: idConfiguracion },
          type: QueryTypes.SELECT,
        },
      );

      if (existente) {
        idCliente = existente.id;
        console.log(
          `[webhook_contactos] Cliente encontrado por email: id=${idCliente}`,
        );
      }
    }

    // Si no existe → crear nuevo contacto
    if (!idCliente) {
      const [insertResult] = await db.query(
        `
        INSERT INTO clientes_chat_center
          (id_configuracion, nombre_cliente, apellido_cliente, email_cliente,
           celular_cliente, telefono_limpio, source, propietario, estado_contacto)
        VALUES (:cfg, :nombre, :apellido, :email, :telRaw, :telLimpio, 'wa', 0, 'contacto_inicial')
      `,
        {
          replacements: {
            cfg: idConfiguracion,
            nombre: nombre || 'Lead Webhook',
            apellido,
            email,
            telRaw,
            telLimpio: telLimpio || null,
          },
          type: QueryTypes.INSERT,
        },
      );

      idCliente = insertResult;
      clienteNuevo = true;
      console.log(`[webhook_contactos] Cliente NUEVO creado: id=${idCliente}`);
    }

    // ── 4. Obtener encargado actual del cliente ──
    let idEncargado = null;

    if (idCliente) {
      const [enc] = await db.query(
        `
        SELECT id_encargado FROM clientes_chat_center
        WHERE id = :id AND id_encargado IS NOT NULL
        LIMIT 1
      `,
        {
          replacements: { id: idCliente },
          type: QueryTypes.SELECT,
        },
      );

      if (enc?.id_encargado) {
        idEncargado = enc.id_encargado;
      }
    }

    // ── 5. Separar datos de contacto de las respuestas ──
    const { datosContacto, respuestas } = separarDatos(body);

    // ── 6. Guardar respuesta centralizada ──
    const [insertResp] = await db.query(
      `
      INSERT INTO encuestas_respuestas
        (id_encuesta, id_configuracion, id_cliente_chat_center, id_encargado,
         source, score, respuestas, datos_contacto, estado)
      VALUES (:idEnc, :cfg, :idCli, :idEnc2, 'webhook', NULL, :resp, :datos, 'recibida')
    `,
      {
        replacements: {
          idEnc: idEncuesta,
          cfg: idConfiguracion,
          idCli: idCliente,
          idEnc2: idEncargado,
          resp: JSON.stringify(respuestas),
          datos: JSON.stringify({
            nombre: nombre || null,
            apellido: apellido || null,
            email: email || null,
            telefono: telRaw || null,
          }),
        },
        type: QueryTypes.INSERT,
      },
    );

    console.log(
      `[webhook_contactos] ✅ Respuesta guardada: id=${insertResp} encuesta=${idEncuesta} cliente=${idCliente} encargado=${idEncargado}`,
    );

    return res.status(200).json({
      ok: true,
      id_respuesta: insertResp,
      id_cliente: idCliente,
      id_encuesta: idEncuesta,
      id_encargado: idEncargado,
      cliente_nuevo: clienteNuevo,
      encuesta: nombreEncuesta,
    });
  } catch (err) {
    console.error('[webhook_contactos] ❌ ERROR:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
