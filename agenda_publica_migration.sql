-- 2026-11-04: agenda pública de implementación (/agendar) que reemplaza al
-- Calendly del modal «Agendar implementación gratis» y de «Agendar demo» en
-- /home. Ver src/services/agenda_publica.service.js.
--
-- La reserva cae en la agenda de ImporChat de la cuenta de soporte (hoy la
-- 265 «Soporte Importaciones Expertos», agenda 32), asignada a un asesor de la
-- lista agenda_publica_asesores (reparto: menos reservas en 30 días; empate →
-- el que lleva más tiempo sin recibir). El evento se crea en el Google
-- Calendar que ese asesor tiene vinculado a esa agenda, con Meet e invitación
-- por correo; el recordatorio por WhatsApp lo manda cron/aviso_calendarios.js
-- con la plantilla de la cuenta (configuraciones.template_notificar_calendario).
--
-- Las tablas las crea el servicio con CREATE TABLE IF NOT EXISTS al primer
-- uso y siembra la config (265/32) y el asesor inicial (2474, Juan Garzón);
-- este archivo es solo registro. Todo se edita desde el super admin
-- (/administrador-agenda).

-- 2026-11-04 (tarde): la agenda deja de ser solo de ImporChat. Cada cuenta
-- tiene la suya (/agendar/<slug>) y la configura desde Calendario → Agenda
-- pública; la principal (principal = 1) es la que abren el modal y /home.
-- ALTER aplicado ese día en la BD:
--   ALTER TABLE agenda_publica_config
--     MODIFY id INT NOT NULL AUTO_INCREMENT,
--     ADD COLUMN slug VARCHAR(80) NULL AFTER id_configuracion,
--     ADD COLUMN principal TINYINT NOT NULL DEFAULT 0 AFTER slug,
--     ADD COLUMN lugar VARCHAR(200) NULL AFTER descripcion,
--     ADD COLUMN plantilla_confirmacion VARCHAR(100) NULL AFTER lugar,
--     ADD UNIQUE KEY ux_configuracion (id_configuracion),
--     ADD UNIQUE KEY ux_slug (slug);
--   UPDATE agenda_publica_config SET slug = 'imporchat', principal = 1,
--     plantilla_confirmacion = 'reunion_agendada_imporchat',
--     hora_inicio = '08:00', hora_fin = '17:00' WHERE id_configuracion = 265;
--   ALTER TABLE agenda_publica_asesores
--     ADD COLUMN id_configuracion INT NOT NULL DEFAULT 0 AFTER id,
--     DROP INDEX ux_sub_usuario,
--     ADD UNIQUE KEY ux_cfg_sub (id_configuracion, id_sub_usuario);
--   UPDATE agenda_publica_asesores SET id_configuracion = 265 WHERE id_configuracion = 0;
--   ALTER TABLE agenda_publica_reservas
--     ADD COLUMN id_configuracion INT NOT NULL DEFAULT 0 AFTER id,
--     ADD KEY idx_cfg_inicio (id_configuracion, start_utc);
-- Horario 08:00–17:00: el último hueco TERMINA a la hora de cierre (con 60
-- min, el último empieza a las 16:00).

CREATE TABLE IF NOT EXISTS agenda_publica_config (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  activo TINYINT NOT NULL DEFAULT 1,
  id_configuracion INT NOT NULL,
  slug VARCHAR(80) NULL,                                  -- /agendar/<slug>
  principal TINYINT NOT NULL DEFAULT 0,                   -- la que abren modal y /home
  calendar_id BIGINT UNSIGNED NOT NULL,
  duracion_min SMALLINT NOT NULL DEFAULT 60,
  hora_inicio VARCHAR(5) NOT NULL DEFAULT '08:00',
  hora_fin VARCHAR(5) NOT NULL DEFAULT '17:00',
  dias VARCHAR(20) NOT NULL DEFAULT '1,2,3,4,5',          -- 0=domingo … 6=sábado
  anticipacion_horas SMALLINT NOT NULL DEFAULT 3,         -- no se ofrece nada antes de N horas
  dias_adelante SMALLINT NOT NULL DEFAULT 14,
  time_zone VARCHAR(64) NOT NULL DEFAULT 'America/Guayaquil',
  titulo VARCHAR(120) NOT NULL DEFAULT 'Cita',
  descripcion TEXT NULL,
  lugar VARCHAR(200) NULL,                                -- NULL = videollamada (Meet)
  plantilla_confirmacion VARCHAR(100) NULL,               -- plantilla Meta con 5 variables
  actualizado_por INT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY ux_configuracion (id_configuracion),
  UNIQUE KEY ux_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agenda_publica_asesores (
  id INT AUTO_INCREMENT PRIMARY KEY,
  id_configuracion INT NOT NULL DEFAULT 0,
  id_sub_usuario INT NOT NULL,
  activo TINYINT NOT NULL DEFAULT 1,
  orden INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY ux_cfg_sub (id_configuracion, id_sub_usuario)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agenda_publica_reservas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  id_configuracion INT NOT NULL DEFAULT 0,
  appointment_id BIGINT UNSIGNED NULL,
  id_sub_usuario INT NOT NULL,
  nombre VARCHAR(120) NOT NULL,
  email VARCHAR(160) NOT NULL,
  telefono VARCHAR(20) NOT NULL,
  origen VARCHAR(20) NOT NULL DEFAULT 'enlace',           -- modal | home | enlace
  id_usuario_cuenta INT NULL,                             -- cuenta de ImporChat si vino del modal
  id_cliente INT NULL,                                    -- contacto creado en la cuenta de soporte
  start_utc DATETIME NOT NULL,
  end_utc DATETIME NOT NULL,
  meeting_url VARCHAR(255) NULL,
  tz_cliente VARCHAR(64) NULL,
  google_ok TINYINT NULL,                                 -- 1 evento creado, 0 falló, NULL sin dato
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_asesor_fecha (id_sub_usuario, created_at),
  KEY idx_inicio (start_utc),
  KEY idx_cfg_inicio (id_configuracion, start_utc),
  KEY idx_cuenta (id_usuario_cuenta),
  KEY idx_telefono (telefono)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Recordatorio por WhatsApp de la cuenta 265 (una hora antes, plantilla
-- notificacion_calendario: nombre, reunión, hora, enlace). Aplicado el
-- 2026-11-04; antes la cuenta no tenía plantilla y el cron no mandaba nada.
-- UPDATE configuraciones
--    SET recordatorios_cita = '1',
--        template_notificar_calendario = 'notificacion_calendario',
--        recordatorios_cita_plantillas = '{"1":{"plantilla":"notificacion_calendario","body":["nombre","servicio","hora","ubicacion"],"buttons":[]}}'
--  WHERE id = 265;

-- Plantilla de confirmación inmediata por WhatsApp (creada en Meta el
-- 2026-11-04 en la WABA de la 265, id 1603998084267998, categoría UTILITY,
-- idioma es): reunion_agendada_imporchat con 5 variables (nombre, fecha,
-- hora + zona, enlace Meet, asesor). El servicio la manda al reservar; si Meta
-- aún no la aprueba, solo falla ese envío y queda el log. Para cambiarla,
-- PLANTILLA_CONFIRMACION en agenda_publica.service.js.

-- Origen en el calendario: appointments.service.listAppointments cruza con
-- agenda_publica_reservas.appointment_id y devuelve extendedProps.origen =
-- 'agenda_publica'; /calendario lo pinta con la etiqueta «Agenda web».

-- Reparto y resultados:
-- SELECT s.nombre_encargado, COUNT(*) reservas, SUM(ap.status='Cancelado') canceladas
--   FROM agenda_publica_reservas r
--   JOIN sub_usuarios_chat_center s ON s.id_sub_usuario = r.id_sub_usuario
--   LEFT JOIN appointments ap ON ap.id = r.appointment_id
--  WHERE r.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
--  GROUP BY s.nombre_encargado;

-- 2026-11-04 (tarde): cuenta de Google propia de la agenda. El admin elige
-- desde el panel un vínculo de users_google_accounts del calendario de la
-- agenda (p. ej. «comercial» de ImporChat, la de Calendly): el evento y la
-- invitación por correo salen de esa cuenta atienda quien atienda, el asesor
-- entra como invitado, y «Traer reuniones de Google» importa lo que ya existe
-- (últimos 90 días y futuro) como citas sin encargado, que la agenda pública
-- trata como ocupadas para todos. Ya aplicado en la BD.
-- ALTER TABLE agenda_publica_config ADD COLUMN google_link_id INT NULL AFTER plantilla_confirmacion;
