'use strict';

const { autoCrearOrdenDropi } = require('../services/dropiAutoOrder.service');
const { db } = require('../database/config');

/**
 * POST /dropi/auto-orden/probar
 *
 * Dispara autoCrearOrdenDropi de forma SÍNCRONA (await) para:
 *  - Testing manual sin tener que cerrar una conversación real.
 *  - Futuro botón del front "reintentar subida a Dropi".
 *
 * Dos modos de uso:
 *
 *  A) Reintentar una fila fallida del log (lo que usará el botón del front):
 *     { "id_log": 131 }
 *     → lee dropi_auto_ordenes_log #131, toma su datos_bot/id_cliente/id_configuracion
 *       y vuelve a ejecutar el flujo.
 *
 *  B) Mandar los datos a mano (testing libre):
 *     {
 *       "id_configuracion": 411,
 *       "id_cliente": 463730,
 *       "force": true,
 *       "datosBot": {
 *         "nombre": "...", "telefono": "...", "provincia": "...",
 *         "ciudad": "...", "direccion": "...", "producto": "...",
 *         "precio": "$25", "cantidad": "2"
 *       }
 *     }
 *
 * force (default true): salta el gate auto_crear_orden_dropi, porque siempre
 * es una acción manual explícita. Manda force:false si quieres respetar el gate.
 *
 * Crea una ORDEN REAL en Dropi (PENDIENTE CONFIRMACION). Para pruebas que
 *    no quieras despachar, usa datos tipo "nodespachar" como en el flujo manual.
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

    // ── Modo A: reintentar desde una fila del log ──
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
      id_configuracion = row.id_configuracion;
      id_cliente = row.id_cliente;
      try {
        datosBot = JSON.parse(row.datos_bot || '{}');
      } catch (_) {
        datosBot = {};
      }
      // por si el datos_bot guardado no traía teléfono
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
