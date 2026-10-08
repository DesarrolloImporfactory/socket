-- 2026-10-08: saldo telefónico COMPARTIDO entre conexiones del mismo dueño.
-- Un usuario con varias conexiones (p. ej. Imporfactory y Ventas + Expertos)
-- no tiene que repartir el saldo entre ellas: una conexión puede "colgarse"
-- del saldo de otra conexión de la misma cuenta (id_usuario).
--   id_configuracion_saldo  conexión titular cuyo saldo y precio por minuto
--                           usa esta conexión. NULL = saldo propio.
-- La conexión que comparte mantiene su propio activo/caller_id; su
-- saldo_centavos queda en 0 (las recargas y consumos van al titular, con
-- "· conexión #N" en el detalle del movimiento). Solo un nivel: una titular
-- no puede a su vez compartir de otra.
-- Pendiente de aplicar (misma BD dev/prod).
ALTER TABLE telefonia_cuentas ADD COLUMN id_configuracion_saldo INT NULL AFTER id_configuracion;
ALTER TABLE telefonia_cuentas ADD INDEX idx_tel_cuentas_saldo (id_configuracion_saldo);
