-- ---------------------------------------------------------------------------
-- Soporte para dos apps de Meta en la integración de anuncios
--
-- Mismo motivo que dos_apps_meta_migration.sql, pero para Meta Ads: la app
-- histórica quedó restringida y no puede obtener acceso avanzado a
-- ads_management / ads_read / pages_manage_ads. Se levanta una segunda app.
--
-- Alcance del problema, que aquí es MENOR que en Messenger: las llamadas de
-- anuncios usan el token del cliente tal cual (Bearer) y NO firman con
-- appsecret_proof, así que un token viejo sigue funcionando aunque el servidor
-- esté configurado con otra app. La app sólo importa en dos sitios:
--
--   1. debug_token  — exige el token de app de LA app que emitió el token
--                     inspeccionado. Cruzarlas rompe la resolución de páginas
--                     del lanzador de anuncios.
--   2. El intercambio del `code` al conectar — sólo afecta a conexiones nuevas.
--
-- Se aplica a mano sobre la BD principal (chat_center).
-- ---------------------------------------------------------------------------

-- Qué app emitió el access_token de cada conexión.
-- NULL = la app legacy, que es lo que son todas las conexiones existentes.
-- El código resuelve NULL -> legacy, así que no hace falta backfill.
ALTER TABLE `meta_ad_connections`
  ADD COLUMN `fb_app_id` VARCHAR(32) NULL DEFAULT NULL
  COMMENT 'App ID de Meta que emitió access_token. NULL = app legacy'
  AFTER `access_token`;

-- Comprobación
-- SELECT COALESCE(fb_app_id,'NULL(legacy)') app, COUNT(*)
--   FROM meta_ad_connections GROUP BY 1;
