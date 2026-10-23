-- 2026-10-22: avisos al dueño sobre su cuenta de OpenAI que NO apagan el bot.
-- openai_activo=0 significa "bot mudo" y el front muestra "tu asistente está
-- en pausa". Hay casos donde el bot sigue respondiendo pero el dueño tiene que
-- hacer algo: su organización de OpenAI no está verificada para gpt-5 y el bot
-- contesta con el modelo de respaldo (gpt-4.1-mini). Ver utils/openia/avisoOpenAI.js
-- y el respaldo en kanban_ia.service (ejecutarConResponsesAPI).
--   openai_aviso_codigo  ORG_NO_VERIFICADA (único por ahora)
--   openai_aviso_msg     texto para el dueño
--   openai_aviso_at      cuándo se detectó
-- Se limpia cuando gpt-5 vuelve a responder, cuando el dueño pulsa "Ya
-- verifiqué" (comprobación en vivo) o cuando cambia la llave.
-- Pendiente de aplicar (misma BD dev/prod). Mientras no exista la columna, el
-- motor sigue respondiendo con el respaldo y solo deja el aviso en el log.
ALTER TABLE configuraciones
  ADD COLUMN openai_aviso_codigo VARCHAR(40)  NULL AFTER claude_cuenta_at,
  ADD COLUMN openai_aviso_msg    VARCHAR(500) NULL AFTER openai_aviso_codigo,
  ADD COLUMN openai_aviso_at     DATETIME     NULL AFTER openai_aviso_msg;
