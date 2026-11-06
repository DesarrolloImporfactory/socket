const { db } = require('../database/config');
const { ipDePeticion } = require('./suspension_audit.service');

/**
 * Historial del número de WhatsApp de cada conexión.
 *
 * Desde el 06-11-2026 el cliente puede desconectar su número, cambiarlo y
 * volver a conectar desde /conexiones. Cuando después reclame «yo no puse ese
 * número» o «se me desconectó solo», acá queda quién lo hizo (subusuario,
 * cuenta, IP, navegador), desde dónde (panel, Embedded Signup, conexión
 * manual, script) y cómo estaba la fila antes y después (teléfono, phone_id,
 * WABA, wa_status, nombre). No se muestra en el front: es evidencia para
 * soporte (scripts/historialConexion.js --cfg N).
 *
 * Tabla `configuraciones_numero_log` (configuraciones_numero_log_migration.sql
 * es el registro). Se crea sola la primera vez (CREATE TABLE IF NOT EXISTS,
 * igual que dropi_auditoria_acciones). Fail-open: nunca rompe la acción que
 * audita; a lo sumo deja un warn.
 */

const SQL_CREAR = `
CREATE TABLE IF NOT EXISTS configuraciones_numero_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  id_configuracion BIGINT UNSIGNED NOT NULL,
  id_usuario BIGINT UNSIGNED NULL COMMENT 'dueño de la conexión',
  accion VARCHAR(30) NOT NULL COMMENT 'cambio_numero | cambio_nombre | desconectar | conectar',
  origen VARCHAR(30) NOT NULL DEFAULT 'panel' COMMENT 'panel | embedded_signup | conexion_manual | script',
  telefono_anterior VARCHAR(30) NULL,
  telefono_nuevo VARCHAR(30) NULL,
  id_telefono_anterior VARCHAR(50) NULL,
  id_telefono_nuevo VARCHAR(50) NULL,
  id_whatsapp_anterior VARCHAR(50) NULL,
  id_whatsapp_nuevo VARCHAR(50) NULL,
  wa_status_anterior VARCHAR(50) NULL,
  wa_status_nuevo VARCHAR(50) NULL,
  nombre_anterior VARCHAR(255) NULL,
  nombre_nuevo VARCHAR(255) NULL,
  actor_tipo VARCHAR(20) NOT NULL DEFAULT 'sub_usuario' COMMENT 'sub_usuario | usuario | sistema',
  actor_id_sub_usuario BIGINT UNSIGNED NULL,
  actor_id_usuario BIGINT UNSIGNED NULL,
  actor_usuario VARCHAR(255) NULL,
  actor_email VARCHAR(255) NULL,
  actor_rol VARCHAR(100) NULL,
  ip VARCHAR(45) NULL,
  user_agent VARCHAR(255) NULL,
  detalle TEXT NULL COMMENT 'JSON: total_chats, confirmar_mezcla, resultado en Meta, etc.',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_cnl_config (id_configuracion, created_at),
  KEY idx_cnl_usuario (id_usuario, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

let tablaLista = false;
async function asegurarTabla() {
  if (tablaLista) return;
  await db.query(SQL_CREAR);
  tablaLista = true;
}

const rec = (v, max) =>
  v === null || typeof v === 'undefined' || v === ''
    ? null
    : String(v).slice(0, max);

/**
 * @param {object|null} req  petición Express (con o sin auth.protect)
 * @param {object} o
 * @param {number} o.id_configuracion
 * @param {number} [o.id_usuario]     dueño de la conexión
 * @param {'cambio_numero'|'cambio_nombre'|'desconectar'|'conectar'} o.accion
 * @param {string} [o.origen]         panel | embedded_signup | conexion_manual | script
 * @param {object} [o.antes]          { telefono, id_telefono, id_whatsapp, wa_status, nombre }
 * @param {object} [o.despues]        idem
 * @param {object|string} [o.detalle] se guarda como JSON
 */
async function registrarCambioConexion(req, o) {
  try {
    await asegurarTabla();
    const s = req?.sessionUser || null;
    const antes = o.antes || {};
    const despues = o.despues || {};
    const detalle =
      o.detalle === null || typeof o.detalle === 'undefined'
        ? null
        : typeof o.detalle === 'string'
          ? o.detalle
          : JSON.stringify(o.detalle);

    // Sin sesión (Embedded Signup y conexión manual no pasan por protect):
    // queda el id_usuario que mandó el front y la IP.
    const actor_tipo = s ? 'sub_usuario' : o.actor_id_usuario ? 'usuario' : 'sistema';

    await db.query(
      `INSERT INTO configuraciones_numero_log
         (id_configuracion, id_usuario, accion, origen,
          telefono_anterior, telefono_nuevo,
          id_telefono_anterior, id_telefono_nuevo,
          id_whatsapp_anterior, id_whatsapp_nuevo,
          wa_status_anterior, wa_status_nuevo,
          nombre_anterior, nombre_nuevo,
          actor_tipo, actor_id_sub_usuario, actor_id_usuario,
          actor_usuario, actor_email, actor_rol,
          ip, user_agent, detalle, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      {
        replacements: [
          Number(o.id_configuracion),
          o.id_usuario ? Number(o.id_usuario) : null,
          rec(o.accion, 30),
          rec(o.origen || 'panel', 30),
          rec(antes.telefono, 30),
          rec(despues.telefono, 30),
          rec(antes.id_telefono, 50),
          rec(despues.id_telefono, 50),
          rec(antes.id_whatsapp, 50),
          rec(despues.id_whatsapp, 50),
          rec(antes.wa_status, 50),
          rec(despues.wa_status, 50),
          rec(antes.nombre, 255),
          rec(despues.nombre, 255),
          actor_tipo,
          s?.id_sub_usuario ? Number(s.id_sub_usuario) : null,
          s?.id_usuario
            ? Number(s.id_usuario)
            : o.actor_id_usuario
              ? Number(o.actor_id_usuario)
              : null,
          rec(s?.nombre_encargado || s?.usuario, 255),
          rec(s?.email, 255),
          rec(s?.rol, 100),
          req ? ipDePeticion(req) : null,
          rec(req?.headers?.['user-agent'], 255),
          rec(detalle, 4000),
        ],
      },
    );
  } catch (e) {
    console.warn(
      '[conexion_numero_audit] no se pudo registrar el cambio:',
      e?.message,
    );
  }
}

module.exports = { registrarCambioConexion };
