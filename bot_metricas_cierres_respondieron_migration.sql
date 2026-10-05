-- Tablero "Salud del bot": numerador del indicador principal
-- "% de cierre sobre quienes conversaron con el bot".
-- cierres_respondieron = cierres de contactos que SÍ respondieron ese día.
-- El % = cierres_respondieron / convers_respondieron.
-- El código tolera que la columna no exista (cae al cálculo anterior), pero
-- el número nuevo aparece recién con la columna + el recálculo nocturno
-- (o: node scripts/backfillBotMetricas.js 95, de madrugada).
ALTER TABLE bot_metricas_diarias
  ADD COLUMN cierres_respondieron INT UNSIGNED NOT NULL DEFAULT 0
  AFTER cierres_kanban;
