-- ════════════════════════════════════════════════════════════════════════
-- Vincular una publicación de Facebook con un producto del catálogo.
--
-- POR QUÉ
-- El asistente de comentarios necesita saber DE QUÉ están hablando. Inyectarle
-- el catálogo entero no sirve: el bloque `catalogo_inline` del kanban llega a
-- ~64.000 caracteres, y pagar eso por cada sugerencia de dos frases es caro y
-- además empeora la respuesta (cuanta más paja, más se despista el modelo).
--
-- Con el producto vinculado, la sugerencia sale en tres niveles:
--   1. Respuesta rápida del producto (productos_wizard.respuestas_rapidas_json)
--      elegida por el matcher determinista → 0 tokens.
--   2. IA con ESE producto inyectado, no el catálogo.
--   3. Sin producto vinculado → prompt genérico, empuja al privado.
--
-- Es manual a propósito. Se miró si el anuncio permitía deducirlo
-- (anuncios_producto.source_id dentro de post_id) y no calza en ningún caso.
--
-- id_producto NO lleva FOREIGN KEY: si el negocio borra el producto, la
-- publicación tiene que seguir en la bandeja. El JOIN devuelve NULL y el
-- asistente cae solo al nivel 3.
--
-- Aplicar a mano: db.sync NO altera tablas existentes.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE facebook_posts
  ADD COLUMN id_producto INT NULL DEFAULT NULL AFTER permalink_url,
  ADD COLUMN producto_vinculado_at DATETIME NULL DEFAULT NULL AFTER id_producto,
  ADD INDEX idx_fb_posts_producto (id_configuracion, id_producto);
