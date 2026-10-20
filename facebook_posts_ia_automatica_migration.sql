-- ════════════════════════════════════════════════════════════════════════
-- Interruptor de la respuesta automática, por publicación.
--
-- La IA de comentarios pasa a contestar sola. Eso publica texto a la vista de
-- todos en la página de un negocio, así que tiene que poder apagarse sin
-- apagar el asistente entero: hay publicaciones donde conviene (un producto a
-- la venta) y publicaciones donde no (un comunicado, un sorteo, una disculpa).
--
-- POR QUÉ EL DEFAULT ES 1
--
-- Porque este interruptor no es el que decide si se contesta. Hacen falta tres
-- cosas a la vez, y las otras dos son mucho más restrictivas:
--   1. la cuenta tiene encendida la respuesta automática
--      (config_json.auto del asistente de comentarios; por defecto apagada);
--   2. la publicación tiene un producto vinculado — sin contexto la IA no
--      habla en público;
--   3. esto.
-- Con el default en 0 habría que encender dos cosas por cada publicación para
-- que funcione lo que el negocio ya pidió al encender la cuenta. El default en
-- 1 hace que vincular el producto sea el único gesto, y apagar sea la
-- excepción — que es como se usa.
--
-- Aplicar a mano: db.sync NO altera tablas existentes.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE facebook_posts
  ADD COLUMN ia_automatica TINYINT(1) NOT NULL DEFAULT 1
    COMMENT 'La IA contesta sola los comentarios de esta publicacion'
    AFTER producto_vinculado_at;
