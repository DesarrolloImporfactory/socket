-- 2026-10-05: las extensiones de Zadarma se reciclan entre asesores.
-- ultimo_uso_at = última vez que el asesor pidió el teléfono o llamó; una
-- extensión sin uso en 15 min puede reasignarse a otro asesor que la necesite.
-- Aplicada el 2026-10-05 (misma BD dev/prod).
ALTER TABLE telefonia_extensiones ADD COLUMN ultimo_uso_at DATETIME NULL AFTER widget_key_vence_at;
