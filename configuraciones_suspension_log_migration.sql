-- ─────────────────────────────────────────────────────────────────────────────
-- Auditoría de suspensión / reactivación de conexiones (`configuraciones`)
--
-- Contexto: la columna `configuraciones.suspendido` guarda el estado pero no
-- deja rastro de QUIÉN lo cambió. Cuando un cliente dice que su conexión "se
-- suspendió sola" no había forma de contradecirlo: lo único que quedaba era
-- `suspended_at` (la fecha) y `suspended_reason`, que solo se llenaba en el
-- downgrade de Stripe.
--
-- Caso que originó esto (2026-08-28): configuración 320 "Importaverimax"
-- (usuario 649) con `suspended_at = 2026-08-27 20:39:43` y `suspended_reason`
-- NULL. Al no ser 'downgrade' se descartó el webhook de Stripe, pero no se
-- pudo saber qué sesión llamó a `toggle_suspension`.
--
-- Esta tabla registra cada cambio que pasa por la aplicación, con el actor
-- (subusuario + cuenta + IP) o el marcador de sistema cuando lo hace el
-- webhook de Stripe.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `configuraciones_suspension_log` (
  `id` BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,

  `id_configuracion` BIGINT(20) UNSIGNED NOT NULL
    COMMENT 'Conexion afectada (configuraciones.id)',
  `id_usuario` BIGINT(20) UNSIGNED NULL
    COMMENT 'Dueno de la conexion (configuraciones.id_usuario)',

  `accion` ENUM('suspender','reactivar') NOT NULL,

  `origen` ENUM('panel','stripe_downgrade','otro') NOT NULL DEFAULT 'otro'
    COMMENT 'panel = boton Eliminar conexion; stripe_downgrade = webhook al aplicar el downgrade',
  `motivo` VARCHAR(50) NULL
    COMMENT 'Mismo valor que se escribe en configuraciones.suspended_reason',

  `actor_tipo` ENUM('sub_usuario','sistema') NOT NULL,
  `actor_id_sub_usuario` BIGINT(20) NULL,
  `actor_id_usuario` BIGINT(20) UNSIGNED NULL
    COMMENT 'Cuenta del actor. Si no coincide con id_usuario lo suspendio alguien de OTRA cuenta',
  `actor_usuario` VARCHAR(255) NULL,
  `actor_email` VARCHAR(255) NULL,
  `actor_rol` VARCHAR(255) NULL,

  `ip` VARCHAR(45) NULL
    COMMENT 'Primer valor de x-forwarded-for (no hay trust proxy en app.js)',
  `user_agent` VARCHAR(255) NULL,
  `detalle` VARCHAR(255) NULL
    COMMENT 'Contexto extra: id de suscripcion de Stripe, plan destino, etc.',

  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (`id`),
  KEY `ix_csl_config` (`id_configuracion`, `created_at`),
  KEY `ix_csl_usuario` (`id_usuario`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ─────────────────────────────────────────────────────────────────────────────
-- OPCIONAL — trigger de red de seguridad. NO se aplica por defecto.
--
-- Lo de arriba solo ve lo que pasa por la API. Un UPDATE hecho a mano en la BD
-- (por ejemplo el `SET suspendido = 0` con el que reactivamos las conexiones)
-- o desde cualquier otro sistema que toque esta BD no queda registrado. Este
-- trigger cierra ese hueco: cualquier cambio del flag deja fila, y si esa fila
-- no tiene un registro de la app en el mismo segundo, el cambio vino de fuera.
--
-- ⚠️ Antes de aplicarlo: en esta BD ya hay una vista y varios triggers cuyo
-- DEFINER es `shadow`@`%`. Si ese usuario se borra, todo lo que dependa de él
-- revienta con error 1449. Crea este trigger con un DEFINER que no se vaya a
-- eliminar (el usuario de la aplicación) y verifica con
--   SELECT TRIGGER_NAME, DEFINER FROM information_schema.TRIGGERS;
-- ─────────────────────────────────────────────────────────────────────────────

-- DELIMITER $$
-- CREATE DEFINER = CURRENT_USER TRIGGER `trg_configuraciones_susp_au`
-- AFTER UPDATE ON `configuraciones`
-- FOR EACH ROW
-- BEGIN
--   IF NOT (OLD.suspendido <=> NEW.suspendido) THEN
--     INSERT INTO `configuraciones_suspension_log`
--       (id_configuracion, id_usuario, accion, origen, motivo,
--        actor_tipo, detalle, created_at)
--     VALUES
--       (NEW.id, NEW.id_usuario,
--        IF(NEW.suspendido = 1, 'suspender', 'reactivar'),
--        'otro', NEW.suspended_reason,
--        'sistema',
--        CONCAT('trigger BD · sesion MySQL: ', USER()),
--        NOW());
--   END IF;
-- END$$
-- DELIMITER ;
