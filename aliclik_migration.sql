-- ============================================================================
-- aliclik_migration.sql
--
-- Esquema de la integración con Aliclik (fulfillment Perú).
--
-- Por qué existe: estas tablas ya se aplicaron A MANO en producción
-- (chat_center) pero nunca se versionaron. Este archivo es la reproducción
-- FIEL de lo que hay hoy allá — verificado con SHOW CREATE TABLE contra
-- chat_center en MariaDB 10.6 — para que un entorno nuevo quede idéntico.
--
-- No basta con db.sync({force:false}): `aliclik_plantillas_enviadas` no tiene
-- modelo Sequelize (solo se usa por SQL crudo desde aliclik_notifier.service.js
-- y aliclikOrders.service.js), así que sin este script el primer envío de
-- plantilla revienta con "table doesn't exist".
--
-- Es idempotente: se puede correr varias veces sin romper nada.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────
-- 1) Vinculación de la cuenta con Aliclik
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `aliclik_integrations` (
  `id`               bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `id_configuracion` bigint(20) unsigned NOT NULL,
  `store_name`       varchar(150) NOT NULL,
  -- Cifrado con utils/cryptoToken (misma llave que Dropi: DROPI_TOKEN_ENC_KEY)
  `token_enc`        text NOT NULL,
  `token_last4`      varchar(4) DEFAULT NULL,
  -- `exp` del JWT de Aliclik (30 días en los que emiten hoy). Cuando vence, su
  -- API responde 401 y la cuenta deja de recibir estados en silencio.
  `token_exp_at`     datetime DEFAULT NULL,
  `company_id`       bigint(20) unsigned DEFAULT NULL,
  `integration_id`   bigint(20) unsigned DEFAULT NULL,
  -- Segmento de path que el cliente pega en el panel de Aliclik. Autentica el
  -- webhook (su payload no trae firma) y resuelve a qué configuración
  -- pertenece el evento (tampoco trae companyId).
  `webhook_secret`   varchar(64) NOT NULL,
  `is_active`        tinyint(4) NOT NULL DEFAULT 1,
  `deleted_at`       datetime DEFAULT NULL,
  `created_at`       datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at`       datetime NOT NULL DEFAULT current_timestamp()
                     ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_aliclik_webhook_secret` (`webhook_secret`),
  UNIQUE KEY `uq_aliclik_integrations`
    (`id_configuracion`, `store_name`, `deleted_at`),
  KEY `idx_aliclik_integrations_config` (`id_configuracion`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ─────────────────────────────────────────────────────────────
-- 2) Espejo local de los pedidos
--
-- No es una optimización como dropi_orders_cache: es camino crítico. El
-- webhook de Aliclik llega solo con {orderNumber, callStatus, status,
-- dispatchStatus} — sin teléfono, sin productos, sin total. Sin esta tabla no
-- hay a quién notificar.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `aliclik_orders_cache` (
  `id`               bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  -- String ("ALC000123456789"), no un entero como el de Dropi
  `order_number`     varchar(60) NOT NULL,
  `id_configuracion` bigint(20) unsigned NOT NULL,
  -- Los tres ejes de estado, tal cual los devuelve Aliclik
  `call_status`      varchar(40) DEFAULT NULL,
  `status`           varchar(40) DEFAULT NULL,
  `dispatch_status`  varchar(40) DEFAULT NULL,
  -- Resultado del mapeo a nuestro vocabulario canónico
  `estado_config`    varchar(50) DEFAULT NULL,
  `total`            decimal(12,2) DEFAULT 0.00,
  `name`             varchar(200) DEFAULT NULL,
  `surname`          varchar(200) DEFAULT NULL,
  `phone`            varchar(100) DEFAULT NULL,
  `city`             varchar(200) DEFAULT NULL,
  `state`            varchar(200) DEFAULT NULL,
  `product_detail`   text DEFAULT NULL,
  `order_created_at` datetime DEFAULT NULL,
  `order_data`       longtext DEFAULT NULL,
  `synced_at`        datetime DEFAULT NULL,
  `created_at`       datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at`       datetime NOT NULL DEFAULT current_timestamp()
                     ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  -- Lo usa el updateOnDuplicate de upsertOrders. Sin él se insertan filas
  -- repetidas en vez de actualizar, en silencio.
  UNIQUE KEY `uq_aliclik_order` (`order_number`, `id_configuracion`),
  KEY `idx_aliclik_cache_config` (`id_configuracion`),
  KEY `idx_aliclik_cache_phone` (`id_configuracion`, `phone`),
  KEY `idx_aliclik_cache_created` (`id_configuracion`, `order_created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ─────────────────────────────────────────────────────────────
-- 3) Bitácora cruda del webhook + idempotencia
--
-- La doc de Aliclik avisa que los estados pueden llegar en desorden y
-- repetidos, y pide idempotencia. El UNIQUE de event_hash la resuelve.
--
-- `payload` es longtext con CHECK json_valid: es lo que MariaDB crea cuando
-- Sequelize declara DataTypes.JSON (ahí JSON es un alias, no un tipo propio).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `aliclik_webhook_events` (
  `id`               bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `order_number`     varchar(60) DEFAULT NULL,
  `id_configuracion` bigint(20) unsigned DEFAULT NULL,
  `call_status`      varchar(40) DEFAULT NULL,
  `status`           varchar(40) DEFAULT NULL,
  `dispatch_status`  varchar(40) DEFAULT NULL,
  `payload`          longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
                     DEFAULT NULL CHECK (json_valid(`payload`)),
  -- sha256(id_configuracion|payload). Incluye la configuración porque el
  -- payload (4 campos) es tan chico que dos cuentas podrían generar eventos
  -- idénticos y una le robaría el evento a la otra.
  `event_hash`       varchar(64) NOT NULL,
  `created_at`       datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_aliclik_event_hash` (`event_hash`),
  KEY `idx_aliclik_event_order` (`order_number`),
  KEY `idx_aliclik_event_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ─────────────────────────────────────────────────────────────
-- 4) Dedupe de envíos de plantillas
--
-- ESTA es la que no tiene modelo Sequelize. El UNIQUE es lo que hace atómico a
-- reclamarEnvio() y evita que webhook y cron manden el mismo mensaje dos veces.
--
-- OJO: a diferencia de dropi_plantillas_enviadas, acá NO hay columna `source`
-- ni `sent_at` (la marca de tiempo es `created_at`). Las filas de bloqueo que
-- deja aliclikOrders.service al crear un pedido desde el panel se distinguen
-- solo por su template_name '[SKIP] creada en sistema'.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `aliclik_plantillas_enviadas` (
  `id`               bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `order_number`     varchar(60) NOT NULL,
  `id_configuracion` bigint(20) unsigned NOT NULL,
  -- Estado canónico (ver ESTADOS_ALICLIK en aliclik_notifier.service.js)
  `estado`           varchar(50) NOT NULL,
  `phone`            varchar(100) DEFAULT NULL,
  `template_name`    varchar(255) DEFAULT NULL,
  `total`            decimal(12,2) DEFAULT NULL,
  `wa_message_id`    varchar(255) DEFAULT NULL,
  `created_at`       datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_aliclik_order_config_estado`
    (`order_number`, `id_configuracion`, `estado`),
  KEY `idx_aliclik_enviadas_config` (`id_configuracion`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ─────────────────────────────────────────────────────────────
-- 5) dropi_plantillas_config.proveedor
--
-- La pantalla "Plantillas de seguimiento" es común a los dos proveedores; lo
-- único que cambia es qué estados existen. Sin esta columna, la config de
-- Aliclik pisaría la de Dropi.
--
-- ADD COLUMN IF NOT EXISTS no existe en MySQL 5.7/8.0, así que se resuelve con
-- SQL dinámico para que el script siga siendo idempotente en ambos motores.
-- ─────────────────────────────────────────────────────────────
SET @col_existe := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'dropi_plantillas_config'
     AND COLUMN_NAME  = 'proveedor'
);
SET @sql := IF(@col_existe = 0,
  'ALTER TABLE `dropi_plantillas_config` ADD COLUMN `proveedor` varchar(20) NOT NULL DEFAULT ''dropi'' AFTER `id_configuracion`',
  'SELECT ''columna proveedor ya existe'' AS aviso');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- El UNIQUE de la config tiene que incluir el proveedor: si quedara solo como
-- (id_configuracion, estado_dropi), Aliclik y Dropi se pisan la fila.
-- En producción ese índice se llama `uq_cfg_proveedor_estado`; se comprueba por
-- COLUMNAS y no por nombre para no crear un duplicado con otro nombre.
SET @idx_existe := (
  SELECT COUNT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'dropi_plantillas_config'
     AND NON_UNIQUE   = 0
     AND COLUMN_NAME  = 'proveedor'
);
SET @sql := IF(@idx_existe = 0,
  'ALTER TABLE `dropi_plantillas_config` ADD UNIQUE KEY `uq_cfg_proveedor_estado` (`id_configuracion`, `proveedor`, `estado_dropi`)',
  'SELECT ''indice unico por proveedor ya existe'' AS aviso');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
