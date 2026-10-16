-- Proveedor de IA por cuenta: OpenAI (como siempre) o Claude (Anthropic).
-- El cliente elige en Asistentes AI con qué proveedor responde el bot del
-- kanban. La llave de Claude se guarda cifrada igual que la de OpenAI
-- (utils/cryptoToken, DROPI_TOKEN_ENC_KEY) y al front solo llega enmascarada.
--
-- Se aplica a mano (misma BD dev y prod). Idempotente: si la columna ya
-- existe, MySQL avisa y no cambia nada.

ALTER TABLE configuraciones
  ADD COLUMN proveedor_ia ENUM('openai', 'claude') NOT NULL DEFAULT 'openai'
    COMMENT 'Con qué proveedor responde el bot del kanban (Asistentes AI)'
    AFTER api_key_openai,
  ADD COLUMN api_key_claude VARCHAR(1000) NULL
    COMMENT 'API key de Anthropic (Claude), cifrada con cryptoToken'
    AFTER proveedor_ia;
