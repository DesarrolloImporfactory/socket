/* «Mi bot no contesta»: revisa la cuenta de IMPORCHAT del que escribe y dice
   qué está fallando, con la clase que lo explica.

   Con el teléfono de WhatsApp del que escribe —y SOLO con ese dato— busca su
   cuenta de IMPORCHAT y recorre, para cada conexión suya, las mismas puertas
   que recorre el motor antes de contestar (`kanban_ia.service.js`,
   `procesarMensajeKanban`), en el mismo orden:

     D1 plan y conexión      → planAcceso.verificarAccesoAutomatizaciones
     D2 WhatsApp             → id_telefono / id_whatsapp / wa_status / metodo_pago
     D3 interruptor          → openai_assistants tipo 'ventas'
     D4 ajustes del bot      → ia_ajustes (modo prueba, horario)
     D5 IA y llave           → proveedor_ia, llave guardada, openai_activo y su error
     D6 columnas             → la columna de los chats que escribieron en 48 h
     D7 evidencia            → en 48 h, en cuántos chats le escribieron y en cuántos contestó el bot

   Todo sale de lo que IMPORCHAT ya guardó: no llama a Meta ni a OpenAI.

   SOLO LECTURA: este archivo no tiene un solo INSERT, UPDATE ni DELETE, y el
   adaptador de consulta se niega a ejecutar cualquier cosa que no empiece por
   SELECT.

   SEGURIDAD — de quién es la cuenta:
     · Se entra por el número de WhatsApp del remitente, que lo entrega Meta.
       Nunca por un número o un correo que alguien ESCRIBA en el chat.
     · Solo vale la coincidencia 'exacta' (`telefono.comoCoincide`): un número
       guardado sin código de país no prueba de qué país es.
     · Si el número aparece en dos cuentas, no se revisa ninguna.
     · Las llaves y el token NO se leen: el SELECT devuelve solo si existen. El
       mensaje de error de OpenAI (trae «sk-proj-***») solo se usa para
       clasificar, nunca se copia al texto.
     · El texto sale del catálogo fijo `T.DIAGNOSTICO` (Daniel lo aprueba antes
       de encender), con los nombres de SUS conexiones y columnas. */

'use strict';

const T = require('./textos');
const { comoCoincide, colaCandidatos } = require('./telefono');

const LIMITE_MS = 7000; // la herramienta tiene 8 s de tope (TOPE_HERRAMIENTA_MS)
const MAX_TEXTO = 1400; // la guardia corta en 1500 (guardia.js, MAX_RESPUESTA)
const MAX_CONEXIONES = 3;
const SANO_SI = 0.9; // el bot contestó en al menos el 90 % de los chats

/* Errores de IA guardados en configuraciones.openai_error_msg. Los de Claude
   llevan el prefijo «Claude:» (kanban_ia.service.js, marcarOpenAIInactivo). */
const CLASE_ERROR = [
  [/no credits|credit balance|sin saldo|insufficient/i, 'sin_saldo'],
  [/exceeded your current quota|quota/i, 'cuota_agotada'],
  [/incorrect api key|invalid.*api[ -]?key|authentication_error|revocad|inv[aá]lida/i, 'llave_invalida'],
];

/* Lo que planAcceso devuelve cuando NO deja pasar → clave de T.DIAGNOSTICO. */
const FALLA_ACCESO = {
  sin_configuracion: 'configuracion_inexistente',
  configuracion_inexistente: 'configuracion_inexistente',
  conexion_suspendida: 'conexion_suspendida',
  sin_usuario: 'sin_usuario',
  cuenta_suspendido: 'cuenta_suspendido',
  cuenta_cancelado: 'cuenta_cancelado',
  sin_plan: 'sin_plan',
  plan_vencido: 'plan_vencido',
  plan_inactivo: 'plan_inactivo',
  plan_descatalogado: 'plan_descatalogado',
};
// Con estas la conexión no existe para el motor: lo demás no se revisa.
const FALLA_TERMINAL = new Set(['configuracion_inexistente', 'conexion_suspendida', 'sin_usuario']);

const WA_PROPIO = { BANNED: 'wa_baneado', NO_REGISTRADO: 'wa_no_registrado', TOKEN_EXPIRED: 'wa_token_vencido' };

const COLA_SQL = (col) => `RIGHT(REGEXP_REPLACE(COALESCE(${col}, ''), '[^0-9]', ''), 9)`;

/** Consulta de solo lectura a la base de IMPORCHAT. Se carga recién al usarla
    para que las pruebas locales no necesiten la base. */
async function consultarImporchat(sql, replacements = {}) {
  if (!/^\s*select\b/i.test(sql) || /;\s*\S/.test(sql)) {
    throw new Error('diagnosticoCuenta: solo se permiten consultas SELECT');
  }
  // eslint-disable-next-line global-require
  const { db } = require('../../database/config');
  return db.query(sql, { replacements, type: db.QueryTypes.SELECT });
}

// eslint-disable-next-line global-require
const verificarAccesoReal = (id) => require('../planAcceso').verificarAccesoAutomatizaciones(id);
// eslint-disable-next-line global-require
const estadosReconectarReales = () => require('../../services/whatsapp_numero_health.service').ESTADOS_RECONECTAR;
// eslint-disable-next-line global-require
const ajustesReales = () => require('../ajustesIA');

const conLimite = (promesa, ms) =>
  Promise.race([
    promesa,
    new Promise((_, rechazar) => {
      const t = setTimeout(() => rechazar(new Error(`sin respuesta en ${ms} ms`)), ms);
      if (t.unref) t.unref();
    }),
  ]);

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const UTC_ECUADOR = -5;
/** « desde el 22-oct» (día de Ecuador), o '' si la fecha no sirve. */
function desde(fecha, ahora) {
  if (!fecha) return '';
  const d = new Date(fecha);
  if (Number.isNaN(d.getTime()) || d.getTime() > ahora.getTime()) return '';
  const local = new Date(d.getTime() + UTC_ECUADOR * 60 * 60 * 1000);
  return ` desde el ${local.getUTCDate()}-${MESES[local.getUTCMonth()]}`;
}

/** Nombre de una conexión o columna, para el texto: una línea y corto. */
const nombreCorto = (v, porDefecto) => {
  const s = String(v || '').replace(/\s+/g, ' ').replace(/[«»]/g, '').trim();
  return s ? s.slice(0, 40) : porDefecto;
};

const llenar = (texto, vars = {}) =>
  texto.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));

/* ── 1. ¿De quién es este número? ─────────────────────────────────────────── */
async function identificar(telefono, consultar, propia) {
  const cola = colaCandidatos(telefono);
  if (!cola) return { estado: 'sin_cuenta' };

  // El WhatsApp personal del registro (usuarios_chat_center.whatsapp_lead) y
  // el número de las conexiones (configuraciones.telefono). Se miran SIEMPRE
  // los dos: si apuntan a cuentas distintas, no se revisa ninguna.
  const leads = await consultar(
    `SELECT id_usuario, whatsapp_lead_pais AS pais, whatsapp_lead AS lead
       FROM usuarios_chat_center
      WHERE ${COLA_SQL("CONCAT(COALESCE(whatsapp_lead_pais, ''), COALESCE(whatsapp_lead, ''))")} = :cola
      LIMIT 20`,
    { cola },
  );
  const usuarios = new Set(
    (leads || [])
      .filter(
        (f) =>
          comoCoincide(telefono, `${f.pais || ''}${f.lead || ''}`) === 'exacto' ||
          comoCoincide(telefono, f.lead) === 'exacto',
      )
      .map((f) => Number(f.id_usuario))
      .filter(Boolean),
  );

  const porRegistro = new Set(usuarios);
  const lineas = await consultar(
    `SELECT id, id_usuario, telefono
       FROM configuraciones
      WHERE ${COLA_SQL('telefono')} = :cola AND id_usuario IS NOT NULL${propia ? ' AND id <> :propia' : ''}
      LIMIT 20`,
    propia ? { cola, propia } : { cola },
  );
  const conexionesDelNumero = new Set();
  for (const f of lineas || []) {
    if (comoCoincide(telefono, f.telefono) === 'exacto' && Number(f.id_usuario)) {
      usuarios.add(Number(f.id_usuario));
      conexionesDelNumero.add(Number(f.id));
    }
  }

  if (usuarios.size > 1) return { estado: 'ambiguo' };
  if (!usuarios.size) return { estado: 'sin_cuenta' };
  // Si solo se le encontró por el número de una conexión, se revisa solo esa:
  // en una agencia, las otras conexiones de la cuenta pueden ser de otra persona.
  return { estado: 'ok', idUsuario: [...usuarios][0], solo: porRegistro.size ? null : conexionesDelNumero };
}

/* ── 2. ¿Qué conexiones se revisan? ───────────────────────────────────────── */
const SQL_CONEXIONES = (conPropia) => `
  SELECT c.id, c.nombre_configuracion, c.suspendido, c.tipo_configuracion, c.proveedor_ia,
         (c.api_key_openai IS NOT NULL AND c.api_key_openai <> '') AS k_oa,
         (c.api_key_claude IS NOT NULL AND c.api_key_claude <> '') AS k_cl,
         (c.token IS NOT NULL AND c.token <> '') AS tok,
         (COALESCE(c.id_telefono, '') <> '' AND COALESCE(c.id_whatsapp, '') <> '') AS vinculada,
         c.wa_status, c.metodo_pago,
         c.openai_activo, c.openai_error_msg, c.ia_ajustes,
         u.fecha_renovacion
    FROM configuraciones c
    LEFT JOIN usuarios_chat_center u ON u.id_usuario = c.id_usuario
   WHERE c.id_usuario = :uid${conPropia ? ' AND c.id <> :propia' : ''}
   ORDER BY c.id DESC
   LIMIT 50`;

async function elegirConexiones(idUsuario, consultar, propia, solo) {
  const todas = ((await consultar(SQL_CONEXIONES(Boolean(propia)), propia ? { uid: idUsuario, propia } : { uid: idUsuario })) || [])
    .filter((c) => !solo || solo.has(Number(c.id)));
  if (!todas.length) return [];

  const actividad = await consultar(
    `SELECT id_configuracion, COUNT(*) AS n
       FROM mensajes_clientes
      WHERE id_configuracion IN (:ids) AND rol_mensaje = 0 AND deleted_at IS NULL
        AND created_at >= NOW() - INTERVAL 30 DAY
      GROUP BY id_configuracion`,
    { ids: todas.map((c) => c.id) },
  );
  const mensajes = new Map((actividad || []).map((f) => [Number(f.id_configuracion), Number(f.n) || 0]));

  const conMensajes = todas
    .filter((c) => mensajes.get(Number(c.id)) > 0)
    .sort((a, b) => mensajes.get(Number(b.id)) - mensajes.get(Number(a.id)) || Number(b.id) - Number(a.id));
  if (conMensajes.length) return conMensajes.slice(0, MAX_CONEXIONES);

  // Ninguna tuvo mensajes en 30 días: la más reciente que no esté eliminada.
  const vivas = todas.filter((c) => Number(c.suspendido) !== 1).sort((a, b) => Number(b.id) - Number(a.id));
  return vivas.length ? [vivas[0]] : [];
}

/* ── 3. Las puertas del motor, conexión por conexión ─────────────────────── */
function claseErrorIA(msg, proveedorIA) {
  const proveedor = /^\s*claude:/i.test(msg) || proveedorIA === 'claude' ? 'claude' : 'openai';
  const fila = CLASE_ERROR.find(([re]) => re.test(msg));
  return `${fila ? fila[1] : 'ia_error'}_${proveedor}`;
}

async function revisarConexion(cfg, ctx) {
  const fallas = [];
  const agregar = (clave, vars = {}) => fallas.push({ clave, vars });

  // D1 · plan y conexión (las mismas reglas que corta el motor).
  const acceso = await ctx.verificarAcceso(cfg.id);
  if (!acceso || acceso.motivo === 'error_verificacion') throw new Error('no se pudo verificar el plan');
  if (!acceso.permitido) {
    const clave = FALLA_ACCESO[acceso.motivo];
    if (!clave) throw new Error(`motivo de acceso desconocido: ${acceso.motivo}`);
    agregar(clave, { desde: clave === 'plan_vencido' ? desde(cfg.fecha_renovacion, ctx.ahora) : '' });
    if (FALLA_TERMINAL.has(clave)) return { fallas, evidencia: { escribieron: 0, chats: 0, contestados: 0 } };
  }

  // D2 · WhatsApp.
  // Sin fecha: wa_status_at se reescribe en cada chequeo de salud, no marca
  // cuándo se cayó. Lo mismo openai_error_at en D5 (cada fallo lo pisa).
  const wa = String(cfg.wa_status || '').toUpperCase();
  if (!Number(cfg.vinculada)) agregar('wa_sin_vincular');
  else if (WA_PROPIO[wa]) agregar(WA_PROPIO[wa]);
  else if (ctx.estadosReconectar.includes(wa)) agregar('wa_reconectar');
  else if (!Number(cfg.tok)) agregar('wa_reconectar');
  if (cfg.metodo_pago !== null && cfg.metodo_pago !== undefined && Number(cfg.metodo_pago) === 0) agregar('meta_pago');

  // D3 · interruptor «Bot activo» (Integraciones → Asistentes AI).
  const interruptor = ctx.interruptores.get(Number(cfg.id));
  if (!interruptor) agregar('interruptor_nunca');
  else if (Number(interruptor.activo) === 0) agregar('interruptor_apagado');

  // D4 · ajustes del bot (no se arreglan desde el panel).
  const ajustes = ctx.ajustesIA.normalizar(cfg.ia_ajustes);
  if (ajustes.solo_numeros?.length) agregar('modo_prueba', { n: ajustes.solo_numeros.length });
  if (!ctx.ajustesIA.dentroDeHorario(ajustes, ctx.ahora)) agregar('fuera_de_horario');

  // D5 · IA y llave.
  const proveedor = cfg.proveedor_ia === 'claude' ? 'claude' : 'openai';
  const tieneLlave = Number(proveedor === 'claude' ? cfg.k_cl : cfg.k_oa) === 1;
  if (!tieneLlave) agregar(`sin_llave_${proveedor}`);
  else if (cfg.openai_activo !== null && cfg.openai_activo !== undefined && Number(cfg.openai_activo) === 0) {
    agregar(claseErrorIA(String(cfg.openai_error_msg || ''), proveedor));
  }

  // D6 · columnas (solo el tablero kanban tiene columnas).
  const chats = ctx.chats.get(Number(cfg.id)) || [];
  const esKanban = !cfg.tipo_configuracion || cfg.tipo_configuracion === 'kanban';
  const columnas = esKanban ? ctx.columnas.get(Number(cfg.id)) || [] : [];
  const porEstado = new Map(columnas.map((c) => [String(c.estado_db || '').toLowerCase(), c]));
  if (esKanban) {
    if (!columnas.length) {
      agregar('sin_columnas');
    } else {
      // Las plantillas traen columnas sin IA a propósito (asesor, perdidos,
      // cerrado…) y el motor mueve chats ahí: eso no es una falla. Solo se
      // marca la columna donde entra un chat nuevo.
      const entrada =
        porEstado.get('contacto_inicial') ||
        columnas.find((c) => Number(c.es_principal) === 1) ||
        [...columnas].sort((a, b) => (Number(a.orden) || 0) - (Number(b.orden) || 0))[0];
      const enEntrada = chats
        .filter((f) => porEstado.get(String(f.estado || '').toLowerCase()) === entrada)
        .reduce((s, f) => s + (Number(f.n) || 0), 0);
      if (!Number(entrada.con_ia)) {
        agregar('columna_sin_ia', {
          columna: nombreCorto(entrada.nombre, 'principal'),
          chats: enEntrada > 0 ? ` y ahí están ${enEntrada} de tus chats` : '',
        });
      }
      // Con IA pero sin prompt sí es falla, en la de entrada o donde haya chats.
      const conChats = new Set(chats.map((f) => porEstado.get(String(f.estado || '').toLowerCase())).filter(Boolean));
      const sinPrompt = [entrada, ...conChats].find((c) => Number(c.con_ia) && Number(c.sin_prompt));
      if (sinPrompt) agregar('columna_sin_prompt', { columna: nombreCorto(sinPrompt.nombre, 'principal') });
      // Chats en un estado sin columna activa: el motor no les contesta («sin_columna»).
      const huerfanos = chats.filter((f) => Number(f.bot_openia) === 1 && !porEstado.has(String(f.estado || '').toLowerCase()));
      const nHuerfanos = huerfanos.reduce((s, f) => s + (Number(f.n) || 0), 0);
      if (nHuerfanos > 0) agregar('columna_inexistente', { n: nHuerfanos });
    }
  }
  const total = chats.reduce((s, f) => s + (Number(f.n) || 0), 0);
  const apagados = chats.filter((f) => Number(f.bot_openia) !== 1).reduce((s, f) => s + (Number(f.n) || 0), 0);
  // Apagado en TODOS los chats sí explica que no conteste; en algunos, es un dato.
  if (apagados > 0) agregar(apagados === total ? 'chats_bot_apagado_todos' : 'chats_bot_apagado', { n: apagados });

  // D7 · evidencia: solo los chats donde el bot SÍ debería contestar (bot
  // encendido en el chat y, en kanban, columna con IA).
  const evidencia = { escribieron: total, chats: 0, contestados: 0 };
  for (const f of chats) {
    if (Number(f.bot_openia) !== 1) continue;
    if (esKanban && !Number(porEstado.get(String(f.estado || '').toLowerCase())?.con_ia)) continue;
    evidencia.chats += Number(f.n) || 0;
    evidencia.contestados += Number(f.contestados) || 0;
  }

  // Lo que bloquea va primero; lo informativo (horario, pago de Meta, chats
  // apagados a mano) nunca encabeza.
  const informativa = (f) => (T.DIAGNOSTICO[f.clave].informativo ? 1 : 0);
  return { fallas: fallas.sort((a, b) => informativa(a) - informativa(b)), evidencia };
}

/* Respuestas con prefijo IA_ que NO son la IA contestando: el respaldo (sale
   justo cuando la IA falló), los mensajes fijos y los flujos armados
   (consumo_ia.controller.js, SIN_IA; colchonMensajeIlegible.js). */
const NO_ES_IA = ['IA_respaldo', 'IA_wizard', 'IA_mensaje_fijo', 'IA_respuesta_rapida', 'IA_flujo_venta', 'IA_colchon'];

/* Lecturas por lote de D3, D6 y D7: una consulta cada una para todas las
   conexiones elegidas. */
async function leerLotes(ids, consultar) {
  const interruptores = await consultar(
    `SELECT id_configuracion, activo
       FROM openai_assistants
      WHERE id_configuracion IN (:ids) AND tipo = 'ventas' AND deleted_at IS NULL`,
    { ids },
  );
  const columnas = await consultar(
    `SELECT id, id_configuracion, nombre, estado_db, es_principal, orden,
            (activa_ia = 1 AND COALESCE(assistant_id, '') <> '') AS con_ia,
            (TRIM(COALESCE(instrucciones, '')) = '') AS sin_prompt
       FROM kanban_columnas
      WHERE id_configuracion IN (:ids) AND activo = 1`,
    { ids },
  );
  // D6 + D7: los chats donde el cliente escribió en 48 h (hace más de 10 min,
  // para no contar los que el bot aún está esperando por la ráfaga), por
  // columna y bot del chat, y en cuántos la IA contestó DESPUÉS del último de
  // esos mensajes del cliente: una respuesta vieja no prueba que hoy conteste.
  const chats = await consultar(
    `SELECT cc.id_configuracion, LOWER(COALESCE(cc.estado_contacto, '')) AS estado, cc.bot_openia,
            COUNT(*) AS n, SUM(COALESCE(m.ia_at >= m.cliente_at, 0)) AS contestados
       FROM clientes_chat_center cc
       JOIN (SELECT id_configuracion, celular_recibe,
                    MAX(CASE WHEN rol_mensaje = 0 AND created_at < NOW() - INTERVAL 10 MINUTE THEN created_at END) AS cliente_at,
                    MAX(CASE WHEN rol_mensaje = 1 AND responsable REGEXP '^IA_' AND responsable NOT IN (:no_ia)
                             THEN created_at END) AS ia_at
               FROM mensajes_clientes
              WHERE id_configuracion IN (:ids) AND rol_mensaje IN (0, 1) AND deleted_at IS NULL
                AND created_at >= NOW() - INTERVAL 48 HOUR
              GROUP BY id_configuracion, celular_recibe
             HAVING cliente_at IS NOT NULL) m
         ON m.id_configuracion = cc.id_configuracion AND m.celular_recibe = cc.id
      WHERE cc.deleted_at IS NULL
      GROUP BY cc.id_configuracion, estado, cc.bot_openia`,
    { ids, no_ia: NO_ES_IA },
  );

  const porConexion = (filas, varias = true) => {
    const m = new Map();
    for (const f of filas || []) {
      const k = Number(f.id_configuracion);
      if (!varias) {
        if (!m.has(k)) m.set(k, f); // como el motor: la primera fila
        continue;
      }
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(f);
    }
    return m;
  };
  return {
    interruptores: porConexion(interruptores, false),
    columnas: porConexion(columnas),
    chats: porConexion(chats),
  };
}

/* ── 4. El texto para el alumno ──────────────────────────────────────────── */
const lineaTutorial = (clave) => {
  const t = T.TUTORIALES[clave];
  return t ? `Mira la clase «${t.titulo}»: ${t.enlace}` : '';
};

function bloqueConexion(c, conNombre) {
  const [primera, ...resto] = c.fallas;
  const def = T.DIAGNOSTICO[primera.clave];
  const partes = [`${conNombre ? `En «${c.nombre}»: ` : ''}${llenar(def.texto, primera.vars)}`];
  if (def.tutorial) partes.push(lineaTutorial(def.tutorial));
  if (resto.length) partes.push(`Además: ${resto.map((f) => T.DIAGNOSTICO[f.clave].corto).join(', ')}.`);
  return partes.join('\n');
}

const bloquea = (f) => !T.DIAGNOSTICO[f.clave].informativo;

function redactar(conexiones) {
  const conFallas = conexiones.filter((c) => c.fallas.some(bloquea));

  if (!conFallas.length) {
    // Lo informativo no explica que el bot no conteste: se nombra al final.
    const avisos = [...new Set(conexiones.flatMap((c) => c.fallas.map((f) => T.DIAGNOSTICO[f.clave].corto)))];
    const ademas = avisos.length ? `Además: ${avisos.join(', ')}.` : '';
    const t = conexiones.reduce((s, c) => s + c.escribieron, 0);
    const n = conexiones.reduce((s, c) => s + c.chats, 0);
    const m = conexiones.reduce((s, c) => s + c.contestados, 0);
    if (n > 0 && m >= SANO_SI * n) {
      return {
        resultado: 'sano',
        texto: [T.DIAGNOSTICO_FRASES.inicio, llenar(T.DIAGNOSTICO_FRASES.sano, { n, m }), lineaTutorial('prompt'), ademas]
          .filter(Boolean)
          .join('\n'),
      };
    }
    return {
      resultado: 'sin_causa',
      // «Te escribieron en N» solo con los chats que vio: si escribieron pero
      // ninguno es de los que el bot debe contestar, o no escribió nadie, se dice así.
      texto: [T.DIAGNOSTICO_FRASES.inicio, `${llenar(T.DIAGNOSTICO_FRASES[n > 0 ? 'sin_causa' : t > 0 ? 'sin_chats_con_bot' : 'sin_chats'], { n, m, t })} ${T.MENSAJE_ASESOR}`, ademas]
        .filter(Boolean)
        .join('\n'),
    };
  }

  const armar = (lista, sobran) => {
    const conNombre = conexiones.length > 1;
    const partes = [T.DIAGNOSTICO_FRASES.inicio, ...lista.map((c) => bloqueConexion(c, conNombre))];
    if (sobran) partes.push(T.DIAGNOSTICO_FRASES.otra_conexion);
    if (lista.some((c) => c.fallas.some((f) => T.DIAGNOSTICO[f.clave].asesor))) partes.push(T.MENSAJE_ASESOR);
    return partes.join('\n\n');
  };

  // Si no cabe, se quedan las conexiones con más chats.
  const orden = [...conFallas].sort((a, b) => b.chats - a.chats);
  for (let k = orden.length; k >= 1; k--) {
    const texto = armar(orden.slice(0, k), k < orden.length);
    if (texto.length <= MAX_TEXTO) return { resultado: 'con_fallas', texto };
  }
  // Ni una sola cabe con sus «Además»: solo la primera falla de la primera.
  const una = { ...orden[0], fallas: orden[0].fallas.slice(0, 1) };
  return { resultado: 'con_fallas', texto: armar([una], orden.length > 1).slice(0, MAX_TEXTO) };
}

const FIJO = (estado, texto) => ({ estado, resultado: null, conexiones: [], texto });
const textoError = () => `${T.DIAGNOSTICO_FRASES.error} ${T.MENSAJE_ASESOR}`;

/**
 * @param {string} telefono  WhatsApp del que escribe (lo entrega Meta).
 * @param {object} [o]
 * @param {Function} [o.consultar]        (sql, replacements) → filas; por defecto la base de IMPORCHAT.
 * @param {Function} [o.verificarAcceso]  id_configuracion → { permitido, motivo } (planAcceso).
 * @param {Date}     [o.ahora]            para horario y fechas.
 * @param {number}   [o.propia]           conexión de la línea que atiende (la 265): no es del alumno.
 * @param {string[]} [o.estadosReconectar]
 * @param {object}   [o.ajustesIA]        { normalizar, dentroDeHorario }
 * @returns {Promise<{estado: string, resultado: string|null, conexiones: object[], texto: string}>}
 *   estado: 'sin_cuenta' | 'ambiguo' | 'error' | 'revisada'
 *   resultado (solo con 'revisada'): 'con_fallas' | 'sano' | 'sin_causa'
 */
async function diagnosticarCuenta(telefono, o = {}) {
  try {
    return await conLimite(revisar(telefono, o), o.limite_ms || LIMITE_MS);
  } catch (err) {
    return { ...FIJO('error', textoError()), motivo: String(err?.message || err) };
  }
}

async function revisar(telefono, o) {
  const consultar = o.consultar || consultarImporchat;
  const propia = Number(o.propia) || null;
  const ctx = {
    ahora: o.ahora instanceof Date ? o.ahora : new Date(),
    verificarAcceso: o.verificarAcceso || verificarAccesoReal,
    estadosReconectar: o.estadosReconectar || estadosReconectarReales(),
    ajustesIA: o.ajustesIA || ajustesReales(),
  };

  const quien = await identificar(telefono, consultar, propia);
  if (quien.estado === 'ambiguo') return FIJO('ambiguo', `${T.DIAGNOSTICO_FRASES.ambiguo} ${T.MENSAJE_ASESOR}`);
  if (quien.estado !== 'ok') {
    return FIJO(
      'sin_cuenta',
      [`${T.DIAGNOSTICO_FRASES.sin_cuenta} ${T.MENSAJE_ASESOR}`, `Si todavía no tienes cuenta: ${lineaTutorial('cuenta')}`].join('\n'),
    );
  }

  const elegidas = await elegirConexiones(quien.idUsuario, consultar, propia, quien.solo);
  if (!elegidas.length) {
    const def = T.DIAGNOSTICO.sin_conexion;
    return {
      estado: 'revisada',
      resultado: 'con_fallas',
      conexiones: [],
      texto: [T.DIAGNOSTICO_FRASES.inicio, def.texto, lineaTutorial(def.tutorial)].join('\n'),
    };
  }

  Object.assign(ctx, await leerLotes(elegidas.map((c) => c.id), consultar));

  const conexiones = [];
  for (const cfg of elegidas) {
    const { fallas, evidencia } = await revisarConexion(cfg, ctx);
    conexiones.push({
      id: Number(cfg.id),
      nombre: nombreCorto(cfg.nombre_configuracion, 'tu conexión'),
      fallas,
      escribieron: evidencia.escribieron,
      chats: evidencia.chats,
      contestados: evidencia.contestados,
    });
  }

  const { resultado, texto } = redactar(conexiones);
  return {
    estado: 'revisada',
    resultado,
    conexiones: conexiones.map((c) => ({ ...c, fallas: c.fallas.map((f) => f.clave) })),
    texto,
  };
}

module.exports = {
  diagnosticarCuenta,
  consultarImporchat,
  // para las pruebas
  claseErrorIA,
  MAX_TEXTO,
};
