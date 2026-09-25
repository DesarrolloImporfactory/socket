/**
 * Dashboard de atención: qué hace cada asesor, hora a hora.
 *
 * Responde dos preguntas que el dashboard de mensajes no contesta:
 *   1. ¿Cuántos chats atiende cada asesor en cada hora del día? (para ver
 *      quién está trabajando y quién no, cruzado con su tiempo conectado).
 *   2. ¿Cuánto tarda cada asesor en contestarle al cliente?
 *
 * Por qué se calcula en memoria y no en SQL:
 *   mensajes_clientes no guarda QUIÉN envió el mensaje, solo `responsable`
 *   (el nombre del asesor tal cual, o etiquetas automáticas como IA_*,
 *   cron_*, 'CRM Ventas'). Emparejar "primer mensaje del cliente sin
 *   responder → primera respuesta humana" por chat es una pasada secuencial
 *   trivial en JS y una consulta correlacionada carísima en MySQL
 *   (mensajes_clientes es la tabla caliente del sistema). Se trae el rango
 *   una sola vez, ordenado por id, y se recorre.
 *
 * Definición del tiempo de respuesta (misma regla que
 * liberar_sin_respuesta.service):
 *   - La espera arranca en el PRIMER mensaje del cliente posterior a la
 *     última respuesta humana. Si el cliente escribe cinco veces seguidas,
 *     el reloj no se reinicia.
 *   - La cierra la primera respuesta HUMANA (rol 1 no automático). Una
 *     plantilla del cron o el bot no cuentan como respuesta del asesor.
 *   - Se atribuye al asesor que escribió esa respuesta (por `responsable`),
 *     no al dueño actual del chat.
 *   - Se mide en minutos hábiles (horario de la conexión): un cliente que escribe a
 *     las 22:00 y recibe respuesta a las 08:05 esperó 5 minutos, no diez
 *     horas. Se devuelve también el promedio real para comparar.
 *
 * Los mensajes desde el celular (responsable 'Whatsapp Business') o desde el
 * inbox de Meta ('Messenger Inbox', 'Instagram Inbox') son respuestas de una
 * persona pero no se sabe cuál: se agrupan aparte en `sin_asesor`.
 */
const { db } = require('../database/config');
const {
  esRemitenteNoRespuesta,
  esBot,
  minutosHabiles,
  parseFechaBD,
} = require('./liberar_sin_respuesta.service');
const {
  obtenerHorario,
  publico: horarioPublico,
} = require('./atencion_horario.service');

/** Umbrales del semáforo (mismos que el cronómetro del chat en el front). */
const UMBRALES_MIN = { advertencia: 5, critico: 10 };

/* Horario en el que se cuentan las esperas: lo configura el administrador
   por conexión (atencion_horario.service.js; por defecto L-V 08:00-17:00).
   Solo se usa el offset fijo de acá para cortar las horas del día. */
const OFFSET_MINUTOS = -5 * 60;

/** Nombre de asesor tal como viene en `responsable`, normalizado para
 *  emparejar: sin asteriscos ni espacios de más, en minúsculas. */
const claveNombre = (v) =>
  String(v || '')
    .replace(/\*/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

/** Techo de filas de mensajes por consulta: la 242 mueve ~32k en 30 días. */
const LIMITE_MENSAJES = 400000;

const MS_HORA = 3600_000;

/** "YYYY-MM-DD HH:mm:ss" (hora Ecuador) → ms "como si fuera UTC", para sacar
 *  hora del día y cortar por horas sin depender de la zona del servidor. */
function msLocal(valor) {
  if (!valor) return null;
  if (valor instanceof Date) return valor.getTime() + OFFSET_MINUTOS * 60_000;
  const texto = String(valor).trim().replace(' ', 'T');
  const sinZona = texto.replace(/(\.\d+)?([zZ]|[+-]\d{2}:?\d{2})$/, '');
  const ms = Date.parse(`${sinZona}Z`);
  return Number.isNaN(ms) ? null : ms;
}

const horaDe = (msLoc) => new Date(msLoc).getUTCHours();

function percentil(valores, p) {
  if (!valores.length) return null;
  const orden = [...valores].sort((a, b) => a - b);
  const idx = Math.min(orden.length - 1, Math.floor((orden.length - 1) * p));
  return Math.round(orden[idx]);
}
const promedio = (v) =>
  v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;

function nuevoAcumulador(base) {
  return {
    ...base,
    chats: new Set(),
    mensajes: 0,
    conectado_seg: 0,
    esperas: [], // segundos hábiles
    esperas_reales: [], // segundos de reloj
    manejos: [], // segundos desde que abrió el chat hasta que contestó
    por_hora: Array.from({ length: 24 }, (_, h) => ({
      h,
      chats: new Set(),
      mensajes: 0,
      conectado_seg: 0,
    })),
  };
}

function cerrarAcumulador(acc) {
  const buckets = { ok: 0, advertencia: 0, critico: 0 };
  for (const seg of acc.esperas) {
    const min = seg / 60;
    if (min >= UMBRALES_MIN.critico) buckets.critico += 1;
    else if (min >= UMBRALES_MIN.advertencia) buckets.advertencia += 1;
    else buckets.ok += 1;
  }
  return {
    ...acc,
    chats: acc.chats.size,
    respuestas: acc.esperas.length,
    mediana_seg: percentil(acc.esperas, 0.5),
    p90_seg: percentil(acc.esperas, 0.9),
    promedio_seg: promedio(acc.esperas),
    promedio_real_seg: promedio(acc.esperas_reales),
    manejos: acc.manejos.length,
    manejo_mediana_seg: percentil(acc.manejos, 0.5),
    manejo_p90_seg: percentil(acc.manejos, 0.9),
    ...buckets,
    esperas: undefined,
    esperas_reales: undefined,
    por_hora: acc.por_hora.map((c) => ({
      h: c.h,
      chats: c.chats.size,
      mensajes: c.mensajes,
      conectado_seg: Math.round(c.conectado_seg),
    })),
  };
}

/** Reparte un intervalo [desde, hasta) (ms locales) en los buckets de hora. */
function repartirPorHora(porHora, desde, hasta) {
  let cursor = desde;
  while (cursor < hasta) {
    const finHora = Math.floor(cursor / MS_HORA) * MS_HORA + MS_HORA;
    const corte = Math.min(finHora, hasta);
    porHora[horaDe(cursor)].conectado_seg += (corte - cursor) / 1000;
    cursor = corte;
  }
}

async function buildAtencionAsesores(
  configIds,
  id_usuario,
  fromDT,
  toDT,
  agentId = null,
) {
  const desdeLoc = msLocal(fromDT);
  const hastaLoc = msLocal(toDT);
  // Se arrastra un día hacia atrás para saber si el chat ya venía esperando
  // (un cliente que escribió anoche y recibe respuesta hoy cuenta hoy).
  const desdeArrastre = new Date(desdeLoc - 24 * MS_HORA)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  // Varias conexiones a la vez (sin id_configuracion): rige el horario de la
  // primera; el dashboard de atención se usa conexión por conexión.
  const [horario, subUsuariosCuenta, miembros, mensajes, sesiones, aperturasRows] =
    await Promise.all([
    obtenerHorario(configIds[0]),
    db.query(
      `SELECT id_sub_usuario, nombre_encargado, rol, suspendido
       FROM sub_usuarios_chat_center WHERE id_usuario = ?`,
      { replacements: [id_usuario], type: db.QueryTypes.SELECT },
    ),
    // Solo el equipo de la conexión: quienes están en algún departamento de
    // ella (así se reparten los chats en /departamentos). La cuenta puede
    // tener 25 subusuarios y esta conexión atenderla 8; el resto no va aquí.
    db.query(
      `SELECT DISTINCT sud.id_sub_usuario, dc.nombre_departamento
       FROM departamentos_chat_center dc
       INNER JOIN sub_usuarios_departamento sud
         ON sud.id_departamento = dc.id_departamento
       WHERE dc.id_configuracion IN (?)`,
      { replacements: [configIds], type: db.QueryTypes.SELECT },
    ),
    db.query(
      `SELECT m.id, m.celular_recibe AS chat, m.rol_mensaje AS rol,
              m.responsable, m.created_at
       FROM mensajes_clientes m
       WHERE m.id_configuracion IN (?) AND m.deleted_at IS NULL
         AND m.rol_mensaje IN (0, 1)
         AND (m.tipo_mensaje IS NULL OR m.tipo_mensaje <> 'revoke')
         AND m.created_at BETWEEN ? AND ?
       ORDER BY m.id
       LIMIT ${LIMITE_MENSAJES}`,
      {
        replacements: [configIds, desdeArrastre, toDT],
        type: db.QueryTypes.SELECT,
      },
    ),
    db.query(
      `SELECT id_sub_usuario, inicio, fin
       FROM presencia_sesiones
       WHERE id_usuario = ? AND inicio <= ? AND COALESCE(fin, inicio) >= ?`,
      { replacements: [id_usuario, toDT, fromDT], type: db.QueryTypes.SELECT },
    ),
    // Cuándo abrió cada asesor el chat que tenía al cliente esperando
    // (models/atencion_aperturas.model.js). Se cruza abajo con la respuesta.
    db.query(
      `SELECT id_cliente_chat_center AS chat, id_sub_usuario,
              mensaje_cliente_at, abierto_at
       FROM atencion_aperturas
       WHERE id_configuracion IN (?) AND abierto_at BETWEEN ? AND ?`,
      {
        replacements: [configIds, desdeArrastre, toDT],
        type: db.QueryTypes.SELECT,
      },
    ).catch((e) => {
      // Tabla recién creada por db.sync: si aún no existe, sin manejo.
      if (/doesn't exist/i.test(e?.message || '')) return [];
      throw e;
    }),
  ]);

  // aperturas[chat][ms del mensaje pendiente] = [{ id_sub_usuario, abiertoMs }]
  const aperturas = new Map();
  for (const ap of aperturasRows) {
    const clave = `${ap.chat}|${parseFechaBD(ap.mensaje_cliente_at)}`;
    if (!aperturas.has(clave)) aperturas.set(clave, []);
    aperturas.get(clave).push({
      id_sub_usuario: Number(ap.id_sub_usuario),
      abiertoMs: parseFechaBD(ap.abierto_at),
    });
  }

  // ── Asesores por nombre (así viene `responsable`) ──
  // Sin departamentos configurados no hay equipo definido: se toma toda la
  // cuenta para no dejar la vista vacía.
  const idsEquipo = new Set(miembros.map((m) => Number(m.id_sub_usuario)));
  const departamentos = [
    ...new Set(miembros.map((m) => m.nombre_departamento).filter(Boolean)),
  ];
  const subUsuarios = idsEquipo.size
    ? subUsuariosCuenta.filter((su) => idsEquipo.has(Number(su.id_sub_usuario)))
    : subUsuariosCuenta;
  const nombresCuenta = new Set(
    subUsuariosCuenta.map((su) => claveNombre(su.nombre_encargado)),
  );

  const porId = new Map();
  const porNombre = new Map();
  for (const su of subUsuarios) {
    if (agentId && Number(su.id_sub_usuario) !== Number(agentId)) continue;
    const acc = nuevoAcumulador({
      id_sub_usuario: su.id_sub_usuario,
      nombre: su.nombre_encargado,
      rol: su.rol,
      suspendido: Number(su.suspendido) === 1,
    });
    porId.set(Number(su.id_sub_usuario), acc);
    const clave = claveNombre(su.nombre_encargado);
    if (clave && !porNombre.has(clave)) porNombre.set(clave, acc);
  }
  // Respuestas humanas que no son del equipo: otro subusuario de la cuenta
  // (un admin que entró a contestar) o alguien sin identificar (celular,
  // API). Se agrupan aparte para que el total cuadre sin ensuciar el equipo.
  const otros = new Map();
  const acumuladorDe = (responsable) => {
    const clave = claveNombre(responsable);
    if (porNombre.has(clave)) return porNombre.get(clave);
    if (agentId) return null;
    if (!otros.has(clave)) {
      otros.set(
        clave,
        nuevoAcumulador({
          id_sub_usuario: null,
          nombre: String(responsable || 'Sin responsable')
            .replace(/\*/g, '')
            .trim(),
          origen: nombresCuenta.has(clave) ? 'fuera_del_equipo' : 'sin_asesor',
        }),
      );
    }
    return otros.get(clave);
  };

  // ── Pasada por chat ──
  const porChat = new Map();
  for (const m of mensajes) {
    let lista = porChat.get(m.chat);
    if (!lista) porChat.set(m.chat, (lista = []));
    lista.push(m);
  }

  const totales = {
    esperas: [],
    esperas_reales: [],
    manejos: [],
    chats: new Set(),
    mensajes: 0,
  };
  for (const [chat, lista] of porChat) {
    let esperaDesde = null; // { loc, real }
    for (const m of lista) {
      const loc = msLocal(m.created_at);
      if (loc == null) continue;
      if (Number(m.rol) === 0) {
        if (esperaDesde === null) {
          esperaDesde = { loc, real: parseFechaBD(m.created_at) };
        }
        continue;
      }
      // Cron/avisos automáticos: no responden a nadie, no tocan la espera.
      if (esRemitenteNoRespuesta(m.responsable)) continue;
      // El bot sí atiende al cliente: cierra la espera, pero no es actividad
      // de ningún asesor ni muestra de su tiempo.
      if (esBot(m.responsable)) {
        esperaDesde = null;
        continue;
      }
      // Lo enviado desde la app de Messenger/Instagram o desde el celular
      // es una persona (va a `otros` porque no se sabe qué asesor fue).
      const enRango = loc >= desdeLoc && loc <= hastaLoc;
      const acc = acumuladorDe(m.responsable);
      if (acc && enRango) {
        acc.mensajes += 1;
        acc.chats.add(chat);
        const celda = acc.por_hora[horaDe(loc)];
        celda.mensajes += 1;
        celda.chats.add(chat);
        totales.mensajes += 1;
        totales.chats.add(chat);
      }
      if (esperaDesde !== null) {
        if (acc && enRango) {
          const real = parseFechaBD(m.created_at);
          const segHabil = Math.round(
            minutosHabiles(esperaDesde.real, real, horario) * 60,
          );
          const segReal = Math.max(0, Math.round((real - esperaDesde.real) / 1000));
          acc.esperas.push(segHabil);
          acc.esperas_reales.push(segReal);
          totales.esperas.push(segHabil);
          totales.esperas_reales.push(segReal);
          // Manejo: desde que ABRIÓ el chat hasta esta respuesta. Se toma la
          // apertura del mismo asesor que contestó; si no la hay (contestó
          // sin abrirlo, o lo abrió otro), la más antigua.
          const abiertas = aperturas.get(`${chat}|${esperaDesde.real}`) || [];
          const propia =
            abiertas.find((x) => x.id_sub_usuario === Number(acc.id_sub_usuario)) ||
            abiertas.reduce(
              (mejor, x) => (!mejor || x.abiertoMs < mejor.abiertoMs ? x : mejor),
              null,
            );
          if (propia && propia.abiertoMs != null && propia.abiertoMs <= real) {
            // También en horario: abrir el viernes 16:57 y contestar el
            // lunes 09:00 son 1h 03m, no 64 horas.
            const segManejo = Math.round(
              minutosHabiles(propia.abiertoMs, real, horario) * 60,
            );
            acc.manejos.push(segManejo);
            totales.manejos.push(segManejo);
          }
        }
        esperaDesde = null;
      }
    }
  }

  // ── Tiempo conectado por hora (presencia_sesiones) ──
  // Un asesor con dos pestañas abiertas tiene dos sesiones a la vez; sumarlas
  // daba 108 minutos en una hora. Se fusionan los intervalos solapados.
  const intervalosPorAsesor = new Map();
  for (const s of sesiones) {
    const id = Number(s.id_sub_usuario);
    if (!porId.has(id)) continue;
    const ini = msLocal(s.inicio);
    const fin = msLocal(s.fin) ?? ini;
    if (ini == null) continue;
    const desde = Math.max(ini, desdeLoc);
    const hasta = Math.min(fin, hastaLoc);
    if (hasta <= desde) continue;
    if (!intervalosPorAsesor.has(id)) intervalosPorAsesor.set(id, []);
    intervalosPorAsesor.get(id).push([desde, hasta]);
  }
  for (const [id, intervalos] of intervalosPorAsesor) {
    const acc = porId.get(id);
    intervalos.sort((a, b) => a[0] - b[0]);
    let [ini, fin] = intervalos[0];
    const fusionados = [];
    for (const [a, b] of intervalos.slice(1)) {
      if (a <= fin) fin = Math.max(fin, b);
      else {
        fusionados.push([ini, fin]);
        [ini, fin] = [a, b];
      }
    }
    fusionados.push([ini, fin]);
    for (const [a, b] of fusionados) {
      acc.conectado_seg += (b - a) / 1000;
      repartirPorHora(acc.por_hora, a, b);
    }
  }

  const asesores = [...porId.values()]
    .map(cerrarAcumulador)
    .map((a) => ({ ...a, conectado_seg: Math.round(a.conectado_seg) }))
    .sort((a, b) => b.chats - a.chats || b.mensajes - a.mensajes);

  const bucketsTot = { ok: 0, advertencia: 0, critico: 0 };
  for (const seg of totales.esperas) {
    const min = seg / 60;
    if (min >= UMBRALES_MIN.critico) bucketsTot.critico += 1;
    else if (min >= UMBRALES_MIN.advertencia) bucketsTot.advertencia += 1;
    else bucketsTot.ok += 1;
  }

  return {
    umbrales_min: UMBRALES_MIN,
    horario: horarioPublico(horario),
    departamentos,
    asesores,
    otros: [...otros.values()]
      .map(cerrarAcumulador)
      .filter((a) => a.mensajes > 0)
      .map(({ por_hora, conectado_seg, ...resto }) => resto)
      .sort((a, b) => b.chats - a.chats),
    totales: {
      chats: totales.chats.size,
      mensajes: totales.mensajes,
      respuestas: totales.esperas.length,
      mediana_seg: percentil(totales.esperas, 0.5),
      p90_seg: percentil(totales.esperas, 0.9),
      promedio_seg: promedio(totales.esperas),
      promedio_real_seg: promedio(totales.esperas_reales),
      manejos: totales.manejos.length,
      manejo_mediana_seg: percentil(totales.manejos, 0.5),
      ...bucketsTot,
      truncado: mensajes.length >= LIMITE_MENSAJES,
    },
  };
}

module.exports = { buildAtencionAsesores, UMBRALES_MIN };
