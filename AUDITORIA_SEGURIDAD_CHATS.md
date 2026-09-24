# Auditoría de permisos sobre chats — 2026-09-24

Revisión de **solo lectura** del backend (`socket`) y el frontend
(`chatcenter-front`). No se explotó nada contra el servidor: todo sale de leer
el código. No se modificó ningún archivo por esta auditoría.

**Origen:** al añadir la validación de "solo el encargado o un administrador
puede transferir un chat" (`transferirChat`), los asesores empezaron a recibir
error 403 sobre chats que la interfaz sí les mostraba. Buscando por qué
aparecían esos chats se encontró que el filtro por encargado no se sostiene
fuera de la pantalla.

---

## Resumen para decidir

La lista "Mis chats / En espera" **no es un control de acceso**: es una ayuda
visual. El backend la calcula con datos que manda el propio navegador, y casi
todas las acciones sobre un chat no comprueban de quién es.

Lo importante no es el 403. Es que hoy, en la práctica:

- un asesor puede leer y contestar chats de sus compañeros;
- varias acciones no verifican siquiera que el chat sea **de la misma cuenta**,
  o sea que un cliente podría alcanzar datos de otro cliente;
- parte de eso no requiere ni haber iniciado sesión.

No hay indicios de que esto se haya usado. No se revisaron registros de
acceso; conviene hacerlo por separado.

---

## Hallazgos confirmados

Los siguientes se verificaron leyendo el código directamente.

### 1. El canal de Socket.IO no pide autenticación

`src/server.js:152` — el único espacio con verificación de sesión es
`/presence`. El canal principal, donde viven el listado de chats, la lectura de
conversaciones, la asignación de encargado y el envío de mensajes, acepta a
cualquiera que se conecte.

**Efecto:** los eventos de `src/sockets/index.js` y
`src/sockets/unified.gateway.js` son alcanzables sin sesión, sabiendo un
`id_configuracion` (un número pequeño) y un id de chat.

### 2. `GET_CHATS` confía en el rol que manda el navegador

`src/sockets/index.js:104-110` — el `id_sub_usuario` y el `rol` llegan como
argumentos del mensaje, no de una sesión verificada. En
`src/services/chat.service.js:67` el rol decide si se aplica o no el filtro por
encargado.

**Efecto:** el filtro por pestaña se puede anular desde el navegador. Es la
razón de fondo por la que "que no aparezca el chat" no puede ser la única
defensa.

### 3. `asignar_encargado` por HTTP no valida nada

`src/routes/departamentos_chat_center.routes.js:57` →
`src/controllers/departamentos_chat_center.controller.js:901` — cambia el dueño
de un chat a partir del id que venga en la petición. Es la ruta gemela de
`transferirChat`, pero sin la validación que se le agregó a esa. Tampoco
comprueba que el chat pertenezca a la cuenta de quien lo pide.

*Nota: el frontend actual no usa esta ruta; se llega a ella por la API.*

### 4. Cerrar chat, bot y remarketing identifican el chat solo por su id

`src/controllers/clientes_chat_center.controller.js:81` (`actualizar_cerrado`),
`:278` (`actualizar_bot_openia`) y `:299` (`actualizar_enviar_remarketing`) —
reciben el id del chat y actualizan por `WHERE id = ?`, sin `id_configuracion` y
sin mirar el encargado.

**Efecto:** con una sesión válida de cualquier cuenta se puede cerrar o reabrir
un chat ajeno. Cerrar además deja una nota dentro de esa conversación y, en las
cuentas que lo tengan activado, **programa una encuesta de satisfacción al
cliente real**.

### 5. Routers completos sin verificación de sesión

Verificado con búsqueda de `protect` en cada archivo de rutas:

| Router | Estado |
|---|---|
| `kanban_columnas.routes.js` | sin `protect` |
| `kanban_acciones.routes.js` | sin `protect` |
| `remarketing_pendientes.routes.js` | sin `protect` |
| `automatizador.routes.js` | sin `protect` |
| `media.routes.js` | sin `protect` |
| `webhook.routes.js` | sin `protect` |
| `whatsapp.routes.js` | solo 2 de 41 rutas |

`whatsapp_managment` incluye envío de audio, plantillas masivas y programados;
al resolver la conexión por el `id_configuracion` recibido, usa el token de
WhatsApp de esa cuenta.

---

## Reportado por la auditoría, no verificado en detalle

Se anotan como pendientes de comprobar, no como hechos.

- **Lectura de conversaciones por socket** (`GET_CHATS_BOX`, `CHAT_JOIN_CFG`,
  `GET_CELLPHONES`, `GET_DATA_ADMIN`): devolverían el historial y los contactos
  de cualquier cuenta. Es consecuencia directa del punto 1.
- **Envío de mensajes por socket** (`CHAT_SEND`, `SEND_MESSAGE` en
  `unified.gateway.js`): enviaría con el token de la cuenta indicada, firmando
  con el nombre de asesor que venga en el mensaje.
- **`POST /api/v1/whatsapp/webhook`** (`src/controllers/chat.controller.js:14`):
  además de devolver el último mensaje de un chat, reemite a todos los
  navegadores conectados, con lo que podría insertar mensajes falsos en el panel.
- **`ultimo_mensaje`** (`clientes_chat_center.controller.js:1738`): la consulta
  no incluiría `id_configuracion`.
- **Kanban y listados de contactos**: validan la cuenta contra el dato recibido,
  no contra la sesión.
- **Eventos de Dropi/Aliclik en el socket**: crearían o cancelarían pedidos
  reales usando la clave de integración de la cuenta indicada.

---

## Lo que sí está bien

- `transferirChat`: usa la sesión (`req.sessionUser`) para el actor y aplica la
  regla contra el `id_encargado` leído de la base.
- `traspasarTrasPlantilla` (`clientes_chat_center.controller.js:476`): lee el
  chat con `WHERE id = ? AND id_configuracion = ?` y rechaza si el encargado no
  es el de la sesión. **Es el patrón a copiar.**
- `chatsSinRespuesta`: toma rol y usuario de la sesión.
- `listarClientesPorEtiqueta` y `totalClientesUltimoMes`: validan que la
  configuración sea del usuario de la sesión.
- Alta, edición y borrado de departamentos: restringidos por rol.
- Espacio `/presence`: verifica el token correctamente.
- Ya existe `protectConfigOwner` (`auth.middleware.js:113`) y hace lo correcto:
  **falta usarlo**.

---

## Orden de arreglo sugerido

1. **Autenticar el canal principal de Socket.IO**, reusando el verificador que
   ya usa `/presence`, y tomar el usuario y el rol de ahí en vez de los
   argumentos del mensaje. Cierra los puntos 1 y 2 y buena parte de lo no
   verificado. *Toca a todos los clientes conectados: hay que coordinar el
   despliegue del frontend y el backend.*
2. **Un middleware de "dueño del chat"** que resuelva el chat, valide la cuenta
   contra la sesión y aplique la regla que ya existe en `puedeTransferir`.
   Aplicarlo a `asignar_encargado`, `actualizar_cerrado`, `actualizar_bot_openia`,
   `actualizar_enviar_remarketing` y los cambios de estado del kanban.
3. **`protect` en los routers que no lo tienen**, empezando por
   `whatsapp_managment`, que puede enviar mensajes.
4. **`protectConfigOwner` en las lecturas** (listados de contactos, historial de
   encargados, exportaciones).

Los puntos 2, 3 y 4 son acotados y no rompen clientes. El 1 es el que resuelve
el problema de fondo y el que hay que planificar.

---

## Cambios ya hechos en el frontend (no son el arreglo de fondo)

Corrigen que aparecieran chats ajenos en la lista; **no** impiden el acceso:

- La regla de pertenencia ahora es una sola función y se aplica igual al agregar
  y al quitar chats, en los dos avisos del socket.
- Abrir un chat por enlace (`/chat/:id`, kanban, flujos masivos, carritos) ya no
  lo mete en la lista; responderle tampoco.
- El manejador de cambios de encargado ya se da de baja: antes se acumulaba uno
  por cada chat abierto, cada uno con la pestaña que estaba activa al
  registrarse, y el resultado dependía de cuál corriera último.
- Al asignarse un chat de "En espera", ahora sale de esa lista.
