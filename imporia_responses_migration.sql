-- ═══════════════════════════════════════════════════════════════
-- imporia_responses_migration.sql
--
-- Mueve ImporIA de la Assistants API a la Responses API.
--
-- ⚠️ SE APLICA SOBRE LA BD DE IMPORSUIT (la de `DB_*` en el .env del socket,
--    `db_2` en el código), que es donde ya viven threads_imporsuit y
--    mensajes_gpt_imporsuit. NO sobre la BD de ChatCenter.
--
-- POR QUÉ
--
-- ImporIA quedó fuera de la migración de agosto y siguió corriendo contra
-- threads/runs. El 2026-08-26 OpenAI apagó la Assistants API y desde ese día
-- no contesta: 69 mensajes de usuarios sin una sola respuesta, y los dos
-- assistants (asst_UVA… EC, asst_shn… MX) devuelven 404.
--
-- Con Assistants, el prompt y el modelo vivían DENTRO del assistant en OpenAI.
-- Con Responses tienen que vivir acá. Eso es `imporia_prompts`.
--
-- Con Assistants, el hilo de la conversación era `threads_imporsuit.id_thread_chat`.
-- Con Responses es `previous_response_id`. Eso es la columna `response_id`.
--
-- Se aplica a mano, una sola vez (misma convención que el resto de
-- *_migration.sql del repo).
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- 1. Prompts por país
--
-- Reemplaza a los objetos assistant borrados. Un registro por país: hoy EC y
-- MX, que son los dos que el controller tenía quemados.
--
-- vector_store_id: los vector stores NO murieron con la Assistants API —viven
-- en su propio endpoint y la Responses API los consume igual vía file_search—,
-- así que se reusan tal cual sin volver a subir archivos.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `imporia_prompts` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `pais` CHAR(2) NOT NULL,
  `nombre` VARCHAR(100) NOT NULL DEFAULT '',
  `instrucciones` MEDIUMTEXT NOT NULL,
  `modelo` VARCHAR(50) NOT NULL DEFAULT 'gpt-4.1-mini',
  `max_tokens` INT UNSIGNED NOT NULL DEFAULT 800,
  `vector_store_id` VARCHAR(64) DEFAULT NULL,
  `activo` TINYINT(1) NOT NULL DEFAULT 1,
  `creado_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `actualizado_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_imporia_prompts_pais` (`pais`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- 2. La memoria de la conversación
--
-- `id_thread_chat` se deja en su sitio a propósito: son 1.065 conversaciones y
-- ese id es el único rastro de dónde estuvo el historial viejo. No estorba.
--
-- `response_at` existe para poder cortar cadenas viejas: OpenAI retiene las
-- respuestas ~30 días, así que un previous_response_id de hace dos meses da
-- 404. Se corta a los 14 días, igual que hace ChatCenter en
-- obtener_response.service.js.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE `threads_imporsuit`
  ADD COLUMN `response_id` VARCHAR(80) DEFAULT NULL AFTER `id_thread_chat`,
  ADD COLUMN `response_at` DATETIME DEFAULT NULL AFTER `response_id`;

-- ─────────────────────────────────────────────────────────────
-- 3. Los prompts
--
-- Los originales vivían dentro de los assistants y ya no se podían leer (404).
-- Estos los aportó Tony, que los tenía guardados aparte.
--
-- vector_store_id:
--   MX  vs_69864c99f0348191b4c2dc9bf73962db  ← "Vector store for Asistente GPT
--       IMPORSUIT MX", 2 archivos, 4.1 MB, activo hasta el 2026-08-25. Su
--       prompt depende de él: dice "usando EXCLUSIVAMENTE los archivos
--       cargados", así que sin el vector store MX no puede clasificar nada.
--   EC  NULL  ← a propósito. No es que se haya perdido: el prompt de EC no
--       menciona archivos en ningún momento —clasifica de memoria y manda al
--       portal de la aduana a verificar—, y en la cuenta tampoco quedó ningún
--       vector store suyo. Si algún día se le cargan documentos, se pone el id
--       acá y el servicio lo toma solo, sin tocar código.
--
-- modelo: gpt-4.1-mini, el default que usaba el resto del sistema para estos
-- asistentes. Si sabes con cuál corrían de verdad, cámbialo acá.
--
-- Ninguno de los dos textos lleva comillas simples ni backslashes, así que van
-- literales y no hay nada escapado. Si los editas, ojo con eso.
-- ─────────────────────────────────────────────────────────────
INSERT INTO `imporia_prompts`
  (`pais`, `nombre`, `instrucciones`, `modelo`, `max_tokens`, `vector_store_id`)
VALUES
  ('EC', 'Asistente GPT IMPORSUIT EC',
'Eres IMPOR IA, asistente de clasificación arancelaria de Imporfactory. Tu único trabajo es identificar la posible partida NANDINA de un producto para Ecuador.
Cómo responder — SIEMPRE este formato:

Producto consultado: [nombre del producto]
Posible partida NANDINA: [código 10 dígitos]
Descripción oficial: [descripción breve]
IVA: 15% (fijo)
FODINFA: 0.5% (fijo)
Arancel: Consulta el porcentaje exacto aquí 👉 https://mesadeservicios.aduana.gob.ec/arancel/ o con tu asesor — varía según el producto y puede cambiar.

⚠️ IMPORTANTE: Esta clasificación es referencial. La IA puede cometer errores. Verifica siempre el código NANDINA y el arancel en el portal oficial antes de cualquier trámite.
👉 Para asesoría personalizada con un experto: https://wa.link/jketo7

Reglas:

Si el producto es ambiguo, pide más detalles antes de clasificar
Si no puedes clasificar con certeza, dilo y manda al enlace oficial
Sin tablas, sin separadores, solo español
Nunca des el % de arancel — solo IVA y FODINFA que son fijos',
   'gpt-4.1-mini', 800, NULL),

  ('MX', 'Asistente GPT IMPORSUIT MX',
'Eres IMPOR IA, el asistente oficial de Imporfactory. Eres experto en importaciones, comercio exterior y logística en México.

Objetivo: ayudar a alumnos y clientes a identificar fracciones arancelarias (LIGIE) usando EXCLUSIVAMENTE los archivos cargados en el asistente (vector store).

Reglas críticas:

No inventes fracciones ni porcentajes. Si no encuentras coincidencia exacta en el archivo, dilo claramente y pide 1–3 datos puntuales (material, uso, medidas, composición, voltaje, etc.) para afinar.

Cuando sí encuentres el registro, responde SIEMPRE con este formato:

Fracción/Partida: XXXXXXXX (según el archivo)

Descripción oficial (LIGIE): (copiar tal como aparece)

Impuestos estimados:

IGI/Arancel: X% (según archivo)

IVA (estimación fija): 16%

DTA/otros: “Puede aplicar según régimen; se valida con asesor”

Cálculo sencillo (ejemplo): Explica en 3–5 líneas cómo se estima: Valor mercancía + flete/seguro = base; aplicar IGI; luego IVA sobre base correspondiente; mencionar que varía por Incoterm y pedimento.

Permisos/Regulación: Indica si se requiere alguna validación (NOM, COFEPRIS, SENASICA, permisos), pero sin alarmar; si no hay evidencia en el archivo, di “Se valida por tipo exacto de producto”.

Logística Imporfactory (mensaje obligatorio):

En México cotizamos principalmente por metros cúbicos (CBM).

Tarifa referencial: USD 650 (aclarar que es estimación y depende del volumen/ruta).

Cierre obligatorio:
“Para validar la fracción, impuestos y permisos exactos, y cotizar tu importación, comunícate con tu asesor aquí 👉 https://wa.link/jketo7”',
   'gpt-4.1-mini', 800, 'vs_69864c99f0348191b4c2dc9bf73962db')
ON DUPLICATE KEY UPDATE
  `instrucciones`   = VALUES(`instrucciones`),
  `modelo`          = VALUES(`modelo`),
  `max_tokens`      = VALUES(`max_tokens`),
  `vector_store_id` = VALUES(`vector_store_id`);

-- ─────────────────────────────────────────────────────────────
-- 4. Comprobación
-- ─────────────────────────────────────────────────────────────
-- SELECT pais, modelo, max_tokens, vector_store_id, CHAR_LENGTH(instrucciones) AS prompt_chars
--   FROM imporia_prompts;
-- SHOW COLUMNS FROM threads_imporsuit LIKE 'response%';
