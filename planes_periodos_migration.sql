-- ─────────────────────────────────────────────────────────────────────────────
-- Planes con pago semestral y anual
--
-- Contexto (2026-09-24): los planes públicos (ImporChat $39, Pro Ecosistema
-- $49, Avanzado $99) se cobraban solo mes a mes. Se agregan dos periodos de
-- pago adelantado sobre los MISMOS planes y productos de Stripe:
--   semestral = paga 5 meses y usa 6      anual = paga 10 meses y usa 12
-- El plan de $29 (cursos) no entra: ya es un beneficio.
--
-- El plan (id_plan) no cambia con el periodo: límites, herramientas y MRR
-- siguen colgando de planes_chat_center. Aquí solo vive el precio de Stripe
-- por periodo. Los precios se crearon con scripts/crearPreciosPeriodicos.js.
--
-- usuarios_chat_center.periodo_pago lo escribe el webhook de Stripe a partir
-- del price de la suscripción; el código lo lee de forma tolerante (si la
-- columna no existe todavía, asume 'mensual').
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS planes_periodos_chat_center (
  id_periodo     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_plan        INT NOT NULL,
  periodo        ENUM('semestral','anual') NOT NULL,
  meses          TINYINT UNSIGNED NOT NULL,
  precio         DECIMAL(10,2) NOT NULL,
  id_price_prod  VARCHAR(100) NOT NULL,
  id_price_test  VARCHAR(100) DEFAULT NULL,
  activo         TINYINT(1) NOT NULL DEFAULT 1,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id_periodo),
  UNIQUE KEY uq_plan_periodo (id_plan, periodo),
  KEY idx_price_prod (id_price_prod),
  KEY idx_price_test (id_price_test)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO planes_periodos_chat_center
  (id_plan, periodo, meses, precio, id_price_prod, id_price_test)
VALUES
  (2, 'semestral',  6, 195.00, 'price_1UJJWBClsPjxVwZws38JRG0u', 'price_1UJJW8ClsPjxVwZwghcqTuc7'),
  (2, 'anual',     12, 390.00, 'price_1UJJWBClsPjxVwZwbL23Mqy5', 'price_1UJJW8ClsPjxVwZwU6fEyYWz'),
  (3, 'semestral',  6, 245.00, 'price_1UJJWCClsPjxVwZwXRTMHFvt', 'price_1UJJW9ClsPjxVwZw6P6MTZtd'),
  (3, 'anual',     12, 490.00, 'price_1UJJWCClsPjxVwZw22ntl5TT', 'price_1UJJW9ClsPjxVwZwUaFphucq'),
  (4, 'semestral',  6, 495.00, 'price_1UJJWDClsPjxVwZwh3sUBrS5', 'price_1UJJWAClsPjxVwZwQceiWZSS'),
  (4, 'anual',     12, 990.00, 'price_1UJJWDClsPjxVwZwOY8LYO3y', 'price_1UJJWAClsPjxVwZwypuv5ROv'),
  -- Comunidad ($29, alumnos de cursos): mismo beneficio, agregado el 2026-09-24.
  (22, 'semestral', 6, 145.00, 'price_1UJKVMClsPjxVwZw2vZeH46p', 'price_1UJKVKClsPjxVwZwvhxE9S6M'),
  (22, 'anual',    12, 290.00, 'price_1UJKVMClsPjxVwZw8wSbrkOc', 'price_1UJKVKClsPjxVwZwo6mtcLYX'),
  -- Planes TEST (solo existen en Stripe test; se prueban en local desbloqueándolos
  -- con usuarios_chat_center.unlocked_plans). Ambas columnas llevan el price de test.
  (16, 'semestral',  6, 145.00, 'price_1UJL9aClsPjxVwZwBP4HTqM8', 'price_1UJL9aClsPjxVwZwBP4HTqM8'),
  (16, 'anual',     12, 290.00, 'price_1UJL9aClsPjxVwZwtQq6Ra2u', 'price_1UJL9aClsPjxVwZwtQq6Ra2u'),
  (17, 'semestral',  6, 245.00, 'price_1UJJW9ClsPjxVwZw6P6MTZtd', 'price_1UJJW9ClsPjxVwZw6P6MTZtd'),
  (17, 'anual',     12, 490.00, 'price_1UJJW9ClsPjxVwZwUaFphucq', 'price_1UJJW9ClsPjxVwZwUaFphucq'),
  (18, 'semestral',  6, 495.00, 'price_1UJJWAClsPjxVwZwQceiWZSS', 'price_1UJJWAClsPjxVwZwQceiWZSS'),
  (18, 'anual',     12, 990.00, 'price_1UJJWAClsPjxVwZwypuv5ROv', 'price_1UJJWAClsPjxVwZwypuv5ROv'),
  (23, 'semestral',  6, 145.00, 'price_1UJKVKClsPjxVwZwvhxE9S6M', 'price_1UJKVKClsPjxVwZwvhxE9S6M'),
  (23, 'anual',     12, 290.00, 'price_1UJKVKClsPjxVwZwo6mtcLYX', 'price_1UJKVKClsPjxVwZwo6mtcLYX')
ON DUPLICATE KEY UPDATE
  meses = VALUES(meses), precio = VALUES(precio),
  id_price_prod = VALUES(id_price_prod), id_price_test = VALUES(id_price_test);

-- ALGORITHM = INSTANT: agrega la columna sin reconstruir usuarios_chat_center.
ALTER TABLE usuarios_chat_center
  ADD COLUMN periodo_pago ENUM('mensual','semestral','anual') NOT NULL DEFAULT 'mensual'
  AFTER stripe_subscription_status,
  ALGORITHM = INSTANT;
