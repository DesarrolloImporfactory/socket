/* Pruebas de «revisar_mi_imporchat»: el diagnóstico de la cuenta IMPORCHAT
   del alumno (diagnosticoCuenta.js), su herramienta, la bandera de la cuenta,
   la guardia con el diagnóstico y la mezcla del instalador.

   Sin base de datos, sin red y sin la API de Claude: la cuenta IMPORCHAT sale
   de una base falsa que responde según la consulta.

     node scripts/probar_soporte_expertos_diagnostico.js
*/
'use strict';

const fs = require('fs');
const path = require('path');

const rutaDb = require.resolve(path.join(__dirname, '../src/database/config'));
require.cache[rutaDb] = { id: rutaDb, filename: rutaDb, loaded: true, exports: { db: {}, db_2: {} } };

/* El servicio de salud de WhatsApp carga axios al empezar: aquí solo hace
   falta su lista de estados (se comprueba abajo que es la del archivo real). */
const { ESTADOS_RECONECTAR } = require('./soporte_expertos/cuenta_imporchat_de_mentira');
const rutaSalud = require.resolve(path.join(__dirname, '../src/services/whatsapp_numero_health.service'));
require.cache[rutaSalud] = { id: rutaSalud, filename: rutaSalud, loaded: true, exports: { ESTADOS_RECONECTAR } };

const { diagnosticarCuenta, claseErrorIA, MAX_TEXTO, MAX_DATOS, leerDato, olvidarDatosProbados } = require('../src/utils/soporteExpertos/diagnosticoCuenta');
const { crearHerramientas, sumarHechosHerramientas } = require('../src/utils/soporteExpertos/herramientas');
const { hablaDeImporchat } = require('../src/utils/soporteExpertos/intencion');
const { mezclarSoporteExpertos } = require('./soporte_expertos/mezclarAjustes');
const ajustesIA = require('../src/utils/ajustesIA');
const T = require('../src/utils/soporteExpertos/textos');
const { SECCION_DIAGNOSTICO, SECCION_HERRAMIENTAS } = require('../src/utils/prompt_soporte_expertos.data');

let ok = 0;
let fallos = 0;
function prueba(nombre, pasa, detalle = '') {
  if (pasa) {
    ok++;
    console.log(`  OK    ${nombre}`);
  } else {
    fallos++;
    console.log(`  FALLA ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

const { TEL, AHORA, conexion, columna, chats, escenario, baseFalsa, PERMITIDO, NIEGA } = require('./soporte_expertos/cuenta_imporchat_de_mentira');

function revisar(cambios = {}, o = {}) {
  const b = baseFalsa(escenario(cambios));
  return diagnosticarCuenta(o.telefono || TEL, {
    consultar: b.consultar,
    verificarAcceso: o.verificarAcceso || PERMITIDO,
    ahora: AHORA,
    propia: o.propia === undefined ? 265 : o.propia,
    ...(o.limite_ms ? { limite_ms: o.limite_ms } : {}),
  }).then((r) => ({ ...r, llamadas: b.llamadas }));
}

const enlace = (clave) => T.TUTORIALES[clave].enlace;
const inicioDe = (texto) => texto.split('{')[0].slice(0, 40);
const VOSEO = /\b(Tocá|Tenés|Podés|Hacé|Mirá|Andá|Fijate|Dale|Entrá|Escribí|Elegí|Pegá|Usá|Revisá|Recargá|Subí|Creá|Encendé|Instalá|Querés|Sabés)\b/;

(async () => {
  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n1-3. Identidad');
  {
    const r = await revisar({}, { telefono: '593987000111' });
    prueba('1. número desconocido → sin_cuenta', r.estado === 'sin_cuenta', r.estado);
    prueba('   sin_cuenta pide el número o el correo (puede ser cualquiera) y da la clase para crear la cuenta', /número o el correo/.test(r.texto) && /cualquier otro número/.test(r.texto) && r.texto.includes(enlace('cuenta')));
    prueba('   sin_cuenta todavía no lo manda al asesor', !r.texto.includes(T.MENSAJE_ASESOR));
  }
  {
    const r = await revisar({ usuarios: [{ id_usuario: 7, pais: '+593', lead: '0987123456' }, { id_usuario: 8, pais: '+593', lead: '987123456' }] });
    prueba('2. número en 2 usuarios → ambiguo', r.estado === 'ambiguo', r.estado);
    prueba('   ambiguo no nombra ninguna conexión y va al asesor', !/Tienda Ana/.test(r.texto) && r.texto.includes(T.MENSAJE_ASESOR));
    prueba('   ambiguo no revisa ninguna conexión', !r.llamadas.some((l) => /FROM configuraciones c/.test(l.sql)));
  }
  {
    const b = baseFalsa(escenario());
    const h = crearHerramientas({ telefono: TEL, canalVerificable: false, diagnostico: true, deps: { consultarImporchat: b.consultar } });
    const herramienta = h.lista.find((x) => x.definicion.name === 'revisar_mi_imporchat');
    const texto = await herramienta.ejecutar({});
    prueba('3. canal no verificable → no_verificable', texto === T.DIAGNOSTICO_FRASES.no_verificable);
    prueba('   y cero consultas a la base', b.llamadas.length === 0, String(b.llamadas.length));
  }
  {
    const r = await revisar({ usuarios: [], conexiones: [conexion({ telefono: '+593 98 712 3456' })] });
    prueba('   sin WhatsApp de registro, entra por el número de su conexión', r.estado === 'revisada', r.estado);
  }
  {
    const r = await revisar({ usuarios: [{ id_usuario: 7, pais: '', lead: '987123456' }] });
    prueba('15. coincidencia «nacional» (sin código de país) no vale → sin_cuenta', r.estado === 'sin_cuenta', r.estado);
  }
  {
    const r = await revisar({ usuarios: [{ id_usuario: 7, pais: '+593', lead: '593987123456' }] });
    prueba('   el lead guardado ya con código de país también vale', r.estado === 'revisada', r.estado);
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n4. Cada falla con su texto y su clase');
  const conIA = (extra) => ({ conexiones: [conexion(extra)] });
  const CASOS = {
    conexion_suspendida: [conIA({ suspendido: 1 }), NIEGA('conexion_suspendida')],
    configuracion_inexistente: [{}, NIEGA('configuracion_inexistente')],
    sin_usuario: [{}, NIEGA('sin_usuario')],
    cuenta_suspendido: [{}, NIEGA('cuenta_suspendido')],
    cuenta_cancelado: [{}, NIEGA('cuenta_cancelado')],
    sin_plan: [{}, NIEGA('sin_plan')],
    plan_vencido: [{}, NIEGA('plan_vencido')],
    plan_inactivo: [{}, NIEGA('plan_inactivo')],
    plan_descatalogado: [{}, NIEGA('plan_descatalogado')],
    wa_sin_vincular: [conIA({ vinculada: 0 })],
    wa_reconectar: [conIA({ wa_status: 'DISCONNECTED' })],
    wa_token_vencido: [conIA({ wa_status: 'TOKEN_EXPIRED' })],
    wa_no_registrado: [conIA({ wa_status: 'NO_REGISTRADO' })],
    wa_baneado: [conIA({ wa_status: 'BANNED' })],
    meta_pago: [conIA({ metodo_pago: 0 })],
    interruptor_nunca: [{ asistentes: [] }],
    interruptor_apagado: [{ asistentes: [{ id_configuracion: 101, activo: 0 }] }],
    modo_prueba: [conIA({ ia_ajustes: JSON.stringify({ solo_numeros: ['593999999999', '593988888888'] }) })],
    fuera_de_horario: [conIA({ ia_ajustes: JSON.stringify({ horario: { desde: '18:00', hasta: '08:00' } }) })],
    sin_llave_openai: [conIA({ k_oa: 0 })],
    sin_saldo_openai: [conIA({ openai_activo: 0, openai_error_msg: 'You have no credits left', openai_error_at: '2026-10-22T15:00:00Z' })],
    cuota_agotada_openai: [conIA({ openai_activo: 0, openai_error_msg: 'You exceeded your current quota, please check your plan' })],
    llave_invalida_openai: [conIA({ openai_activo: 0, openai_error_msg: 'Incorrect API key provided: sk-proj-abc***xyz' })],
    ia_error_openai: [conIA({ openai_activo: 0, openai_error_msg: 'Request timed out' })],
    sin_llave_claude: [conIA({ proveedor_ia: 'claude', k_cl: 0 })],
    sin_saldo_claude: [conIA({ proveedor_ia: 'claude', k_cl: 1, openai_activo: 0, openai_error_msg: 'Claude: Your credit balance is too low' })],
    cuota_agotada_claude: [conIA({ proveedor_ia: 'claude', k_cl: 1, openai_activo: 0, openai_error_msg: 'Claude: quota exceeded' })],
    llave_invalida_claude: [conIA({ proveedor_ia: 'claude', k_cl: 1, openai_activo: 0, openai_error_msg: 'Claude: invalid x-api-key' })],
    ia_error_claude: [conIA({ proveedor_ia: 'claude', k_cl: 1, openai_activo: 0, openai_error_msg: 'Claude: overloaded' })],
    sin_columnas: [{ columnas: [] }],
    columna_sin_ia: [{ columnas: [columna({ con_ia: 0 })] }],
    columna_sin_prompt: [{ columnas: [columna({ sin_prompt: 1 })] }],
    chats_bot_apagado: [{ chats: [chats(11, 11), chats(3, 0, { bot_openia: 0 })] }],
    columna_inexistente: [{ chats: [chats(9, 0, { estado: 'columna_borrada' })] }],
    chats_bot_apagado_todos: [{ chats: [chats(20, 0, { bot_openia: 0 })] }],
  };
  for (const [clave, [cambios, verificarAcceso]] of Object.entries(CASOS)) {
    const r = await revisar(cambios, { verificarAcceso });
    const def = T.DIAGNOSTICO[clave];
    const primera = r.conexiones[0]?.fallas[0];
    // Lo informativo no encabeza: con la cuenta sana va solo en «Además».
    const texto = def.informativo
      ? r.resultado === 'sano' && r.texto.includes(`Además: ${def.corto}.`) && !r.texto.includes(inicioDe(def.texto))
      : r.texto.includes(inicioDe(def.texto)) && (!def.tutorial || r.texto.includes(enlace(def.tutorial)));
    const bien =
      r.estado === 'revisada' &&
      primera === clave &&
      texto &&
      (!def.asesor || r.texto.includes(T.MENSAJE_ASESOR)) &&
      !/\{\w+\}/.test(r.texto) &&
      r.texto.length <= MAX_TEXTO;
    const marca = def.informativo ? ' (informativo)' : `${def.tutorial ? ` (clase ${def.tutorial})` : ''}${def.asesor ? ' (asesor)' : ''}`;
    prueba(`${clave}${marca}`, bien, `${r.estado} · ${r.resultado} · ${primera} · ${r.texto.slice(0, 160)}`);
  }
  const cubiertas = new Set([...Object.keys(CASOS), 'sin_conexion']);
  const sinCaso = Object.keys(T.DIAGNOSTICO).filter((k) => !cubiertas.has(k));
  prueba('cada clave del catálogo tiene su caso', !sinCaso.length, sinCaso.join(', '));
  {
    // Revisión 3: wa_status_at y openai_error_at se reescriben en cada chequeo;
    // no dicen cuándo empezó la falla, así que no salen en el texto.
    const sinFecha = await Promise.all([CASOS.sin_saldo_openai[0], CASOS.wa_reconectar[0], CASOS.wa_baneado[0], CASOS.llave_invalida_claude[0]].map((c) => revisar(c)));
    prueba('R3. WhatsApp y la IA no dicen «desde el…» (la fecha se reescribe)', sinFecha.every((x) => !/desde el \d/.test(x.texto)), sinFecha.map((x) => x.texto.slice(0, 60)).join(' | '));
    const v = await revisar(CASOS.plan_vencido[0], { verificarAcceso: NIEGA('plan_vencido') });
    prueba('plan vencido con su fecha', v.texto.includes('venció desde el 20-oct'), v.texto.slice(0, 120));
    const col = await revisar(CASOS.columna_sin_ia[0]);
    prueba('columna sin IA nombra la columna y cuántos chats tiene', col.texto.includes('«Contacto inicial»') && col.texto.includes('14 de tus chats'), col.texto.slice(0, 160));
    const apag = await revisar(CASOS.chats_bot_apagado[0]);
    prueba('R5. bot apagado en 3 chats: no cuenta como «no contestó» (11 de 11 → sano)', apag.resultado === 'sano' && apag.texto.includes('11 chats') && apag.texto.includes('contestó en 11'), apag.texto);
    const sinChats = await revisar({ columnas: [columna({ con_ia: 0 })], chats: [] });
    prueba('sin chats en 48 h, revisa la columna de entrada (sin contar chats)', sinChats.conexiones[0].fallas[0] === 'columna_sin_ia' && !/de tus chats/.test(sinChats.texto));
    const principal = await revisar({
      columnas: [columna({ id: 2, nombre: 'Seguimiento', estado_db: 'seguimiento', es_principal: 0, orden: 2 }), columna({ id: 3, nombre: 'Nuevos', estado_db: 'nuevos', es_principal: 1, orden: 5, con_ia: 0 })],
      chats: [],
    });
    prueba('sin contacto_inicial, la columna principal', principal.texto.includes('«Nuevos»'), principal.texto.slice(0, 120));
    const terminal = await revisar({ conexiones: [conexion({ suspendido: 1, wa_status: 'BANNED', k_oa: 0 })] }, { verificarAcceso: NIEGA('conexion_suspendida') });
    prueba('conexión eliminada: no se listan las demás puertas', terminal.conexiones[0].fallas.join() === 'conexion_suspendida', terminal.conexiones[0].fallas.join());
    const varias = await revisar({ conexiones: [conexion({ wa_status: 'DISCONNECTED', k_oa: 0 })], asistentes: [] });
    prueba('varias fallas: la primera con su clase y las demás en «Además»', varias.conexiones[0].fallas[0] === 'wa_reconectar' && /Además: el bot nunca se encendió, no tienes llave de OpenAI\./.test(varias.texto), varias.texto);
    const noKanban = await revisar({ conexiones: [conexion({ tipo_configuracion: 'ventas' })], columnas: [] });
    prueba('una conexión que no es kanban no se revisa por columnas', !noKanban.conexiones[0].fallas.includes('sin_columnas'));
    const fuera = await revisar(CASOS.fuera_de_horario[0]);
    prueba('fuera de horario con la cuenta sana: sin asesor, solo la clase del prompt', !fuera.texto.includes(T.MENSAJE_ASESOR) && !fuera.texto.includes(enlace('kanban')));
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\nR1. Columnas sin IA a propósito (asesor, perdidos, cerrado)');
  {
    const asesor = columna({ id: 2, nombre: 'Asesor', estado_db: 'asesor', es_principal: 0, orden: 4, con_ia: 0 });
    const perdidos = columna({ id: 3, nombre: 'Perdidos', estado_db: 'perdidos', es_principal: 0, orden: 5, con_ia: 0 });
    const r = await revisar({ columnas: [columna(), asesor, perdidos], chats: [chats(10, 10), chats(5, 0, { estado: 'asesor' }), chats(2, 0, { estado: 'perdidos' })] });
    prueba('R1. chats en «Asesor» y «Perdidos» sin IA → no es falla', !r.conexiones[0].fallas.includes('columna_sin_ia'), r.conexiones[0].fallas.join());
    prueba('R1. esos chats no cuentan en «te escribieron» (10 de 10 → sano)', r.resultado === 'sano' && r.texto.includes('10 chats') && r.texto.includes('contestó en 10'), r.texto);
    const entradaMala = await revisar({ columnas: [columna({ con_ia: 0 }), asesor], chats: [chats(6, 0), chats(4, 0, { estado: 'asesor' })] });
    prueba('R1. la columna de entrada sin IA sí es falla, con sus chats', entradaMala.conexiones[0].fallas[0] === 'columna_sin_ia' && entradaMala.texto.includes('6 de tus chats'), entradaMala.texto.slice(0, 160));
    const seguimiento = columna({ id: 4, nombre: 'Seguimiento', estado_db: 'seguimiento', es_principal: 0, orden: 2, sin_prompt: 1 });
    const vacia = await revisar({ columnas: [columna(), seguimiento], chats: [chats(8, 8), chats(3, 0, { estado: 'seguimiento' })] });
    prueba('R1. columna con IA y sin instrucciones donde hay chats → falla', vacia.conexiones[0].fallas[0] === 'columna_sin_prompt' && vacia.texto.includes('«Seguimiento»'), vacia.texto.slice(0, 160));
    const otraVacia = await revisar({ columnas: [columna(), seguimiento], chats: [chats(8, 8)] });
    prueba('R1. columna sin instrucciones y sin chats (no es la de entrada) → no se marca', !otraVacia.conexiones[0].fallas.includes('columna_sin_prompt'));
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\nR2. Respuestas que no son de la IA');
  {
    const r = await revisar();
    const l = r.llamadas.find((x) => /FROM clientes_chat_center/.test(x.sql));
    const excluidas = ['IA_respaldo', 'IA_wizard', 'IA_mensaje_fijo', 'IA_respuesta_rapida', 'IA_flujo_venta', 'IA_colchon'];
    prueba('R2. la consulta excluye respaldo, mensajes fijos y flujos', /responsable NOT IN \(:no_ia\)/.test(l.sql) && excluidas.every((x) => l.r.no_ia.includes(x)), JSON.stringify(l.r.no_ia));
    prueba('R2. solo cuenta chats donde escribió el cliente (hace más de 10 min)', /HAVING cliente_at IS NOT NULL/.test(l.sql) && /rol_mensaje = 0 AND created_at < NOW\(\) - INTERVAL 10 MINUTE/.test(l.sql));
    prueba('V2. «contestó» = la IA respondió después del último mensaje del cliente', /m\.ia_at >= m\.cliente_at/.test(l.sql));
    prueba('R2. una sola consulta para columnas y evidencia', r.llamadas.filter((x) => /mensajes_clientes/.test(x.sql) && /48 HOUR/.test(x.sql)).length === 1);
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\nV2. Segunda revisión');
  {
    const apagadoTodo = await revisar(CASOS.chats_bot_apagado_todos[0]);
    prueba('V1. bot apagado en los 20 chats → es la causa, no «0 chats»', apagadoTodo.resultado === 'con_fallas' && apagadoTodo.texto.includes('20 chats') && !/en 0 chats/.test(apagadoTodo.texto), apagadoTodo.texto);
    const asesor = columna({ id: 2, nombre: 'Asesor', estado_db: 'asesor', es_principal: 0, orden: 4, con_ia: 0 });
    const enAsesor = await revisar({ columnas: [columna(), asesor], chats: [chats(15, 0, { estado: 'asesor' })] });
    prueba('V1. 15 chats, todos en «Asesor» → lo dice, sin «0 chats»', enAsesor.resultado === 'sin_causa' && enAsesor.texto.includes('15 chats') && /Asesor/.test(enAsesor.texto) && !/en 0 chats/.test(enAsesor.texto), enAsesor.texto);
    const nadie = await revisar({ chats: [] });
    prueba('V1. nadie escribió → «nadie le escribió», sin «0 chats»', nadie.texto.includes(T.DIAGNOSTICO_FRASES.sin_chats) && !/en 0 chats/.test(nadie.texto));
    const borrada = await revisar(CASOS.columna_inexistente[0]);
    prueba('V3. chats en una columna desactivada → falla con su número', borrada.conexiones[0].fallas[0] === 'columna_inexistente' && borrada.texto.includes('9 chats'), borrada.texto.slice(0, 160));
    const borradaApagada = await revisar({ chats: [chats(10, 10), chats(4, 0, { estado: 'columna_borrada', bot_openia: 0 })] });
    prueba('V3. si en esos chats el bot está apagado, no se marca la columna', !borradaApagada.conexiones[0].fallas.includes('columna_inexistente'));

    const ana = conexion({ id: 301, id_usuario: 9, nombre_configuracion: 'Tienda Ana', telefono: '+593 98 712 3456', wa_status: 'DISCONNECTED' });
    const beto = conexion({ id: 302, id_usuario: 9, nombre_configuracion: 'Tienda Beto', telefono: '+593 99 444 5555', k_oa: 0 });
    const agencia = await revisar({ usuarios: [], conexiones: [ana, beto], actividad: [{ id_configuracion: 301, n: 10 }, { id_configuracion: 302, n: 30 }] });
    prueba('V4. encontrada solo por el número de una conexión → revisa solo esa', agencia.conexiones.map((c) => c.id).join() === '301' && !/Beto/.test(agencia.texto), agencia.conexiones.map((c) => c.id).join());
    const registrada = await revisar({ usuarios: [{ id_usuario: 9, pais: '+593', lead: '0987123456' }], conexiones: [ana, beto], actividad: [{ id_configuracion: 301, n: 10 }, { id_configuracion: 302, n: 30 }] });
    prueba('V4. encontrada por su WhatsApp del registro → revisa sus conexiones', registrada.conexiones.map((c) => c.id).sort().join() === '301,302', registrada.conexiones.map((c) => c.id).join());
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\nR4. El número en el registro Y en una conexión');
  {
    const ajena = conexion({ id: 200, id_usuario: 9, nombre_configuracion: 'Otra', telefono: '+593 98 712 3456' });
    const dos = await revisar({ conexiones: [conexion(), ajena] });
    prueba('R4. el registro dice una cuenta y una conexión otra → ambiguo, no revisa', dos.estado === 'ambiguo' && !dos.llamadas.some((x) => /FROM configuraciones c/.test(x.sql)), dos.estado);
    const misma = await revisar({ conexiones: [conexion({ telefono: '+593 98 712 3456' })] });
    prueba('R4. las dos apuntan a la misma cuenta → la revisa', misma.estado === 'revisada', misma.estado);
    prueba('R4. siempre mira las dos tablas', misma.llamadas.some((x) => /FROM usuarios_chat_center\s+WHERE/.test(x.sql)) && misma.llamadas.some((x) => /FROM configuraciones\s+WHERE/.test(x.sql)));
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\nR5. Lo informativo nunca encabeza');
  {
    const r = await revisar({ conexiones: [conexion({ metodo_pago: 0 })], asistentes: [{ id_configuracion: 101, activo: 0 }] });
    prueba('R5. pago de Meta + interruptor apagado → encabeza el interruptor', r.conexiones[0].fallas.join() === 'interruptor_apagado,meta_pago' && r.texto.includes(inicioDe(T.DIAGNOSTICO.interruptor_apagado.texto)), r.conexiones[0].fallas.join());
    const fuera = await revisar({ conexiones: [conexion({ ia_ajustes: JSON.stringify({ horario: { desde: '18:00', hasta: '08:00' } }) })], chats: [chats(14, 3)] });
    prueba('R5. solo fuera de horario y contestó 3 de 14 → sin_causa con «Además»', fuera.resultado === 'sin_causa' && fuera.texto.includes(T.MENSAJE_ASESOR) && fuera.texto.includes(`Además: ${T.DIAGNOSTICO.fuera_de_horario.corto}.`), fuera.texto);
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n5. Errores de la IA');
  prueba('«You have no credits» → sin_saldo_openai', claseErrorIA('You have no credits', 'openai') === 'sin_saldo_openai');
  prueba('«Claude: sin saldo» → sin_saldo_claude aunque la cuenta diga openai', claseErrorIA('Claude: sin saldo', 'openai') === 'sin_saldo_claude');
  prueba('«Incorrect API key» → llave_invalida_openai', claseErrorIA('Incorrect API key provided: sk-proj-abc', 'openai') === 'llave_invalida_openai');
  {
    const r = await revisar(CASOS.llave_invalida_openai[0]);
    prueba('el texto nunca trae la llave (sk-)', !/sk-/.test(r.texto));
    const c = await revisar(CASOS.sin_saldo_claude[0]);
    prueba('el saldo de Claude no manda a platform.openai.com', !/platform\.openai\.com/.test(c.texto) && /console\.anthropic\.com/.test(c.texto));
    const sql = r.llamadas.find((l) => /FROM configuraciones c/.test(l.sql)).sql;
    prueba('el SELECT de la conexión no trae llaves ni token, solo si existen', !/c\.(api_key_openai|api_key_claude|token)\s*,/.test(sql) && /AS k_oa/.test(sql) && /AS tok/.test(sql));
    prueba('openai_error_msg no se copia al texto', !r.texto.includes('Incorrect API key'));
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n6, 17. Sin fallas');
  {
    const r = await revisar();
    prueba('6. 14 de 14 chats → sano, con «14» y la clase del prompt', r.resultado === 'sano' && r.texto.includes('14 chats') && r.texto.includes(enlace('prompt')), r.texto);
    const cero = await revisar({ chats: [] });
    prueba('17. sin chats en 48 h → sin_causa', cero.resultado === 'sin_causa', cero.resultado);
    const pocos = await revisar({ chats: [chats(14, 3)] });
    prueba('17. contestó 3 de 14 → sin_causa', pocos.resultado === 'sin_causa', pocos.resultado);
    prueba('17. sin_causa nunca dice «bien conectada» y va al asesor', ![cero, pocos].some((x) => /bien conectada/.test(x.texto)) && [cero, pocos].every((x) => x.texto.includes(T.MENSAJE_ASESOR)));
    prueba('17. sin_causa cuenta lo que vio («contestó en 3»)', pocos.texto.includes('14 chats') && pocos.texto.includes('contestó en 3'));
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n7, 16, 18. Qué conexiones');
  {
    const r = await revisar({
      conexiones: [conexion(), conexion({ id: 102, nombre_configuracion: 'Vieja', suspendido: 1 })],
    });
    prueba('7. suspendida sin mensajes en 30 días → no aparece', r.conexiones.map((c) => c.id).join() === '101', r.conexiones.map((c) => c.id).join());
    const soloVieja = await revisar({ conexiones: [conexion({ suspendido: 1 })], actividad: [] });
    prueba('   solo una eliminada y sin mensajes → «no tienes número conectado»', soloVieja.texto.includes(T.DIAGNOSTICO.sin_conexion.texto));
    const quieta = await revisar({ conexiones: [conexion({ id: 103, wa_status: 'DISCONNECTED' }), conexion({ id: 104 })], actividad: [] });
    prueba('   sin mensajes en 30 días, la más reciente', quieta.conexiones.map((c) => c.id).join() === '104', quieta.conexiones.map((c) => c.id).join());

    const mala = (id, nombre) => conexion({ id, nombre_configuracion: nombre, wa_status: 'DISCONNECTED', k_oa: 0, metodo_pago: 0, ia_ajustes: JSON.stringify({ solo_numeros: ['593999999999'] }) });
    const tres = await revisar({
      conexiones: [mala(101, 'Tienda Ana con un nombre bastante largo'), mala(102, 'Segunda tienda de Ana'), mala(103, 'Tercera tienda'), mala(105, 'Cuarta')],
      asistentes: [],
      columnas: [],
      actividad: [101, 102, 103, 105].map((id, i) => ({ id_configuracion: id, n: 50 - i })),
      chats: [101, 102, 103, 105].map((id, i) => chats(20 - i, 0, { id_configuracion: id })),
    }, { verificarAcceso: NIEGA('plan_vencido') });
    prueba('16. varias conexiones con muchas fallas → texto ≤ 1400', tres.texto.length <= MAX_TEXTO, String(tres.texto.length));
    prueba('16. tope de 3 conexiones', tres.conexiones.length === 3, String(tres.conexiones.length));
    prueba('16. cada conexión con su nombre', /En «Tienda Ana/.test(tres.texto));

    const nada = await revisar({ conexiones: [] });
    prueba('18. usuario sin conexiones → sin_conexion con la clase de WhatsApp', nada.texto.includes(T.DIAGNOSTICO.sin_conexion.texto) && nada.texto.includes(enlace('whatsapp')));
    const sinPropia = await revisar({}, { propia: null });
    const sqlSin = sinPropia.llamadas.find((l) => /FROM configuraciones c/.test(l.sql)).sql;
    prueba('18. con propia = null el SQL no lleva «c.id <>»', !/c\.id <>/.test(sqlSin) && sinPropia.estado === 'revisada');
    const conPropia = await revisar({ conexiones: [conexion(), conexion({ id: 265 })] }, { propia: 265 });
    prueba('18. con propia = 265 la línea que atiende no se revisa', !conPropia.conexiones.some((c) => c.id === 265));
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n8. Errores → nunca «revisada»');
  {
    const r = await diagnosticarCuenta(TEL, { consultar: async () => { throw new Error('se cayó la base'); }, verificarAcceso: PERMITIDO, ahora: AHORA });
    prueba('8. la base falla → error con asesor', r.estado === 'error' && r.texto.includes(T.MENSAJE_ASESOR), r.estado);
    const v = await revisar({}, { verificarAcceso: async () => ({ permitido: true, motivo: 'error_verificacion' }) });
    prueba('8. planAcceso da error_verificacion → error', v.estado === 'error', v.estado);
    const lento = await diagnosticarCuenta(TEL, { consultar: () => new Promise((listo) => setTimeout(() => listo([]), 400)), verificarAcceso: PERMITIDO, ahora: AHORA, limite_ms: 50 });
    prueba('8. la base no contesta → error a tiempo', lento.estado === 'error', lento.estado);
    const raro = await revisar({}, { verificarAcceso: NIEGA('motivo_nuevo') });
    prueba('8. un motivo de plan desconocido → error, no «sano»', raro.estado === 'error', raro.estado);
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n9. Bandera de la cuenta');
  prueba('9. diagnostico sin herramientas → apagado', ajustesIA.normalizar({ soporte_expertos: { diagnostico: true } }).soporte_expertos.diagnostico === false);
  prueba('9. diagnostico con herramientas → encendido', ajustesIA.normalizar({ soporte_expertos: { herramientas: true, diagnostico: true } }).soporte_expertos.diagnostico === true);
  prueba('9. «true» suelto no lo enciende', ajustesIA.normalizar({ soporte_expertos: true }).soporte_expertos.diagnostico === false);

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n10. Herramienta');
  {
    const nombres = (h) => h.lista.map((x) => x.definicion.name).join(',');
    prueba('10. sin diagnostico, la lista es la de hoy', nombres(crearHerramientas({})) === 'ver_mi_carga,pasar_a_humano');
    prueba('10. con diagnostico → 3 herramientas', nombres(crearHerramientas({ diagnostico: true })) === 'ver_mi_carga,revisar_mi_imporchat,pasar_a_humano');
    prueba('10. con diagnostico y sin carga → 2', nombres(crearHerramientas({ diagnostico: true, cargas: false })) === 'revisar_mi_imporchat,pasar_a_humano');
    const def = crearHerramientas({ diagnostico: true }).lista[1].definicion;
    prueba('10. la herramienta solo recibe «dato» (número o correo del registro) y nada más', JSON.stringify(Object.keys(def.input_schema.properties)) === '["dato"]' && def.input_schema.additionalProperties === false);

    const b = baseFalsa(escenario({ conexiones: [conexion({ k_oa: 0 })] }));
    let imporsuit = 0;
    const h = crearHerramientas({
      telefono: TEL, canalVerificable: true, diagnostico: true, idConfiguracionPropia: 265,
      deps: { consultar: async () => { imporsuit++; return []; }, consultarImporchat: b.consultar, verificarAcceso: PERMITIDO, ahora: AHORA },
    });
    const texto = await h.lista[1].ejecutar({});
    prueba('10. revisa la base de IMPORCHAT, no la de Imporsuit', b.llamadas.length > 0 && imporsuit === 0);
    prueba('10. devuelve el texto del diagnóstico', texto.includes(inicioDe(T.DIAGNOSTICO.sin_llave_openai.texto)));
    prueba('10. queda guardado para la guardia', h.diagnosticoConsultado()?.estado === 'revisada');
    prueba('10. la línea que atiende llega como «propia»', b.llamadas.some((l) => l.r.propia === 265));
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n11. Guardia');
  {
    const hechos = () => ({ respaldo: { firme: '', estado: '' }, textoSeguro: T.MENSAJE_ASESOR });
    const diag = { estado: 'revisada', resultado: 'con_fallas', texto: 'DIAGNOSTICO' };
    const a = sumarHechosHerramientas(hechos(), ['DIAGNOSTICO'], null, { mensaje: 'mi bot no contesta', diagnostico: diag });
    prueba('11. revisada + habla de su bot → el texto seguro es el diagnóstico', a.textoSeguro === 'DIAGNOSTICO');
    const e = sumarHechosHerramientas(hechos(), ['x'], null, { mensaje: 'mi bot no contesta', diagnostico: { estado: 'error', texto: 'X' } });
    prueba('11. con error → sigue el asesor', e.textoSeguro === T.MENSAJE_ASESOR);
    const s = sumarHechosHerramientas(hechos(), ['x'], null, { mensaje: 'mi bot no contesta', diagnostico: { ...diag, resultado: 'sin_causa' } });
    prueba('11. con sin_causa → sigue el asesor', s.textoSeguro === T.MENSAJE_ASESOR);
    const otro = sumarHechosHerramientas(hechos(), ['x'], null, { mensaje: 'ya hice el pago de la clase', diagnostico: diag });
    prueba('11. si no habla de su IMPORCHAT → sigue el asesor', otro.textoSeguro === T.MENSAJE_ASESOR);
    const largo = sumarHechosHerramientas(hechos(), ['x'], null, { mensaje: 'mi bot no contesta', diagnostico: { ...diag, texto: 'x'.repeat(1401) } });
    prueba('11. un diagnóstico de más de 1400 → sigue el asesor', largo.textoSeguro === T.MENSAJE_ASESOR);
    const sinDiag = sumarHechosHerramientas(hechos(), ['x'], null, { mensaje: 'mi bot no contesta' });
    prueba('11. sin diagnóstico → como hoy', sinDiag.textoSeguro === T.MENSAJE_ASESOR);
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n12. Catálogo de textos');
  {
    const fijos = Object.values(T.TEXTOS_FIJOS);
    prueba('12. ningún texto del diagnóstico entra en TEXTOS_FIJOS', !Object.values(T.DIAGNOSTICO).some((d) => fijos.includes(d.texto)) && !('DIAGNOSTICO' in T.TEXTOS_FIJOS) && !fijos.some((t) => /cursos\/32\?contenido=6(5[1458]|34)\b/.test(String(t))));
    prueba('12. cada falla tiene texto y frase corta', Object.values(T.DIAGNOSTICO).every((d) => d.texto && d.corto));
    const malos = Object.entries(T.DIAGNOSTICO).filter(([, d]) => d.tutorial && !T.TUTORIALES[d.tutorial]).map(([k]) => k);
    prueba('12. cada tutorial existe', !malos.length, malos.join(', '));
    prueba('12. todos los tutoriales son del curso de IMPORCHAT', Object.values(T.TUTORIALES).every((t) => /^https:\/\/imporfactory\.app\/cursos\/32\?contenido=\d+$/.test(t.enlace)));
    const todos = [...Object.values(T.DIAGNOSTICO).map((d) => d.texto), ...Object.values(T.DIAGNOSTICO_FRASES), SECCION_DIAGNOSTICO];
    const conVoseo = todos.filter((t) => VOSEO.test(t));
    prueba('12. tuteo, nunca voseo', !conVoseo.length, conVoseo.join(' | ').slice(0, 200));
    prueba('12. sin emojis (el prompt de la 265 los prohíbe)', !todos.some((t) => /\p{Extended_Pictographic}/u.test(t)));
    const largos = Object.entries(T.DIAGNOSTICO).filter(([, d]) => (d.texto.match(/[.!?](\s|$)/g) || []).length > 3).map(([k]) => k);
    prueba('12. ningún texto pasa de 3 frases', !largos.length, largos.join(', '));
    prueba('12. la sección del prompt nombra la herramienta y no reemplaza la de herramientas', /revisar_mi_imporchat/.test(SECCION_DIAGNOSTICO) && /ver_mi_carga/.test(SECCION_HERRAMIENTAS));
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\nD1-D13 y P1-P8. Registrado con otro número o con su correo (Daniel, 24-oct)');
  {
    const OTRO = '593999000111'; // escribe desde un número que no es el de su cuenta
    const conDato = (dato, mensaje, cambios = {}, o = {}) => {
      const b = baseFalsa(escenario(cambios));
      return diagnosticarCuenta(o.telefono || OTRO, {
        consultar: b.consultar, verificarAcceso: PERMITIDO, ahora: o.ahora || AHORA, propia: 265,
        dato, mensaje: mensaje === undefined ? dato : mensaje,
      }).then((r) => ({ ...r, llamadas: b.llamadas }));
    };
    olvidarDatosProbados();
    let r = await conDato('0987123456', 'me registré con el 0987123456');
    prueba('D1. número sin código de país (el del registro) → revisa su cuenta', r.estado === 'revisada' && r.por === 'dato', `${r.estado} ${r.por}`);
    prueba('    y empieza diciendo con qué la encontró', r.texto.startsWith('Encontré tu cuenta con ese número.'), r.texto.slice(0, 60));
    r = await conDato('+593 98 712 3456', 'es el +593 98 712 3456');
    prueba('D2. número con código y espacios → revisa', r.estado === 'revisada', r.estado);
    olvidarDatosProbados();
    r = await conDato('Ana.Perez@Gmail.com', 'mi correo es Ana.Perez@Gmail.com', { correos: [{ id_usuario: 7, email: 'ana.perez@gmail.com', sub: false }] });
    prueba('D3. correo del dueño (sin importar mayúsculas) → revisa', r.estado === 'revisada' && r.texto.startsWith('Encontré tu cuenta con ese correo.'), r.estado);
    r = await conDato('admin@tienda.com', 'admin@tienda.com', { correos: [{ id_usuario: 7, email: 'admin@tienda.com', sub: true }] });
    prueba('D4. correo del administrador de la cuenta → revisa', r.estado === 'revisada', r.estado);
    r = await conDato('x@y.com', 'x@y.com', { correos: [{ id_usuario: 7, email: 'x@y.com', sub: false }, { id_usuario: 8, email: 'x@y.com', sub: true }] });
    prueba('D5. correo en dos cuentas → ambiguo, al asesor, sin revisar nada', r.estado === 'ambiguo' && r.texto.includes(T.MENSAJE_ASESOR) && !r.llamadas.some((l) => /FROM configuraciones c/.test(l.sql)));
    olvidarDatosProbados();
    r = await conDato('nadie@gmail.com', 'nadie@gmail.com');
    prueba('D6. correo sin cuenta → «Tampoco encontré…» + asesor + clase de crear cuenta', /^Tampoco encontré una cuenta de IMPORCHAT con ese correo\./.test(r.texto) && r.texto.includes(T.MENSAJE_ASESOR) && r.texto.includes(enlace('cuenta')));
    r = await conDato('0987123456', 'hola, mi bot no contesta');
    prueba('D7. dato que no está en el mensaje de este turno → no busca, lo pide', r.estado === 'pide_dato' && r.texto === T.DIAGNOSTICO_FRASES.dato_no_escrito && !r.llamadas.some((l) => /:correo|FROM configuraciones c/.test(l.sql)));
    r = await conDato('mi tienda', 'mi tienda');
    prueba('D8. algo que no es número ni correo → pide el dato bien escrito', r.estado === 'pide_dato' && r.texto === T.DIAGNOSTICO_FRASES.dato_invalido);
    olvidarDatosProbados();
    for (const c of ['a1@x.com', 'a2@x.com', 'a3@x.com']) await conDato(c, c);
    r = await conDato('a1@x.com', 'a1@x.com');
    prueba('D9. repetir un dato ya probado no gasta intentos', r.estado === 'sin_cuenta', r.estado);
    r = await conDato('a4@x.com', 'a4@x.com');
    prueba(`D9. el ${MAX_DATOS + 1}.º dato distinto del día → límite y asesor, sin consultar`, r.estado === 'limite' && r.texto.includes(T.MENSAJE_ASESOR) && !r.llamadas.length, r.estado);
    r = await conDato('a4@x.com', 'a4@x.com', {}, { ahora: new Date(AHORA.getTime() + 25 * 3600 * 1000) });
    prueba('D10. al día siguiente puede volver a probar', r.estado === 'sin_cuenta', r.estado);
    olvidarDatosProbados();
    r = await conDato('otra@cuenta.com', 'otra@cuenta.com', { correos: [{ id_usuario: 8, email: 'otra@cuenta.com', sub: false }] }, { telefono: TEL });
    prueba('D11. si su WhatsApp SÍ tiene cuenta, el dato se ignora y revisa la suya', r.estado === 'revisada' && r.por === 'numero' && !r.llamadas.some((l) => /:correo/.test(l.sql)));
    const lim = leerDato('0987654321', '5215512345678');
    prueba('D12. un 09… escrito desde México no se completa como Ecuador', !lim || !lim.valor.startsWith('593'), JSON.stringify(lim));
    prueba('D12. 55 1234 5678 desde México → 52 + número', leerDato('55 1234 5678', '5215512345678')?.valor === '525512345678');
    olvidarDatosProbados();
    // La herramienta pasa el dato y el mensaje del turno.
    const b = baseFalsa(escenario());
    const h = crearHerramientas({ telefono: OTRO, mensaje: 'con este: 0987123456', canalVerificable: true, diagnostico: true, idConfiguracionPropia: 265,
      deps: { consultarImporchat: b.consultar, verificarAcceso: PERMITIDO, ahora: AHORA } });
    const herr = h.lista.find((x) => x.definicion.name === 'revisar_mi_imporchat');
    prueba('D13. el esquema ofrece solo el campo «dato», opcional', JSON.stringify(Object.keys(herr.definicion.input_schema.properties)) === '["dato"]' && !herr.definicion.input_schema.required);
    const t = await herr.ejecutar({ dato: '0987123456' });
    prueba('D13. la herramienta revisa con el dato del mensaje', t.startsWith('Encontré tu cuenta con ese número.') && h.diagnosticoConsultado().por === 'dato', t.slice(0, 60));
    prueba('D13. ver_mi_carga sigue sin ningún campo', JSON.stringify(h.lista[0].definicion.input_schema.properties) === '{}');
    olvidarDatosProbados();

    // Revisión independiente (24-oct): privacidad del camino del dato.
    r = await conDato('+593 98 555 0000', 'es el +593 98 555 0000', { usuarios: [] });
    prueba('P1. el número de una CONEXIÓN (el de atención, público) escrito en el chat no abre la cuenta', r.estado === 'sin_cuenta', r.estado);
    olvidarDatosProbados();
    r = await conDato('0987123456', 'me registré con el 0987123456', {
      conexiones: [conexion(), conexion({ id: 102, nombre_configuracion: 'Tienda Dos' })],
      chats: [chats(14, 3), chats(6, 1, { id_configuracion: 102 })],
      columnas: [columna(), columna({ id: 2, id_configuracion: 102 })],
      asistentes: [{ id_configuracion: 101, activo: 1 }, { id_configuracion: 102, activo: 0 }],
      actividad: [{ id_configuracion: 101, n: 40 }, { id_configuracion: 102, n: 9 }],
    });
    prueba('P2. por dato: sin nombres de conexión', r.estado === 'revisada' && !/Tienda/.test(r.texto), r.texto.slice(0, 120));
    prueba('P2. por dato: sin cifras de la cuenta', !/\b(14|6|3)\b/.test(r.texto.replace(/https?:\S+/g, '')), r.texto);
    const sinDato = await revisar({ chats: [chats(14, 14)] });
    olvidarDatosProbados();
    const sanoDato = await conDato('0987123456', 'me registré con el 0987123456');
    prueba('P3. sana por su WhatsApp: con cifras · sana por dato: sin cifras', /14 chats/.test(sinDato.texto) && !/14/.test(sanoDato.texto) && sanoDato.resultado === 'sano', sanoDato.texto.slice(0, 120));
    olvidarDatosProbados();
    r = await conDato('ana@gmail.com', 'mi correo es xana@gmail.com', { correos: [{ id_usuario: 7, email: 'ana@gmail.com', sub: false }] });
    prueba('P4. correo que solo está DENTRO de otro (xana@ / ana@) → no vale', r.estado === 'pide_dato', r.estado);
    r = await conDato('ana@gmail.com', 'es ana@gmail.com.', { correos: [{ id_usuario: 7, email: 'ana@gmail.com', sub: false }] });
    prueba('P4. correo con punto final de la frase → vale', r.estado === 'revisada', r.estado);
    r = await conDato('+593987123456', 'es el +51 987123456');
    prueba('P5. número de otro país con la misma cola → no vale', r.estado === 'pide_dato', r.estado);
    olvidarDatosProbados();
    const hechos = () => ({ respaldo: { firme: '', estado: '' }, textoSeguro: T.MENSAJE_ASESOR });
    const pide = sumarHechosHerramientas(hechos(), ['x'], null, { mensaje: 'hola', diagnostico: { estado: 'sin_cuenta', texto: T.DIAGNOSTICO_FRASES.sin_cuenta } });
    prueba('P6. si la guardia frena el «no encontré tu cuenta», va el texto fijo que pide el dato', pide.textoSeguro === T.DIAGNOSTICO_FRASES.sin_cuenta);
    const { pideDatosDeOtro } = require('../src/utils/soporteExpertos/intencion');
    prueba('P7. «el estado de mi imporchat, me registré con el 0987…» no dispara el candado de la carga ajena', !pideDatosDeOtro('el estado de mi imporchat, me registré con el número 0987123456', OTRO).pide);
    prueba('P7. «dónde está la carga del 0987…» sigue con candado', pideDatosDeOtro('dónde está la carga del 0987123456', OTRO).pide);
    for (let i = 0; i < 1100; i++) await conDato('x@x.com', 'x@x.com', {}, { telefono: `5939${String(i).padStart(8, '0')}` });
    r = await conDato('x@x.com', 'x@x.com', {}, { telefono: '593911111111', ahora: new Date(AHORA.getTime() + 25 * 3600 * 1000) });
    prueba('P8. con más de mil teléfonos guardados se barren los vencidos y sigue funcionando', r.estado === 'sin_cuenta', r.estado);
    olvidarDatosProbados();
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n13. ¿Habla de su IMPORCHAT?');
  for (const f of ['Mi bot no contesta', 'se me desconectó el WhatsApp de imporchat', 'mi api key de Open AI no funciona', 'el bot responde cualquier cosa', 'no sé cómo poner el prompt de la columna']) {
    prueba(`13. sí: «${f}»`, hablaDeImporchat(f));
  }
  for (const f of ['cuándo llega mi carga', 'ya hice el pago', 'buenas tardes', 'quiero cotizar 500 unidades', 'no me llega el link de la clase']) {
    prueba(`13. no: «${f}»`, !hablaDeImporchat(f));
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n14. Instalador');
  {
    const f = { cargas: true, fichas: false, herramientas: true };
    const m = mezclarSoporteExpertos({ soporte_expertos: { diagnostico: true, algo_nuevo: 3, cargas: false } }, f);
    prueba('14. conserva diagnostico y lo desconocido', m.diagnostico === true && m.algo_nuevo === 3);
    prueba('14. pisa lo que maneja el instalador', m.cargas === true && m.fichas === false && m.guardia === true && m.herramientas === true);
    const v = mezclarSoporteExpertos({}, f);
    prueba('14. sin nada previo da lo mismo que hoy', JSON.stringify(v) === JSON.stringify({ cargas: true, fichas: false, guardia: true, herramientas: true }));
    prueba('14. «true» suelto previo no se esparce', JSON.stringify(mezclarSoporteExpertos({ soporte_expertos: true }, f)) === JSON.stringify(v));
    const instalador = fs.readFileSync(path.join(__dirname, 'instalarBotSoporteExpertos.js'), 'utf8');
    prueba('14. el instalador usa la mezcla', /soporte_expertos: mezclarSoporteExpertos\(previo,/.test(instalador) && (instalador.match(/soporte_expertos:/g) || []).length === 1);
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n19 y lo que solo se prueba en la base real');
  {
    const r = await revisar();
    const ev = r.llamadas.find((l) => /FROM clientes_chat_center/.test(l.sql));
    prueba('19. la respuesta de respaldo (IA_respaldo) no cuenta como respuesta del bot', ev.r.no_ia.includes('IA_respaldo') && /REGEXP '\^IA_'/.test(ev.sql));
    prueba('todas las consultas son SELECT', r.llamadas.every((l) => /^\s*select\b/i.test(l.sql)));
    const salud = fs.readFileSync(rutaSalud, 'utf8');
    prueba('la lista de estados de WhatsApp es la del servicio real', ESTADOS_RECONECTAR.every((e) => salud.includes(`'${e}'`)));
  }

  console.log(`\n${fallos ? `HAY FALLAS: ${fallos} fallan, ${ok} pasan` : `TODO BIEN: ${ok} pasan, 0 fallan`}`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
