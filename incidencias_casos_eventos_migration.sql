-- ─────────────────────────────────────────────────────────────────────────────
-- Casos en Incidencias, parte 3: línea de tiempo del caso (2026-09-28)
--
-- Todo lo que se hizo con un caso, en orden, con qué / cuándo / quién: creado,
-- puesto en espera, resuelto. Reemplaza el informe manual.
--
-- ⚠ REGISTRO DE AUDITORÍA: solo se agregan filas. No hay endpoint para editar
-- ni borrar entradas; si algo se hizo mal, se agrega otra que lo corrige.
-- Cada acción es su propio INSERT, así que dos personas que guardan casi a la
-- vez dejan dos entradas y ninguna pisa a la otra.
--
-- Requiere incidencias_casos_migration.sql y incidencias_casos_estado_migration.sql.
-- El código funciona sin esta tabla: los casos se siguen marcando y
-- resolviendo, solo que sin línea de tiempo.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `incidencias_casos_eventos` (
  `id`              INT NOT NULL AUTO_INCREMENT,
  `id_incidencia`   INT NOT NULL COMMENT 'incidencias_chat_center.id (el caso)',
  `accion`          VARCHAR(20) NOT NULL COMMENT 'creado | en_espera | resuelto',
  `comentario`      TEXT NULL DEFAULT NULL,
  `id_sub_usuario`  INT NULL DEFAULT NULL COMMENT 'Quién lo hizo',
  `autor_nombre`    VARCHAR(150) NULL DEFAULT NULL COMMENT 'Nombre al momento de la acción',
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_evento_caso` (`id_incidencia`, `created_at`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Casos que ya existían antes de esta tabla: se reconstruye su historia con
-- lo que guardan las columnas del propio caso.
INSERT INTO `incidencias_casos_eventos`
  (`id_incidencia`, `accion`, `comentario`, `id_sub_usuario`, `autor_nombre`, `created_at`)
SELECT i.id, 'creado', i.descripcion, i.id_sub_usuario, i.autor_nombre, i.created_at
  FROM `incidencias_chat_center` i
 WHERE i.tipo IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM `incidencias_casos_eventos` e WHERE e.id_incidencia = i.id);

INSERT INTO `incidencias_casos_eventos`
  (`id_incidencia`, `accion`, `comentario`, `id_sub_usuario`, `autor_nombre`, `created_at`)
SELECT i.id, 'en_espera', i.espera_comentario, i.espera_por, s.nombre_encargado, i.espera_fecha
  FROM `incidencias_chat_center` i
  LEFT JOIN `sub_usuarios_chat_center` s ON s.id_sub_usuario = i.espera_por
 WHERE i.tipo IS NOT NULL AND i.espera_fecha IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM `incidencias_casos_eventos` e
                    WHERE e.id_incidencia = i.id AND e.accion = 'en_espera');

INSERT INTO `incidencias_casos_eventos`
  (`id_incidencia`, `accion`, `comentario`, `id_sub_usuario`, `autor_nombre`, `created_at`)
SELECT i.id, 'resuelto', i.resolucion_comentario, i.resolucion_por, s.nombre_encargado, i.resolucion_fecha
  FROM `incidencias_chat_center` i
  LEFT JOIN `sub_usuarios_chat_center` s ON s.id_sub_usuario = i.resolucion_por
 WHERE i.tipo IS NOT NULL AND i.resolucion_fecha IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM `incidencias_casos_eventos` e
                    WHERE e.id_incidencia = i.id AND e.accion = 'resuelto');
