-- Llaves del asistente flotante que paga la plataforma (/administrador-asistente).
-- NO hace falta correrla a mano: services/asistente_plataforma.service.js crea
-- las dos tablas la primera vez que se usa. Queda aquí como referencia.

CREATE TABLE IF NOT EXISTS asistente_plataforma_config (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  proveedor ENUM('openai','claude') NOT NULL DEFAULT 'openai',
  modelo_claude VARCHAR(60) NULL,
  modelo_openai VARCHAR(60) NULL,
  tope_diario INT NOT NULL DEFAULT 40,
  api_key_openai TEXT NULL,          -- cifrada (utils/cryptoToken)
  api_key_claude TEXT NULL,          -- cifrada (utils/cryptoToken)
  openai_cuenta TEXT NULL,           -- JSON: a qué cuenta pertenece la llave
  claude_cuenta TEXT NULL,
  openai_error_codigo VARCHAR(20) NULL,  -- SIN_SALDO | KEY_INVALIDA | RATE_LIMIT | ERROR
  openai_error_msg VARCHAR(300) NULL,
  openai_error_at DATETIME NULL,
  claude_error_codigo VARCHAR(20) NULL,
  claude_error_msg VARCHAR(300) NULL,
  claude_error_at DATETIME NULL,
  updated_by VARCHAR(255) NULL,
  updated_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO asistente_plataforma_config (id, proveedor) VALUES (1, 'openai');

CREATE TABLE IF NOT EXISTS asistente_plataforma_uso (
  sujeto VARCHAR(40) NOT NULL,       -- cfg:<id_configuracion> o usr:<id_usuario>
  fecha DATE NOT NULL,               -- día en hora de Ecuador
  origen VARCHAR(12) NOT NULL,       -- propia | openai | claude | env
  preguntas INT NOT NULL DEFAULT 0,
  tokens BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (sujeto, fecha, origen),
  KEY ix_apu_fecha (fecha)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
