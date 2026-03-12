-- =============================================================================
-- MIGRATION: Índices para optimizar obtenerDashboardCompleto
-- Problema: queries >300s por full table scans en mensajes_clientes,
--           clientes_chat_center e historial_encargados
-- =============================================================================
-- EJECUTAR UNO POR UNO en horario de baja carga (CREATE INDEX bloquea en MyISAM,
-- en InnoDB usa ALGORITHM=INPLACE si la versión lo soporta).
-- Verifica primero si ya existen: SHOW INDEX FROM <tabla>;
-- =============================================================================


-- =============================================================================
-- TABLA: mensajes_clientes
-- =============================================================================

-- Índice 1: Cubre la creación de temp_primer_entrante (TEMP 2)
-- Filtros: id_configuracion (JOIN), rol_mensaje=0, deleted_at IS NULL, created_at BETWEEN
-- GROUP BY: id_configuracion, celular_recibe  →  MIN(created_at) cubierto al final
--
-- También cubre temp_ultimo_entrante (TEMP 3) y temp_ultimo_saliente (TEMP 4)
-- que usan los mismos filtros pero sin rango de fechas (MAX(created_at) global)
CREATE INDEX idx_mc_conf_rol_del_at_cel
  ON mensajes_clientes (id_configuracion, rol_mensaje, deleted_at, created_at, celular_recibe);

-- Índice 2: Cubre las subconsultas correlacionadas de primera respuesta
-- Usadas en repliesAgg (sección 1c) y firstResponse (sección 4 charts)
--   WHERE id_configuracion = ?        → de la temp table
--     AND celular_recibe   = ?        → por cliente específico
--     AND rol_mensaje      = 1
--     AND deleted_at IS NULL
--     AND created_at > first_in_at   → rango abierto
CREATE INDEX idx_mc_conf_cel_rol_del_at
  ON mensajes_clientes (id_configuracion, celular_recibe, rol_mensaje, deleted_at, created_at);


-- =============================================================================
-- TABLA: clientes_chat_center
-- =============================================================================

-- Índice 3: Cubre queries de chats resueltos (secciones 1b, 3-SLA, 4-charts)
-- Filtros: id_configuracion (JOIN o WHERE), deleted_at IS NULL, propietario=0,
--          chat_cerrado=1, chat_cerrado_at BETWEEN
CREATE INDEX idx_ccc_conf_cerrado_at
  ON clientes_chat_center (id_configuracion, deleted_at, propietario, chat_cerrado, chat_cerrado_at);

-- Índice 4: Cubre la sección 5b (carga actual por asesor)
-- JOIN: ccc.id_encargado = su.id_sub_usuario
-- Filtros adicionales: chat_cerrado=0, deleted_at IS NULL, propietario=0
CREATE INDEX idx_ccc_encargado_abierto
  ON clientes_chat_center (id_encargado, chat_cerrado, deleted_at, propietario, id_configuracion);


-- =============================================================================
-- TABLA: historial_encargados
-- =============================================================================

-- Índice 5: Cubre sección 5a (chats asignados en rango) y sección 6 (transferencias)
-- Filtro: fecha_registro BETWEEN
-- Columnas usadas: id_encargado_nuevo (JOIN/GROUP), id_cliente_chat_center (JOIN/GROUP)
CREATE INDEX idx_he_fecha_encargado
  ON historial_encargados (fecha_registro, id_encargado_nuevo, id_cliente_chat_center);


-- =============================================================================
-- TABLA: configuraciones
-- =============================================================================

-- Índice 6: Cubre la creación de temp_configs (TEMP 1)
-- WHERE id_usuario = ? AND suspendido = 0 [AND id = ?]
CREATE INDEX idx_conf_usuario_susp
  ON configuraciones (id_usuario, suspendido, id);


-- =============================================================================
-- VERIFICACIÓN POST-MIGRACIÓN
-- =============================================================================
-- SHOW INDEX FROM mensajes_clientes;
-- SHOW INDEX FROM clientes_chat_center;
-- SHOW INDEX FROM historial_encargados;
-- SHOW INDEX FROM configuraciones;
