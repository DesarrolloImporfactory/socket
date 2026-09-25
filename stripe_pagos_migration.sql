-- ─────────────────────────────────────────────────────────────────────────────
-- Enlaces de pago con la cuenta de Stripe de CADA cliente
--
-- Contexto (2026-09-25): el asesor necesita cobrar un monto puntual desde el
-- chat ("+" → Crear enlace de pago) y ver si ya se pagó. El cobro de la 242
-- (plantilla saldo_pendiente_pago) sigue igual: es otra cosa, va contra la
-- cartera de Imporsuit y lo crea el PHP.
--
-- Modelo elegido: llave propia. Cada cuenta (id_configuracion) pega una llave
-- restringida de SU Stripe; el dinero cae en su cuenta y la plataforma no
-- cobra comisión. Sin Stripe Connect ni onboarding.
--
-- stripe_integrations  → la llave, cifrada con utils/cryptoToken (misma llave
--                        que Dropi/Aliclik), una por configuración.
-- enlaces_pago         → una fila por factura de Stripe creada desde el chat
--                        (o por el bot a futuro). El estado se sincroniza
--                        consultando la factura: al abrir el chat y por cron
--                        cada 10 min. No exige webhook al cliente.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stripe_integrations (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_configuracion  BIGINT UNSIGNED NOT NULL,
  nombre            VARCHAR(150) NOT NULL,
  secret_key_enc    TEXT NOT NULL,
  key_last4         VARCHAR(4) DEFAULT NULL,
  modo              ENUM('live','test') NOT NULL DEFAULT 'live',
  moneda_default    VARCHAR(3) NOT NULL DEFAULT 'usd',
  account_id        VARCHAR(64) DEFAULT NULL,
  account_nombre    VARCHAR(150) DEFAULT NULL,
  is_active         TINYINT(1) NOT NULL DEFAULT 1,
  deleted_at        DATETIME DEFAULT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_stripe_integrations (id_configuracion, deleted_at),
  KEY idx_stripe_integrations_config (id_configuracion)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS enlaces_pago (
  id                       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_configuracion         BIGINT UNSIGNED NOT NULL,
  id_cliente_chat_center   BIGINT UNSIGNED NOT NULL,
  id_sub_usuario           BIGINT UNSIGNED DEFAULT NULL,
  origen                   ENUM('asesor','bot','api') NOT NULL DEFAULT 'asesor',
  stripe_customer_id       VARCHAR(64) DEFAULT NULL,
  stripe_invoice_id        VARCHAR(64) NOT NULL,
  stripe_payment_intent    VARCHAR(64) DEFAULT NULL,
  url_pago                 VARCHAR(500) NOT NULL,
  url_pdf                  VARCHAR(500) DEFAULT NULL,
  monto                    DECIMAL(12,2) NOT NULL,
  moneda                   VARCHAR(3) NOT NULL DEFAULT 'usd',
  concepto                 VARCHAR(255) NOT NULL,
  estado                   ENUM('pendiente','pagado','anulado') NOT NULL DEFAULT 'pendiente',
  vence_at                 DATETIME DEFAULT NULL,
  pagado_at                DATETIME DEFAULT NULL,
  anulado_at               DATETIME DEFAULT NULL,
  id_mensaje               BIGINT UNSIGNED DEFAULT NULL,
  ultimo_check_at          DATETIME DEFAULT NULL,
  created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_enlaces_pago_invoice (stripe_invoice_id),
  KEY idx_enlaces_pago_config_estado (id_configuracion, estado, created_at),
  KEY idx_enlaces_pago_cliente (id_cliente_chat_center, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
