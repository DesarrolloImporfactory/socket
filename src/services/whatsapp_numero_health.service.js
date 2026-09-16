/**
 * Salud del número de WhatsApp de cada conexión (configuraciones.wa_status).
 *
 * Contexto (2026-09-16, cfg 1071 "Free Shop"): el número quedó DISCONNECTED en
 * Meta desde el 10-09 y la WABA dejó de ser accesible, pero /conexiones seguía
 * mostrando "Conectado" porque el listado solo mira id_telefono + id_whatsapp.
 * Un escaneo de las 471 conexiones activas encontró 76 que Meta ya no tenía
 * como CONNECTED (65 con la WABA inaccesible, 6 PENDING, 1 DISCONNECTED).
 *
 * Este servicio centraliza la consulta a Meta que antes vivía solo dentro de
 * numero_status (whatsapp.controller.js) para que la usen tres caminos:
 *   - numero_status: el chat pregunta al cargar (caché de 1 h).
 *   - cron/whatsappNumerosHealth.js: barre todas las conexiones cada 6 h con
 *     freno por los límites de Graph.
 *   - webhook account_update: PARTNER_REMOVED / ACCOUNT_DELETED / baneos
 *     marcan la conexión al instante.
 *
 * Regla de oro: solo se persiste un veredicto DEFINITIVO. Un timeout, un 5xx
 * o un rate limit no pueden pisar un estado real, porque el listado de
 * /conexiones muestra "Pendiente" + botón de conectar para cualquier estado de
 * ESTADOS_RECONECTAR y mandaríamos al cliente a reconectar sin motivo.
 */

const axios = require('axios');
const { db } = require('../database/config');

/* Estados que dejan la conexión como "Pendiente" en /conexiones y muestran el
   botón de conectar. Reconectar (embeddedSignupComplete con id_configuracion)
   hace UPDATE sobre la misma fila: no hace falta limpiar credenciales. */
const ESTADOS_RECONECTAR = [
  'DISCONNECTED',
  'PENDING',
  'MIGRATED',
  'BANNED',
  'DELETED',
  'SUSPENDED', // valor legado de numero_status para el 100/33
  'TOKEN_EXPIRED',
  'SIN_ACCESO', // Meta 100/33: la WABA/número ya no existe o nos quitaron el acceso
];

/* Expresión SQL para los listados de conexiones (alias de tabla `c`). El
   front (isConectado) ya prioriza `status_whatsapp` si viene como string y
   solo considera conectado el valor exacto 'CONNECTED'. FLAGGED, RATE_LIMITED
   y UNKNOWN no son desconexiones: se reportan como CONNECTED aquí. */
const SQL_STATUS_WHATSAPP = `
        CASE
          WHEN COALESCE(c.id_telefono,'') = '' OR COALESCE(c.id_whatsapp,'') = '' THEN 'SIN_VINCULAR'
          WHEN c.wa_status IN (${ESTADOS_RECONECTAR.map((e) => `'${e}'`).join(',')}) THEN c.wa_status
          ELSE 'CONNECTED'
        END`;

/* Códigos de Graph que significan "vuelve más tarde", nunca un veredicto. */
const CODIGOS_RATE_LIMIT = new Set([4, 17, 32, 613, 80007, 80008]);

function graphVersion() {
  return process.env.GRAPH_VERSION || 'v22.0';
}

/* Lee los headers de uso de Graph y devuelve el porcentaje más alto (0-100).
   x-app-usage: {"call_count":N,"total_cputime":N,"total_time":N}
   x-business-use-case-usage: {"<business_id>":[{"type":"whatsapp",
     "call_count":N,"total_cputime":N,"total_time":N, ...}]} */
function leerUsoGraph(headers = {}) {
  let max = 0;
  const tomar = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of ['call_count', 'total_cputime', 'total_time']) {
      const v = Number(obj[k]);
      if (Number.isFinite(v) && v > max) max = v;
    }
  };
  try {
    if (headers['x-app-usage']) tomar(JSON.parse(headers['x-app-usage']));
  } catch {}
  try {
    if (headers['x-business-use-case-usage']) {
      const buc = JSON.parse(headers['x-business-use-case-usage']);
      for (const lista of Object.values(buc)) {
        (Array.isArray(lista) ? lista : [lista]).forEach(tomar);
      }
    }
  } catch {}
  return max;
}

/* Consulta GET /{phone_number_id}?fields=status,... con el token de la
   conexión. Se pregunta por el número y no por la WABA porque el número sigue
   respondiendo (status DISCONNECTED) aun cuando la WABA ya da 100/33.
   Devuelve { status, definitivo, detalle, uso, rateLimit }. */
async function consultarEstadoNumero(cfg) {
  if (!cfg?.id_telefono || !cfg?.token) {
    return {
      status: 'SIN_VINCULAR',
      definitivo: false,
      detalle: 'La conexión no tiene id_telefono o token.',
      uso: 0,
    };
  }

  try {
    const resp = await axios.get(
      `https://graph.facebook.com/${graphVersion()}/${cfg.id_telefono}`,
      {
        params: {
          fields: 'status,quality_rating,throughput',
          access_token: cfg.token,
        },
        timeout: 10000,
      },
    );
    const data = resp.data || {};
    const uso = leerUsoGraph(resp.headers);

    let status = 'CONNECTED';
    if (data.status && String(data.status).toUpperCase() !== 'CONNECTED') {
      // DISCONNECTED, PENDING, MIGRATED, BANNED, DELETED, RESTRICTED...
      status = String(data.status).toUpperCase();
    } else if (data?.throughput?.level === 'NOT_ALLOWED') {
      status = 'BANNED';
    } else if (data?.quality_rating === 'RED') {
      status = 'FLAGGED';
    }

    return {
      status,
      definitivo: true,
      detalle: data.status ? `Meta status=${data.status}` : '',
      uso,
    };
  } catch (err) {
    const meta = err?.response?.data?.error || null;
    const code = Number(meta?.code);
    const sub = Number(meta?.error_subcode);
    const detalle = String(meta?.message || err.message || '').slice(0, 300);
    const uso = leerUsoGraph(err?.response?.headers);

    if (CODIGOS_RATE_LIMIT.has(code)) {
      return {
        status: 'RATE_LIMITED',
        definitivo: false,
        detalle,
        uso,
        rateLimit: true,
      };
    }
    if (code === 190) {
      return { status: 'TOKEN_EXPIRED', definitivo: true, detalle, uso };
    }
    // 100/33 "Object with ID ... does not exist, cannot be loaded due to
    // missing permissions": el número fue borrado, migrado a otro proveedor o
    // el cliente nos sacó de su WABA. 10 y 200 son permisos revocados.
    if ((code === 100 && sub === 33) || code === 10 || code === 200) {
      return { status: 'SIN_ACCESO', definitivo: true, detalle, uso };
    }
    // Timeout, 5xx de Meta, 100 con otro subcódigo (parámetro): no se sabe.
    return { status: 'UNKNOWN', definitivo: false, detalle, uso };
  }
}

async function persistirEstado(id_configuracion, status) {
  await db.query(
    `UPDATE configuraciones SET wa_status = ?, wa_status_at = NOW() WHERE id = ?`,
    { replacements: [status, id_configuracion], type: db.QueryTypes.UPDATE },
  );
}

/* Consulta y persiste solo si el veredicto es definitivo. Devuelve el
   resultado de consultarEstadoNumero más `anterior` y `cambio`. */
async function revisarConfiguracion(cfg, origen = '') {
  const r = await consultarEstadoNumero(cfg);
  const anterior = cfg?.wa_status || null;
  r.anterior = anterior;
  r.cambio = false;

  if (r.definitivo) {
    await persistirEstado(cfg.id, r.status);
    r.cambio = anterior !== r.status;
    if (r.cambio) {
      console.log(
        `[wa-health] cfg ${cfg.id} "${cfg.nombre_configuracion || ''}" ` +
          `${anterior || 'NULL'} → ${r.status}${r.detalle ? ` · ${r.detalle}` : ''}` +
          `${origen ? ` · ${origen}` : ''}`,
      );
    }
  } else if (origen) {
    console.log(
      `[wa-health] cfg ${cfg.id} sin veredicto (${r.status})${r.detalle ? `: ${r.detalle}` : ''} · ${origen}`,
    );
  }
  return r;
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/* Barrido de todas las conexiones activas con número vinculado.
   Freno por límites de Meta:
   - una llamada por conexión, separadas por `pausaMs` (por defecto 1,5 s:
     ~470 conexiones ≈ 12 min por pasada);
   - se detiene si Graph devuelve un código de rate limit o si el uso
     reportado en los headers supera `umbralUso` %;
   - omite las revisadas hace menos de `omitirRevisadasMin` minutos (el chat
     ya las consultó vía numero_status). */
async function revisarTodas({
  pausaMs = 1500,
  umbralUso = 75,
  omitirRevisadasMin = 60,
  ids = null,
} = {}) {
  const filtroIds = Array.isArray(ids) && ids.length ? `AND c.id IN (?)` : '';
  const rows = await db.query(
    `SELECT c.id, c.nombre_configuracion, c.id_telefono, c.token, c.wa_status, c.wa_status_at
       FROM configuraciones c
      WHERE c.suspendido = 0
        AND COALESCE(c.id_telefono,'') <> ''
        AND COALESCE(c.token,'') <> ''
        AND (c.wa_status_at IS NULL OR c.wa_status_at < NOW() - INTERVAL ? MINUTE)
        ${filtroIds}
      ORDER BY (c.wa_status_at IS NULL) DESC, c.wa_status_at ASC`,
    {
      replacements: filtroIds
        ? [omitirRevisadasMin, ids]
        : [omitirRevisadasMin],
      type: db.QueryTypes.SELECT,
    },
  );

  const resumen = {
    pendientes: rows.length,
    revisadas: 0,
    definitivas: 0,
    cambios: [],
    porEstado: {},
    detenido: null,
    usoMax: 0,
  };

  for (const cfg of rows) {
    const r = await revisarConfiguracion(cfg);
    resumen.revisadas += 1;
    resumen.usoMax = Math.max(resumen.usoMax, r.uso || 0);
    if (r.definitivo) {
      resumen.definitivas += 1;
      resumen.porEstado[r.status] = (resumen.porEstado[r.status] || 0) + 1;
      if (r.cambio) {
        resumen.cambios.push({
          id: cfg.id,
          nombre: cfg.nombre_configuracion,
          de: r.anterior,
          a: r.status,
          detalle: r.detalle,
        });
      }
    }

    if (r.rateLimit) {
      resumen.detenido = `rate_limit: ${r.detalle}`;
      break;
    }
    if ((r.uso || 0) >= umbralUso) {
      resumen.detenido = `uso_app ${r.uso}% >= ${umbralUso}%`;
      break;
    }
    if (pausaMs > 0) await dormir(pausaMs);
  }

  return resumen;
}

/* Webhook `account_update` (objeto whatsapp_business_account). entry.id es
   la WABA. Eventos documentados por Meta: PARTNER_REMOVED, ACCOUNT_DELETED,
   DISABLED_UPDATE (ban_info.waba_ban_state: SCHEDULE_FOR_DISABLE | DISABLE |
   REINSTATE), ACCOUNT_RESTRICTION, ACCOUNT_VIOLATION, VERIFIED_ACCOUNT,
   PARTNER_ADDED, PARTNER_APP_INSTALLED/UNINSTALLED, entre otros.
   Para los que dejan la conexión muerta se marca directo (Graph fallaría con
   100/33 de todas formas); para el resto se re-consulta el número. */
async function manejarAccountUpdate(wabaId, value = {}) {
  const evento = String(value?.event || '').toUpperCase();
  if (!wabaId) return { evento, afectadas: 0 };

  const configs = await db.query(
    `SELECT id, nombre_configuracion, id_telefono, token, wa_status
       FROM configuraciones
      WHERE id_whatsapp = ? AND suspendido = 0`,
    { replacements: [String(wabaId)], type: db.QueryTypes.SELECT },
  );

  console.log(
    `[wa-health][webhook] account_update ${evento || '(sin event)'} waba=${wabaId} ` +
      `configs=${configs.map((c) => c.id).join(',') || 'ninguna'}` +
      (value?.ban_info ? ` ban=${JSON.stringify(value.ban_info)}` : '') +
      (value?.restriction_info
        ? ` restriction=${JSON.stringify(value.restriction_info)}`
        : ''),
  );
  if (!configs.length) return { evento, afectadas: 0 };

  let directo = null;
  if (evento === 'PARTNER_REMOVED') directo = 'SIN_ACCESO';
  else if (evento === 'ACCOUNT_DELETED') directo = 'DELETED';
  else if (
    evento === 'DISABLED_UPDATE' &&
    String(value?.ban_info?.waba_ban_state || '').toUpperCase() === 'DISABLE'
  ) {
    directo = 'BANNED';
  }

  for (const cfg of configs) {
    if (directo) {
      await persistirEstado(cfg.id, directo);
      console.log(
        `[wa-health] cfg ${cfg.id} "${cfg.nombre_configuracion || ''}" ` +
          `${cfg.wa_status || 'NULL'} → ${directo} · webhook ${evento}`,
      );
    } else {
      await revisarConfiguracion(cfg, `webhook ${evento || 'account_update'}`);
    }
  }
  return { evento, afectadas: configs.length, directo };
}

module.exports = {
  ESTADOS_RECONECTAR,
  SQL_STATUS_WHATSAPP,
  consultarEstadoNumero,
  persistirEstado,
  revisarConfiguracion,
  revisarTodas,
  manejarAccountUpdate,
  leerUsoGraph,
};
