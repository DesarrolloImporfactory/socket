-- Fase 2 Claude (2026-10-17): texto de los archivos de conocimiento.
-- Claude no tiene file_search: el texto del documento se extrae al subirlo
-- (utils/claude/textoDeArchivo.js) y se guarda aquí; el motor lo mete inline
-- en las instrucciones cuando la cuenta responde con Claude
-- (utils/claude/documentos.js). Se aplica A MANO (db.sync no agrega columnas).
-- Para los archivos ya subidos: node scripts/extraerTextoArchivosConocimiento.js

ALTER TABLE kanban_archivos
  ADD COLUMN texto_extraido MEDIUMTEXT NULL AFTER storage_path,
  ADD COLUMN texto_chars INT UNSIGNED NULL AFTER texto_extraido;
