-- ─────────────────────────────────────────────────────────────────────────────
-- Casos en Incidencias, parte 2: estado de tres valores (2026-09-28)
--
-- La vista de seguimiento (Oportunidades Comerciales / Escalamientos) muestra
-- cada caso como sin resolver, en espera o resuelto. El patrón de encuestas
-- (escalado_resuelto) solo tiene dos estados, así que se agrega estado_caso.
--
-- escalado_resuelto se mantiene y va sincronizado (1 = resuelto): es el que
-- usa la verificación de duplicados y el índice idx_caso_abierto, y un caso
-- en espera sigue abierto.
--
-- Requiere incidencias_casos_migration.sql. El código funciona sin esta
-- migración: los casos se ven como sin resolver / resuelto y no se puede
-- poner uno en espera.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE `incidencias_chat_center`
  ADD COLUMN `estado_caso` ENUM('sin_resolver','en_espera','resuelto') NULL DEFAULT NULL
    COMMENT 'Solo casos (tipo no NULL); NULL en las notas libres'
    AFTER `escalado_resuelto`,
  ADD COLUMN `espera_comentario` TEXT NULL DEFAULT NULL
    AFTER `estado_caso`,
  ADD COLUMN `espera_por` INT NULL DEFAULT NULL
    COMMENT 'id_sub_usuario que lo puso en espera'
    AFTER `espera_comentario`,
  ADD COLUMN `espera_fecha` DATETIME NULL DEFAULT NULL
    AFTER `espera_por`;

UPDATE `incidencias_chat_center`
   SET `estado_caso` = IF(`escalado_resuelto` = 1, 'resuelto', 'sin_resolver')
 WHERE `tipo` IS NOT NULL;
