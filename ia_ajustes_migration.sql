-- Ajustes del bot a nivel de cuenta (utils/ajustesIA.js).
-- JSON con: espera_rafaga_seg, mensaje_fallback, numeros_excluidos, pausa_humano.
-- NULL = sin ajustes: el bot queda exactamente como estaba.
-- El código tolera que la columna no exista, así que el orden deploy/migración da igual.

ALTER TABLE configuraciones
  ADD COLUMN ia_ajustes JSON NULL;
