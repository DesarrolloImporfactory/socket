# Archivos default del kanban

Archivos de conocimiento que la plataforma adjunta por defecto cuando un
cliente enciende un switch de la vista kanban config. Viajan con el deploy
(por eso viven acá y NO en `src/uploads/`, que está excluido del rsync).

## AGENCIAS_SERVIENTREGA_RETIRO_OFICINA.txt

Lo usa el switch **"Retiro en agencia Servientrega"**
(`services/kanban_retiro_agencia.service.js`). Texto extraído del PDF
"DIRECTORIO DE OFICINAS SERVIENTREGA — RETIRO EN OFICINA (COD)" (2026-08-31:
597 oficinas, 220 ciudades, 23 provincias — sin Galápagos; totales
verificados contra el propio índice del documento).

Formato (contrato que el bloque del prompt asume):
- Encabezado con la regla de uso restringido (solo cuando el cliente YA
  eligió retiro; 3-5 oficinas priorizando el sector; entrega 2-3 días).
- Cuerpo agrupado `PROVINCIA: X` → `Ciudad: Y (N oficina(s))` → una entrada
  `Oficina Servientrega — Sector Z · Ciudad · Provincia` + `Dirección: ...`
  por oficina.

Si un cliente sube su propio archivo con este mismo nombre canónico, el
toggle usa el del cliente en vez de este. Si el archivo no está, el toggle de
activación falla con un error claro y no rompe nada más.
