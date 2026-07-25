-- ia_split_mensajes_migration.sql
-- Permite que la respuesta de la IA kanban se envíe en 2-3 mensajes naturales
-- en vez de un solo bloque de texto.
--
-- Va ENCENDIDO por defecto: el comportamiento humano (responder en varios
-- mensajes) es el deseado, y cada conexión puede apagarlo desde el panel
-- (tab Asistente del kanban) si prefiere el mensaje único.

ALTER TABLE `configuraciones`
  ADD COLUMN `ia_split_mensajes` TINYINT(1) NOT NULL DEFAULT 1
  COMMENT 'Divide la respuesta de la IA en varios mensajes (0=off, 1=on)'
  AFTER `api_key_openai`;

-- Encender en todas las conexiones existentes
UPDATE `configuraciones` SET `ia_split_mensajes` = 1;
