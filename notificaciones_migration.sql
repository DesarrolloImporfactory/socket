-- ─────────────────────────────────────────────────────────────────────────
-- Notificaciones internas (campana del encabezado)
--
-- Genéricas: cualquier módulo puede avisarle algo a un usuario. Hoy las usa
-- solo "novedad Dropi requiere asesor"; mañana, lo que haga falta.
--
-- Una fila POR USUARIO destinatario (no una por aviso): cada quien tiene su
-- propio "visto" y nadie le marca como leída la notificación a otro.
--
-- Solo CREA una tabla nueva. El código tolera que todavía no exista (no
-- notifica, pero no rompe nada).
--
-- OJO: producción y desarrollo comparten la misma base (98.91.50.83).
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notificaciones (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- Destinatario (sub_usuarios_chat_center.id_sub_usuario)
  id_sub_usuario   BIGINT UNSIGNED NOT NULL,
  -- Cuenta a la que pertenece el aviso. NULL = aviso general del usuario.
  id_configuracion BIGINT UNSIGNED NULL,
  -- Identifica el origen: 'novedad_dropi', …
  tipo             VARCHAR(50) NOT NULL,
  titulo           VARCHAR(200) NOT NULL,
  mensaje          VARCHAR(500) NULL,
  -- A dónde lleva el clic (ruta del front, p. ej. /novedades-dropi?orden=123)
  url              VARCHAR(300) NULL,
  -- Datos extra para pintar (encargado, cliente, pedido…)
  datos            JSON NULL,
  -- Evita repetir el mismo aviso al mismo usuario (p. ej. "novedad:45").
  clave_unica      VARCHAR(190) NULL,
  leida            TINYINT(1) NOT NULL DEFAULT 0,
  leida_at         DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_notif_usuario_clave (id_sub_usuario, clave_unica),
  KEY idx_notif_usuario (id_sub_usuario, leida, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
