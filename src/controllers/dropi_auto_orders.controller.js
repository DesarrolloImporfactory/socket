'use strict';

const { autoCrearOrdenDropi } = require('../services/dropiAutoOrder.service');
const { db } = require('../database/config');

/**
 * POST /dropi/auto-orden/probar
 *
 * Dispara autoCrearOrdenDropi de forma SÍNCRONA (await) para:
 *  - Testing manual sin tener que cerrar una conversación real.
 *  - Botón del front "corregir y crear" / "reintentar subida a Dropi".
 *
 * Dos modos de uso:
 *
 *  A) Reintentar/corregir desde una fila del log (panel, clientes con fallo):
 *     { "id_log": 131 }                         → reintenta tal cual
 *     { "id_log": 131, "datosBot": { ... } }    → reintenta con correcciones
 *     → lee dropi_auto_ordenes_log #131, mergea las correcciones sobre lo
 *       guardado y vuelve a ejecutar el flujo.
 *
 *  B) Creación manual (panel, clientes "pendientes" sin log):
 *     {
 *       "id_configuracion": 411,
 *       "id_cliente": 463730,
 *       "force": true,
 *       "datosBot": { "nombre": "...", "telefono": "...", ... }
 *     }
 *
 * force (default true): salta el gate auto_crear_orden_dropi, porque siempre
 * es una acción manual explícita. Manda force:false si quieres respetar el gate.
 *
 * Crea una ORDEN REAL en Dropi (PENDIENTE CONFIRMACION). Para pruebas que
 * no quieras despachar, usa datos tipo "nodespachar".
 */
exports.probarAutoOrden = async (req, res) => {
  try {
    let {
      id_log = null,
      id_configuracion = null,
      id_cliente = null,
      datosBot = null,
      api_key_openai = null,
    } = req.body || {};

    const force = req.body?.force ?? true;

    // ── Modo A: reintentar desde una fila del log (con correcciones opcionales) ──
    if (id_log) {
      const [row] = await db.query(
        `SELECT id_configuracion, id_cliente, telefono, datos_bot
           FROM dropi_auto_ordenes_log
          WHERE id = ? LIMIT 1`,
        { replacements: [id_log], type: db.QueryTypes.SELECT },
      );
      if (!row) {
        return res
          .status(404)
          .json({ ok: false, message: `No existe log #${id_log}` });
      }

      let base = {};
      try {
        base = JSON.parse(row.datos_bot || '{}');
      } catch (_) {}

      // las correcciones que mande el front pisan lo guardado
      const correcciones =
        datosBot && typeof datosBot === 'object' ? datosBot : {};
      datosBot = { ...base, ...correcciones };

      id_configuracion = row.id_configuracion;
      id_cliente = row.id_cliente;
      if (!datosBot.telefono && row.telefono) datosBot.telefono = row.telefono;
    }

    // ── Validación ──
    if (!id_configuracion || !datosBot || typeof datosBot !== 'object') {
      return res.status(400).json({
        ok: false,
        message: 'Envía id_log, o bien id_configuracion + datosBot (objeto).',
      });
    }

    // Para distinguir el log de ESTA corrida del de corridas previas,
    // guardamos el último id de log antes de ejecutar.
    const [{ maxId = 0 } = {}] = await db.query(
      `SELECT COALESCE(MAX(id), 0) AS maxId
         FROM dropi_auto_ordenes_log
        WHERE id_configuracion = ?
          ${id_cliente ? 'AND id_cliente = ?' : ''}`,
      {
        replacements: id_cliente
          ? [id_configuracion, id_cliente]
          : [id_configuracion],
        type: db.QueryTypes.SELECT,
      },
    );

    // ── Ejecuta el flujo (síncrono) ──
    const resultado = await autoCrearOrdenDropi({
      id_configuracion,
      id_cliente: id_cliente || null,
      datosBot,
      api_key_openai,
      force,
    });

    // ── Lee el registro de ESTA corrida para devolver el motivo exacto ──
    const [log] = await db.query(
      `SELECT id, resultado, paso_fallo, dropi_order_id, detalle, created_at
         FROM dropi_auto_ordenes_log
        WHERE id_configuracion = ?
          ${id_cliente ? 'AND id_cliente = ?' : ''}
        ORDER BY id DESC
        LIMIT 1`,
      {
        replacements: id_cliente
          ? [id_configuracion, id_cliente]
          : [id_configuracion],
        type: db.QueryTypes.SELECT,
      },
    );

    const hayLogNuevo = log && Number(log.id) > Number(maxId);
    const creada = Boolean(resultado?.orderId);

    // Sin log nuevo y sin orden → el gate estaba apagado y force=false
    if (!creada && !hayLogNuevo) {
      return res.status(409).json({
        ok: false,
        resultado: 'no_ejecutado',
        message:
          'No se ejecutó (auto_crear_orden_dropi apagado). Manda force:true para forzar.',
      });
    }

    return res.status(creada ? 200 : 422).json({
      ok: creada,
      orderId: resultado?.orderId || log?.dropi_order_id || null,
      resultado: log?.resultado || (creada ? 'creada' : 'fallida'),
      paso_fallo: log?.paso_fallo || null,
      detalle: log?.detalle || null,
      id_log: log?.id || null,
      created_at: log?.created_at || null,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: err?.message || 'Error interno probando auto-orden',
    });
  }
};

/**
 * POST /dropi_integrations/auto-orders/pendientes
 * Body: { id_configuracion, limit?, offset? }
 *
 * Clientes en estado_contacto='generar_guia' a los que AÚN les falta la orden.
 * Excluye:
 *  - los que el bot SÍ creó (último log 'creada')
 *  - los que ya tienen orden en Dropi por otra vía (cache del cron: manual /
 *    Shopify), contando solo órdenes creadas DESPUÉS del intento del bot.
 * Cruza con el último log para mostrar el motivo del fallo y prellenar el form.
 */
// Órdenes que entraron por el webhook de Shopify pero NO llegaron a Dropi
// (huérfanas): shopify_ordenes_webhook sin match en dropi_orders_cache por
// teléfono (últimos 9 díg) + total (±0.5) dentro de una ventana. Para
// recrearlas manualmente en Dropi desde la vista de pedidos.
exports.listShopifyHuerfanas = async (req, res) => {
  try {
    const id_configuracion = Number(
      req.body?.id_configuracion ?? req.query?.id_configuracion,
    );
    if (!id_configuracion) {
      return res
        .status(400)
        .json({ ok: false, message: 'id_configuracion requerido' });
    }
    const dias = Math.min(Math.max(Number(req.body?.dias) || 15, 1), 60);
    // Margen para que Dropi alcance a sincronizar la orden antes de marcarla
    // huérfana (Dropi suele subirla en ~15 min). La lista se recalcula en cada
    // carga, así que apenas Dropi la crea, desaparece sola.
    const graciaMin = Math.min(
      Math.max(Number(req.body?.gracia_min) || 45, 0),
      1440,
    );

    const rows = await db.query(
      `SELECT sow.id, sow.shopify_order_id, sow.order_number,
              sow.phone_normalizado, sow.total_price, sow.financial_status,
              sow.datos_orden, sow.shopify_created_at
         FROM shopify_ordenes_webhook sow
        WHERE sow.id_configuracion = :cfg
          AND sow.phone_normalizado IS NOT NULL
          AND sow.shopify_created_at >= DATE_SUB(NOW(), INTERVAL :dias DAY)
          AND sow.shopify_created_at <= DATE_SUB(NOW(), INTERVAL :gracia MINUTE)
          AND NOT EXISTS (
            SELECT 1 FROM dropi_orders_cache oc
             WHERE oc.id_configuracion = :cfg AND oc.id_usuario = 0
               AND RIGHT(REGEXP_REPLACE(oc.phone,'[^0-9]',''),9)
                   = RIGHT(sow.phone_normalizado COLLATE utf8mb4_unicode_ci, 9)
               AND ABS(oc.total_order - sow.total_price) < 0.5
               AND oc.order_created_at BETWEEN
                     DATE_SUB(sow.shopify_created_at, INTERVAL 3 DAY)
                 AND DATE_ADD(sow.shopify_created_at, INTERVAL 3 DAY)
          )
        ORDER BY sow.shopify_created_at DESC
        LIMIT 100`,
      {
        replacements: { cfg: id_configuracion, dias, gracia: graciaMin },
        type: db.QueryTypes.SELECT,
      },
    );

    // Resolver id_cliente por teléfono (el webhook Shopify crea el chat) para
    // reusar el mismo flujo de crear que las huérfanas de WhatsApp.
    const tels = [
      ...new Set(rows.map((r) => r.phone_normalizado).filter(Boolean)),
    ];
    const clienteByTel = new Map();
    if (tels.length) {
      const clientes = await db.query(
        `SELECT id, RIGHT(REGEXP_REPLACE(celular_cliente,'[^0-9]',''),9) AS tel9
           FROM clientes_chat_center
          WHERE id_configuracion = :cfg AND deleted_at IS NULL
            AND RIGHT(REGEXP_REPLACE(celular_cliente,'[^0-9]',''),9) IN (:tels)
          ORDER BY id`,
        {
          replacements: { cfg: id_configuracion, tels: tels.map((t) => t.slice(-9)) },
          type: db.QueryTypes.SELECT,
        },
      );
      for (const c of clientes)
        if (!clienteByTel.has(c.tel9)) clienteByTel.set(c.tel9, c.id);
    }

    const data = rows.map((r) => {
      let datos = null;
      if (r.datos_orden) {
        try {
          datos =
            typeof r.datos_orden === 'string'
              ? JSON.parse(r.datos_orden)
              : r.datos_orden;
        } catch (_) {}
      }
      const tel9 = String(r.phone_normalizado || '').slice(-9);
      return {
        id: r.id,
        id_cliente: clienteByTel.get(tel9) || null,
        shopify_order_id: r.shopify_order_id,
        order_number: r.order_number,
        telefono: r.phone_normalizado,
        total: r.total_price,
        financial_status: r.financial_status,
        shopify_created_at: r.shopify_created_at,
        datos, // null en órdenes viejas (antes del snapshot)
      };
    });

    return res.json({ ok: true, total: data.length, data });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err?.message });
  }
};

// Lista los productos vinculados a Dropi de una configuración (para el select
// del formulario de "pedidos sin subir"). Misma fuente que usa autoCrearOrden.
exports.listarProductosVinculados = async (req, res) => {
  try {
    const id_configuracion = Number(
      req.body?.id_configuracion ?? req.query?.id_configuracion,
    );
    if (!id_configuracion) {
      return res
        .status(400)
        .json({ ok: false, message: 'id_configuracion requerido' });
    }
    const rows = await db.query(
      `SELECT id, nombre, precio, external_id, imagen_url
         FROM productos_chat_center
        WHERE id_configuracion = ? AND eliminado = 0
          AND external_source = 'DROPI' AND external_id IS NOT NULL
        ORDER BY nombre ASC`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    return res.json({ ok: true, data: rows });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err?.message });
  }
};

// Datos del bot (resumen de cierre parseado) de UN cliente, para prellenar
// el panel de crear orden. Sale del último dropi_auto_ordenes_log.datos_bot;
// si no hay log, cae al contacto (clientes_chat_center).
exports.datosBotCliente = async (req, res) => {
  try {
    const id_configuracion = Number(
      req.body?.id_configuracion ?? req.query?.id_configuracion,
    );
    const id_cliente = Number(req.body?.id_cliente ?? req.query?.id_cliente);
    if (!id_configuracion || !id_cliente) {
      return res
        .status(400)
        .json({ ok: false, message: 'id_configuracion e id_cliente requeridos' });
    }

    const rows = await db.query(
      `SELECT c.id AS id_cliente, c.nombre_cliente, c.apellido_cliente,
              c.celular_cliente, c.direccion,
              l.id AS id_log, l.datos_bot
         FROM clientes_chat_center c
         LEFT JOIN (
           SELECT x.* FROM dropi_auto_ordenes_log x
           JOIN ( SELECT id_cliente, MAX(id) AS max_id
                    FROM dropi_auto_ordenes_log
                   WHERE id_configuracion = :cfg AND id_cliente = :cli
                   GROUP BY id_cliente ) m ON m.max_id = x.id
         ) l ON l.id_cliente = c.id
        WHERE c.id = :cli AND c.id_configuracion = :cfg
        LIMIT 1`,
      {
        replacements: { cfg: id_configuracion, cli: id_cliente },
        type: db.QueryTypes.SELECT,
      },
    );
    if (!rows.length) return res.json({ ok: true, data: null });

    const r = rows[0];
    let datosLog = null;
    if (r.datos_bot) {
      try {
        datosLog = JSON.parse(r.datos_bot);
      } catch (_) {}
    }
    const datos = datosLog || {
      nombre: [r.nombre_cliente, r.apellido_cliente]
        .filter(Boolean)
        .join(' ')
        .trim(),
      telefono: r.celular_cliente || '',
      provincia: '',
      ciudad: '',
      direccion: r.direccion || '',
      producto: '',
      precio: '',
      cantidad: '1',
    };

    return res.json({
      ok: true,
      data: { id_cliente: r.id_cliente, tiene_log: !!datosLog, datos },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err?.message });
  }
};

exports.listPendientesGenerarGuia = async (req, res) => {
  try {
    const id_configuracion = Number(
      req.body?.id_configuracion ?? req.query?.id_configuracion,
    );
    if (!id_configuracion) {
      return res
        .status(400)
        .json({ ok: false, message: 'id_configuracion requerido' });
    }
    const limit = Math.min(Math.max(Number(req.body?.limit) || 100, 1), 200);
    const offset = Math.max(Number(req.body?.offset) || 0, 0);

    const WHERE = `
      c.id_configuracion = :cfg
      AND c.deleted_at IS NULL
      AND c.estado_contacto = 'generar_guia'
      -- el bot NO la creó (excluye 'creada'); incluye 'fallida' y sin intento
      AND (l.id IS NULL OR l.resultado <> 'creada')
      -- y NADIE la creó por otro lado (cache del cron: manual / Shopify)
      AND NOT EXISTS (
        SELECT 1 FROM dropi_orders_cache oc
         WHERE oc.id_configuracion = :cfg
           AND oc.phone COLLATE utf8mb4_unicode_ci
               LIKE CONCAT('%', RIGHT(REPLACE(c.celular_cliente, ' ', ''), 9))
           AND (l.id IS NULL OR oc.order_created_at >= l.created_at)
      )`;

    const LATEST_LOG = `
      LEFT JOIN (
        SELECT x.* FROM dropi_auto_ordenes_log x
        JOIN ( SELECT id_cliente, MAX(id) AS max_id
                 FROM dropi_auto_ordenes_log
                WHERE id_configuracion = :cfg
                GROUP BY id_cliente ) m ON m.max_id = x.id
      ) l ON l.id_cliente = c.id`;

    const rows = await db.query(
      `SELECT
         c.id AS id_cliente, c.nombre_cliente, c.apellido_cliente,
         c.celular_cliente, c.direccion, c.ultimo_mensaje_at,
         l.id AS id_log, l.resultado, l.paso_fallo, l.detalle,
         l.datos_bot, l.created_at AS log_at
       FROM clientes_chat_center c
       ${LATEST_LOG}
       WHERE ${WHERE}
       ORDER BY (l.resultado = 'fallida') DESC, c.ultimo_mensaje_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      { replacements: { cfg: id_configuracion }, type: db.QueryTypes.SELECT },
    );

    const data = rows.map((r) => {
      let datosLog = null;
      if (r.datos_bot) {
        try {
          datosLog = JSON.parse(r.datos_bot);
        } catch (_) {}
      }
      const datos = datosLog || {
        nombre: [r.nombre_cliente, r.apellido_cliente]
          .filter(Boolean)
          .join(' ')
          .trim(),
        telefono: r.celular_cliente || '',
        provincia: '',
        ciudad: '',
        direccion: r.direccion || '',
        producto: '',
        precio: '',
        cantidad: '1',
      };
      return {
        id_cliente: r.id_cliente,
        id_log: r.id_log || null,
        estado: r.resultado === 'fallida' ? 'fallida' : 'pendiente',
        paso_fallo: r.paso_fallo || null,
        detalle: r.detalle || null,
        telefono: datos.telefono,
        datos,
        created_at: r.log_at || null,
      };
    });

    const [{ total = 0 } = {}] = await db.query(
      `SELECT COUNT(*) AS total
         FROM clientes_chat_center c
         ${LATEST_LOG}
        WHERE ${WHERE}`,
      { replacements: { cfg: id_configuracion }, type: db.QueryTypes.SELECT },
    );

    return res.json({ ok: true, total: Number(total), data });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err?.message });
  }
};
