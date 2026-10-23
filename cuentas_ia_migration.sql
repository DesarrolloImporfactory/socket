-- 2026-10-22: cuenta dueña de cada llave de IA, guardada en la BD.
-- Hasta ahora la vista de Asistentes preguntaba en vivo a OpenAI (/v1/me) y a
-- Anthropic (/v1/organizations/me) cada vez que se abría, y para saber "en qué
-- conexión está la llave del correo X" había que recorrer las 740 llaves con un
-- script. La cuenta de una llave no cambia mientras la llave sea la misma:
-- se guarda al cargar la llave y solo se vuelve a consultar al cambiarla
-- (ver src/utils/cuentaIA.js).
--   openai_cuenta     JSON {nombre, email, organizacion, organizacion_id,
--                     organizacion_personal, proyecto, proyecto_id}
--   openai_cuenta_at  cuándo se consultó. NULL en cuenta con fecha = falló
--                     (llave revocada, red); se reintenta al día.
--   claude_cuenta     JSON {organizacion, organizacion_id, workspace_id}.
--                     Anthropic no entrega el correo con una llave normal.
--   claude_cuenta_at  idem.
-- Pendiente de aplicar (misma BD dev/prod). Después de aplicar, llenar las
-- llaves existentes con:  node scripts/poblarCuentasIA.js --aplicar
ALTER TABLE configuraciones
  ADD COLUMN openai_cuenta    JSON     NULL AFTER api_key_claude,
  ADD COLUMN openai_cuenta_at DATETIME NULL AFTER openai_cuenta,
  ADD COLUMN claude_cuenta    JSON     NULL AFTER openai_cuenta_at,
  ADD COLUMN claude_cuenta_at DATETIME NULL AFTER claude_cuenta;

-- Buscar en qué conexión está una llave por correo (sin tocar OpenAI):
-- SELECT id, nombre_configuracion, openai_cuenta->>'$.email' AS correo
--   FROM configuraciones
--  WHERE openai_cuenta->>'$.email' = 'correo@dominio.com';
