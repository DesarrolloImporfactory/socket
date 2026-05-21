-- =============================================================================
-- MIGRATION: Kanban IA V2 (Structured Outputs)
-- =============================================================================
-- Tablas necesarias para el flujo V2 de kanban_ia que usa
-- response_format: json_schema en lugar de parsing de texto con regex.
--
-- No modifica ninguna tabla existente. V1 sigue funcionando intacta.
-- =============================================================================
-- ─────────────────────────────────────────────────────────────────────────────
-- Tabla 1: kanban_columnas_v2_schemas
-- Una fila por columna que esta opt-in a V2.
-- Si una columna NO tiene fila aqui (o tiene activo=0), el caller debe
-- usar V1 (procesarMensajeKanban) — V2 devuelve { ok:false, motivo:'sin_config_v2' }.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE
  kanban_columnas_v2_schemas (
    id INT NOT NULL AUTO_INCREMENT,
    id_kanban_columna INT NOT NULL,
    -- JSON Schema completo en el formato de OpenAI:
    --   { "name": "...", "strict": true, "schema": { ... } }
    -- Se envia tal cual a response_format.json_schema
    response_schema LONGTEXT NOT NULL,
    -- Mapa de la enum `accion` del schema → estado_db al que mover el cliente.
    -- Ejemplo Sara/Imporshop:
    --   { "generar_guia": "pedidos_confirmados",
    --     "cancelar": "cancelados",
    --     "escalar_asesor": "asesor" }
    -- Si "ninguna" o accion sin mapeo → no se cambia el estado.
    accion_map JSON NULL,
    -- Override opcional del modelo (default: el que tenga el asistente OpenAI)
    modelo VARCHAR(50) NULL,
    activo TINYINT (1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_columna (id_kanban_columna),
    KEY idx_activo (activo),
    CONSTRAINT fk_v2_schema_columna FOREIGN KEY (id_kanban_columna) REFERENCES kanban_columnas (id) ON DELETE CASCADE
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- ─────────────────────────────────────────────────────────────────────────────
-- Tabla 2: kanban_pedidos_v2
-- Persiste cada pedido extraido por el modelo en una respuesta V2.
-- Es solo trazabilidad — el cambio de estado del cliente se hace en
-- clientes_chat_center.estado_contacto via accion_map.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE
  kanban_pedidos_v2 (
    id INT NOT NULL AUTO_INCREMENT,
    id_kanban_columna INT NOT NULL,
    id_cliente INT NOT NULL,
    id_configuracion INT NOT NULL,
    accion VARCHAR(50) NOT NULL DEFAULT 'ninguna',
    pedido_json JSON NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_cliente (id_cliente),
    KEY idx_columna (id_kanban_columna),
    KEY idx_configuracion (id_configuracion),
    KEY idx_created (created_at)
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;