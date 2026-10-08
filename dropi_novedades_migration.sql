-- ─────────────────────────────────────────────────────────────────────────
-- Registro de novedades Dropi y su historial
--
-- Para qué: Dropi solo dice "esta orden está en NOVEDAD"; no guarda de forma
-- consultable cuántas veces se volvió a ofrecer, quién la solventó ni cómo
-- terminó. Estas dos tablas lo registran para:
--   - saber cuántas veces se ofreció un pedido (reincidencia → pasa a asesor),
--   - medir si las soluciones funcionan (¿terminó entregada o devuelta?),
--   - dejar constancia de lo que propuso la IA y lo que envió el asesor.
--
-- Solo CREA tablas nuevas: no toca ninguna existente. El código tolera que
-- todavía no existan (no registra, pero no rompe nada), así que se puede
-- aplicar antes o después del deploy.
--
-- OJO: producción y desarrollo comparten la misma base (98.91.50.83).
-- ─────────────────────────────────────────────────────────────────────────

-- Una fila por cada novedad de una orden. Si la orden vuelve a caer en
-- novedad después de ofrecerse, es una fila nueva con numero = 2, 3…
CREATE TABLE IF NOT EXISTS dropi_novedades (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_configuracion BIGINT UNSIGNED NOT NULL,
  dropi_order_id   BIGINT UNSIGNED NOT NULL,
  -- 1 = primera novedad de la orden, 2 = segunda (reincidencia)…
  numero           SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  shipping_guide   VARCHAR(100) NULL,
  transportadora   VARCHAR(100) NULL,
  novedad          VARCHAR(500) NULL,
  -- pendiente  : sin solventar
  -- solventada : se envió una solución, la transportadora aún no la mueve
  -- en_ruta    : la orden salió de novedad (se volvió a ofrecer)
  -- cerrada    : la orden terminó (ver resultado)
  estado           ENUM('pendiente','solventada','en_ruta','cerrada')
                   NOT NULL DEFAULT 'pendiente',
  -- Cómo terminó: entregada / devolucion / cancelada / nueva_novedad
  resultado        VARCHAR(40) NULL,
  -- 1 = no debe resolverse en automático: la gestiona un asesor.
  requiere_asesor  TINYINT(1) NOT NULL DEFAULT 0,
  motivo_asesor    VARCHAR(255) NULL,
  -- Última solución enviada
  tipo_solucion    VARCHAR(40) NULL,   -- volver_a_ofrecer / ajustar_recaudo / devolucion / externa
  solucion         VARCHAR(500) NULL,
  solventada_por   ENUM('asesor','ia','dropi') NULL,
  id_sub_usuario   BIGINT UNSIGNED NULL,
  detectada_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  solventada_at    DATETIME NULL,
  cerrada_at       DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                   ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_novedad_orden_numero (id_configuracion, dropi_order_id, numero),
  KEY idx_novedad_cfg_estado (id_configuracion, estado),
  KEY idx_novedad_cfg_asesor (id_configuracion, requiere_asesor, estado)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bitácora: todo lo que le pasó a cada novedad, en orden.
CREATE TABLE IF NOT EXISTS dropi_novedades_historial (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_novedad       BIGINT UNSIGNED NOT NULL,
  id_configuracion BIGINT UNSIGNED NOT NULL,
  dropi_order_id   BIGINT UNSIGNED NOT NULL,
  -- detectada / reincidencia / sugerencia_ia / solventada / devolucion /
  -- solventada_externa / en_ruta / cerrada / error_dropi
  evento           VARCHAR(40) NOT NULL,
  origen           ENUM('sistema','asesor','ia','dropi') NOT NULL DEFAULT 'sistema',
  id_sub_usuario   BIGINT UNSIGNED NULL,
  nombre_usuario   VARCHAR(150) NULL,
  descripcion      VARCHAR(500) NULL,
  -- Datos del evento (payload enviado a Dropi, respuesta de la IA…)
  detalle          JSON NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_hist_novedad (id_novedad),
  KEY idx_hist_orden (id_configuracion, dropi_order_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
