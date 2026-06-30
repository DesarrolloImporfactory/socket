-- =============================================================================
-- ÍNDICES — vista de Contactos  (GET /clientes_chat_center/listar -> listarClientes)
-- Motor real: MariaDB 10.6.  Búsqueda por teléfono SOLO sobre celular_cliente.
-- =============================================================================


-- =============================================================================
-- [APLICADO] BÚSQUEDA POR TELÉFONO RÁPIDA — columna generada + índice
-- =============================================================================
-- Problema: el match por teléfono era `REPLACE(...celular_cliente...) LIKE '%suf'`,
-- un full table scan (~1.100 ms sobre 396k filas) porque un LIKE '%sufijo' + función
-- no es indexable.
--
-- Solución: columna GENERADA VIRTUAL derivada de celular_cliente = reverso de los
-- dígitos. Buscar por sufijo nacional se vuelve un PREFIJO sobre el reverso => usa
-- índice (rango). Sigue siendo 100% celular_cliente (auto-sincronizada por el motor,
-- sin tocar rutas de escritura). NO usa telefono_limpio.
--
-- Resultado verificado en vivo (cfg 242, 88.693 contactos):
--   * EXPLAIN: type=range, key=idx_ccc_cfg_celrev, rows=1
--   * tiempo servidor: de ~1.100 ms (scan) a ~0 ms (seek). Cobertura 1419/1419 formateados.
--
-- ADD COLUMN VIRTUAL = instantáneo (no reconstruye la tabla).
-- CREATE INDEX = 1 pasada online (tardó ~75 s sobre 396k filas; LOCK=NONE).

ALTER TABLE clientes_chat_center
  ADD COLUMN celular_rev VARCHAR(32)
  AS (LEFT(REVERSE(REGEXP_REPLACE(celular_cliente, '[^0-9]', '')), 32)) VIRTUAL;

CREATE INDEX idx_ccc_cfg_celrev
  ON clientes_chat_center (id_configuracion, celular_rev);

-- Uso en el código (listarClientes):
--   revPrefix = reverse(ultimos9DelNumero)
--   WHERE id_configuracion = ? AND celular_rev LIKE CONCAT(revPrefix, '%')
--
-- Para revertir:
--   DROP INDEX idx_ccc_cfg_celrev ON clientes_chat_center;
--   ALTER TABLE clientes_chat_center DROP COLUMN celular_rev;


-- =============================================================================
-- ÍNDICES DE LISTADO/ORDEN — YA EXISTEN (no crear, verificado con SHOW INDEX)
-- =============================================================================
--   ✓ idx_ccc_listar_actividad (id_configuracion, deleted_at, ultimo_mensaje_at, ultimo_msg_id)
--   ✓ idx_ccc_listar_creado    (id_configuracion, deleted_at, created_at, id)
--   ✓ idx_ea_etq_conf_cli      etiquetas_asignadas (id_etiqueta, id_configuracion, id_cliente_chat_center)
--   ✓ filtros estado_contacto / asesor / ciclo ya tienen índice propio.


-- =============================================================================
-- LIMPIEZA OPCIONAL — índices redundantes (reducen costo de escritura)
-- =============================================================================
-- ⚠️ Verifica uso real (EXPLAIN) antes de dropear. Uno por uno.
-- DROP INDEX idx_cli_last_msg ON clientes_chat_center;          -- dup EXACTO de idx_ccc_listar_actividad
-- DROP INDEX idx_cc_cfg_deleted_created ON clientes_chat_center;-- prefijo de idx_ccc_listar_creado
-- DROP INDEX idx_etq_id_etiqueta ON etiquetas_asignadas;        -- prefijo de idx_ea_etq_conf_cli
-- DROP INDEX idx_id_configuracion ON clientes_chat_center;      -- prefijo de múltiples compuestos


-- =============================================================================
-- VERIFICACIÓN
-- =============================================================================
-- SHOW INDEX FROM clientes_chat_center;
-- EXPLAIN SELECT id FROM clientes_chat_center
--   WHERE id_configuracion=242 AND deleted_at IS NULL AND celular_rev LIKE '429700889%';
