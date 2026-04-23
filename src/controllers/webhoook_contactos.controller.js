/**
 * webhook_contactos.controller.js
 *
 * Sistema Centralizado de Encuestas - IMPORCHAT
 *
 * POST /api/v1/webhook_contactos/inbound
 *   → Recibe respuestas de formularios externos (webhook_lead)
 *   → Busca encuesta activa por webhook_secret o id_configuracion
 *   → Busca/crea cliente en clientes_chat_center (scoped por id_configuracion)
 *   → Asigna encargado vía ROUND ROBIN (reutiliza lógica existente)
 *   → Guarda respuesta en encuestas_respuestas
 *   → Envía mensaje de bienvenida:
 *        - Dentro 24h → texto libre (ChatService.sendMessage)
 *        - Fuera 24h  → template de Meta (con o sin variables)
 */

const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');
const ChatService = require('../services/chat.service');
const whatsappService = require('../services/whatsapp.service');

// ⚠️ Ajusta estas rutas si tu estructura de carpetas es distinta
const { ensureUnifiedClient } = require('../utils/unified/ensureUnifiedClient');
const {
  asignarRoundRobinClienteExistente,
} = require('../utils/webhook_whatsapp/round_robin');

// ── Helpers ──────────────────────────────────────────────────

function limpiarTelefono(raw) {
  return String(raw || '').replace(/\D/g, '');
}

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

function separarDatos(body) {
  const datosContacto = {};
  const respuestas = {};
  for (const [key, val] of Object.entries(body)) {
    if (CAMPOS_CONTACTO.has(key.toLowerCase())) datosContacto[key] = val;
    else respuestas[key] = val;
  }
  return { datosContacto, respuestas };
}

function extraerContacto(body) {
  const nombre = body.nombre || body.name || body.first_name || '';
  const apellido = body.apellido || body.surname || body.last_name || '';
  const email = body.correo || body.email || body.mail || '';
  const telRaw =
    body.telefono || body.phone || body.celular || body.whatsapp || '';
  const telLimpio = limpiarTelefono(telRaw);
  return { nombre, apellido, email, telRaw, telLimpio };
}

/**
 * Detecta si el cliente está dentro de la ventana de 24h de Meta.
 * Aislado por id_configuracion (multi-tenant seguro).
 */
async function estaDentroVentana24h({ idCliente, idConfiguracion }) {
  try {
    const [row] = await db.query(
      `SELECT MAX(created_at) AS last_in
         FROM mensajes_clientes
        WHERE celular_recibe = :idCliente
          AND id_configuracion = :idConfiguracion
          AND (direction = 'in' OR rol_mensaje = 0)
          AND deleted_at IS NULL`,
      {
        replacements: { idCliente: String(idCliente), idConfiguracion },
        type: QueryTypes.SELECT,
      },
    );

    if (!row?.last_in) return false;
    const diffMs = Date.now() - new Date(row.last_in).getTime();
    return diffMs < 24 * 60 * 60 * 1000;
  } catch (err) {
    console.error(
      '[webhook_contactos] Error detectando ventana 24h:',
      err.message,
    );
    return false; // ante duda → fuera de ventana → template (más seguro)
  }
}

/**
 * Reemplaza placeholders {nombre}, {apellido}, {email}, {telefono}.
 * Limpia espacios sobrantes cuando el placeholder queda vacío.
 */
function resolverPlaceholders(str, contacto, { defaultValue = '' } = {}) {
  if (typeof str !== 'string') return String(str ?? '');

  const nombre = (contacto.nombre || '').trim() || defaultValue;
  const apellido = (contacto.apellido || '').trim() || defaultValue;
  const email = (contacto.email || '').trim() || defaultValue;
  const telefono = (contacto.telefono || '').trim() || defaultValue;

  return (
    str
      .replace(/\{nombre\}/gi, nombre)
      .replace(/\{apellido\}/gi, apellido)
      .replace(/\{email\}/gi, email)
      .replace(/\{telefono\}/gi, telefono)
      // limpieza estética: "Hola !" → "Hola!"
      .replace(/\s+([!,.?])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}

/**
 * Parse seguro de template_parameters (puede venir como JSON string,
 * array ya parseado, null o vacío).
 */
function parseTemplateParams(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Envía el mensaje de bienvenida según ventana 24h.
 * Fire-and-forget: nunca hace throw, solo loguea.
 */
async function enviarMensajeBienvenida({
  idCliente,
  idConfiguracion,
  telefono,
  encuestaCfg,
  contacto,
}) {
  try {
    const hayTexto = !!(encuestaCfg.mensaje_dentro_24h || '').trim();
    const hayTemplate = !!(encuestaCfg.template_fuera_24h || '').trim();

    if (!hayTexto && !hayTemplate) {
      console.log(
        '[webhook_contactos] Encuesta sin mensaje configurado — no se envía nada',
      );
      return { enviado: false, motivo: 'sin_configuracion' };
    }

    const dentroVentana = await estaDentroVentana24h({
      idCliente,
      idConfiguracion,
    });
    console.log(
      `[webhook_contactos] Ventana 24h: ${dentroVentana ? 'DENTRO' : 'FUERA'} → cliente=${idCliente} config=${idConfiguracion}`,
    );

    // ── DENTRO 24h → texto libre ──
    if (dentroVentana && hayTexto) {
      const chatService = new ChatService();
      const dataAdmin = await chatService.getDataAdmin(idConfiguracion);

      if (!dataAdmin) {
        console.error(
          '[webhook_contactos] No se pudo obtener dataAdmin para config',
          idConfiguracion,
        );
        return { enviado: false, motivo: 'sin_data_admin' };
      }

      const textoFinal = resolverPlaceholders(
        encuestaCfg.mensaje_dentro_24h,
        contacto,
      );

      await chatService.sendMessage({
        mensaje: textoFinal,
        to: telefono,
        dataAdmin,
        tipo_mensaje: 'text',
        id_configuracion: idConfiguracion,
        nombre_encargado: 'Encuesta Webhook',
      });

      console.log(
        `[webhook_contactos] ✅ Texto enviado (dentro 24h) → ${telefono}`,
      );
      return { enviado: true, tipo: 'texto' };
    }

    // ── FUERA 24h (o sin texto configurado) → template ──
    if (!hayTemplate) {
      console.log(
        '[webhook_contactos] Fuera de 24h y sin template configurado — no se envía',
      );
      return { enviado: false, motivo: 'fuera_24h_sin_template' };
    }

    // Template puede no tener variables → paramsRaw = []
    const paramsRaw = parseTemplateParams(encuestaCfg.template_parameters);

    // Si tiene variables, resolver placeholders con default amigable
    // (Meta rechaza parámetros vacíos con error 132000)
    const paramsResueltos = paramsRaw.map((p) =>
      resolverPlaceholders(String(p ?? ''), contacto, { defaultValue: 'Hola' }),
    );

    const result = await whatsappService.sendWhatsappMessageTemplateScheduled({
      telefono,
      id_configuracion: idConfiguracion,
      responsable: 'Encuesta Webhook',
      nombre_template: encuestaCfg.template_fuera_24h,
      template_parameters: paramsResueltos, // [] si el template no tiene variables
    });

    console.log(
      `[webhook_contactos] ✅ Template "${encuestaCfg.template_fuera_24h}" enviado (fuera 24h) → ${telefono} wamid=${result?.wamid} params=${paramsResueltos.length}`,
    );
    return { enviado: true, tipo: 'template', wamid: result?.wamid };
  } catch (err) {
    console.error('[webhook_contactos] ❌ Error enviando mensaje bienvenida:', {
      message: err.message,
      meta_error: err.meta_error || null,
    });
    return { enviado: false, motivo: 'error', error: err.message };
  }
}

// ── Controller principal ─────────────────────────────────────

exports.inbound = async (req, res) => {
  const body = req.body || {};
  const secret = req.headers['x-webhook-secret'] || '';
  const ts = new Date().toISOString();

  console.log(`[webhook_contactos ${ts}] BODY:`, JSON.stringify(body));

  try {
    // 1. Extraer datos contacto
    const { nombre, apellido, email, telRaw, telLimpio } =
      extraerContacto(body);

    if (!telLimpio && !email) {
      return res.status(400).json({
        ok: false,
        error:
          'Se requiere al menos teléfono o email para identificar al contacto',
      });
    }

    // 2. Buscar encuesta activa (con datos de mensaje + datos de configuración para RR)
    let idEncuesta = null;
    let idConfiguracion = null;
    let nombreEncuesta = null;
    let encuestaCfg = null;

    // 2a. Por webhook_secret
    if (secret) {
      const [conn] = await db.query(
        `SELECT ec.id_encuesta, ec.id_configuracion,
                e.nombre AS nombre_encuesta,
                e.mensaje_dentro_24h,
                e.template_fuera_24h,
                e.template_parameters,
                cfg.id_usuario AS id_usuario_dueno,
                cfg.permiso_round_robin,
                cfg.id_telefono AS business_phone_id
           FROM encuestas_conexiones ec
           JOIN encuestas e ON e.id = ec.id_encuesta
           JOIN configuraciones cfg ON cfg.id = ec.id_configuracion
          WHERE ec.webhook_secret = :secret
            AND ec.activa = 1
            AND e.activa = 1
            AND e.deleted_at IS NULL
            AND cfg.suspendido = 0
          LIMIT 1`,
        { replacements: { secret }, type: QueryTypes.SELECT },
      );

      if (conn) {
        idEncuesta = conn.id_encuesta;
        idConfiguracion = conn.id_configuracion;
        nombreEncuesta = conn.nombre_encuesta;
        encuestaCfg = {
          mensaje_dentro_24h: conn.mensaje_dentro_24h,
          template_fuera_24h: conn.template_fuera_24h,
          template_parameters: conn.template_parameters,
          // 🆕 datos para round robin
          id_usuario_dueno: conn.id_usuario_dueno,
          permiso_round_robin: conn.permiso_round_robin,
          business_phone_id: conn.business_phone_id,
        };
      }
    }

    // 2b. Fallback por id_configuracion del body
    if (!idEncuesta) {
      const cfgFromBody = Number(body.id_configuracion) || null;
      if (cfgFromBody) {
        const [conn] = await db.query(
          `SELECT ec.id_encuesta, ec.id_configuracion,
                  e.nombre AS nombre_encuesta,
                  e.mensaje_dentro_24h,
                  e.template_fuera_24h,
                  e.template_parameters,
                  cfg.id_usuario AS id_usuario_dueno,
                  cfg.permiso_round_robin,
                  cfg.id_telefono AS business_phone_id
             FROM encuestas_conexiones ec
             JOIN encuestas e ON e.id = ec.id_encuesta
             JOIN configuraciones cfg ON cfg.id = ec.id_configuracion
            WHERE ec.id_configuracion = :cfg
              AND ec.activa = 1
              AND e.activa = 1
              AND e.tipo = 'webhook_lead'
              AND e.deleted_at IS NULL
              AND cfg.suspendido = 0
            LIMIT 1`,
          { replacements: { cfg: cfgFromBody }, type: QueryTypes.SELECT },
        );

        if (conn) {
          idEncuesta = conn.id_encuesta;
          idConfiguracion = conn.id_configuracion;
          nombreEncuesta = conn.nombre_encuesta;
          encuestaCfg = {
            mensaje_dentro_24h: conn.mensaje_dentro_24h,
            template_fuera_24h: conn.template_fuera_24h,
            template_parameters: conn.template_parameters,
            // 🆕 datos para round robin
            id_usuario_dueno: conn.id_usuario_dueno,
            permiso_round_robin: conn.permiso_round_robin,
            business_phone_id: conn.business_phone_id,
          };
        }
      }
    }

    // 2c. No hay encuesta → responder OK pero no procesar más
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
      `[webhook_contactos] Encuesta: id=${idEncuesta} "${nombreEncuesta}" → config=${idConfiguracion}`,
    );

    // 3. Buscar o crear cliente (con Round Robin automático)
    let idCliente = null;
    let clienteNuevo = false;
    let nombreBD = null;
    let apellidoBD = null;
    let encargadoPrevio = null; // para saber si ya tenía encargado

    // 3a. Match previo por email (evita duplicar si solo cambió el tel)
    if (email) {
      const [existenteEmail] = await db.query(
        `SELECT id, nombre_cliente, apellido_cliente, id_encargado
           FROM clientes_chat_center
          WHERE email_cliente = :email
            AND id_configuracion = :cfg
            AND deleted_at IS NULL
          LIMIT 1`,
        {
          replacements: { email, cfg: idConfiguracion },
          type: QueryTypes.SELECT,
        },
      );

      if (existenteEmail) {
        idCliente = existenteEmail.id;
        nombreBD = existenteEmail.nombre_cliente;
        apellidoBD = existenteEmail.apellido_cliente;
        encargadoPrevio = existenteEmail.id_encargado;
        console.log(
          `[webhook_contactos] Cliente existente por email: id=${idCliente} encargado=${encargadoPrevio}`,
        );
      }
    }

    // 3b. Si no se encontró por email y hay teléfono → usar ensureUnifiedClient (aplica RR si crea)
    if (!idCliente && telLimpio) {
      const cliente = await ensureUnifiedClient({
        id_configuracion: idConfiguracion,
        id_usuario_dueno: encuestaCfg.id_usuario_dueno,
        source: 'wa',
        business_phone_id: encuestaCfg.business_phone_id,
        phone: telLimpio,
        nombre_cliente: nombre || '',
        apellido_cliente: apellido || '',
        motivo: 'auto_round_robin_webhook_lead',
        permiso_round_robin: encuestaCfg.permiso_round_robin,
      });

      if (cliente?.id) {
        idCliente = cliente.id;
        nombreBD = cliente.nombre_cliente;
        apellidoBD = cliente.apellido_cliente;
        encargadoPrevio = cliente.id_encargado;

        // Detectar si fue recién creado (sin mensajes aún)
        const [countRow] = await db.query(
          `SELECT COUNT(*) AS total FROM mensajes_clientes
            WHERE celular_recibe = :id AND id_configuracion = :cfg AND deleted_at IS NULL`,
          {
            replacements: { id: String(idCliente), cfg: idConfiguracion },
            type: QueryTypes.SELECT,
          },
        );
        clienteNuevo = Number(countRow?.total || 0) === 0;

        console.log(
          `[webhook_contactos] Cliente via ensureUnifiedClient: id=${idCliente} nuevo=${clienteNuevo} encargado=${encargadoPrevio}`,
        );

        // Si el cliente existía con email vacío y ahora recibimos email, actualizarlo
        if (email && !cliente.email_cliente) {
          await db.query(
            `UPDATE clientes_chat_center SET email_cliente = :email WHERE id = :id`,
            {
              replacements: { email, id: idCliente },
              type: QueryTypes.UPDATE,
            },
          );
        }
      }
    }

    // 3c. Solo email (sin teléfono) → crear sin RR (no hay canal WA)
    if (!idCliente && email) {
      console.log(
        '[clientes_chat_center INSERT] webhook_contactos — lead solo email, sin RR',
      );
      const [insertResult] = await db.query(
        `INSERT INTO clientes_chat_center
          (id_configuracion, nombre_cliente, apellido_cliente, email_cliente,
           source, propietario, estado_contacto)
         VALUES (:cfg, :nombre, :apellido, :email, 'wa', 0, 'contacto_inicial')`,
        {
          replacements: {
            cfg: idConfiguracion,
            nombre: nombre || 'Lead Webhook',
            apellido,
            email,
          },
          type: QueryTypes.INSERT,
        },
      );
      idCliente = insertResult;
      clienteNuevo = true;
      console.log(
        `[webhook_contactos] Cliente NUEVO creado (solo email): id=${idCliente}`,
      );
    }

    // 3d. Safety: si todavía no hay cliente, abortar
    if (!idCliente) {
      console.error('[webhook_contactos] No se pudo resolver idCliente');
      return res.status(500).json({
        ok: false,
        error: 'No se pudo crear o encontrar el cliente',
      });
    }

    // 3e. 🆕 Si cliente ya existía SIN encargado y hay teléfono → aplicar RR
    //     (cubre leads antiguos que nunca se asignaron)
    if (!encargadoPrevio && telLimpio && !clienteNuevo) {
      try {
        const nuevoEncargado = await asignarRoundRobinClienteExistente({
          id_cliente: idCliente,
          id_configuracion: idConfiguracion,
          id_usuario_dueno: encuestaCfg.id_usuario_dueno,
          permiso_round_robin: encuestaCfg.permiso_round_robin,
          motivo: 'auto_round_robin_webhook_lead_reopen',
        });

        if (nuevoEncargado) {
          console.log(
            `[webhook_contactos] 🔄 RR aplicado a cliente existente sin encargado: id=${idCliente} → encargado=${nuevoEncargado}`,
          );
        }
      } catch (rrErr) {
        console.error(
          '[webhook_contactos] Error aplicando RR a cliente existente:',
          rrErr.message,
        );
        // no es crítico, continuar
      }
    }

    // 4. Encargado actual (refleja RR si se acaba de asignar)
    let idEncargado = null;
    const [enc] = await db.query(
      `SELECT id_encargado FROM clientes_chat_center
        WHERE id = :id AND id_encargado IS NOT NULL LIMIT 1`,
      { replacements: { id: idCliente }, type: QueryTypes.SELECT },
    );
    if (enc?.id_encargado) idEncargado = enc.id_encargado;

    // 5. Separar respuestas del contacto
    const { respuestas } = separarDatos(body);

    // 6. Guardar respuesta centralizada
    const [insertResp] = await db.query(
      `INSERT INTO encuestas_respuestas
        (id_encuesta, id_configuracion, id_cliente_chat_center, id_encargado,
         source, score, respuestas, datos_contacto, estado)
       VALUES (:idEnc, :cfg, :idCli, :idEnc2, 'webhook', NULL, :resp, :datos, 'recibida')`,
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

    // 7. Responder YA al webhook (no esperar al envío de WhatsApp)
    res.status(200).json({
      ok: true,
      id_respuesta: insertResp,
      id_cliente: idCliente,
      id_encuesta: idEncuesta,
      id_encargado: idEncargado,
      cliente_nuevo: clienteNuevo,
      encuesta: nombreEncuesta,
    });

    // 8. Fire-and-forget: enviar mensaje de bienvenida
    if (telLimpio) {
      // Resolver nombre con fallback en cadena: webhook → BD → vacío
      let nombreFinal = (nombre || '').trim();
      let apellidoFinal = (apellido || '').trim();

      if (!nombreFinal && nombreBD && nombreBD !== 'Lead Webhook') {
        nombreFinal = nombreBD.trim();
      }
      if (!apellidoFinal && apellidoBD) {
        apellidoFinal = apellidoBD.trim();
      }

      enviarMensajeBienvenida({
        idCliente,
        idConfiguracion,
        telefono: telLimpio,
        encuestaCfg,
        contacto: {
          nombre: nombreFinal,
          apellido: apellidoFinal,
          email,
          telefono: telRaw,
        },
      }).then((result) => {
        console.log('[webhook_contactos] Resultado envío bienvenida:', result);
      });
    } else {
      console.log(
        '[webhook_contactos] Sin teléfono → no se envía mensaje de bienvenida',
      );
    }
  } catch (err) {
    console.error('[webhook_contactos] ❌ ERROR:', err);
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
};
