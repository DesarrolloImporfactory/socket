-- Lista de números que no reciben NINGÚN envío automático (2026-10-16).
--
-- La leen los crons del socket (masivos programados, remarketing,
-- recordatorios de citas, encuestas; ver src/utils/contactosBloqueados.js) y
-- los avisos automáticos de Imporsuit (cobranzas, campañas, automatizaciones;
-- Class/ContactosBloqueados.php en imporsutipro). Va por número, en todas las
-- líneas. Los asesores pueden seguir contestando a mano.
--
-- Se compara por los últimos 9 dígitos, igual que clientes_chat_center.celular_last9.
-- Alta y baja: php scripts/bloquear_contacto.php (imporsutipro).

CREATE TABLE IF NOT EXISTS `contactos_bloqueados` (
  `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `celular_last9` CHAR(9)      NOT NULL,
  `celular`       VARCHAR(20)  NOT NULL COMMENT 'el número como se dio, con código de país',
  `motivo`        VARCHAR(255) NULL,
  `bloqueado_por` VARCHAR(120) NULL,
  `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_contactos_bloqueados_last9` (`celular_last9`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
