-- ════════════════════════════════════════════════════════════
-- Elimina configuraciones.api_key_gemini
--
-- La columna guardaba la key de Gemini de PLATAFORMA como DEFAULT: cada config
-- nueva nacía con una copia cifrada (1.106 filas el 2026-09-21). Insta Landing
-- está dada de baja y el controller ya lee la key de GEMINI_API_KEY (.env).
--
-- ⚠ ORDEN OBLIGATORIO — desarrollo y producción comparten esta base.
-- Correr SOLO cuando el código sin `api_key_gemini` en
-- src/models/configuraciones.model.js esté desplegado en TODOS los entornos
-- (caja de dev + producción vía Impormerge). Con código viejo corriendo, cada
-- Configuraciones.findOne() pide la columna y revienta con "Unknown column":
-- se cae el webhook de WhatsApp completo, no solo Gemini.
--
-- Antes de borrar: si la key de Gemini ya no se usa, revocarla también en
-- Google AI Studio. Borrar la columna no la invalida, y quedó en dumps/backups.
-- ════════════════════════════════════════════════════════════

ALTER TABLE configuraciones DROP COLUMN api_key_gemini;
