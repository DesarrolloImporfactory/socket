-- Recuperación de clientes (2026-10-12)
-- El servicio (src/services/recuperacion.service.js) ejecuta estos mismos
-- CREATE TABLE IF NOT EXISTS al primer uso, así que aplicar este archivo a
-- mano es opcional; queda como registro del esquema.

-- Subusuarios elegidos por el super admin para ver /recuperacion
-- (además de super_administrador y gestor_clientes, que entran siempre).
CREATE TABLE IF NOT EXISTS recuperacion_asesores_chat_center (
  id INT AUTO_INCREMENT PRIMARY KEY,
  id_sub_usuario INT NOT NULL,
  email VARCHAR(190) NULL,
  nombre VARCHAR(190) NULL,
  activo TINYINT(1) NOT NULL DEFAULT 1,
  agregado_por INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sub (id_sub_usuario)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Un caso por cliente en riesgo. Lo abre el sistema al entrar a una cohorte
-- y lo cierra solo cuando sale (recuperado si quedó activo, perdido si no).
-- monto_plan = precio del plan al abrir: lo que estaba en juego.
CREATE TABLE IF NOT EXISTS recuperacion_casos_chat_center (
  id_caso INT AUTO_INCREMENT PRIMARY KEY,
  id_usuario INT NOT NULL,
  cohorte VARCHAR(40) NOT NULL,
  estado ENUM('abierto','recuperado','perdido','descartado') NOT NULL DEFAULT 'abierto',
  monto_plan DECIMAL(10,2) NULL,
  asignado_a_id INT NULL,
  asignado_a_nombre VARCHAR(190) NULL,
  asignado_en DATETIME NULL,
  abierto_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cerrado_en DATETIME NULL,
  cerrado_por VARCHAR(190) NULL,
  cierre_motivo VARCHAR(255) NULL,
  -- En qué quedó el cliente al cerrar: pago | prueba | activo_otro | cancelado |
  -- vencido | sin_plan | manual | sin_cuenta. Mide "cuántos llegaron a pagar".
  estado_final VARCHAR(30) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_usuario_estado (id_usuario, estado),
  KEY ix_estado_cerrado (estado, cerrado_en),
  KEY ix_asignado (asignado_a_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Asesores iniciales (pedido del 2026-10-12): los dos de la conexión "expertos".
-- INSERT IGNORE INTO recuperacion_asesores_chat_center (id_sub_usuario, email, nombre)
-- SELECT id_sub_usuario, email, nombre_encargado FROM sub_usuarios_chat_center
--  WHERE LOWER(email) IN ('j.chico@clubdeimportadoresoficial.com', 'juanfegarzon@imporchat.com');

-- ── Automatizaciones (12-10-2026, tarde) ─────────────────────────────────
-- Secuencias de plantillas desde la conexión de Expertos. También las crea
-- el servicio (recuperacion_automatizaciones.service.js) y siembra las 4
-- secuencias por defecto APAGADAS (activa = 0).
CREATE TABLE IF NOT EXISTS recuperacion_automatizaciones (
  id INT AUTO_INCREMENT PRIMARY KEY,
  clave VARCHAR(40) NOT NULL,
  nombre VARCHAR(120) NOT NULL,
  descripcion TEXT NULL,
  cohortes JSON NULL,
  activa TINYINT(1) NOT NULL DEFAULT 0,
  inicia_en DATETIME NULL,
  solo_sin_respuesta TINYINT(1) NOT NULL DEFAULT 1,
  ciclico TINYINT(1) NOT NULL DEFAULT 0,
  intervalo_dias INT NOT NULL DEFAULT 3,
  max_por_dia INT NOT NULL DEFAULT 100,
  incluir_numero_conexion TINYINT(1) NOT NULL DEFAULT 0,
  stripe_coupon_id VARCHAR(60) NOT NULL DEFAULT 'RECUPERACION10',
  actualizado_por VARCHAR(190) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_clave (clave)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS recuperacion_automatizacion_pasos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  id_automatizacion INT NOT NULL,
  orden INT NOT NULL,
  titulo VARCHAR(120) NOT NULL,
  texto_sugerido TEXT NULL,
  nombre_template VARCHAR(120) NULL,
  language_code VARCHAR(10) NOT NULL DEFAULT 'es',
  parametros JSON NULL,
  espera_dias INT NOT NULL DEFAULT 3,
  aplica_descuento TINYINT(1) NOT NULL DEFAULT 0,
  activo TINYINT(1) NOT NULL DEFAULT 1,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_auto_orden (id_automatizacion, orden)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Bitácora: un renglón por envío (encolado en template_envios_programados) u omisión.
CREATE TABLE IF NOT EXISTS recuperacion_automatizacion_envios (
  id INT AUTO_INCREMENT PRIMARY KEY,
  id_automatizacion INT NOT NULL,
  id_paso INT NOT NULL,
  orden INT NOT NULL,
  id_usuario INT NOT NULL,
  id_caso INT NULL,
  telefono VARCHAR(30) NULL,
  id_cliente_chat INT NULL,
  id_envio_programado INT NULL,
  nombre_template VARCHAR(120) NULL,
  parametros_resueltos JSON NULL,
  origen VARCHAR(20) NOT NULL DEFAULT 'cron',
  estado ENUM('encolado','enviado','error','omitido') NOT NULL DEFAULT 'encolado',
  detalle VARCHAR(255) NULL,
  enviado_en DATETIME NULL,
  respondio_en DATETIME NULL,
  descuento_aplicado TINYINT(1) NOT NULL DEFAULT 0,
  descuento_detalle VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_auto_usuario (id_automatizacion, id_usuario, created_at),
  KEY ix_usuario (id_usuario, created_at),
  KEY ix_envio_prog (id_envio_programado)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
