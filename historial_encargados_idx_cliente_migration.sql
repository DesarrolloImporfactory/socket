-- ─────────────────────────────────────────────────────────────────────────────
-- Índice por chat en historial_encargados
--
-- Contexto: la tabla solo tenía PRIMARY(id) e
-- idx_he_fecha_encargado(fecha_registro, id_encargado_nuevo,
-- id_cliente_chat_center). Toda búsqueda por chat
-- (WHERE id_cliente_chat_center = ?) recorría la tabla completa
-- (~194.000 filas el 2026-09-22):
--   - GET /departamentos_chat_center/historial-encargados/:id (el panel
--     «Historial de encargados» del chat);
--   - el cron liberarChatsSinRespuesta y el round robin al reabrir
--     (vendedorExcluido en services/liberar_sin_respuesta.service.js).
-- Medido: una subconsulta por chat para 815 chats de la 242 tardó 46 s.
--
-- (id_cliente_chat_center, id) sirve tanto para filtrar por chat como para
-- "el último movimiento" (ORDER BY id DESC LIMIT 1).
--
-- InnoDB lo crea en línea (sin bloquear escrituras) en MySQL 8.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE `historial_encargados`
  ADD INDEX `idx_he_cliente_id` (`id_cliente_chat_center`, `id`),
  ALGORITHM = INPLACE, LOCK = NONE;
