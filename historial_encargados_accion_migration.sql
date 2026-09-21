-- ─────────────────────────────────────────────────────────────────────────────
-- Quién hizo cada cambio de encargado (historial_encargados)
--
-- Contexto: el historial guardaba de quién a quién pasó el chat
-- (id_encargado_anterior → id_encargado_nuevo) pero no quién hizo la acción.
-- Caso del 2026-09-21, config 242, chat 676233: Diego Varela transfirió un
-- chat que era de Kathy. El historial decía "Kathy → Adrian" y la notificación
-- "Diego Varela te transfirió": las dos cosas eran ciertas, pero en ningún
-- lado quedaba registrado que el autor había sido Diego.
--
-- La columna la llena transferirChat / asignar_encargado con la sesión real
-- (req.sessionUser). NULL = fila anterior a esta migración, o una asignación
-- automática (round robin) donde no hay una persona detrás.
--
-- El código funciona con o sin la columna: si no existe, el historial se
-- sigue guardando como antes, solo que sin el autor.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE `historial_encargados`
  ADD COLUMN `id_sub_usuario_accion` INT NULL DEFAULT NULL
    COMMENT 'Sub-usuario que hizo la accion; NULL = automatico o historico'
    AFTER `id_encargado_nuevo`;
