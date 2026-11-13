-- Combos vendidos por fuera de la plataforma (Combo Implementación $297):
-- meses gratis de un plan + complementos, activados por correo desde el
-- dashboard del super admin (services/combos.service.js).
--
-- YA APLICADA el 2026-11-12: el servicio la crea sola con CREATE TABLE IF NOT
-- EXISTS la primera vez que se usa. Este archivo queda como referencia.

CREATE TABLE IF NOT EXISTS combos_otorgados_chat_center (
  id INT AUTO_INCREMENT PRIMARY KEY,
  clave VARCHAR(40) NOT NULL,
  email VARCHAR(190) NOT NULL,
  id_usuario INT NULL,
  id_plan INT NOT NULL,
  meses INT NOT NULL,
  addons VARCHAR(190) NOT NULL DEFAULT '',
  monto DECIMAL(10,2) NOT NULL DEFAULT 0,
  -- pendiente_cuenta: el correo aún no se registra.
  -- pendiente_tarjeta: ya entra con plan y complemento; falta la tarjeta.
  -- aplicado: la suscripción de Stripe ya tiene la prueba gratis.
  estado ENUM('pendiente_cuenta','pendiente_tarjeta','aplicado','anulado') NOT NULL,
  -- sub_actualizada | sub_creada | checkout
  modo VARCHAR(30) NULL,
  stripe_subscription_id VARCHAR(80) NULL,
  gratis_hasta DATETIME NULL,
  nota VARCHAR(500) NULL,
  otorgado_por_id INT NULL,
  otorgado_por_nombre VARCHAR(120) NULL,
  aplicado_en DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_combo_email (email),
  KEY ix_combo_usuario (id_usuario, estado)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
