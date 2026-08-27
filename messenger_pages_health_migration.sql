-- ─────────────────────────────────────────────────────────────────────────────
-- Salud de las conexiones de páginas de Facebook (messenger_pages)
--
-- Contexto: `status` es enum('active','revoked') pero NADA en el código lo pasa
-- a 'revoked' cuando Meta invalida el page_access_token. La fila se queda
-- 'active' para siempre y getPageTokenByPageId() sigue entregando un token
-- muerto: los webhooks entrantes llegan igual (no usan token) pero todo envío
-- saliente falla en silencio.
--
-- Diagnóstico del 2026-08-27 sobre las 14 páginas 'active':
--   - 6 con el token muerto ("The session has been invalidated")
--   - 3 válidos pero sin pages_read_engagement
--   - solo 4 de 14 podían leer /{page_id}/feed
--   - 0 con pages_manage_engagement
--
-- Estas columnas guardan el resultado del chequeo para poder mostrarlo en la UI
-- y saber a qué clientes pedirles que reconecten.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE `messenger_pages`
  ADD COLUMN `token_valido` TINYINT(1) NULL DEFAULT NULL
    COMMENT 'Ultimo debug_token: 1 vivo, 0 muerto, NULL nunca revisado'
    AFTER `status`,

  ADD COLUMN `token_revisado_at` DATETIME NULL DEFAULT NULL
    COMMENT 'Cuando se corrio el ultimo chequeo (exitoso o no)'
    AFTER `token_valido`,

  ADD COLUMN `token_error` VARCHAR(255) NULL DEFAULT NULL
    COMMENT 'Mensaje de Meta cuando el token no sirve'
    AFTER `token_revisado_at`,

  ADD COLUMN `token_scopes` TEXT NULL DEFAULT NULL
    COMMENT 'Permisos que trae el token, separados por coma'
    AFTER `token_error`,

  ADD COLUMN `puede_leer_feed` TINYINT(1) NULL DEFAULT NULL
    COMMENT '1 si /{page_id}/feed responde 200. Prerequisito del modulo de comentarios'
    AFTER `token_scopes`,

  ADD COLUMN `revoked_at` DATETIME NULL DEFAULT NULL
    COMMENT 'Cuando se marco status=revoked por token muerto'
    AFTER `puede_leer_feed`;

-- Para listar rápido las conexiones que necesitan reconexión.
ALTER TABLE `messenger_pages`
  ADD INDEX `ix_mp_salud` (`status`, `token_valido`);
