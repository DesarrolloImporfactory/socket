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
  // Clase «Medios de contacto» (Sistema 2 - Proveedores, curso 30, 5 min): cómo escribirle a un proveedor.
  claseContactarProveedor: 'https://imporfactory.app/cursos/30?contenido=383',
};

/* ── Los de la versión 1 (sin cambios) ── */
// La segunda mitad del paso a asesor. La guardia la agrega cuando el modelo
// contestó con una ficha que pasa a una persona y se olvidó de decirlo.
const CIERRE_ASESOR = 'Un asesor lo revisa y te escribe apenas abramos.';
const MENSAJE_ASESOR = `Recibí tu mensaje. ${CIERRE_ASESOR}`;
const MENSAJE_SALUDO =
  'Hola, ¿en qué te puedo ayudar?';
const MENSAJE_RECIBIDO = 'Recibido. Lo sumo a tu caso para el asesor.';
const MENSAJE_ARCHIVO = 'Recibí lo que enviaste. Un asesor lo revisa y te escribe apenas abramos.';
const MENSAJE_CLASE = `El enlace para entrar a la clase en vivo es siempre el mismo: ${LINKS.clase}
Se abre 30 minutos antes de cada clase. Fuera de ese rato te muestra cuándo es la próxima, con la hora de Ecuador y la de México. Las clases anteriores quedan grabadas en la plataforma.`;
const MENSAJE_ROBOT = 'Estás hablando con el asistente de IMPORFACTORY y te ayudo ahora mismo. Si prefieres a una persona, dímelo.';
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

/* Tramo 3 del 70 % (27-oct): el bot junta él los datos de una cotización
   nueva, de uno o dos por mensaje, y con todos llama pasar_a_humano (motivo
   cotizacion) con un resumen. Este es el cierre que devuelve la herramienta;
   el resumen va en la nota interna para el área de precios. */
const MENSAJE_COTIZACION_LISTA = 'Listo, ya tengo todo. El área de precios te prepara la cotización y te escribe apenas abramos.';

/* Tramo 4 del 70 % (27-oct), PENDIENTES DE APROBACIÓN DE DANIEL.
   Buscar la carga o los pagos con el N.º de cotización, la marca o el correo
   que escribe el cliente (identidadPorDato.js). Ninguno dice si un dato
   existe: el que pide el segundo dato sale igual exista o no el primero. */
// Sin carga con su número, en una cuenta con herramientas: pide el dato para BUSCAR (no lo deja anotado).
const MENSAJE_SIN_CARGA_PIDE_DATO =
  'Con el número desde el que me escribes no encuentro una carga en curso; puede estar registrada con otro teléfono. Escríbeme tu número de cotización o tu marca de envío y la busco.';
// Dio una cotización o una marca y su número no prueba que es suya: falta el correo.
const MENSAJE_DATO_PIDE_CORREO =
  'Para cuidar tus datos necesito confirmar que eres tú: escríbeme también el correo con el que te registraste en IMPORFACTORY.';
// Dio el correo y su número no prueba que es suyo: falta la cotización o la marca.
const MENSAJE_DATO_PIDE_CODIGO =
  'Para cuidar tus datos necesito confirmar que eres tú: escríbeme también tu número de cotización o tu marca de envío.';
// Los datos no son del mismo cliente, alguno no existe o ya probó demasiados hoy.
const MENSAJE_DATO_NO_COINCIDE =
  'Con esos datos no puedo confirmar tu cuenta por este chat. El área de logística lo revisa y un asesor te escribe apenas abramos.';
const MENSAJE_DATO_NO_COINCIDE_PAGOS =
  'Con esos datos no puedo confirmar tu cuenta por este chat. Cobranza lo revisa y un asesor te escribe apenas abramos.';
// Se confirmó su cuenta con el dato y tampoco tiene una carga en curso.
const MENSAJE_SIN_CARGA_EN_CUENTA =
  'En tu cuenta no encuentro una carga en curso. El área de logística lo revisa y un asesor te escribe apenas abramos.';
// «¿Hay novedad de mi caso?» y no hay nada de una persona en los últimos 30 días (novedadCaso.js).
const MENSAJE_SIN_NOVEDAD =
  'Todavía no hay una novedad registrada en tu caso: sigue con el equipo y un asesor te escribe apenas abramos.';

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
  MENSAJE_COTIZACION_LISTA,
};

/* Los del tramo 4 van aparte de TODOS / TEXTOS_FIJOS: no están en el prompt
   instalado (los dicen las herramientas y las secciones que el motor suma en
   cada turno), y respaldan la guardia solo cuando una herramienta los trajo. */
const TEXTOS_DATO = {
  MENSAJE_SIN_CARGA_PIDE_DATO,
  MENSAJE_DATO_PIDE_CORREO,
  MENSAJE_DATO_PIDE_CODIGO,
  MENSAJE_DATO_NO_COINCIDE,
  MENSAJE_DATO_NO_COINCIDE_PAGOS,
  MENSAJE_SIN_CARGA_EN_CUENTA,
  MENSAJE_SIN_NOVEDAD,
};

/* ── Diagnóstico de la cuenta IMPORCHAT del alumno (pendientes de aprobación) ──
   Los usa SOLO la herramienta revisar_mi_imporchat (diagnosticoCuenta.js).
   Van aparte de TODOS / TEXTOS_FIJOS a propósito: esos respaldan todos los
   turnos en la guardia, y el bot no puede decir «tu llave está sin saldo» sin
   haber revisado la cuenta. Rutas del panel sacadas del front (AGENT_PLAN.md,
   «Rutas del panel»). `{desde}` = « desde el 22-oct» (solo el plan: las fechas
   de WhatsApp y de la IA se reescriben en cada chequeo y no dicen cuándo empezó).
   `informativo` = se nombra, pero no explica por sí solo que el bot no conteste.
   `discreto` = el mismo aviso sin cifras ni nombres de la cuenta: se usa cuando
   la cuenta se encontró con un número o correo escrito en el chat (podría ser
   de otra persona, así que no se dice nada que identifique la cuenta).

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
  // Tramo 4 del 70 % (pendiente de aprobación): todas sus conexiones las suspendió el cambio a un plan menor.
  conexiones_suspendidas_plan: { texto: 'Tus números de WhatsApp están suspendidos en IMPORCHAT porque tu plan actual no los incluye, por eso el bot no contesta. Revisa tu plan en «Planes y facturación» (lo hace el administrador de la cuenta).', corto: 'tus números están suspendidos por el plan' },
  sin_conexion: { texto: 'No tienes ningún número de WhatsApp conectado a IMPORCHAT. Entra a «Conexiones» y conecta tu número.', tutorial: 'whatsapp', corto: 'no tienes número conectado' },
  // ── Interruptor (D3)
  interruptor_nunca: { texto: `Tu bot nunca se encendió. Entra a ${RUTA_ASISTENTES} → en la tarjeta «Agente de Ventas» o «Agente de Servicios» toca «Configurar», enciende «Bot activo» y «Guardar».`, tutorial: 'openai', corto: 'el bot nunca se encendió' },
  interruptor_apagado: { texto: `Tu bot está apagado. Entra a ${RUTA_ASISTENTES} → en la tarjeta «Agente de Ventas» o «Agente de Servicios» toca «Editar», enciende «Bot activo» y «Guardar».`, tutorial: 'openai', corto: 'el bot está apagado' },
  // ── Ajustes (D4): no se arreglan desde el panel
  modo_prueba: { texto: 'Tu bot está en modo de prueba: solo les contesta a {n} números.', discreto: 'Tu bot está en modo de prueba: solo les contesta a algunos números.', asesor: true, corto: 'el bot está en modo de prueba' },
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
  columna_sin_ia: { texto: `Tu columna «{columna}» no tiene la IA activa{chats}, así que ahí el bot no contesta. Entra a ${RUTA_COLUMNAS} → enciende «IA activa en esta columna» → «Guardar cambios».`, discreto: `Tu columna de entrada no tiene la IA activa, así que ahí el bot no contesta. Entra a ${RUTA_COLUMNAS} → enciende «IA activa en esta columna» → «Guardar cambios».`, tutorial: 'kanban', corto: 'hay columnas sin IA' },
  columna_sin_prompt: { texto: `La columna «{columna}» tiene la IA activa pero sin instrucciones, y así el bot no contesta. Entra a ${RUTA_COLUMNAS} → escribe las «Instrucciones (prompt)» → «Guardar cambios».`, discreto: `Una de tus columnas tiene la IA activa pero sin instrucciones, y así el bot no contesta. Entra a ${RUTA_COLUMNAS} → escribe las «Instrucciones (prompt)» → «Guardar cambios».`, tutorial: 'prompt', corto: 'hay columnas sin instrucciones' },
  columna_inexistente: { texto: `Tienes {n} chats en una columna que borraste o desactivaste, y ahí el bot no contesta. Vuelve a activarla en ${RUTA_COLUMNAS}, o mueve esos chats a una columna con IA.`, discreto: `Tienes chats en una columna que borraste o desactivaste, y ahí el bot no contesta. Vuelve a activarla en ${RUTA_COLUMNAS}, o mueve esos chats a una columna con IA.`, tutorial: 'kanban', corto: 'hay chats en una columna desactivada' },
  chats_bot_apagado_todos: { texto: 'Apagaste el bot dentro de tus {n} chats de las últimas 48 horas, así que no le contesta a nadie. Vuelve a encenderlo dentro de cada chat.', discreto: 'Apagaste el bot dentro de todos tus chats de las últimas 48 horas, así que no le contesta a nadie. Vuelve a encenderlo dentro de cada chat.', corto: 'el bot está apagado en todos tus chats' },
  chats_bot_apagado: { texto: 'Apagaste el bot dentro de {n} chats: en esos el bot no contesta hasta que lo vuelvas a encender en el chat.', discreto: 'Apagaste el bot dentro de algunos chats: en esos el bot no contesta hasta que lo vuelvas a encender en el chat.', informativo: true, corto: 'el bot está apagado en algunos chats' },
});

/* Frases de armado del texto del diagnóstico (no son fallas). */
const DIAGNOSTICO_FRASES = Object.freeze({
  inicio: 'Revisé tu IMPORCHAT.',
  sano: 'En las últimas 48 horas te escribieron en {n} chats y tu bot contestó en {m}: tu cuenta está bien conectada. Si lo que falla es lo que contesta tu bot, esta clase explica cómo mejorar su prompt; y si quieres, te paso con un asesor.',
  sin_causa: 'En las últimas 48 horas te escribieron en {n} chats y tu bot contestó en {m}. No encuentro la causa en tu cuenta.',
  // Las mismas, sin cifras (cuenta encontrada con un dato escrito en el chat).
  sano_discreto: 'Tu bot contestó en las últimas 48 horas: tu cuenta está bien conectada. Si lo que falla es lo que contesta tu bot, esta clase explica cómo mejorar su prompt; y si quieres, te paso con un asesor.',
  sin_causa_discreto: 'No encuentro la causa en tu cuenta.',
  sin_chats_con_bot_discreto: 'En las últimas 48 horas ningún chat quedó donde el bot contesta (están en columnas sin IA, como «Asesor», o con el bot apagado en el chat). No encuentro otra falla en tu cuenta.',
  sin_chats: 'En las últimas 48 horas nadie le escribió a tu número, así que no puedo comprobar si tu bot contesta. No encuentro una falla en tu cuenta.',
  sin_chats_con_bot: 'En las últimas 48 horas te escribieron en {t} chats, pero ninguno está donde el bot contesta (están en columnas sin IA, como «Asesor», o con el bot apagado en el chat). No encuentro otra falla en tu cuenta.',
  otra_conexion: 'Tienes otra conexión; pregúntame por ella si también falla.',
  no_verificable: 'Por este canal no puedo revisar tu cuenta de IMPORCHAT: escríbeme por WhatsApp desde el número con el que te registraste.',
  sin_cuenta: 'No encontré una cuenta de IMPORCHAT con el número desde el que me escribes. Recuerda que pudiste registrarte con cualquier otro número o con tu correo: escríbeme el número o el correo con el que te registraste y la reviso.',
  ambiguo: 'Tu número aparece en más de una cuenta de IMPORCHAT, así que no puedo revisarla por aquí.',
  // Cuando la cuenta se buscó con el número o el correo que escribió el alumno.
  encontrada_por_dato: 'Encontré tu cuenta con ese {tipo}.',
  sin_cuenta_dato: 'Tampoco encontré una cuenta de IMPORCHAT con ese {tipo}.',
  ambiguo_dato: 'Ese {tipo} aparece en más de una cuenta de IMPORCHAT, así que no puedo revisarla por aquí.',
  dato_invalido: 'Eso no parece un número de WhatsApp ni un correo. Escríbeme el número con su código de país (por ejemplo +593 98 765 4321) o el correo con el que te registraste en IMPORCHAT.',
  dato_no_escrito: 'Escríbeme aquí el número o el correo con el que te registraste en IMPORCHAT y la reviso.',
  limite_datos: 'Ya probé varios datos y no encuentro tu cuenta.',
  // Cuenta suspendida (caso 153, 26-oct: le decía «no tienes WhatsApp conectado»).
  // Tramo 4 del 70 %, pendientes de aprobación. `saldo` lo arma ver_mis_pagos.
  cuenta_por_pago: 'Suele pasar cuando hay un pago pendiente.',
  cuenta_saldo: 'En tu cartera, {saldo}',
  cuenta_cierre: 'Cobranza revisa tu cuenta y un asesor te escribe apenas abramos.',
  error: 'No pude revisar tu cuenta de IMPORCHAT ahora.',
});

/* ── Seguimiento al cliente que quedó esperando (seguimiento.js) ──
   ✅ APROBADO POR DANIEL (27-oct, T9 del tramo 5). Aun así solo escribe con
   soporte_expertos.seguimiento = 'real' en la cuenta y el cron de L-V.
   Van aparte de TODOS: no respaldan respuestas en la guardia.
   Ninguno promete hora ni día. `{quien}` = QUIEN_SEGUIMIENTO del área. */
const SEGUIMIENTO_APROBADO = true;
const MENSAJE_SEGUIMIENTO = 'Sigo pendiente de tu consulta: ya está con {quien}, que te escribe por este chat.';
const QUIEN_SEGUIMIENTO = Object.freeze({
  cotizacion: 'el área de cotizaciones',
  logistica: 'el área de logística',
  pago: 'el área de pagos',
  factura: 'el área de pagos',
  reclamo: 'tu asesor',
  otro: 'tu asesor',
});
/* Fuera de la ventana de 24 h de WhatsApp solo se puede escribir con una
   plantilla aprobada por Meta. Esta es la PROPUESTA (no existe todavía en Meta
   y el código no la usa): */
const PLANTILLA_SEGUIMIENTO_PROPUESTA = Object.freeze({
  nombre: 'seguimiento_expertos_v1',
  cuerpo: 'Hola {{1}}, seguimos con tu consulta en IMPORFACTORY. Respóndenos por aquí y tu asesor continúa contigo.',
});

/* ── «Consentidos»: el equipo escribe primero en los momentos que importan
   (consentidos.js). BORRADORES PENDIENTES DE APROBACIÓN DE DANIEL. El tramo 1
   es solo ensayo: el script no tiene código de envío y estos textos solo se
   muestran en el resumen diario que le llega a Daniel. Tuteo ecuatoriano, sin
   voseo. Ninguno promete hora ni día ni inventa una fecha: {fecha} sale del
   contenedor o se cambia por «apenas tengamos la fecha». */
const CONSENTIDOS_APROBADO = false;
const CONSENTIDOS = Object.freeze({
  recibido_china: 'Hola {nombre} 👋 Buenas noticias: tu mercadería {marca} ya llegó a nuestra bodega en China{cajas}. Te aviso apenas suba al contenedor.',
  en_contenedor: '{nombre}, tu carga ya está asignada al contenedor {contenedor} 📦. Te escribo cuando zarpe.',
  contenedor_cerrado: '{nombre}, el contenedor {contenedor} con tu carga ya se cerró ✅. Lo que sigue es el zarpe y te aviso cuando salga.',
  zarpo: '🚢 {nombre}, tu carga ya va en camino en el contenedor {contenedor}. {fecha} Te voy contando cada paso.',
  puerto: '⚓ {nombre}, tu carga ya llegó al puerto de destino y entra al proceso de aduana. Te aviso cuando esté en nuestra bodega.',
  bodega_destino: '🎉 {nombre}, tu carga ya está en nuestra bodega{ciudad}. El equipo de logística te escribe por aquí para coordinar la entrega.',
  entregada: '✅ {nombre}, tu carga figura como entregada. ¿Llegó todo bien? Si algo no cuadra, respóndeme aquí.',
  novedad: '{nombre}, hay una novedad de tu contenedor {contenedor}: «{nota}»',
  sigue_en_camino: 'Hola {nombre}, paso a contarte: tu carga sigue en camino en el contenedor {contenedor}, sin novedades. {fecha}',
  sigue_en_camino_nota: 'Hola {nombre}, paso a contarte cómo va tu carga en el contenedor {contenedor}: «{nota}». {fecha}',
  pago_recibido: '✅ {nombre}, recibimos tu pago de {monto}. ¡Gracias por tu confianza!',
  logro: '👏 {nombre}, terminaste los módulos 1 y 2. Ya puedes agendar tu sesión de implementación aquí: {enlace}',
  post_reunion: '{nombre}, gracias por tu tiempo en la reunión del {dia}. ¿Te quedó alguna duda de lo que vimos? Respóndeme aquí y te ayudo.',
  primera_clase: 'Hola {nombre} 👋 ¿Ya pudiste entrar a tu primera clase? Este es el enlace directo para empezar: {enlace}. Si algo no te deja entrar, escríbeme aquí y lo resolvemos.',
  te_guarde: '{nombre}, te guardé el lugar 😉 Te quedaste en «{leccion}». Sigue justo desde ahí: {enlace}',
});
const CONSENTIDOS_FECHA = Object.freeze({
  con: 'La llegada estimada es el {fecha}.',
  sin: 'Apenas tengamos la fecha de llegada, te la paso.',
});

/* ── Objeción de precio: «me sale muy caro», «en otro lado me cobran menos»
   (objecionPrecio.js). ✅ TODOS APROBADOS POR DANIEL (27-oct), con sus reglas:
   se dice «carga grupal» (no «consolidar»); nadie rebaja (Johan ofrece
   alternativas y un descuento solo lo autoriza Daniel); si el chat lo tiene
   Belén, va la nota a Johan y el chat sigue con ella. Aun así el bot solo los
   usa con soporte_expertos.objecion_precio en la cuenta. Van aparte de TODOS:
   no respaldan respuestas en la guardia. Tuteo ecuatoriano, sin voseo; ninguno
   ofrece descuento ni promete hora. 1.ª objeción: desglose + espacio +
   alternativas; 2.ª: pasa al líder comercial (Johan). espacio_libre no se usa
   mientras no haya mínimo de CBM en México. */
const OBJECION_APROBADO = true;
const OBJECION = Object.freeze({
  desglose_mx:
    'Te explico de dónde sale el valor: el flete a México se cobra por el volumen de tu carga (CBM) y ya incluye los impuestos de importación y la entrega en nuestra bodega de México.',
  desglose_mx_cifras:
    'Te explico de dónde sale el valor: tu carga ocupa {cbm} CBM y el flete a México es de {flete} USD. Ese flete ya incluye los impuestos de importación y la entrega en nuestra bodega de México.',
  desglose_ec:
    'Te explico de dónde sale el valor: la cotización a Ecuador tiene dos partes. El flete, que se cobra por el volumen de tu carga (CBM), y los impuestos de importación (arancel, IVA y otros), que dependen del valor de tu mercadería y los fija la aduana, no nosotros.',
  desglose_otro:
    'Te explico de dónde sale el valor: el flete se cobra por el volumen de tu carga (CBM) y aparte están los impuestos de importación del país de destino.',
  completar_uno:
    'Lo ideal es completar 1 CBM: te quedan {libre} CBM para sumar más productos en el mismo envío. Si no, no pasa nada: el flete se cobra solo por lo que ocupa tu carga.',
  espacio_libre: 'Tu carga ocupa {cbm} CBM y el flete se cobra desde {minimo} CBM: te quedan {libre} CBM para sumar productos sin pagar más flete.',
  paso_siguiente:
    'Mientras más volumen, menos pagas por cada CBM: si sumas productos hasta completar {hasta} CBM, el flete sube solo {extra} USD (de {flete} a {flete_hasta} USD).',
  alternativas:
    'Para bajar el costo por unidad tienes dos caminos: ajustar la cantidad (con más unidades, el flete se reparte entre más productos) o sumar tu mercadería a una carga grupal con otros importadores. ¿Quieres que lo revisemos por alguno de esos caminos?',
  pase_comercial: 'Entiendo. Tu caso pasa a nuestro líder comercial, que revisa contigo las opciones y te escribe apenas abramos.',
});

/* Membresía de Imporsuit del que escribe (ver_mi_membresia,
   membresiaAlumno.js). 🟡 PENDIENTES DE APROBAR por Daniel (27-oct).
   `instruccion` es para el modelo. */
const MEMBRESIA = Object.freeze({
  activa: 'Tu membresía{plan} está activa desde el {desde} hasta el {vence} (te quedan {dias} días).{paquetes}',
  vencida: 'Tu membresía{plan} empezó el {desde} y venció el {vence}.{paquetes}',
  sin_fecha: 'Tu número está registrado en la plataforma{plan}, pero no veo la fecha de tu membresía.',
  sin_membresia:
    'Con este número no encuentro una membresía en la plataforma. Si te registraste con otro número, escríbeme desde ese o pásame el correo con que te registraste y lo reviso con el equipo.',
  error: 'Ahora no pude revisar tu membresía. Un asesor lo revisa y te escribe.',
  instruccion:
    'Responde con estos datos en 1 o 2 frases. Si no puede entrar y la membresía está activa, dale los pasos de la ficha de acceso; si está vencida, díselo y pásalo a una persona para renovar. ' +
    'No inventes precios, descuentos ni fechas.',
});

/* Pedidos de Dropi de la tienda del alumno (ver_mis_pedidos_dropi,
   pedidosDropi.js). 🟡 PENDIENTES DE APROBAR por Daniel (27-oct): el bot los
   puede mandar tal cual si la guardia rechaza su respuesta. `instruccion` no
   le llega al cliente: es para el modelo. */
const DROPI = Object.freeze({
  sin_dropi:
    'No encuentro una tienda de Dropi conectada a tu IMPORCHAT, por eso desde aquí no puedo ver tus pedidos. El estado de cada guía lo ves en tu panel de Dropi; si quieres, pásame el número de guía y lo reviso con el equipo.',
  integracion_apagada: '(La conexión de Dropi de tu IMPORCHAT está apagada: estos datos pueden estar atrasados.)',
  no_coincide: 'No encontré un pedido de los últimos 60 días que coincida con «{dato}».',
  error: 'Ahora no pude revisar tus pedidos de Dropi. Mándame el número de guía o de pedido y lo reviso con el equipo.',
  instruccion:
    'Responde con estos datos en 2 a 4 frases: estado, último movimiento y su fecha, y el enlace de rastreo si lo hay. ' +
    'No prometas fechas de entrega ni digas qué hará la transportadora. ' +
    'Si hay una novedad que hay que gestionar o un reclamo a la transportadora, dile qué dice la novedad y pásalo a una persona con pasar_a_humano (motivo «reclamo»).',
});

/* Proveedores de Yiwu (proveedoresYiwu.js, bandera soporte_expertos.proveedores).
   Aprobados por Daniel el 27-oct. Los contactos son solo para alumnos con
   membresía activa; a los demás, PROVEEDORES_SIN_MEMBRESIA (Daniel pidió «es
   parte de la membresía» en una línea, con el mismo tono). */
const PROVEEDORES_ENCONTRADOS = (n) =>
  n === 1 ? 'Tengo este proveedor en el mercado de Yiwu:' : `Tengo estos ${n} proveedores en el mercado de Yiwu:`;
const PROVEEDORES_TARJETAS = (n) => (n === 1 ? 'Te mando su tarjeta por aquí.' : 'Te mando sus tarjetas por aquí.');
const PROVEEDORES_PEDIR =
  'Escríbeles a varios a la vez y a cada uno pídele: precio por unidad (EXW más envío a Yiwu), cuántas unidades vienen por caja y las medidas o el CBM de la caja. Cuando te respondan, mándame la captura y el área de precios te arma la cotización.';
const PROVEEDORES_VIDEO = `Así se le escribe a un proveedor (clase de 5 minutos): ${LINKS.claseContactarProveedor}
Hay más en el Directorio de Proveedores: ${LINKS.proveedores}`;
const PROVEEDORES_SIN_RESULTADO = `Para ese producto todavía no tengo un proveedor de Yiwu cargado. Búscalo en el Directorio de Proveedores: ${LINKS.proveedores}
Si no está, búscalo en YiwuGo (productos de consumo) o en Alibaba (máquinas y materia prima).
Así se le escribe a un proveedor (clase de 5 minutos): ${LINKS.claseContactarProveedor}
Cuando te respondan, mándame la captura y el área de precios te arma la cotización.`;
const PROVEEDORES_SIN_MEMBRESIA =
  'Los contactos de proveedores de Yiwu son parte de la membresía de IMPORFACTORY. Si ya eres alumno, escríbeme desde el número con el que te registraste en la plataforma.';

/* ── Bot proactivo (proactivo.js, tramo 5). ✅ T1 a T8 APROBADOS POR DANIEL
   (27-oct), tal como están, con su «sí» a prometer hora (va junto con el
   seguimiento y el aviso de Jeff a la persona a las 2 h). Solo con
   soporte_expertos.proactivo en la cuenta. Van aparte de TODOS: no respaldan
   respuestas en la guardia. Tuteo ecuatoriano, sin voseo.
   {nombre} = la persona que tiene el chat · {de_area} = «de logística»
   {cuando} = «hoy hasta las 17:00» | «mañana desde las 8:00» | «el lunes desde las 8:00»
   {desde} = «las 10:15» | «ayer a las 16:30» */
const PROACTIVO_APROBADO = true;
const PROACTIVO = Object.freeze({
  // P1: pedir lo que falta antes de pasar el chat (una sola vez).
  pide_garantia: 'Para que {nombre} lo resuelva sin volver a preguntarte, mándame: el número de orden de Dropi, una foto o video del producto y qué falla.',
  pide_comprobante: 'Para registrar tu pago, mándame la foto del comprobante y, si lo tienes, el número de tu cotización.',
  pide_guia: 'Mándame el número de guía o de orden y la ciudad de entrega, y lo reviso con {nombre}.',
  // P2: confirmar en vez de pasar.
  datos_factura: 'Recibí tus datos para la factura: {datos}. Quedan en tu caso para emitirla después de nacionalizar; no hace falta que los mandes otra vez.',
  cuentas_cotizacion: 'Sí, a las cuentas que están en tu cotización #{n}. Cuando pagues, mándame el comprobante por aquí y lo registro.',
  // P3: al pasar el chat, quién y para cuándo.
  pase: 'Lo pasé a {nombre}, {de_area}. Te escribe por este chat {cuando}.',
  pase_sin_area: 'Lo pasé a {nombre}. Te escribe por este chat {cuando}.',
  pase_directo: 'Esto lo atiende {nombre} directamente. Ya tiene tu caso con lo que me contaste y te escribe {cuando}.',
  // P4: el cliente vuelve a escribir y su pase sigue sin respuesta.
  sigue_con: 'Tu caso lo lleva {nombre} y ya le avisé que escribiste.',
});
/* ── Shipping mark (marcaEnvio.js), FAQ de Daniel del 27-oct. ✅ marca,
   sin_aprobar y sin_marca APROBADOS POR DANIEL (27-oct: «Apruebo los textos
   (a), (b), (c1), (c2) y (c3) tal como están») y ✅ `varias` también («Apruebo
   también el texto c1b de varias marcas tal como está»). Con su bandera en
   false, el que tiene varias marcas vuelve a la ficha marca-de-envio-pedirla.
   Van dentro del proactivo. sin_aprobar y sin_marca se completan con el pase de P3.
   {marca} = EC-12345 · {n} = número de cotización · {lista} = listaDeMarcas() */
const SHIPPING_MARK_APROBADO = true;
const SHIPPING_MARK_VARIAS_APROBADO = true;
const SHIPPING_MARK = Object.freeze({
  marca: 'Lo que te pide tu proveedor es el shipping mark: la marca de envío de tu carga. La tuya es {marca} (cotización N.º {n}). Pásasela para que rotule cada caja con esa marca.',
  varias: 'Lo que te pide tu proveedor es el shipping mark: la marca de envío de tu carga. Tienes estas: {lista}. Cada proveedor rotula sus cajas con la suya; en la plataforma ves cuál le toca a cada uno.',
  sin_aprobar: 'Lo que te pide tu proveedor es el shipping mark: la marca de envío. Sale cuando tu cotización está aprobada, y la N.º {n} todavía no lo está.',
  sin_marca: 'Lo que te pide tu proveedor es el shipping mark: la marca de envío. No la veo registrada todavía.',
});

// «de {área}» para T6, por el área del caso o por la persona que tiene el chat.
const DE_AREA = Object.freeze({
  pago: 'de pagos',
  factura: 'de pagos',
  cotizacion: 'de cotizaciones',
  logistica: 'de logística',
  ecommerce: 'de ecommerce',
  objecion_precio: 'del área comercial',
  reclamo: 'de atención al cliente',
  otro: 'de atención al cliente',
});

module.exports = {
  LINKS,
  ...TODOS,
  CIERRE_ASESOR,
  FRASE_RECLAMO,
  PREGUNTA_CANTIDAD,
  TEXTOS_FIJOS: Object.freeze(TODOS),
  ...TEXTOS_DATO,
  TEXTOS_DATO: Object.freeze(TEXTOS_DATO),
  DIAGNOSTICO,
  DIAGNOSTICO_FRASES,
  TUTORIALES,
  SEGUIMIENTO_APROBADO,
  MENSAJE_SEGUIMIENTO,
  QUIEN_SEGUIMIENTO,
  PLANTILLA_SEGUIMIENTO_PROPUESTA,
  CONSENTIDOS_APROBADO,
  CONSENTIDOS,
  CONSENTIDOS_FECHA,
  OBJECION_APROBADO,
  OBJECION,

  DROPI,
  MEMBRESIA,
  PROVEEDORES_ENCONTRADOS,
  PROVEEDORES_TARJETAS,
  PROVEEDORES_PEDIR,
  PROVEEDORES_VIDEO,
  PROVEEDORES_SIN_RESULTADO,
  PROVEEDORES_SIN_MEMBRESIA,
  PROACTIVO_APROBADO,
  PROACTIVO,
  DE_AREA,
  SHIPPING_MARK_APROBADO,
  SHIPPING_MARK_VARIAS_APROBADO,
  SHIPPING_MARK,
};
