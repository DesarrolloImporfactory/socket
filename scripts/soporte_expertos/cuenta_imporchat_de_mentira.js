/* Una cuenta de IMPORCHAT de mentira para probar «revisar_mi_imporchat»
   (diagnosticoCuenta.js) sin base de datos: responde cada consulta según el
   escenario. La usan scripts/probar_soporte_expertos_diagnostico.js y el arnés. */
'use strict';

/* La lista de estados de WhatsApp de services/whatsapp_numero_health.service
   (que carga axios al empezar). La prueba comprueba que sea la del archivo real. */
const ESTADOS_RECONECTAR = ['DISCONNECTED', 'PENDING', 'MIGRATED', 'BANNED', 'DELETED', 'SUSPENDED', 'TOKEN_EXPIRED', 'SIN_ACCESO', 'NO_REGISTRADO'];

const TEL = '593987123456'; // el alumno que escribe
const AHORA = new Date('2026-10-24T17:00:00Z'); // 12:00 en Ecuador
const cola = (v) => String(v || '').replace(/\D/g, '').slice(-9);

const conexion = (extra = {}) => ({
  id: 101,
  id_usuario: 7,
  nombre_configuracion: 'Tienda Ana',
  telefono: '+593 98 555 0000',
  suspendido: 0,
  tipo_configuracion: 'kanban',
  proveedor_ia: 'openai',
  k_oa: 1,
  k_cl: 0,
  tok: 1,
  vinculada: 1,
  wa_status: 'CONNECTED',
  wa_status_at: '2026-10-22T15:00:00Z',
  metodo_pago: 1,
  openai_activo: 1,
  openai_error_msg: null,
  openai_error_at: null,
  ia_ajustes: null,
  fecha_renovacion: '2026-10-20T15:00:00Z',
  ...extra,
});
const columna = (extra = {}) => ({
  id: 1, id_configuracion: 101, nombre: 'Contacto inicial', estado_db: 'contacto_inicial',
  es_principal: 1, orden: 1, con_ia: 1, sin_prompt: 0, ...extra,
});

/** Fila de la consulta de chats (D6 + D7): n chats escribieron en 48 h en
    esa columna, con ese bot del chat, y la IA contestó en `contestados`. */
const chats = (n, contestados, extra = {}) => ({
  id_configuracion: 101, estado: 'contacto_inicial', bot_openia: 1, n, contestados, ...extra,
});

/** Una cuenta sana: 14 chats en 48 h y el bot contestó los 14. Cada prueba cambia lo suyo. */
function escenario(cambios = {}) {
  return {
    usuarios: [{ id_usuario: 7, pais: '+593', lead: '0987123456' }],
    conexiones: [conexion()],
    asistentes: [{ id_configuracion: 101, activo: 1 }],
    columnas: [columna()],
    chats: [chats(14, 14)],
    actividad: [{ id_configuracion: 101, n: 40 }],
    // [{ id_usuario, email, sub }]: sub = correo del administrador (sub_usuarios), si no, del dueño.
    correos: [],
    // Imporsuit: [{ email, whatsapp }] = alumnos cuya plataforma tiene ese WhatsApp.
    alumnos: [],
    ...cambios,
  };
}

/** Responde cada consulta de diagnosticoCuenta con los datos del escenario. */
function baseFalsa(e) {
  const llamadas = [];
  const enIds = (filas, r) => filas.filter((f) => (r.ids || []).map(Number).includes(Number(f.id_configuracion)));
  const consultar = async (sql, r = {}) => {
    llamadas.push({ sql, r });
    // Por correo (el dato que escribió el alumno): dueño de la cuenta o su administrador.
    if (/FROM sub_usuarios_chat_center[\s\S]*:correo/.test(sql)) {
      return (e.correos || []).filter((c) => c.sub && c.email.toLowerCase() === r.correo);
    }
    if (/FROM usuarios_chat_center[\s\S]*:correo/.test(sql)) {
      return (e.correos || []).filter((c) => !c.sub && c.email.toLowerCase() === r.correo);
    }
    if (/FROM usuarios_chat_center\s+WHERE/.test(sql)) {
      return e.usuarios.filter((u) => cola(`${u.pais || ''}${u.lead || ''}`) === r.cola);
    }
    if (/FROM configuraciones\s+WHERE/.test(sql)) {
      return e.conexiones.filter((c) => cola(c.telefono) === r.cola && (!r.propia || c.id !== r.propia));
    }
    if (/FROM configuraciones c/.test(sql)) {
      return e.conexiones.filter((c) => c.id_usuario === r.uid && (!r.propia || c.id !== r.propia));
    }
    if (/INTERVAL 30 DAY/.test(sql)) return enIds(e.actividad, r);
    if (/FROM openai_assistants/.test(sql)) return enIds(e.asistentes, r);
    if (/FROM kanban_columnas/.test(sql)) return enIds(e.columnas, r);
    if (/FROM clientes_chat_center/.test(sql)) return enIds(e.chats, r);
    throw new Error(`consulta inesperada: ${sql.slice(0, 80)}`);
  };
  // Imporsuit (db_2): solo el cruce del WhatsApp con la plataforma del alumno.
  const consultarImporsuit = async (sql, valores = []) => {
    llamadas.push({ sql, r: valores, imporsuit: true });
    if (e.imporsuitFalla) throw new Error(e.imporsuitFalla);
    if (/FROM plataformas p[\s\S]*\?/.test(sql)) return (e.alumnos || []).filter((a) => cola(a.whatsapp) === valores[0]);
    throw new Error(`consulta inesperada a Imporsuit: ${sql.slice(0, 80)}`);
  };
  return { consultar, consultarImporsuit, llamadas };
}

const PERMITIDO = async () => ({ permitido: true, motivo: 'ok' });
const NIEGA = (motivo) => async () => ({ permitido: false, motivo });


module.exports = { ESTADOS_RECONECTAR, TEL, AHORA, conexion, columna, chats, escenario, baseFalsa, PERMITIDO, NIEGA };
