const { db } = require('../database/config');
const { ipDePeticion } = require('./suspension_audit.service');

/**
 * Auditoría de los interruptores por chat de `clientes_chat_center`:
 * `enviar_remarketing` (switch Remarketing de la cabecera del chat) y
 * `bot_openia` (switch Bot IA).
 *
 * Caso que lo originó (09-11-2026, cfg 1281): un cliente juró que había
 * apagado el remarketing de un chat y que igual le llegó el tercer
 * recordatorio. La columna solo guarda el valor final y el UPDATE es
 * directo, así que no había forma de saber si lo apagó él, cuándo, o si fue
 * el cron al cerrar el ciclo (que también lo pone en 0). Se resolvió por
 * indicios (la cola de remarketing_pendientes seguía intacta). Con esto cada
 * cambio deja fila: quién, desde dónde y por qué.
 *
 * Orígenes:
 *   chat              → el asesor tocó el switch en /chat (hay sesión).
 *   cron_fin_ciclo    → el cron apagó el remarketing al terminar la secuencia.
 *   respuesta_cliente → el cliente respondió a un recordatorio ya enviado
 *                       (cancelarRemarketingKanban).
 *   columna_persistente → programarRemarketingKanban lo reencendió en una
 *                       columna de seguimiento persistente (retiro_agencia).
 *   pedido_nuevo      → un pedido nuevo (Dropi/Aliclik/Shopify) reinició el
 *                       seguimiento.
 *
 * Reglas de la casa: esto NUNCA tumba la operación que audita. Fail-open con
 * warn en consola. La tabla se crea sola la primera vez (misma BD dev/prod).
 */

let tablaLista = false;
async function ensureTabla() {
  if (tablaLista) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS clientes_switch_log (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      id_cliente_chat_center INT NOT NULL,
      id_configuracion INT NULL,
      switch_nombre ENUM('enviar_remarketing','bot_openia') NOT NULL,
      valor_anterior TINYINT NULL,
      valor_nuevo TINYINT NOT NULL,
      origen ENUM('chat','cron_fin_ciclo','respuesta_cliente','columna_persistente','pedido_nuevo','otro') NOT NULL DEFAULT 'otro',
      actor_tipo ENUM('sub_usuario','sistema') NOT NULL,
      actor_id_sub_usuario INT NULL,
      actor_id_usuario INT NULL,
      actor_usuario VARCHAR(255) NULL,
      actor_email VARCHAR(255) NULL,
      actor_rol VARCHAR(100) NULL,
      ip VARCHAR(45) NULL,
      user_agent VARCHAR(255) NULL,
      detalle VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY ix_csw_cliente (id_cliente_chat_center, created_at),
      KEY ix_csw_cfg (id_configuracion, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  tablaLista = true;
}

function recortar(valor, max) {
  if (valor === null || typeof valor === 'undefined') return null;
  return String(valor).slice(0, max);
}

function aBit(v) {
  if (v === null || typeof v === 'undefined' || v === '') return null;
  return Number(v) ? 1 : 0;
}

async function registrar(datos) {
  try {
    await ensureTabla();
    await db.query(
      `INSERT INTO clientes_switch_log
         (id_cliente_chat_center, id_configuracion, switch_nombre,
          valor_anterior, valor_nuevo, origen,
          actor_tipo, actor_id_sub_usuario, actor_id_usuario,
          actor_usuario, actor_email, actor_rol,
          ip, user_agent, detalle, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      {
        replacements: [
          Number(datos.id_cliente_chat_center),
          datos.id_configuracion ? Number(datos.id_configuracion) : null,
          datos.switch_nombre,
          aBit(datos.valor_anterior),
          aBit(datos.valor_nuevo) ?? 0,
          datos.origen || 'otro',
          datos.actor_tipo,
          datos.actor_id_sub_usuario ? Number(datos.actor_id_sub_usuario) : null,
          datos.actor_id_usuario ? Number(datos.actor_id_usuario) : null,
          recortar(datos.actor_usuario, 255),
          recortar(datos.actor_email, 255),
          recortar(datos.actor_rol, 100),
          recortar(datos.ip, 45),
          recortar(datos.user_agent, 255),
          recortar(datos.detalle, 255),
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  } catch (e) {
    console.warn('[switch_audit] no se pudo registrar el cambio:', e?.message);
  }
}

/**
 * Cambio hecho por un asesor desde el chat (la petición ya pasó por
 * auth.protect y requireChatPropietario, que deja el chat en req.chat).
 */
async function auditarDesdeChat(req, opts) {
  const s = req?.sessionUser || {};
  return registrar({
    id_cliente_chat_center: opts.id_cliente_chat_center,
    id_configuracion: opts.id_configuracion ?? req?.chat?.id_configuracion ?? null,
    switch_nombre: opts.switch_nombre,
    valor_anterior: opts.valor_anterior,
    valor_nuevo: opts.valor_nuevo,
    origen: 'chat',
    actor_tipo: 'sub_usuario',
    actor_id_sub_usuario: s.id_sub_usuario || null,
    actor_id_usuario: s.id_usuario || null,
    actor_usuario: s.nombre_encargado || s.usuario || null,
    actor_email: s.email || null,
    actor_rol: s.rol || null,
    ip: ipDePeticion(req),
    user_agent: recortar(req?.headers?.['user-agent'], 255),
    detalle: opts.detalle || null,
  });
}

/** Cambio hecho por el sistema (cron, kanban IA, notifier, Shopify). */
async function auditarDesdeSistema(opts) {
  return registrar({
    id_cliente_chat_center: opts.id_cliente_chat_center,
    id_configuracion: opts.id_configuracion || null,
    switch_nombre: opts.switch_nombre || 'enviar_remarketing',
    valor_anterior: opts.valor_anterior,
    valor_nuevo: opts.valor_nuevo,
    origen: opts.origen || 'otro',
    actor_tipo: 'sistema',
    detalle: opts.detalle || null,
  });
}

/** Últimos cambios de un chat, para diagnósticos y para la UI si hace falta. */
async function historialDeCliente(id_cliente_chat_center, limite = 30) {
  await ensureTabla();
  return db.query(
    `SELECT id, switch_nombre, valor_anterior, valor_nuevo, origen, actor_tipo,
            actor_usuario, actor_email, actor_rol, ip, detalle, created_at
       FROM clientes_switch_log
      WHERE id_cliente_chat_center = ?
      ORDER BY id DESC
      LIMIT ?`,
    {
      replacements: [Number(id_cliente_chat_center), Number(limite) || 30],
      type: db.QueryTypes.SELECT,
    },
  );
}

module.exports = {
  auditarDesdeChat,
  auditarDesdeSistema,
  historialDeCliente,
  ensureTabla,
};
