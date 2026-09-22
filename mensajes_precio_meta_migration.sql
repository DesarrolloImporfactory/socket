-- ─────────────────────────────────────────────────────────────────────────────
-- Precio real de Meta por mensaje saliente de WhatsApp
--
-- Contexto: el status webhook de Meta trae en cada mensaje un objeto
-- `pricing` (billable, type, category) y, solo si el mensaje salió dentro de
-- una ventana free entry point (clic desde anuncio CTWA o botón CTA de la
-- página), `conversation.expiration_timestamp` con el vencimiento exacto de
-- las 72 h. Hasta ahora se descartaba.
--
-- Se guarda para que el chat marque los mensajes que Meta confirmó como
-- gratis por la ventana de 72 h. Se llena desde webhook_meta_whatsapp
-- (loop de statuses); NULL = Meta todavía no mandó el precio, o el mensaje
-- es de antes de esta migración, o no es de WhatsApp.
--
--   precio_meta_tipo       'regular' | 'free_customer_service' | 'free_entry_point'
--   precio_meta_facturable 1 = Meta lo cobra, 0 = gratis
--   precio_meta_categoria  la de Meta: dentro de la ventana de 72 h llega
--                          siempre 'referral_conversion', sea plantilla o no
--   fep_expira_at          vencimiento de la ventana de 72 h (solo FEP)
--
-- ALGORITHM = INSTANT: en MySQL 8 agrega las columnas sin copiar la tabla ni
-- bloquear escrituras. Si el servidor respondiera que no lo soporta, NO
-- quitar la cláusula para forzarlo: sin INSTANT MySQL reconstruye
-- mensajes_clientes completa, y eso no se corre en horario de tráfico.
--
-- IMPORTANTE: correr ANTES de desplegar el código. chat.service pide estas
-- columnas al cargar la conversación; si no existen, el chat no abre.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE `mensajes_clientes`
  ADD COLUMN `precio_meta_tipo` VARCHAR(32) NULL DEFAULT NULL,
  ADD COLUMN `precio_meta_facturable` TINYINT(1) NULL DEFAULT NULL,
  ADD COLUMN `precio_meta_categoria` VARCHAR(40) NULL DEFAULT NULL,
  ADD COLUMN `fep_expira_at` DATETIME NULL DEFAULT NULL,
  ALGORITHM = INSTANT;
