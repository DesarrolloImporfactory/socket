-- Tabla de relación entre APIs y Cursos
-- Permite vincular 1 API a múltiples cursos

CREATE TABLE IF NOT EXISTS `api_cursos` (
  `id_api_curso` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `id_api` BIGINT UNSIGNED NOT NULL,
  `id_curso` BIGINT UNSIGNED NOT NULL,
  `activo` BOOLEAN NOT NULL DEFAULT TRUE,
  `fecha_asignacion` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `fecha_modificacion` TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id_api_curso`),
  UNIQUE KEY `unique_api_curso` (`id_api`, `id_curso`),
  KEY `idx_id_api` (`id_api`),
  KEY `idx_id_curso` (`id_curso`),
  CONSTRAINT `fk_api_cursos_api` FOREIGN KEY (`id_api`) REFERENCES `api` (`id_api`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_api_cursos_curso` FOREIGN KEY (`id_curso`) REFERENCES `cursos` (`id_curso`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Índice adicional para consultas por activo
CREATE INDEX `idx_activo` ON `api_cursos` (`activo`);

-- Comentarios de la tabla
ALTER TABLE `api_cursos` COMMENT = 'Tabla de relación entre APIs y Cursos. Permite que 1 API tenga múltiples cursos asignados.';
