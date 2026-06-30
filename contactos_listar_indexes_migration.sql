-- =============================================================================
-- MIGRATION: Índices para la vista de Contactos
-- Endpoint: GET /api/v1/clientes_chat_center/listar  (controller: listarClientes)
-- Objetivo: evitar filesort y full table scans al filtrar/ordenar contactos por
--           id_configuracion (multi-tenant) + estado/etiquetas/fecha + sort.
-- =============================================================================
-- EJECUTAR UNO POR UNO en horario de baja carga.
-- Verifica primero si ya existen:  SHOW INDEX FROM clientes_chat_center;
-- (Nota: NO uses telefono_limpio: esa columna fue deprecada, todo es celular_cliente.)
--
-- Contexto: la migración dashboard_indexes_migration.sql ya creó
--   idx_ccc_conf_cerrado_at (id_configuracion, deleted_at, propietario, chat_cerrado, chat_cerrado_at)
-- que NO cubre el ORDER BY de la vista de contactos -> de ahí los índices de abajo.
-- =============================================================================


-- =============================================================================
-- NÚCLEO (recomendado) — cubre el caso 99% : filtro por tenant + orden
-- =============================================================================

-- Orden "Última actividad" (actividad_desc / actividad_asc) y orden por defecto.
-- WHERE c.deleted_at IS NULL AND c.id_configuracion = ?  +  ORDER BY ultimo_mensaje_at, ultimo_msg_id
CREATE INDEX idx_ccc_listar_actividad
  ON clientes_chat_center (id_configuracion, deleted_at, ultimo_mensaje_at, ultimo_msg_id);

-- Orden "Creado" (recientes / antiguos).
-- WHERE ... + ORDER BY created_at, id   (+ rango fecha_tipo=created)
CREATE INDEX idx_ccc_listar_creado
  ON clientes_chat_center (id_configuracion, deleted_at, created_at, id);

-- Subconsulta del filtro por etiqueta:
--   SELECT id_cliente_chat_center FROM etiquetas_asignadas
--   WHERE id_etiqueta [IN (...)] AND id_configuracion = ?
CREATE INDEX idx_ea_etq_conf_cli
  ON etiquetas_asignadas (id_etiqueta, id_configuracion, id_cliente_chat_center);


-- =============================================================================
-- OPCIONALES — sólo si esos filtros se usan mucho. Cada índice extra encarece
-- los INSERT/UPDATE (tabla de chat = muy escrita). Añádelos selectivamente.
-- MySQL usa UN índice por acceso a tabla: con el núcleo de arriba estos filtros
-- ya se aplican como condición residual; estos índices ayudan cuando el filtro
-- es muy selectivo (p. ej. un asesor con pocos contactos).
-- =============================================================================

-- Filtro Estado del cliente (estado_cliente = ?)
-- CREATE INDEX idx_ccc_listar_estado
--   ON clientes_chat_center (id_configuracion, deleted_at, estado_cliente);

-- Filtro Estado de contacto (estado_contacto IN (...))  — VARCHAR(50)
-- CREATE INDEX idx_ccc_listar_estcont
--   ON clientes_chat_center (id_configuracion, deleted_at, estado_contacto);

-- Filtro Asesor (id_etiqueta_asesor IN (...))
-- CREATE INDEX idx_ccc_listar_asesor
--   ON clientes_chat_center (id_configuracion, deleted_at, id_etiqueta_asesor);

-- Filtro Ciclo (id_etiqueta_ciclo IN (...))
-- CREATE INDEX idx_ccc_listar_ciclo
--   ON clientes_chat_center (id_configuracion, deleted_at, id_etiqueta_ciclo);

-- Filtro Último producto Ad (ultimo_producto_ad IN (...))
-- OJO: verifica el tipo real de la columna antes de crear el índice.
--   - Si es VARCHAR(<=191): quita el prefijo  -> (..., ultimo_producto_ad)
--   - Si es TEXT/LONGTEXT : el prefijo es OBLIGATORIO (ej. 191) o fallará la DDL.
-- CREATE INDEX idx_ccc_listar_prodad
--   ON clientes_chat_center (id_configuracion, deleted_at, ultimo_producto_ad(191));


-- =============================================================================
-- NOTA sobre la BÚSQUEDA POR TELÉFONO (search_mode=phone)
-- =============================================================================
-- El match es:
--   REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(celular_cliente,' ',''),'-',''),'(',''),')',''),'+','') LIKE '%<ultimos9>'
-- Es una expresión sobre la columna + comodín inicial -> NO es indexable por un
-- índice B-Tree normal (ni funcional). Lo que la hace rápida es que el índice
-- idx_ccc_listar_actividad acota el escaneo a las filas de ESE id_configuracion.
-- Para un futuro índice real de teléfono habría que materializar una columna
-- normalizada de dígitos (p. ej. celular_norm) y crear un índice funcional/columna
-- generada — pero eso implica re-poblarla en TODAS las rutas de escritura.


-- =============================================================================
-- VERIFICACIÓN POST-MIGRACIÓN
-- =============================================================================
-- SHOW INDEX FROM clientes_chat_center;
-- SHOW INDEX FROM etiquetas_asignadas;
-- EXPLAIN <la query de listarClientes>;   -- confirma "Using index" / sin "Using filesort"
