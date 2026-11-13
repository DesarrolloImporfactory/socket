-- Contactos bloqueados en WhatsApp desde el chat (2026-11-12).
--
-- Quien usa coexistencia bloquea desde el celular; quien tiene solo API no
-- tenía cómo. El botón «Bloquear contacto» del menú del chat llama a la Block
-- Users API de Meta (POST/DELETE /{phone_number_id}/block_users) y deja aquí
-- la constancia: Meta es quien bloquea de verdad, esta tabla solo sirve para
-- pintar el estado en el chat y saber quién lo hizo.
--
-- No confundir con `contactos_bloqueados`: esa es la lista interna de «no
-- escribirle con envíos automáticos», va por número en todas las líneas y no
-- toca Meta. Esta es por conexión (un número bloqueado en una línea puede
-- seguir escribiendo a otra).
--
-- Ver src/services/whatsapp_bloqueo.service.js.

CREATE TABLE IF NOT EXISTS `whatsapp_bloqueados` (
  `id`                     INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  `id_configuracion`       BIGINT UNSIGNED NOT NULL,
  `id_cliente_chat_center` BIGINT UNSIGNED NOT NULL,
  `celular`                VARCHAR(32)     NOT NULL COMMENT 'wa_id que devolvió Meta, o el número enviado',
  `id_sub_usuario`         BIGINT UNSIGNED NULL COMMENT 'quién lo bloqueó',
  `nombre_sub_usuario`     VARCHAR(120)    NULL,
  `bot_openia_previo`         TINYINT NULL COMMENT 'cómo estaba el bot antes de bloquear; se restaura al desbloquear',
  `enviar_remarketing_previo` TINYINT NULL COMMENT 'ídem para el remarketing',
  `created_at`             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_whatsapp_bloqueados_chat` (`id_cliente_chat_center`),
  KEY `idx_whatsapp_bloqueados_config` (`id_configuracion`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
