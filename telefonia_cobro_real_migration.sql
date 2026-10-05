-- 2026-10-05: la telefonía cobra el costo REAL de cada llamada en Zadarma
-- (por el margen de la conexión), no una tarifa única por minuto.
--   resto_centavos    fracción de centavo que sobró del último cobro; se
--                     arrastra al siguiente para que la suma cobrada no se
--                     aleje más de 1 centavo del costo real acumulado.
--   costo_zadarma_usd lo que Zadarma cobró por esa llamada (billcost).
-- Aplicada el 2026-10-05 (misma BD dev/prod).
ALTER TABLE telefonia_cuentas ADD COLUMN resto_centavos DECIMAL(8,6) NOT NULL DEFAULT 0 AFTER saldo_centavos;
ALTER TABLE telefonia_llamadas ADD COLUMN costo_zadarma_usd DECIMAL(10,4) NULL AFTER costo_centavos;
