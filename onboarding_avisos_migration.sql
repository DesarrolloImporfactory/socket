-- 2026-10-22: invitación a agendar la implementación (Calendly comercial) para
-- cuentas que no han empezado: una conexión como máximo y ninguna conectada
-- (WhatsApp, Messenger ni Instagram). Ver src/services/onboarding.service.js.
-- La respuesta se guarda por CUENTA, no por navegador:
--   agendado    pulsó «Agendar» → no se vuelve a mostrar
--   descartado  pulsó «No volver a mostrar» → no se vuelve a mostrar
--   pospuesto   pulsó «No por ahora» → vuelve a salir a los 3 días
--   pendiente   se mostró y cerró sin responder
-- La tabla la crea el servicio con CREATE TABLE IF NOT EXISTS al primer uso;
-- este archivo es solo registro.
CREATE TABLE IF NOT EXISTS onboarding_avisos_chat_center (
  id INT AUTO_INCREMENT PRIMARY KEY,
  id_usuario INT NOT NULL,
  aviso VARCHAR(40) NOT NULL,
  estado ENUM('pendiente','pospuesto','agendado','descartado') NOT NULL DEFAULT 'pendiente',
  veces_mostrado INT NOT NULL DEFAULT 0,
  pospuesto_hasta DATETIME NULL,
  respondido_por INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY ux_usuario_aviso (id_usuario, aviso)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Cuántos agendaron / pospusieron / descartaron:
-- SELECT estado, COUNT(*) FROM onboarding_avisos_chat_center WHERE aviso = 'agendar_implementacion' GROUP BY estado;
