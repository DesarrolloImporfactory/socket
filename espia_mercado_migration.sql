-- Espía de mercado (Dropkiller propio) — 30-10-2026
-- Tablas de MERCADO por país (no por cuenta). Las crea también db.sync() al
-- arrancar el socket (models/espia_mercado.model.js); este archivo es para
-- aplicarlas a mano en producción sin esperar un arranque.

CREATE TABLE IF NOT EXISTS espia_producto (
  pais CHAR(2) NOT NULL,
  dropi_product_id BIGINT NOT NULL,
  nombre VARCHAR(300) NULL,
  nombre_norm VARCHAR(80) NULL,
  tipo VARCHAR(12) NULL,
  sku VARCHAR(120) NULL,
  proveedor_id BIGINT NULL,
  proveedor_nombre VARCHAR(200) NULL,
  precio DECIMAL(12,2) NULL,
  sugerido DECIMAL(12,2) NULL,
  categoria VARCHAR(200) NULL,
  imagen_url VARCHAR(600) NULL,
  external_id VARCHAR(100) NULL,
  privado TINYINT NOT NULL DEFAULT 0,
  primera_vez DATETIME NOT NULL,
  ultima_vez DATETIME NOT NULL,
  stock_actual INT NOT NULL DEFAULT 0,
  ventas_total INT NOT NULL DEFAULT 0,
  reabastecimientos INT NOT NULL DEFAULT 0,
  PRIMARY KEY (pais, dropi_product_id),
  KEY ix_espia_producto_prov (pais, proveedor_id),
  KEY ix_espia_producto_norm (pais, nombre_norm),
  KEY ix_espia_producto_ext (pais, external_id),
  KEY ix_espia_producto_ultima (pais, ultima_vez)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Último stock por (producto, bodega, variación): lo que compara cada pasada.
CREATE TABLE IF NOT EXISTS espia_stock_actual (
  pais CHAR(2) NOT NULL,
  dropi_product_id BIGINT NOT NULL,
  warehouse_id BIGINT NOT NULL,
  variacion_id BIGINT NOT NULL DEFAULT 0,
  stock INT NOT NULL DEFAULT 0,
  fecha_hora DATETIME NOT NULL,
  PRIMARY KEY (pais, dropi_product_id, warehouse_id, variacion_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Historial: una fila SOLO cuando cambia ese stock. Se purga a 120 días.
CREATE TABLE IF NOT EXISTS espia_stock_foto (
  pais CHAR(2) NOT NULL,
  dropi_product_id BIGINT NOT NULL,
  warehouse_id BIGINT NOT NULL,
  variacion_id BIGINT NOT NULL DEFAULT 0,
  fecha_hora DATETIME NOT NULL,
  stock INT NOT NULL,
  PRIMARY KEY (pais, dropi_product_id, warehouse_id, variacion_id, fecha_hora),
  KEY ix_espia_stock_foto_fecha (fecha_hora)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lo que lee la pantalla. Se conserva entero.
CREATE TABLE IF NOT EXISTS espia_ventas_dia (
  pais CHAR(2) NOT NULL,
  dropi_product_id BIGINT NOT NULL,
  fecha DATE NOT NULL,
  unidades INT NOT NULL DEFAULT 0,
  reabastecido TINYINT NOT NULL DEFAULT 0,
  PRIMARY KEY (pais, dropi_product_id, fecha),
  KEY ix_espia_ventas_dia_fecha (pais, fecha)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS espia_pasada (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  pais CHAR(2) NOT NULL,
  fuente VARCHAR(20) NOT NULL DEFAULT 'dropi',
  inicio DATETIME NOT NULL,
  fin DATETIME NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'corriendo',
  paginas INT NOT NULL DEFAULT 0,
  productos INT NOT NULL DEFAULT 0,
  fotos_escritas INT NOT NULL DEFAULT 0,
  ventas_sumadas INT NOT NULL DEFAULT 0,
  errores_429 INT NOT NULL DEFAULT 0,
  freno_hasta DATETIME NULL,
  error VARCHAR(500) NULL,
  PRIMARY KEY (id),
  KEY ix_espia_pasada_pais (pais, inicio)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lo que ve la extensión «Espía de tiendas» en la Biblioteca de anuncios de Meta.
CREATE TABLE IF NOT EXISTS espia_anuncio (
  ad_archive_id VARCHAR(40) NOT NULL,
  pais VARCHAR(3) NOT NULL DEFAULT 'ALL',
  pagina_id VARCHAR(40) NULL,
  pagina_nombre VARCHAR(200) NULL,
  dominio VARCHAR(190) NULL,
  url_destino VARCHAR(1000) NULL,
  producto VARCHAR(200) NULL,
  titulo VARCHAR(300) NULL,
  texto TEXT NULL,
  tipo VARCHAR(10) NULL,
  media_url VARCHAR(1000) NULL,
  imagen_url VARCHAR(1000) NULL,
  plataformas VARCHAR(100) NULL,
  inicio DATE NULL,
  primera_vez_visto DATETIME NOT NULL,
  ultima_vez_visto DATETIME NOT NULL,
  activo TINYINT NOT NULL DEFAULT 1,
  n_duplicados INT NOT NULL DEFAULT 1,
  veces_visto INT NOT NULL DEFAULT 1,
  visto_por INT NULL,
  PRIMARY KEY (ad_archive_id),
  KEY ix_espia_anuncio_dominio (dominio, activo),
  KEY ix_espia_anuncio_pais_visto (pais, ultima_vez_visto),
  KEY ix_espia_anuncio_inicio (inicio)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS espia_tienda (
  dominio VARCHAR(190) NOT NULL,
  nombre VARCHAR(200) NULL,
  pais_principal VARCHAR(3) NULL,
  es_shopify TINYINT NULL,
  productos INT NULL,
  moneda VARCHAR(10) NULL,
  tema VARCHAR(120) NULL,
  producto_top VARCHAR(200) NULL,
  anuncios_activos INT NOT NULL DEFAULT 0,
  primera_vez DATETIME NOT NULL,
  ultima_vez DATETIME NOT NULL,
  ultima_revision DATETIME NULL,
  PRIMARY KEY (dominio),
  KEY ix_espia_tienda_activos (pais_principal, anuncios_activos)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS espia_tienda_dia (
  dominio VARCHAR(190) NOT NULL,
  fecha DATE NOT NULL,
  anuncios_activos INT NOT NULL DEFAULT 0,
  anuncios_nuevos INT NOT NULL DEFAULT 0,
  PRIMARY KEY (dominio, fecha)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS espia_seguimiento (
  id_sub_usuario BIGINT NOT NULL,
  tipo VARCHAR(12) NOT NULL,
  ref VARCHAR(190) NOT NULL,
  creado_en DATETIME NOT NULL,
  PRIMARY KEY (id_sub_usuario, tipo, ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 31-10-2026: métricas precalculadas en espia_producto (la pantalla dejó de
-- calcular ventas por fila al leer; las recalcula recalcularMetricas() al cerrar
-- cada pasada y a las 00:10 de cada país) e índices para los órdenes de la lista.
ALTER TABLE espia_producto
  ADD COLUMN ventas_1d INT NOT NULL DEFAULT 0,
  ADD COLUMN ventas_7d INT NOT NULL DEFAULT 0,
  ADD COLUMN ventas_7d_prev INT NOT NULL DEFAULT 0,
  ADD COLUMN ventas_30d INT NOT NULL DEFAULT 0,
  ADD COLUMN n_iguales INT NOT NULL DEFAULT 0,
  ADD COLUMN serie7 VARCHAR(80) NULL,
  ADD COLUMN metricas_en DATETIME NULL,
  ADD KEY ix_espia_producto_v7 (pais, ventas_7d),
  ADD KEY ix_espia_producto_v30 (pais, ventas_30d),
  ADD KEY ix_espia_producto_total (pais, ventas_total),
  ADD KEY ix_espia_producto_stock (pais, stock_actual),
  ADD KEY ix_espia_producto_primera (pais, primera_vez),
  ADD KEY ix_espia_producto_precio (pais, precio);
-- Después: node scripts/espiaMercado.js metricas --pais EC  (y MX)

-- 31-10-2026 (tarde): plataforma de la tienda detectada por la extensión en cada
-- anuncio (Shopify, WhatsApp, Dropi o web) y resumida por tienda.
ALTER TABLE espia_anuncio ADD COLUMN tienda_plataforma VARCHAR(20) NULL AFTER plataformas;
ALTER TABLE espia_tienda ADD COLUMN plataforma VARCHAR(20) NULL AFTER es_shopify;

-- 31-10-2026 (noche): Radar de anuncios. La extensión recorre la Biblioteca de
-- Meta buscando por nombre los productos que más venden y deja el vínculo exacto
-- anuncio ↔ producto (sin depender de palabras del nombre). n_anuncios y radar_en
-- se precalculan en espia_producto para listar/filtrar sin JOIN.
ALTER TABLE espia_producto
  ADD COLUMN n_anuncios INT NOT NULL DEFAULT 0,
  ADD COLUMN radar_en DATETIME NULL,
  ADD KEY ix_espia_producto_anuncios (pais, n_anuncios),
  ADD KEY ix_espia_producto_radar (pais, radar_en);

CREATE TABLE IF NOT EXISTS espia_anuncio_producto (
  pais VARCHAR(2) NOT NULL,
  dropi_product_id BIGINT NOT NULL,
  ad_archive_id VARCHAR(40) NOT NULL,
  origen VARCHAR(12) NOT NULL DEFAULT 'radar',
  creado_en DATETIME NOT NULL,
  PRIMARY KEY (pais, dropi_product_id, ad_archive_id),
  KEY ix_espia_ap_anuncio (ad_archive_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
