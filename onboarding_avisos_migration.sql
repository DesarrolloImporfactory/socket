-- 2026-10-22: invitación a agendar la implementación (Calendly comercial) para
-- cuentas que no han empezado: una conexión como máximo y ninguna conectada
-- (WhatsApp, Messenger ni Instagram). Ver src/services/onboarding.service.js.
-- La respuesta se guarda por CUENTA, no por navegador:
--   agendado    pulsó «Agendar» (abrió la agenda; no sabemos si reservó) →
--               si a los 7 días sigue sin conectar nada, vuelve a salir con
--               otro texto
--   descartado  pulsó «No volver a mostrar» → no se vuelve a mostrar
--   pospuesto   pulsó «No por ahora» → vuelve a salir a los 3 días
--   pendiente   se mostró y cerró sin responder (la X solo oculta en la
--               sesión del navegador)
-- Apagar el modal para todos (agenda llena) o cambiar el enlace de la agenda:
-- constantes MODAL_ACTIVO y CALENDLY_IMPLEMENTACION al inicio de
-- src/services/onboarding.service.js (en código a propósito, no en .env).
-- Reiniciar a mano una cuenta para que vuelva a verlo:
--   UPDATE onboarding_avisos_chat_center SET estado='pendiente', pospuesto_hasta=NULL WHERE id_usuario = <id>;
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
