-- ═══════════════════════════════════════════════════════════════════════════
-- Variantes de Aliclik en productos_variaciones
--
-- La tabla nació para Dropi, donde la identidad de la variante es un solo
-- valor (`dropi_variation_id`) y con el id del producto basta para pedirla.
-- Aliclik funciona distinto: lo que su API acepta al crear un pedido es el
-- `ean` del SKU, y cada SKU vive en un almacén concreto (`warehouseId`) —
-- Aliclik exige que todos los productos de un pedido salgan del MISMO almacén.
--
-- Sin estas dos columnas un producto importado de Aliclik queda en el catálogo
-- pero no se puede pedir: el ean y el almacén se perderían en el import y no
-- hay forma de recuperarlos después (su catálogo no permite buscar por id ni
-- por ean, solo por nombre).
--
-- Ojo: hoy NADIE las lee todavía. El auto-orden de Aliclik no existe; se
-- guardan ahora para que cuando se construya no haya que reimportar todo.
--
-- Idempotente: se puede correr varias veces sin romper nada.
-- Requiere MariaDB 10.0+ / MySQL 8.0.29+ por el IF NOT EXISTS.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE productos_variaciones
  ADD COLUMN IF NOT EXISTS ean varchar(32) DEFAULT NULL
    COMMENT 'EAN del SKU en Aliclik: es lo que su API acepta al crear el pedido',
  ADD COLUMN IF NOT EXISTS warehouse_id int(11) DEFAULT NULL
    COMMENT 'Almacen del SKU en Aliclik; todos los items de un pedido deben compartirlo';

-- Búsqueda por ean dentro de una cuenta (la usará el futuro auto-orden).
ALTER TABLE productos_variaciones
  ADD INDEX IF NOT EXISTS idx_prodvar_ean (id_configuracion, ean);
