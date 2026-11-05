-- Auditoría de lo que el chat le pide a Dropi desde el server (cotizar
-- transportadoras, crear orden). utils/dropiAuditoria.js la crea sola si no
-- existe (CREATE TABLE IF NOT EXISTS); este archivo es registro.
-- Lectura: node scripts/auditoriaDropi.js --cfg 569 --dias 7

CREATE TABLE IF NOT EXISTS dropi_auditoria_acciones (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  id_configuracion BIGINT UNSIGNED NULL,
  accion VARCHAR(40) NOT NULL,            -- cotizar | crear_orden
  country_code VARCHAR(4) NULL,
  resultado VARCHAR(30) NOT NULL,         -- ok | sin_transportadoras | dropi_no_cotizo | dropi_no_creo | error_dropi | error
  motivo VARCHAR(600) NULL,               -- mensaje real de Dropi o del error
  detalle LONGTEXT NULL,                  -- JSON: payload resumido, lo mandado a Dropi, respuesta
  ms INT UNSIGNED NULL,                   -- duración total de la acción
  socket_id VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_cfg_fecha (id_configuracion, created_at),
  KEY idx_accion_resultado (accion, resultado, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
