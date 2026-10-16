-- ════════════════════════════════════════════════════════════════════════
-- De dónde salió cada respuesta publicada en un comentario.
--
-- POR QUÉ
-- En el hilo, nuestras respuestas se ven todas iguales. Da igual si la escribió
-- una persona, si salió de una respuesta rápida del producto o si la redactó la
-- IA. Y no da igual: si mañana un cliente reclama por algo que se le contestó,
-- lo primero que hay que saber es quién lo dijo.
--
-- También sirve para lo de todos los días: ver de un vistazo cuánto está
-- resolviendo solo el producto (respuestas rápidas, que no cuestan tokens) y
-- cuánto está haciendo falta la IA.
--
-- VALORES
--   persona          escrita desde cero por el agente
--   rapida           respuesta rápida del producto, publicada tal cual
--   rapida_editada   salió de una rápida pero el agente la cambió
--   ia               borrador de la IA publicado tal cual
--   ia_editada       borrador de la IA que el agente reescribió
--   NULL             se respondió desde Facebook, no desde ChatCenter
--
-- El NULL es informativo, no un hueco: una respuesta que entró por el webhook
-- sin pasar por acá es exactamente eso, y la bandeja lo muestra como
-- "Desde Facebook".
--
-- Es VARCHAR y no ENUM a propósito: un ENUM obliga a un ALTER cada vez que
-- aparece un origen nuevo (un bot automático, una plantilla), y esta tabla la
-- comparten dev y producción.
--
-- Aplicar a mano: db.sync NO altera tablas existentes.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE facebook_comments
  ADD COLUMN origen_respuesta VARCHAR(24) NULL DEFAULT NULL
    AFTER respuesta_comment_id;
