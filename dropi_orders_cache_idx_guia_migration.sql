-- Botón de rastreo (/kanban_plantillas/t/:guide) busca la orden por guía
-- para saber la transportadora; sin índice recorre toda la tabla.
ALTER TABLE dropi_orders_cache
  ADD INDEX idx_shipping_guide (shipping_guide);
