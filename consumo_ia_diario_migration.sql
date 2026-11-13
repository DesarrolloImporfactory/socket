-- consumo_ia_diario_migration.sql — 13-11-2026 (Jeimy)
-- Resumen diario del consumo del asistente por cuenta. YA APLICADO en la base
-- (lo crea solo services/consumo_ia_diario.service.js con CREATE TABLE IF NOT
-- EXISTS); este archivo es registro.
--
-- El panel de consumo de IA leía de mensajes_clientes todos los salientes del
-- bot del período en cada entrada (cfg 285 a 90 días: 158 s en frío). Ahora los
-- días cerrados se guardan aquí y solo el día de hoy se lee en vivo.

-- Un cubo por cuenta + día + clase + modelo. Solo cantidades: el costo se
-- calcula al leer con los precios vigentes.
--   clase: ia | rmk | fijo | rapida        modelo '': sin desglose guardado
CREATE TABLE IF NOT EXISTS consumo_ia_diario (
  id_configuracion INT NOT NULL,
  dia DATE NOT NULL,
  clase VARCHAR(8) NOT NULL,
  modelo VARCHAR(80) NOT NULL DEFAULT '',
  n INT UNSIGNED NOT NULL DEFAULT 0,
  tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
  tk_entrada BIGINT UNSIGNED NOT NULL DEFAULT 0,
  tk_escrita BIGINT UNSIGNED NOT NULL DEFAULT 0,
  tk_cache BIGINT UNSIGNED NOT NULL DEFAULT 0,
  tk_salida BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id_configuracion, dia, clase, modelo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A qué clientes les escribió el asistente cada día (para «clientes atendidos»
-- de un período, que no se puede sumar por día).
CREATE TABLE IF NOT EXISTS consumo_ia_diario_clientes (
  id_configuracion INT NOT NULL,
  dia DATE NOT NULL,
  celular_recibe BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id_configuracion, dia, celular_recibe),
  KEY idx_cidc_cfg_cel (id_configuracion, celular_recibe, dia)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Qué rango continuo de días tiene resumido cada cuenta.
CREATE TABLE IF NOT EXISTS consumo_ia_diario_estado (
  id_configuracion INT NOT NULL PRIMARY KEY,
  desde DATE NOT NULL,
  hasta DATE NOT NULL,
  actualizado TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Para deshacer: CONSUMO_IA_DIARIO=0 en el .env (el panel vuelve a leer todo de
-- mensajes_clientes) y, si se quiere, DROP de las tres tablas.
