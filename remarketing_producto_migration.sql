-- Remarketing por producto (menú Productos → Remarketing).
--
-- Configuración por producto del recordatorio con botones («⭐ Ver opiniones»,
-- «✅ Sí, lo quiero»), lo que se manda al tocar cada botón (bloques) y los
-- eventos para medirlo. Sale solo dentro de la ventana de 24 h (texto +
-- botones interactivos, sin plantilla de Meta); fuera de ventana el cron cae
-- a la plantilla de la columna como hasta ahora. Aplicar a mano; misma BD
-- dev y prod.

CREATE TABLE IF NOT EXISTS remarketing_producto (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_configuracion INT NOT NULL,
  id_producto INT NOT NULL,
  activo TINYINT(1) NOT NULL DEFAULT 1,
  pasos JSON NOT NULL COMMENT '[{minutos, mensaje, con_imagen, con_botones}] máx 3',
  imagen_url VARCHAR(1000) NULL COMMENT 'cabecera del mensaje; null = foto del producto',
  botones JSON NOT NULL COMMENT '[{clave, titulo (≤20), accion: bloque|cerrar|ia}] máx 3',
  bloques JSON NULL COMMENT '{clave: {items:[{tipo,url,texto,retraso_seg}], remate}}',
  estado_destino VARCHAR(100) NULL COMMENT 'columna a la que se mueve al enviar; null = se queda',
  creado_por INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rmkp_cfg_producto (id_configuracion, id_producto)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS remarketing_producto_eventos (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_configuracion INT NOT NULL,
  id_producto INT NOT NULL,
  id_remarketing_producto INT UNSIGNED NOT NULL,
  id_cliente_chat_center INT NOT NULL,
  id_pendiente INT NULL COMMENT 'remarketing_pendientes.id',
  paso TINYINT NULL,
  evento VARCHAR(30) NOT NULL COMMENT 'enviado | respondio | boton | bloque | cierre_ia | cierre_flujo | fallo',
  detalle VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_rmkp_ev_cfg_prod_fecha (id_configuracion, id_producto, created_at),
  KEY idx_rmkp_ev_cliente (id_cliente_chat_center, created_at),
  KEY idx_rmkp_ev_pendiente (id_pendiente)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Vínculo de cada envío de la cola con el producto. El cron lo usa para
-- mandar texto + botones en vez de IA/plantilla y para encadenar el paso
-- siguiente del producto. ADD COLUMN es en línea en MariaDB 10.6.
ALTER TABLE remarketing_pendientes
  ADD COLUMN id_remarketing_producto INT UNSIGNED NULL,
  ADD COLUMN id_producto INT NULL,
  ADD COLUMN paso_producto TINYINT NULL,
  ALGORITHM = INPLACE, LOCK = NONE;
