-- =============================================================================
-- MIGRATION: anuncios_producto — el ancla determinista anuncio → producto
-- =============================================================================
-- El flujo de entrada más grande del sistema son los anuncios: ~196.000
-- entradas por referral en 60 días. Hoy el producto se adivina desde el TÍTULO
-- del anuncio con 3 niveles de coincidencia de texto, y cuando el título es
-- marketing puro ("Luce 2 tallas menos al instante") no hay texto que valga:
-- el cliente entra sin ancla y el bot puede terminar vendiendo otra cosa.
--
-- Lo que el título no dice, el source_id sí: es el ID del anuncio en Meta, es
-- estable, y un anuncio publicita SIEMPRE el mismo producto. Esta tabla guarda
-- ese vínculo UNA vez —aprendido en el primer match confiable, o backfilleado
-- del histórico— y a partir de ahí la resolución es una búsqueda exacta, no
-- una adivinanza.
--
-- Cobertura medida: solo 227 de 196.285 entradas (0,1%) llegan sin source_id.
--
-- Ya aplicada a mano el 2026-08-18 (misma base dev y producción; db.sync no
-- crea esta tabla porque el modelo no está en initModels, igual que
-- citas_solicitudes).
-- =============================================================================
CREATE TABLE
  anuncios_producto (
    id INT NOT NULL AUTO_INCREMENT,
    id_configuracion BIGINT NOT NULL,
    -- referral.source_id de Meta: el ID del anuncio.
    source_id VARCHAR(64) NOT NULL,
    id_producto INT NOT NULL,
    -- El título con el que se aprendió, para poder auditar el vínculo.
    headline VARCHAR(500) NULL,
    -- Cómo nació el vínculo. Solo se aprende de los niveles confiables
    -- ('exacto', 'contenido'); el nivel de palabras sueltas es demasiado
    -- difuso para grabarlo como verdad.
    via ENUM ('exacto', 'contenido', 'manual') NOT NULL,
    -- Cuántas veces se usó: dice qué anuncios son los que mueven clientes.
    veces INT NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    -- Un anuncio = un producto. El primero que se aprende queda; si el vínculo
    -- está mal, se corrige a mano (via='manual') y nadie lo pisa.
    UNIQUE KEY uq_anuncio (id_configuracion, source_id),
    KEY idx_producto (id_producto)
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
