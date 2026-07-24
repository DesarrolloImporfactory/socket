-- ============================================================================
-- Migración: soporte multi-canal en remarketing_pendientes
-- Agrega el canal (source) + identificadores de ruteo para Instagram/Messenger.
--
-- Con DEFAULT 'wa', TODAS las filas existentes quedan como 'wa' → el cron de
-- WhatsApp sigue procesándolas idéntico. Las filas de Instagram se insertan con
-- source='ig' y las procesa el cron nuevo (cron/remarketing_ig.js).
--
-- Aplicar manualmente:  mysql -u <user> -p <db_principal> < add_source_remarketing_pendientes_migration.sql
-- ============================================================================

ALTER TABLE `remarketing_pendientes`
  ADD COLUMN `source` VARCHAR(4) NOT NULL DEFAULT 'wa' AFTER `id_configuracion`,
  ADD COLUMN `page_id` VARCHAR(50) NULL DEFAULT NULL AFTER `source`,
  ADD COLUMN `external_id` VARCHAR(64) NULL DEFAULT NULL AFTER `page_id`;

-- Índice para que el cron IG filtre rápido por (source, enviado, cancelado, disparo)
ALTER TABLE `remarketing_pendientes`
  ADD INDEX `idx_rmk_source_pend` (`source`, `enviado`, `cancelado`, `tiempo_disparo`);
