-- ════════════════════════════════════════════════════════════════════════
-- Asistente de comentarios configurable.
--
-- 1) prompt: varchar(1000) → TEXT
--
-- El prompt por defecto de comentarios ocupa 1.325 caracteres, así que en
-- varchar(1000) ni siquiera cabe el nuestro. MySQL lo cortaría en 1000 y lo
-- que se pierde son las últimas líneas — entre ellas "Devuelve SOLO el texto
-- de la respuesta", que es la que impide que el modelo escriba "Aquí tienes
-- una opción: ..." y eso acabe publicado en la página del cliente.
--
-- Ensanchar una columna no toca los 650 asistentes de ventas y logístico que
-- ya viven en esta tabla: lo que cabía sigue cabiendo.
--
-- 2) config_json: las decisiones del negocio, sin texto libre
--
-- La mayoría de negocios no quiere escribir un prompt, quiere decir "no
-- publiques precios" y "trátalos de usted". Eso se guarda estructurado y el
-- backend compone el prompt con ello. `prompt` queda para el modo avanzado:
-- cuando alguien escribe el suyo entero, se guarda ahí y manda sobre
-- config_json.
--
-- En los dos casos las reglas que sostienen el sistema —no inventar, devolver
-- solo el texto, el tope de frases— se añaden siempre por código y no se
-- pueden borrar desde la interfaz. Un comentario es público y permanente: ahí
-- una alucinación no la ve un agente, la ve todo el que entre a la
-- publicación.
--
-- Aplicar a mano: db.sync NO altera tablas existentes.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE openai_assistants
  MODIFY COLUMN prompt TEXT NULL,
  ADD COLUMN config_json TEXT NULL DEFAULT NULL AFTER prompt;
