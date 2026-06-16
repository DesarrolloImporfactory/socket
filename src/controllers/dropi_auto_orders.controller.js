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
