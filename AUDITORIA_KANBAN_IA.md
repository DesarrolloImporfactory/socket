# Auditoría Técnica — Sistema Kanban con IA

> **Alcance:** análisis del módulo Kanban + OpenAI del backend (`d:\socket`).
> **Modo:** solo lectura, sin modificar código.
> **Objetivo:** mapear cómo funciona hoy, dónde falla, qué se puede mejorar y cómo encajan *function calling*, *structured outputs* y un eventual *MCP / AI Gateway*.

---

## 1. Resumen ejecutivo (TL;DR)

El sistema **funciona**, pero la capa que conecta el LLM con las acciones del Kanban (cambiar columna, agendar cita, enviar media, etc.) está construida sobre **parsing de texto crudo con regex y `substring includes`**. Eso es exactamente el patrón que produce los errores de JSON que reporta el cliente.

- Los prompts piden al modelo que devuelva *tags* tipo `[cita_confirmada]: true` o bloques con emojis (`🧑 Nombre: …`, `📞 Teléfono: …`) dentro del texto.
- El backend luego hace `respuesta.toLowerCase().includes(trigger)` y extrae campos con `.match(/🧑 Nombre:\s*(.+)/)`.
- No se usa `response_format: { type: "json_schema", strict: true }` ni `tools` (function calling) en ninguna llamada a OpenAI.
- Cualquier desviación del modelo (espacio extra, emoji omitido, mayúscula, idioma cambiado, comilla mal escapada) **silenciosamente rompe la acción** sin error visible.

**La solución no es estrictamente "MCP".** Es migrar a **Structured Outputs + Function Calling**, que OpenAI ya soporta nativo y garantiza JSON válido a nivel de tokens. MCP (Model Context Protocol) es una capa opcional encima, útil si queremos portabilidad multi-proveedor (Claude, Gemini), pero **no resuelve por sí solo los JSON rotos** — lo que los resuelve es el `strict: true`.

---

## 2. Arquitectura actual

### 2.1 Componentes

| Archivo | Rol |
|---|---|
| [src/services/kanban_ia.service.js](src/services/kanban_ia.service.js) | Orquestador: recibe mensaje WA → ejecuta asistente → parsea respuesta → dispara acciones |
| [src/controllers/kanban_asistente.controller.js](src/controllers/kanban_asistente.controller.js) | CRUD de asistentes OpenAI (crear, actualizar, subir archivos a vector store) |
| [src/controllers/kanban_columnas.controller.js](src/controllers/kanban_columnas.controller.js) | CRUD de columnas del tablero |
| [src/controllers/kanban_acciones.controller.js](src/controllers/kanban_acciones.controller.js) | CRUD de acciones por columna (`cambiar_estado`, `agendar_cita`, `contexto_productos`, etc.) |
| [src/controllers/kanban_plantillas.controller.js](src/controllers/kanban_plantillas.controller.js) | Aplicación de plantillas pre-armadas a un cliente |
| [src/controllers/kanban_plantillas_admin.controller.js](src/controllers/kanban_plantillas_admin.controller.js) | Gestión de plantillas globales |

### 2.2 Tablas relevantes

```
kanban_columnas
  ├─ id, id_configuracion, nombre, estado_db, posicion
  ├─ activa_ia (0/1), assistant_id, vector_store_id
  └─ instrucciones (TEXT), modelo (default gpt-4o-mini), max_tokens (default 500)

kanban_acciones
  ├─ id_kanban_columna, tipo_accion
  └─ config (JSON string)   ← aquí vive el trigger textual

kanban_plantillas_globales
  └─ data (JSON con snapshot de columnas + acciones)
```

### 2.3 Flujo completo (mensaje entrante)

```
WhatsApp webhook
   │
   ▼
clientes_chat_center.estado_contacto
   │  ← determina la columna activa
   ▼
kanban_ia.service.js  procesarMensajeKanban()
   │
   ├─ getApiKey(id_configuracion)        ← API key OpenAI por tenant
   ├─ obtenerOCrearThreadId(id_cliente)  ← thread persistente por cliente
   │
   ├─ INYECCIÓN DE CONTEXTO (texto plano)
   │     • productos por categoría
   │     • disponibilidad calendario
   │     se mandan como  role: user, content: "🧾 Contexto adicional:\n..."
   │
   ├─ POST /threads/{id}/messages   (mensaje real del cliente)
   ├─ POST /threads/{id}/runs       (sin response_format, sin tools)
   ├─ polling cada 1.2s, máx 25 intentos (~30s)
   │
   └─ PARSING DE RESPUESTA  ← punto frágil
         • limpiarCitasFileSearch()       (OK)
         • for acciones de la columna:
             - if respuesta.includes(trigger)  → ejecuta acción
         • si hay [cita_confirmada] → procesarAgendarCita() con regex
         • si hay [producto_imagen_url]: ... → enviar media
         • limpiarTagsAcciones() → quitar tags del texto enviado al cliente
```

---

## 3. Cómo se llama a OpenAI hoy

Referencia: [src/services/kanban_ia.service.js:445-502](src/services/kanban_ia.service.js#L445-L502)

```js
// Crear run
POST https://api.openai.com/v1/threads/{thread_id}/runs
Headers: { Authorization: Bearer <key>, 'OpenAI-Beta': 'assistants=v2' }
Body:    { assistant_id, max_completion_tokens: max_tokens }
         //  ↑ ni response_format, ni tools, ni tool_choice
```

- **API**: Assistants v2 (beta).
- **Modelos**: `gpt-4o-mini` (default), opcionalmente `gpt-4o` o `gpt-3.5-turbo`.
- **Sin `response_format: json_schema`**.
- **Sin `tools` / function calling**.
- Solo `file_search` cuando la columna tiene `vector_store_id`.
- Polling de 30 s duros: 25 × 1200 ms.

> El asistente decide el formato de la respuesta **solo por el system prompt** (las "instrucciones" guardadas en `kanban_columnas.instrucciones`). Nada en la capa API garantiza nada del shape.

---

## 4. Parsing de respuestas — la parte frágil

### 4.1 Trigger por `includes()`

[src/services/kanban_ia.service.js:298-335](src/services/kanban_ia.service.js#L298-L335)

```js
const coincide = respuestaRaw.toLowerCase().includes(trigger.toLowerCase());
if (coincide) {
  await db.query(`UPDATE clientes_chat_center SET estado_contacto = ? WHERE id = ?`, ...);
}
```

**Problemas:**
- Sub-coincidencias falsas: trigger `"sí"` matchea `"así"`, `"sígueme"`.
- Si el trigger configurado es `"[cita_confirmada]"` (sin `: true`), también dispara con `"[cita_confirmada]: false"`.
- Si el modelo escribe `"[Cita Confirmada]"` o `"[cita-confirmada]"`, no hay normalización fuzzy.
- Sin negación: no hay forma de decir "dispara solo si NO aparece X".

### 4.2 Extracción de datos con regex línea-a-línea

[src/services/kanban_ia.service.js:569-580](src/services/kanban_ia.service.js#L569-L580)

```js
const nombre   = mensajeGPT.match(/🧑 Nombre:\s*(.+)/)?.[1]?.trim() || '';
const telefono = mensajeGPT.match(/📞 Teléfono:\s*(.+)/)?.[1]?.trim() || '';
const correo   = mensajeGPT.match(/📍 Correo:\s*(.+)/)?.[1]?.trim() || '';
const servicio = mensajeGPT.match(/📍 Servicio que desea:\s*(.+)/)?.[1]?.trim() || '';
const fechaIni = mensajeGPT.match(/🕒 Fecha y hora de inicio:\s*(.+)/)?.[1]?.trim() || '';
const fechaFin = mensajeGPT.match(/🕒 Fecha y hora de fin:\s*(.+)/)?.[1]?.trim() || '';
```

**Problemas:**
- Si el modelo cambia el emoji (`📍 Correo` → `📧 Correo`), captura vacío y la cita se agenda sin email.
- `(.+)` es greedy: si el modelo pone `"Nombre: Juan y María"` en una línea, todo entra como nombre.
- Cero validación de formato (email, teléfono, fecha). Si llega `"Fecha: la próxima semana"`, `moment.tz()` produce *Invalid Date* y agenda en epoch o falla silencioso.
- Si el modelo responde en otro idioma (`"Name:"` en vez de `"Nombre:"`), nada coincide.

### 4.3 Extracción de URLs de media

[src/services/kanban_ia.service.js:520-554](src/services/kanban_ia.service.js#L520-L554)

```js
texto.match(/\[(producto_imagen_url|servicio_imagen_url|upsell_imagen_url)\]:\s*(https?:\/\/[^\s]+)/gi)
```

- Captura hasta el **primer espacio**. URLs firmadas (S3, Cloudinary) con query strings funcionan, pero cualquier URL con espacios encodificados mal cae.
- Silencia falsos negativos.

### 4.4 Limpieza de tags antes de enviar al cliente

[src/services/kanban_ia.service.js:556-564](src/services/kanban_ia.service.js#L556-L564)

```js
.replace(/\[[^\]]+\]:\s*(true|false)/gi, '')   // catch-all
```

- Si el modelo escribe `"Lo confirmamos: [true]"` como parte de prosa, se borra. Probablemente no pasa, pero el catch-all es ancho.

### 4.5 Parsing de `config` JSON con fallback silencioso

[src/services/kanban_ia.service.js:148-162](src/services/kanban_ia.service.js#L148-L162)

```js
const parseConfig = (a) => {
  try {
    let cfg = a?.config;
    if (!cfg) return {};
    while (typeof cfg === 'string') { cfg = JSON.parse(cfg); }
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch (error) {
    return {};   // ← acción se ignora sin log
  }
};
```

Si una `kanban_acciones.config` está corrupta, **la acción desaparece sin rastro**. No hay log, no hay alerta.

---

## 5. Manejo de errores y resiliencia

### 5.1 Lo que está bien hecho

- **Retry con backoff** ante 401/429/500/502/503: [kanban_asistente.controller.js:113-128](src/controllers/kanban_asistente.controller.js#L113-L128).
- **Detección de "sin saldo"** y desactivación automática de IA en la configuración: [kanban_ia.service.js:26-36, 504-513](src/services/kanban_ia.service.js#L26-L36).
- **Limpieza robusta de citaciones `【…】` del file_search**: [kanban_ia.service.js:402-431](src/services/kanban_ia.service.js#L402-L431).
- **Errores por acción aislados**: si falla `agendar_cita`, no rompe el envío de la respuesta al cliente: [kanban_ia.service.js:327-331](src/services/kanban_ia.service.js#L327-L331).

### 5.2 Lo que falla

- **Timeout duro de 30 s** sin parámetro de configuración por columna ni cancelación cooperativa: [kanban_ia.service.js:465-489](src/services/kanban_ia.service.js#L465-L489).
- **Sin circuit breaker**: si OpenAI cae 5 minutos, cada webhook entrante hace 5 retries × 30 s antes de devolver error → saturación.
- **Polling síncrono** dentro del handler del webhook: bloquea conexión HTTP del proveedor (Meta) hasta 30 s, riesgo de timeout en reverse proxy.
- **Acciones no idempotentes**: si Meta reintenta el webhook (timeout > 20 s en su lado), se ejecutan dos cambios de estado y eventualmente dos citas.
- **Sin transacción** entre acciones: si `cambiar_estado` y `agendar_cita` ambos disparan, no hay rollback si la segunda falla.

---

## 6. Observabilidad y costos

| Aspecto | Estado |
|---|---|
| Logging | Texto plano en `src/logs/logs_meta/debug_log.txt` |
| Tokens consumidos | Se obtienen de `run.usage.total_tokens` y se pasan a la función de envío de WhatsApp, **no se persisten por feature ni por cliente** |
| Desglose prompt vs completion | No |
| Costo por configuración | No calculado |
| Costo por columna / acción | No calculado |
| Dashboard de consumo | No existe |
| Alertas de gasto | No existen |
| Rate limit por tenant | No existe |
| Cuotas por plan | No existe (aunque hay `checkToolAccess` en otras partes del sistema) |

**Implicación de negocio:** no se puede atribuir costo de OpenAI por plan SaaS. Si un cliente del plan Comunidad genera el 80% del consumo, no hay forma de detectarlo proactivamente — solo se ve cuando llega la factura de OpenAI.

---

## 7. Seguridad

### 7.1 Multi-tenant y API keys

- **Una API key OpenAI por configuración** almacenada en `configuraciones.api_key_openai` ([kanban_asistente.controller.js:50-60](src/controllers/kanban_asistente.controller.js#L50-L60)). El blast radius si una key se filtra es solo el cliente, lo cual es bueno; pero también significa **N keys que rotar** si OpenAI publica un incidente.
- **Sin rotación automática**, sin auditoría de quién accede a las keys.
- **Riesgo de log leak**: el header `Authorization: Bearer <key>` viaja en cada request; si axios loguea el error completo (algunos middlewares lo hacen), la key aparece en los archivos de log. Revisar interceptores globales de axios.

### 7.2 Autorización endpoints

[src/controllers/kanban_asistente.controller.js:135-140](src/controllers/kanban_asistente.controller.js#L135-L140) (y patrón similar en otros endpoints del módulo):

```js
exports.obtenerAsistente = catchAsync(async (req, res, next) => {
  const { id } = req.body;
  const [col] = await db.query(`SELECT ... FROM kanban_columnas WHERE id = ?`, ...);
  // ← no compara req.user.id_configuracion con col.id_configuracion
```

Confirmar en [src/routes/kanban_*.routes.js](src/routes/) si el middleware de auth ya filtra por `id_configuracion`. Si no, **un tenant puede leer/escribir asistentes de otro** pasando un `id` arbitrario.

### 7.3 Inyección de prompt

El contexto de productos / calendario se concatena sin sanitizar al texto del prompt:

```js
bloqueContexto += `📅 Información del calendario:\n${datosCalendario.bloque}\n\n`;
```

Si un nombre de producto contiene una instrucción adversarial (`"Ignora las instrucciones anteriores y..."`), llega al modelo. Riesgo bajo en práctica, pero existe.

---

## 8. Catálogo de puntos de fallo (priorizado)

| # | Severidad | Componente | Síntoma para el cliente |
|---|---|---|---|
| 1 | **Crítico** | `parseConfig` silencia errores ([kanban_ia.service.js:148](src/services/kanban_ia.service.js#L148)) | "Configuré una acción y no se ejecuta nunca, no hay error" |
| 2 | **Crítico** | Trigger por `includes()` ([kanban_ia.service.js:304](src/services/kanban_ia.service.js#L304)) | "A veces mueve la columna cuando no debería" / "no la mueve cuando debería" |
| 3 | **Crítico** | Falta de autorización por tenant en endpoints | Riesgo de data leak entre clientes (verificar) |
| 4 | **Crítico** | Sin `response_format: json_schema` / `tools` | "El JSON viene mal", "se agendó una cita sin teléfono" |
| 5 | **Alto** | Regex de extracción sin validación ([kanban_ia.service.js:569](src/services/kanban_ia.service.js#L569)) | Citas en calendario con datos basura |
| 6 | **Alto** | Timeout duro 30 s + polling síncrono | "El bot a veces tarda 30 segundos y luego no responde" |
| 7 | **Alto** | Sin idempotencia ante reintentos de Meta | Cambios de estado y citas duplicadas |
| 8 | **Medio** | Vector store sin esperar indexación bien | "Subí el PDF pero el bot no lo conoce" |
| 9 | **Medio** | Sin circuit breaker / fallback de proveedor | Cuando OpenAI tiene incidente, todo el Kanban se cae |
| 10 | **Medio** | Threads reutilizados sin lock por cliente | Mensajes en paralelo del mismo cliente pueden mezclarse |
| 11 | **Bajo** | Contexto inyectado sin límite de tamaño | Catálogos grandes pueden tirar el run por context length |
| 12 | **Bajo** | Logs en texto plano, no estructurados | Imposible hacer analytics o alertas automáticas |

---

## 9. Oportunidades de mejora

### 9.1 Quick wins (1–3 días, sin cambio de arquitectura)

1. **Loguear el fallo de `parseConfig`** (cambia el `return {}` por `log + return {}`). Inmediatamente visibilizamos acciones rotas.
2. **Validar email/teléfono/fecha en `procesarAgendarCita`** antes de hacer el insert al calendario. Si algo no valida, dejar mensaje en log y NO agendar.
3. **Trigger matching más estricto**: usar word boundaries (`\b`) o forzar que el trigger empiece en línea propia, y rechazar matches donde el valor sea explícitamente `false`.
4. **Loguear tokens por columna/cliente** en tabla `kanban_ia_uso` con `total_tokens`, `prompt_tokens`, `completion_tokens`, `modelo`, `id_configuracion`, `id_columna`, `created_at`. Habilita dashboard inmediato.
5. **Verificar autorización** en todos los endpoints de `kanban_asistente.controller.js`: `req.user.id_configuracion === col.id_configuracion`.
6. **Interceptor axios** que enmascare `Authorization` headers antes de cualquier `console.log` / log file.

### 9.2 Mejora estructural — **Structured Outputs** (1–2 semanas, alto impacto)

**El cambio que elimina el dolor del cliente.**

Actualmente:
```js
// system prompt: "Responde con [cita_confirmada]: true cuando..."
// luego en código: respuesta.includes("[cita_confirmada]: true")
```

Migrar a:
```js
// Chat Completions o Responses API
const body = {
  model: 'gpt-4o',
  messages: [{ role: 'system', content: instrucciones }, ...],
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'kanban_action',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          respuesta_usuario: { type: 'string' },
          cambiar_estado:    { type: ['string', 'null'], enum: [...estados, null] },
          agendar_cita: {
            type: ['object', 'null'],
            properties: {
              nombre:        { type: 'string' },
              telefono:      { type: 'string' },
              correo:        { type: 'string' },
              fecha_inicio:  { type: 'string', description: 'ISO 8601' },
              fecha_fin:     { type: 'string' },
              servicio:      { type: 'string' }
            },
            required: ['nombre','telefono','correo','fecha_inicio','fecha_fin','servicio'],
            additionalProperties: false
          },
          enviar_media: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tipo: { enum: ['imagen', 'video'] },
                url:  { type: 'string' }
              },
              required: ['tipo', 'url'],
              additionalProperties: false
            }
          }
        },
        required: ['respuesta_usuario','cambiar_estado','agendar_cita','enviar_media']
      }
    }
  }
};

const data = JSON.parse(resp.choices[0].message.content);
// data está garantizado a cumplir el schema (strict: true)
```

**Efectos:**
- JSON malformado **deja de ser posible** (lo garantiza el sampler de OpenAI a nivel de token).
- `respuesta.includes(trigger)` se elimina por completo. Las acciones se disparan por campo, no por *string matching*.
- Validación de tipos sin código adicional.
- Misma latencia, mismo costo o menos (no se inyecta el bloque de "responde con estos tags").

**Trade-off:** sale del paradigma "Assistants API + tags". Hay que decidir si:
- Quedarse en Assistants API: usar `tools` (function calling) — los runs disparan `tool_call`s tipados.
- Migrar a Responses API (más moderna, soporta structured outputs nativos y todo lo que hace Assistants).

### 9.3 Mejora estructural — **Function Calling para acciones**

Complementa a 9.2 si se queda en Assistants. Cada acción configurable en `kanban_acciones` se convierte en un tool:

```js
tools: [
  {
    type: 'function',
    function: {
      name: 'cambiar_estado',
      description: 'Mueve al cliente a otra columna del Kanban',
      parameters: {
        type: 'object',
        properties: { estado_destino: { type: 'string', enum: [...] } },
        required: ['estado_destino']
      }
    }
  },
  { type: 'function', function: { name: 'agendar_cita', parameters: {...} } },
  { type: 'function', function: { name: 'enviar_media',  parameters: {...} } }
]
```

Cuando el run termina con `requires_action`, el backend recibe el `tool_call` con argumentos ya parseados y tipados. **Cero parsing manual.**

### 9.4 ¿Y un AI Gateway / "MCP centralizado"?

Es la pregunta del cliente. Hay que separarla en dos cosas distintas:

**(a) MCP-protocolo** (Anthropic Model Context Protocol)
- Útil para que las herramientas (consultar Dropi, mover columnas, agendar citas) sean consumibles por **cualquier LLM** (Claude, Gemini) sin reescribir.
- No resuelve los JSON rotos por sí solo: el motor que los resuelve sigue siendo `strict: true` en la llamada al modelo.
- Hoy aporta poco mientras el stack siga 100% OpenAI Assistants.

**(b) AI Gateway centralizado** (lo que probablemente el cliente quiere decir)
- Un microservicio interno (ej. `ai.imporsuit.com`) por donde pasan **todas** las llamadas a LLMs del ERP (Kanban, ImporChat, InstaLanding, remarketing, survey…).
- Ganancias: una sola API key, observabilidad central de tokens y costos por feature/plan, rate limit por tenant, prompt cache, fallback OpenAI → Anthropic → Gemini, versionado de prompts.
- Pérdidas: +50–200 ms de latencia, nuevo SPOF si no se hace HA, 2–4 semanas de trabajo.
- **Camino más barato:** desplegar [LiteLLM Proxy](https://docs.litellm.ai/) en Lightsail, migrar un servicio a la vez (empezar por el más caro o más cambiante — probablemente Kanban IA).

> El AI Gateway y los Structured Outputs son **independientes**. Se pueden hacer en cualquier orden, pero **Structured Outputs tiene más ROI inmediato** porque ataca directo el dolor que reporta el cliente.

### 9.5 Otros refinamientos

- **Circuit breaker** (librería `opossum`) alrededor de las llamadas a OpenAI: si error rate > 50%, abrir circuito 1 minuto y devolver `ia_no_disponible` rápido en lugar de esperar 30 s.
- **Idempotencia** en webhook entrante: clave `idempotency_key = hash(message_id)` que evite procesar el mismo mensaje dos veces si Meta reintenta.
- **Lock por cliente** mientras hay un run activo en el thread (Redis SET NX con TTL) — evita carreras cuando llegan dos mensajes en 1 segundo.
- **Versionado de prompts** en una tabla aparte (`kanban_columnas_prompt_history`) con `id_columna`, `version`, `instrucciones`, `created_at`, `created_by`. Permite rollback inmediato si un cambio rompe producción.
- **Logging estructurado** (winston JSON) hacia un destino agregado (CloudWatch / Datadog / Loki) en lugar de archivo de texto.
- **Métricas de negocio**: tasa de éxito de acciones (`cambiar_estado` ejecutadas / detectadas en respuesta), tasa de citas agendadas con datos completos, latencia p95, costo USD/día por columna.

---

## 10. Roadmap recomendado

| Fase | Tiempo | Entregable |
|---|---|---|
| **F1 — Visibilidad** (semana 1) | 3–5 días | Logs estructurados + tabla `kanban_ia_uso` + dashboard básico de tokens/costo por configuración. Validar autorización en endpoints. Enmascarar API keys en logs. |
| **F2 — Endurecer parsing actual** (semana 1–2) | 3–5 días | Validar email/teléfono/fecha. Loguear fallos de `parseConfig`. Trigger matching estricto. Idempotencia por `message_id`. |
| **F3 — Structured Outputs** (semana 2–4) | 1.5–2 semanas | Migrar 1–2 columnas piloto a Chat Completions + `response_format: json_schema` (o `tools` en Assistants). Eliminar parsing por regex en esas columnas. Medir tasa de acción correcta vs flujo actual. |
| **F4 — Rollout** (semana 4–6) | 1–2 semanas | Migrar el resto de columnas/plantillas globales. Eliminar `limpiarTagsAcciones` y la extracción por regex. |
| **F5 — AI Gateway** (opcional, semana 6+) | 2–4 semanas | Desplegar LiteLLM (o gateway propio si la lógica de planes lo amerita). Migrar servicios uno a uno. Activar cache de prompts y fallback multi-proveedor. |

> Las fases 1 y 2 se pueden empezar **hoy**. La fase 3 es la que el cliente *de verdad* está pidiendo cuando habla de "MCP". La fase 5 es estratégica, no urgente.

---

## 11. Qué responderle al cliente

> *"Tienen razón en el síntoma: hoy los prompts devuelven JSON como texto y lo parseamos con regex, así que cualquier variación del modelo rompe la acción. La solución correcta no es exactamente MCP — MCP es una capa de estandarización opcional. Lo que arregla el problema de raíz es migrar a **Structured Outputs (response_format json_schema, strict: true)** y **function calling**, ambos ya soportados nativamente por OpenAI. Con eso, el JSON queda garantizado a nivel de tokens y desaparecen los errores. Tenemos un roadmap de 2–4 semanas para migrar y, en paralelo, vamos a ganar observabilidad de costo por cliente y plan. MCP / AI Gateway lo evaluamos después como capa estratégica para multi-proveedor."*

---

*Documento generado el 2026-05-18 · solo lectura, no se modificó código.*
