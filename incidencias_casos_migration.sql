-- ─────────────────────────────────────────────────────────────────────────────
-- Casos en Incidencias: «Escalar» y «Oportunidad Comercial» (2026-09-28)
--
-- Contexto: la sección Incidencias del chat guardaba solo texto libre. El
-- asesor de soporte (línea 265) escribía la incidencia y después avisaba por
-- WhatsApp a quien la tenía que resolver. Ahora puede marcar la incidencia
-- como un CASO con tipo, destinatario y estado.
--
-- 1. incidencias_chat_center gana tipo / destinatario / estado de resolución.
--    El estado copia el patrón de encuestas_respuestas (escalado_resuelto +
--    resolucion_comentario/por/fecha). tipo NULL = nota libre, como hasta hoy.
--
-- 2. incidencias_casos_destinatarios dice, por conexión, a quién le llega cada
--    tipo de caso. Es también el gate: una conexión sin filas no ve los botones,
--    y un tipo sin fila no muestra su botón. Así se habilita otra conexión o se
--    cambia el responsable sin tocar código.
--
-- El código funciona con o sin esta migración: sin ella, Incidencias sigue
-- como antes y los botones no aparecen.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE `incidencias_chat_center`
  ADD COLUMN `tipo` VARCHAR(20) NULL DEFAULT NULL
    COMMENT 'NULL = nota libre, o escalamiento | oportunidad'
    AFTER `descripcion`,
  ADD COLUMN `id_sub_usuario_destino` INT NULL DEFAULT NULL
    COMMENT 'A quién le llega el caso (sub_usuarios_chat_center)'
    AFTER `tipo`,
  ADD COLUMN `escalado_resuelto` TINYINT(1) NOT NULL DEFAULT 0
    AFTER `id_sub_usuario_destino`,
  ADD COLUMN `resolucion_comentario` TEXT NULL DEFAULT NULL
    AFTER `escalado_resuelto`,
  ADD COLUMN `resolucion_por` INT NULL DEFAULT NULL
    COMMENT 'id_sub_usuario que lo resolvió'
    AFTER `resolucion_comentario`,
  ADD COLUMN `resolucion_fecha` DATETIME NULL DEFAULT NULL
    AFTER `resolucion_por`,
  ADD KEY `idx_caso_abierto` (`id_cliente_chat_center`, `tipo`, `escalado_resuelto`),
  ADD KEY `idx_caso_destino` (`id_sub_usuario_destino`, `escalado_resuelto`);

CREATE TABLE IF NOT EXISTS `incidencias_casos_destinatarios` (
  `id_configuracion` INT NOT NULL,
  `tipo`             VARCHAR(20) NOT NULL COMMENT 'escalamiento | oportunidad',
  `id_sub_usuario`   INT NOT NULL,
  `created_at`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id_configuracion`, `tipo`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Línea 265 (Soporte Importaciones Expertos): Oportunidad Comercial → Johan
-- Bonilla (377). El responsable de «Escalar» está pendiente de confirmar con
-- Daniel; cuando se sepa:
--   INSERT INTO incidencias_casos_destinatarios (id_configuracion, tipo, id_sub_usuario)
--   VALUES (265, 'escalamiento', <id_sub_usuario>);
INSERT IGNORE INTO `incidencias_casos_destinatarios` (`id_configuracion`, `tipo`, `id_sub_usuario`)
VALUES (265, 'oportunidad', 377);
