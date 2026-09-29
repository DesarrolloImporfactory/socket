-- ─────────────────────────────────────────────────────────────────────────────
-- Límite de tiempo de respuesta configurable por conexión (2026-09-29)
--
-- Pedido «gestión de incidencias», parte 4: el tablero marca el peor tiempo
-- de respuesta cuando pasa del límite (5 minutos en la reunión del 24-sep).
-- Hasta hoy el semáforo 5/10 estaba escrito a mano en
-- atencion_asesores.service.js (UMBRALES_MIN). Ahora se guarda junto al
-- horario de atención de cada conexión y se edita en el mismo lugar.
--
-- Las columnas NO van en models/atencion_horarios.model.js a propósito: si
-- estuvieran, db.sync no las crea en una tabla que ya existe y cada lectura
-- del horario fallaría hasta correr esto. atencion_horario.service.js las lee
-- aparte y, sin ellas, usa 5 / 10.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE `atencion_horarios`
  ADD COLUMN `limite_advertencia_min` SMALLINT UNSIGNED NOT NULL DEFAULT 5
    COMMENT 'Desde aquí la espera se marca (amarillo/rojo en el tablero)'
    AFTER `dias`,
  ADD COLUMN `limite_critico_min` SMALLINT UNSIGNED NOT NULL DEFAULT 10
    COMMENT 'Desde aquí la espera es crítica'
    AFTER `limite_advertencia_min`;
