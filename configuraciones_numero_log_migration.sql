-- Historial del número de WhatsApp de cada conexión (06-11-2026).
-- La crea sola el server la primera vez que registra algo
-- (services/conexion_numero_audit.service.js, CREATE TABLE IF NOT EXISTS);
-- este archivo es el registro de la estructura.
-- Consultar: node scripts/historialConexion.js --cfg N

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
