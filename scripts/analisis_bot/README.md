# Medición del bot con datos reales (una pasada por cuenta)

Tres scripts de solo lectura que cargan la cohorte de los últimos N días a
memoria por cuenta (consultas indexadas: `idx_mensajes_rol_config` en
mensajes y `idx_cc_cfg_deleted_created` en contactos; nada de `RAND()` ni
subconsultas correlacionadas sobre toda la tabla). México tarda ~40 s,
Ecuador ~2,5 min contra la BD compartida.

- `node scripts/analisis_bot/panorama.js mx|ec [dias=7] [salida.json]` —
  embudo (chats IA, respondieron, cerraron) y las hipótesis medidas: H1 foto
  adjunta en listados, H2 "déjame revisar el catálogo" (disparos, falsos,
  qué pasó después), H3 objeción de precio y qué contesta el bot, H4 pidió
  precio y calló, H5 "¿tienen X?" fuera de catálogo, H6 "¿solo eso tienen?",
  H8 wizard con precio vs sin wizard; último mensaje del cliente y del bot
  más frecuentes; tabla por cuenta.
- `node scripts/analisis_bot/precio.js mx|ec [dias=7] [solo_modelo]` — la
  respuesta a la PRIMERA pregunta de precio: quién contestó, si dio el
  precio, si listó combos, qué preguntó al final, foto/video, latencia, y
  para cada corte cuántos volvieron a escribir y cuántos cerraron (también
  por cuenta). `solo_modelo` deja fuera el wizard, el colchón y las
  respuestas rápidas. Sirve para leer el experimento A/B de precio en México
  (kanban_ia.service: `AB_PRECIO_MX`, brazo B = id de cliente par).
- `node scripts/analisis_bot/objecion.js mx|ec [dias=7]` — primera objeción
  de precio del cliente ("está caro", "lo pienso", "presupuesto"…) y qué
  contestó el bot (repite ciudad, se despide, pregunta cantidad, argumenta
  valor, ofrece descuento, asesor), con % que volvió y % que cerró por tipo;
  también "¿hay descuento?" y "¿solo eso tienen?". Sirve para leer el bloque
  de objeción de kanban_ia (`OBJECION_PRECIO_ACTIVA`, log `💬 [objeción
  precio]`).
- `node scripts/analisis_bot/remk.js mx|ec [dias=7]` — cada mensaje de
  remarketing (cron) agrupado por su arranque: cuántos se mandaron, % que
  contestó en 24 h y % de esos chats que cerró.

Cierre = `estado_contacto` actual en generar_guia o más allá (misma
definición que el tablero Salud del bot). Las ventanas excluyen el día en
curso. Línea base medida del 11 al 17 de octubre de 2026 en
`[[precio-silencio-ab-mx]]` (memoria de Claude).
