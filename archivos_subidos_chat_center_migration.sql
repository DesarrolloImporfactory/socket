-- Registro de archivos ya subidos a S3 (uploader) y a la Video API.
--
-- El uploader crea un objeto nuevo en cada llamada (agrega un timestamp al
-- nombre), así que el mismo adjunto de una plantilla terminaba en el bucket
-- una vez por cada envío. utils/archivosSubidos.js guarda aquí el sha256 del
-- contenido → URL devuelta y uploadToUploader / uploadVideoToVideoAPI
-- consultan antes de subir. Sin la tabla el código sigue funcionando (avisa
-- una vez en el log y sube como antes). Aplicar a mano; misma BD dev y prod.

CREATE TABLE IF NOT EXISTS archivos_subidos_chat_center (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  hash CHAR(64) NOT NULL COMMENT 'sha256 del contenido',
  destino ENUM('s3', 'video_api') NOT NULL DEFAULT 's3',
  url VARCHAR(1000) NOT NULL,
  respuesta JSON NULL COMMENT 'lo que devolvió el uploader / la Video API',
  bytes INT UNSIGNED NOT NULL DEFAULT 0,
  mimetype VARCHAR(120) NULL,
  nombre VARCHAR(255) NULL,
  veces INT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'cuántas subidas se ahorraron',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ultimo_uso_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_archivo_hash_destino (hash, destino)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
