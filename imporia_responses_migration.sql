-- ═══════════════════════════════════════════════════════════════
-- imporia_responses_migration.sql
--
-- Mueve ImporIA de la Assistants API a la Responses API.
--
-- ⚠️ SE APLICA SOBRE LA BD DE IMPORSUIT (la de `DB_*` en el .env del socket,
--    `db_2` en el código), que es donde ya viven threads_imporsuit y
--    mensajes_gpt_imporsuit. NO sobre la BD de ChatCenter.
--
-- POR QUÉ
--
-- ImporIA quedó fuera de la migración de agosto y siguió corriendo contra
-- threads/runs. El 2026-08-26 OpenAI apagó la Assistants API y desde ese día
-- no contesta: 69 mensajes de usuarios sin una sola respuesta, y los dos
-- assistants (asst_UVA… EC, asst_shn… MX) devuelven 404.
--
-- Con Assistants, el prompt y el modelo vivían DENTRO del assistant en OpenAI.
-- Con Responses tienen que vivir acá. Eso es `imporia_prompts`.
--
-- Con Assistants, el hilo de la conversación era `threads_imporsuit.id_thread_chat`.
-- Con Responses es `previous_response_id`. Eso es la columna `response_id`.
--
-- Se aplica a mano, una sola vez (misma convención que el resto de
-- *_migration.sql del repo).
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- 1. Prompts por país
--
-- Reemplaza a los objetos assistant borrados. Un registro por país: hoy EC y
-- MX, que son los dos que el controller tenía quemados.
--
-- vector_store_id: los vector stores NO murieron con la Assistants API —viven
-- en su propio endpoint y la Responses API los consume igual vía file_search—,
-- así que se reusan tal cual sin volver a subir archivos.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `imporia_prompts` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `pais` CHAR(2) NOT NULL,
  `nombre` VARCHAR(100) NOT NULL DEFAULT '',
  `instrucciones` MEDIUMTEXT NOT NULL,
  `modelo` VARCHAR(50) NOT NULL DEFAULT 'gpt-4.1-mini',
  `max_tokens` INT UNSIGNED NOT NULL DEFAULT 800,
  `vector_store_id` VARCHAR(64) DEFAULT NULL,
  `activo` TINYINT(1) NOT NULL DEFAULT 1,
  `creado_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `actualizado_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_imporia_prompts_pais` (`pais`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- 2. La memoria de la conversación
--
-- `id_thread_chat` se deja en su sitio a propósito: son 1.065 conversaciones y
-- ese id es el único rastro de dónde estuvo el historial viejo. No estorba.
--
-- `response_at` existe para poder cortar cadenas viejas: OpenAI retiene las
-- respuestas ~30 días, así que un previous_response_id de hace dos meses da
-- 404. Se corta a los 14 días, igual que hace ChatCenter en
-- obtener_response.service.js.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE `threads_imporsuit`
  ADD COLUMN `response_id` VARCHAR(80) DEFAULT NULL AFTER `id_thread_chat`,
  ADD COLUMN `response_at` DATETIME DEFAULT NULL AFTER `response_id`;

-- ─────────────────────────────────────────────────────────────
-- 3. Los prompts
--
-- ⚠️ FALTA PEGAR EL TEXTO DE LOS DOS PROMPTS.
--
-- Los originales vivían dentro de los assistants y ya no se pueden leer (404).
-- Reemplaza PEGAR_PROMPT_EC y PEGAR_PROMPT_MX por el texto real, escapando las
-- comillas simples ('  →  \').
--
-- vector_store_id:
--   MX  vs_69864c99f0348191b4c2dc9bf73962db  ← "Vector store for Asistente GPT
--       IMPORSUIT MX", 2 archivos, 4.1 MB, activo hasta el 2026-08-25.
--   EC  NULL  ← en la cuenta no quedó ningún vector store de EC. Si aparece
--       (o si se vuelven a subir los archivos), se pone acá y el servicio lo
--       toma solo, sin tocar código.
--
-- modelo: gpt-4.1-mini es el default que usaba el resto del sistema para estos
-- asistentes. Si sabes con cuál corrían, cámbialo acá.
-- ─────────────────────────────────────────────────────────────
INSERT INTO `imporia_prompts`
  (`pais`, `nombre`, `instrucciones`, `modelo`, `max_tokens`, `vector_store_id`)
VALUES
  ('EC', 'Asistente GPT IMPORSUIT EC', 'PEGAR_PROMPT_EC', 'gpt-4.1-mini', 800, NULL),
  ('MX', 'Asistente GPT IMPORSUIT MX', 'PEGAR_PROMPT_MX', 'gpt-4.1-mini', 800, 'vs_69864c99f0348191b4c2dc9bf73962db')
ON DUPLICATE KEY UPDATE
  `instrucciones`   = VALUES(`instrucciones`),
  `modelo`          = VALUES(`modelo`),
  `max_tokens`      = VALUES(`max_tokens`),
  `vector_store_id` = VALUES(`vector_store_id`);

-- ─────────────────────────────────────────────────────────────
-- 4. Comprobación
-- ─────────────────────────────────────────────────────────────
-- SELECT pais, modelo, max_tokens, vector_store_id, CHAR_LENGTH(instrucciones) AS prompt_chars
--   FROM imporia_prompts;
-- SHOW COLUMNS FROM threads_imporsuit LIKE 'response%';
