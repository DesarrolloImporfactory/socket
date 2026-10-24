/* Textos FIJOS que el bot de soporte de Expertos le manda al cliente. Viven en
   un solo lugar porque los usan el prompt, la guardia de respuestas (son el
   reemplazo cuando el modelo se sale de la regla) y las pruebas.

   Los aprueba Daniel antes de abrir el bot a clientes reales. Ninguno promete
   una hora ni un día: solo «apenas abramos». Tuteo ecuatoriano, sin voseo. */

'use strict';

const LINKS = {
  plataforma: 'https://imporfactory.app',
  // Enlace fijo de la clase en vivo: abre la sala solo cuando el calendario de
  // la plataforma dice que hay clase (imporsuit-pro, docs/enlace_clase.md).
  clase: 'https://new.imporsuitpro.com/clase',
  // Las 6 herramientas de «Importaciones» en la plataforma nueva (imporfactory.app,
  // rutas sacadas de su código el 18-oct-2026). El bot manda al cliente a la
  // herramienta exacta en vez de pasarlo a un asesor.
  importaciones: 'https://imporfactory.app/importaciones',
  ideasProductos: 'https://imporfactory.app/ideas-productos',
  proveedores: 'https://imporfactory.app/proveedores',
  calculadora: 'https://imporfactory.app/calculadora',
  seguimientoCarga: 'https://imporfactory.app/seguimiento-carga',
  infoaduana: 'https://imporfactory.app/infoaduana',
  imporia: 'https://imporfactory.app/imporia',
  checklist: 'https://imporfactory.app/checklist',
  cursoMetodoYuan: 'https://imporfactory.app/cursos/30',
};

/* ── Los de la versión 1 (sin cambios) ── */
// La segunda mitad del paso a asesor. La guardia la agrega cuando el modelo
// contestó con una ficha que pasa a una persona y se olvidó de decirlo.
const CIERRE_ASESOR = 'Un asesor lo revisa y te escribe apenas abramos.';
const MENSAJE_ASESOR = `Recibí tu mensaje. ${CIERRE_ASESOR}`;
const MENSAJE_SALUDO =
  'Hola. Cuéntame qué necesitas. Si hace falta un asesor, lo dejo anotado para que te escriba apenas abramos.';
const MENSAJE_RECIBIDO = 'Recibido. Lo sumo a tu caso para el asesor.';
const MENSAJE_ARCHIVO = 'Recibí lo que enviaste. Un asesor lo revisa y te escribe apenas abramos.';
const MENSAJE_CLASE = `El enlace para entrar a la clase en vivo es siempre el mismo: ${LINKS.clase}
Se abre 30 minutos antes de cada clase. Fuera de ese rato te muestra cuándo es la próxima, con la hora de Ecuador y la de México. Las clases anteriores quedan grabadas en la plataforma.`;
const MENSAJE_ROBOT = 'Soy el asistente automático de IMPORFACTORY. Un asesor te escribe apenas abramos.';
// Lo que recibe el cliente si OpenAI falla (ia_ajustes → mensaje_fallback).
const MENSAJE_FALLBACK = 'Recibimos tu mensaje. Un asesor te escribe apenas abramos.';

/* ── Nuevos de la versión 2 (pendientes de aprobación) ── */
// Preguntó por su carga y con su número no hay ninguna en curso.
const MENSAJE_SIN_CARGA =
  'Con el número desde el que me escribes no encuentro una carga en curso; puede estar registrada con otro teléfono. Envíame tu marca de envío o tu número de cotización y lo dejo anotado para el área de logística. Un asesor te escribe apenas abramos.';
// Hay carga, pero el dato del sistema no se puede informar sin que lo vea una persona.
const MENSAJE_CARGA_A_LOGISTICA =
  'Recibí tu mensaje. El área de logística revisa tu carga y un asesor te escribe apenas abramos.';
// Pide la carga de otra persona, de otro número o con un código que no es suyo.
const MENSAJE_SOLO_TU_NUMERO =
  'Por seguridad, por este chat solo puedo informar la carga registrada con el número desde el que escribes. Un asesor revisa tu consulta y te escribe apenas abramos.';
// Mandó un archivo, un video o un audio que no se pudo leer y no dijo para qué.
const MENSAJE_ADJUNTO_SIN_TEXTO =
  'Recibí lo que enviaste, pero no lo puedo abrir. Cuéntame en un mensaje qué necesitas con eso y lo dejo anotado para el asesor.';

/* ── Tras la prueba en papel de la versión 2 (pendientes de aprobación) ──
   No traen palabras nuevas: son «Entiendo tu preocupación.» (que el prompt ya
   mandaba ante un reclamo) más un texto fijo. Están aquí porque ahora también
   los pone el CÓDIGO cuando el modelo manda un reclamo a cobranza o le repite
   el estado de la carga a quien reclama por la demora. */
const FRASE_RECLAMO = 'Entiendo tu preocupación.';
const MENSAJE_RECLAMO = `${FRASE_RECLAMO} ${MENSAJE_ASESOR}`;
const MENSAJE_RECLAMO_CARGA = `${FRASE_RECLAMO} ${MENSAJE_CARGA_A_LOGISTICA}`;

/* La ficha `cotizar-datos` ya no pide la cantidad (para no pedirla dos veces):
   la pide el prompt junto con el paso a asesor. Si el modelo manda la ficha
   sola y la guardia le completa el paso, también completa este pedido, salvo
   que el cliente ya haya dicho cuántas unidades quiere (senales.dioCantidad).
   Es la misma frase que trae la ficha `cotizar-producto-del-catalogo`. */
const PREGUNTA_CANTIDAD = 'Dime cuántas unidades piensas comprar.';

const TODOS = {
  MENSAJE_ASESOR,
  MENSAJE_SALUDO,
  MENSAJE_RECIBIDO,
  MENSAJE_ARCHIVO,
  MENSAJE_CLASE,
  MENSAJE_ROBOT,
  MENSAJE_FALLBACK,
  MENSAJE_SIN_CARGA,
  MENSAJE_CARGA_A_LOGISTICA,
  MENSAJE_SOLO_TU_NUMERO,
  MENSAJE_ADJUNTO_SIN_TEXTO,
  MENSAJE_RECLAMO,
  MENSAJE_RECLAMO_CARGA,
};

/* ── Diagnóstico de la cuenta IMPORCHAT del alumno (pendientes de aprobación) ──
   Los usa SOLO la herramienta revisar_mi_imporchat (diagnosticoCuenta.js).
   Van aparte de TODOS / TEXTOS_FIJOS a propósito: esos respaldan todos los
   turnos en la guardia, y el bot no puede decir «tu llave está sin saldo» sin
   haber revisado la cuenta. Rutas del panel sacadas del front (AGENT_PLAN.md,
   «Rutas del panel»). `{desde}` = « desde el 22-oct» (solo el plan: las fechas
   de WhatsApp y de la IA se reescriben en cada chequeo y no dicen cuándo empezó).
   `informativo` = se nombra, pero no explica por sí solo que el bot no conteste.

   Los tutoriales son las clases del curso de IMPORCHAT (curso 32) que ya usan
   las fichas del bot (fichas_bot.json, campo `enlace`). */
const CURSO_IMPORCHAT = 'https://imporfactory.app/cursos/32?contenido=';
const TUTORIALES = Object.freeze({
  openai: { titulo: 'Conectar IMPORCHAT con Open IA', enlace: `${CURSO_IMPORCHAT}655` },
  whatsapp: { titulo: 'Conecta WhatsApp Business con IMPORCHAT y Meta', enlace: `${CURSO_IMPORCHAT}654` },
  pago_meta: { titulo: 'Solucionar error en el método de pago en Meta', enlace: `${CURSO_IMPORCHAT}634` },
  kanban: { titulo: 'Instala las plantillas Kanban y tablero de clientes', enlace: `${CURSO_IMPORCHAT}658` },
  prompt: { titulo: 'Optimiza y personaliza el prompt de tu bot', enlace: `${CURSO_IMPORCHAT}869` },
  cuenta: { titulo: 'Crea tu cuenta en IMPORCHAT', enlace: `${CURSO_IMPORCHAT}651` },
});

const RUTA_ASISTENTES = 'Integraciones → Asistentes AI';
const RUTA_COLUMNAS = 'Agentes → Configurar agentes → la columna → pestaña «Asistente»';

/* clave: { texto, tutorial?: clave de TUTORIALES, asesor?: true (el alumno no
   lo arregla solo), corto: lo que se dice en «Además: …» } */
const DIAGNOSTICO = Object.freeze({
  // ── Plan y conexión (D1)
  conexion_suspendida: { texto: 'Esta conexión está eliminada en IMPORCHAT y no se puede reactivar desde el panel.', asesor: true, corto: 'la conexión está eliminada' },
  configuracion_inexistente: { texto: 'No encuentro esta conexión en IMPORCHAT.', asesor: true, corto: 'no encuentro la conexión' },
  sin_usuario: { texto: 'Esta conexión no está ligada a ninguna cuenta de IMPORCHAT.', asesor: true, corto: 'la conexión no tiene cuenta' },
  cuenta_suspendido: { texto: 'Tu cuenta de IMPORCHAT está suspendida, por eso el bot no contesta.', asesor: true, corto: 'tu cuenta está suspendida' },
  cuenta_cancelado: { texto: 'Tu cuenta de IMPORCHAT está cancelada, por eso el bot no contesta.', asesor: true, corto: 'tu cuenta está cancelada' },
  sin_plan: { texto: 'Tu cuenta no tiene un plan activo, por eso el bot no contesta. Entra a «Planes y facturación» y elige un plan (lo hace el administrador de la cuenta).', corto: 'no tienes plan' },
  plan_vencido: { texto: 'Tu plan de IMPORCHAT venció{desde}, por eso el bot dejó de contestar. Entra a «Planes y facturación» → «Renovar plan» (lo hace el administrador de la cuenta).', corto: 'tu plan venció' },
  plan_inactivo: { texto: 'Tu plan de IMPORCHAT no está activo, por eso el bot no contesta. Entra a «Planes y facturación» → «Renovar plan» (lo hace el administrador de la cuenta).', corto: 'tu plan no está activo' },
  plan_descatalogado: { texto: 'Tu plan de IMPORCHAT ya no existe en el catálogo, por eso el bot no contesta. Entra a «Planes y facturación» y elige un plan vigente.', corto: 'tu plan ya no existe' },
  // ── WhatsApp (D2)
  wa_sin_vincular: { texto: 'Tu número de WhatsApp no está vinculado a esta conexión. Entra a «Conexiones» → la tarjeta del número → «Conectar».', tutorial: 'whatsapp', corto: 'el WhatsApp no está vinculado' },
  wa_reconectar: { texto: 'Tu WhatsApp está desconectado de IMPORCHAT: por eso no te llegan los mensajes. Entra a «Conexiones» → la tarjeta del número → «Reconectar».', tutorial: 'whatsapp', corto: 'el WhatsApp está desconectado' },
  wa_token_vencido: { texto: 'El permiso de Meta para tu WhatsApp venció. Entra a «Conexiones» → la tarjeta del número → «Reconectar» para renovarlo.', tutorial: 'whatsapp', corto: 'venció el permiso de Meta' },
  wa_no_registrado: { texto: 'Tu número dejó de estar registrado en la API de WhatsApp (pasa si lo volviste a verificar en la app de WhatsApp Business). Entra a «Conexiones» → la tarjeta del número → «Reconectar».', tutorial: 'whatsapp', corto: 'el número dejó de estar registrado' },
  wa_baneado: { texto: 'Meta bloqueó tu número de WhatsApp. Reconectar no lo desbloquea: hay que apelar ante Meta.', asesor: true, corto: 'Meta bloqueó el número' },
  meta_pago: { texto: 'Meta marcó un problema con el método de pago de tu cuenta de WhatsApp: sin eso no salen las plantillas. Corrígelo en el administrador de WhatsApp de Meta.', tutorial: 'pago_meta', informativo: true, corto: 'Meta tiene un problema con tu método de pago' },
  sin_conexion: { texto: 'No tienes ningún número de WhatsApp conectado a IMPORCHAT. Entra a «Conexiones» y conecta tu número.', tutorial: 'whatsapp', corto: 'no tienes número conectado' },
  // ── Interruptor (D3)
  interruptor_nunca: { texto: `Tu bot nunca se encendió. Entra a ${RUTA_ASISTENTES} → en la tarjeta «Agente de Ventas» o «Agente de Servicios» toca «Configurar», enciende «Bot activo» y «Guardar».`, tutorial: 'openai', corto: 'el bot nunca se encendió' },
  interruptor_apagado: { texto: `Tu bot está apagado. Entra a ${RUTA_ASISTENTES} → en la tarjeta «Agente de Ventas» o «Agente de Servicios» toca «Editar», enciende «Bot activo» y «Guardar».`, tutorial: 'openai', corto: 'el bot está apagado' },
  // ── Ajustes (D4): no se arreglan desde el panel
  modo_prueba: { texto: 'Tu bot está en modo de prueba: solo les contesta a {n} números.', asesor: true, corto: 'el bot está en modo de prueba' },
  fuera_de_horario: { texto: 'Ahora mismo tu bot está fuera del horario en que contesta.', informativo: true, corto: 'ahora está fuera de horario' },
  // ── IA y llave (D5)
  sin_llave_openai: { texto: `Tu cuenta no tiene llave de OpenAI, y sin ella el bot no puede contestar. Entra a ${RUTA_ASISTENTES} → «Añadir API Key», pega tu llave y «Guardar».`, tutorial: 'openai', corto: 'no tienes llave de OpenAI' },
  sin_saldo_openai: { texto: 'Tu llave de OpenAI se quedó sin saldo: por eso tu bot no contesta. Recarga en platform.openai.com → Billing. Si ya recargaste, escríbele una prueba a tu número: el bot se reactiva solo con la primera respuesta que logra.', tutorial: 'openai', corto: 'la llave de OpenAI no tiene saldo' },
  cuota_agotada_openai: { texto: 'Tu llave de OpenAI llegó a su límite de gasto: por eso tu bot no contesta. Sube el límite o recarga en platform.openai.com → Billing. Si ya lo hiciste, escríbele una prueba a tu número: el bot se reactiva solo con la primera respuesta que logra.', tutorial: 'openai', corto: 'la llave de OpenAI llegó a su límite' },
  llave_invalida_openai: { texto: `Tu llave de OpenAI no es válida o la borraron. Crea una nueva en platform.openai.com → API keys y pégala en ${RUTA_ASISTENTES} → «Editar API Key» → «Guardar».`, tutorial: 'openai', corto: 'la llave de OpenAI no es válida' },
  ia_error_openai: { texto: 'OpenAI rechazó las últimas respuestas de tu bot.', asesor: true, corto: 'OpenAI dio error' },
  sin_llave_claude: { texto: 'Tu cuenta está configurada con Claude pero no tiene su llave, y sin ella el bot no puede contestar.', asesor: true, corto: 'falta la llave de Claude' },
  sin_saldo_claude: { texto: 'Tu llave de Claude se quedó sin saldo: por eso tu bot no contesta. Recarga en console.anthropic.com → Billing. Si ya recargaste, escríbele una prueba a tu número: el bot se reactiva solo con la primera respuesta que logra.', asesor: true, corto: 'la llave de Claude no tiene saldo' },
  cuota_agotada_claude: { texto: 'Tu llave de Claude llegó a su límite de gasto. Súbelo en console.anthropic.com.', asesor: true, corto: 'la llave de Claude llegó a su límite' },
  llave_invalida_claude: { texto: 'Tu llave de Claude no es válida o la borraron.', asesor: true, corto: 'la llave de Claude no es válida' },
  ia_error_claude: { texto: 'Claude rechazó las últimas respuestas de tu bot.', asesor: true, corto: 'Claude dio error' },
  // ── Columnas (D6)
  sin_columnas: { texto: 'Tu conexión no tiene tablero de columnas, y el bot necesita uno para saber qué contestar. Instala una plantilla en «Agentes».', tutorial: 'kanban', corto: 'no tienes tablero' },
  columna_sin_ia: { texto: `Tu columna «{columna}» no tiene la IA activa{chats}, así que ahí el bot no contesta. Entra a ${RUTA_COLUMNAS} → enciende «IA activa en esta columna» → «Guardar cambios».`, tutorial: 'kanban', corto: 'hay columnas sin IA' },
  columna_sin_prompt: { texto: `La columna «{columna}» tiene la IA activa pero sin instrucciones, y así el bot no contesta. Entra a ${RUTA_COLUMNAS} → escribe las «Instrucciones (prompt)» → «Guardar cambios».`, tutorial: 'prompt', corto: 'hay columnas sin instrucciones' },
  columna_inexistente: { texto: `Tienes {n} chats en una columna que borraste o desactivaste, y ahí el bot no contesta. Vuelve a activarla en ${RUTA_COLUMNAS}, o mueve esos chats a una columna con IA.`, tutorial: 'kanban', corto: 'hay chats en una columna desactivada' },
  chats_bot_apagado_todos: { texto: 'Apagaste el bot dentro de tus {n} chats de las últimas 48 horas, así que no le contesta a nadie. Vuelve a encenderlo dentro de cada chat.', corto: 'el bot está apagado en todos tus chats' },
  chats_bot_apagado: { texto: 'Apagaste el bot dentro de {n} chats: en esos el bot no contesta hasta que lo vuelvas a encender en el chat.', informativo: true, corto: 'el bot está apagado en algunos chats' },
});

/* Frases de armado del texto del diagnóstico (no son fallas). */
const DIAGNOSTICO_FRASES = Object.freeze({
  inicio: 'Revisé tu IMPORCHAT.',
  sano: 'En las últimas 48 horas te escribieron en {n} chats y tu bot contestó en {m}: tu cuenta está bien conectada. Si lo que falla es lo que contesta tu bot, esta clase explica cómo mejorar su prompt; y si quieres, te paso con un asesor.',
  sin_causa: 'En las últimas 48 horas te escribieron en {n} chats y tu bot contestó en {m}. No encuentro la causa en tu cuenta.',
  sin_chats: 'En las últimas 48 horas nadie le escribió a tu número, así que no puedo comprobar si tu bot contesta. No encuentro una falla en tu cuenta.',
  sin_chats_con_bot: 'En las últimas 48 horas te escribieron en {t} chats, pero ninguno está donde el bot contesta (están en columnas sin IA, como «Asesor», o con el bot apagado en el chat). No encuentro otra falla en tu cuenta.',
  otra_conexion: 'Tienes otra conexión; pregúntame por ella si también falla.',
  no_verificable: 'Por este canal no puedo revisar tu cuenta de IMPORCHAT: escríbeme por WhatsApp desde el número con el que te registraste.',
  sin_cuenta: 'Con el número desde el que me escribes no encuentro una cuenta de IMPORCHAT; puede estar registrada con otro teléfono.',
  ambiguo: 'Tu número aparece en más de una cuenta de IMPORCHAT, así que no puedo revisarla por aquí.',
  error: 'No pude revisar tu cuenta de IMPORCHAT ahora.',
});

module.exports = {
  LINKS,
  ...TODOS,
  CIERRE_ASESOR,
  FRASE_RECLAMO,
  PREGUNTA_CANTIDAD,
  TEXTOS_FIJOS: Object.freeze(TODOS),
  DIAGNOSTICO,
  DIAGNOSTICO_FRASES,
  TUTORIALES,
};
