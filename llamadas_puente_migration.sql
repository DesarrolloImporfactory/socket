-- 2026-10-15: llamadas de WhatsApp desde otra conexión + nombre de presentación.
-- Un número en coexistencia (app + API) no puede llamar: Meta exige solo Cloud
-- API. Esa conexión puede llamar DESDE otra de la misma cuenta.
--   id_configuracion_llamadas  conexión (mismo id_usuario, llamadas encendidas)
--                              por la que salen el permiso y la llamada.
--                              NULL = su propio número.
--   nombre_llamadas            nombre con el que se presenta en el permiso de
--                              llamada. NULL = nombre de WhatsApp del número.
-- El código tolera que aún no esté aplicada (se comporta como antes).
-- Pendiente de aplicar (misma BD dev/prod).
ALTER TABLE configuraciones
  ADD COLUMN id_configuracion_llamadas INT NULL DEFAULT NULL,
  ADD COLUMN nombre_llamadas VARCHAR(100) NULL DEFAULT NULL,
  ADD INDEX idx_cfg_llamadas_puente (id_configuracion_llamadas);
