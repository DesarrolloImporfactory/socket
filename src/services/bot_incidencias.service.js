const { AsyncLocalStorage } = require('async_hooks');
const { db } = require('../database/config');

/**
 * Registro en BD de los turnos del bot donde el CÓDIGO intervino o algo falló.
 *
 * Por qué existe (Daniel, 10-11-2026): cada reclamo de «el bot respondió algo
 * sin sentido» se diagnosticaba a ciegas. Lo que el modelo escribió, la
 * guardia que lo reemplazó y el motivo solo quedaban en
 * src/logs/logs_meta/debug_log.txt del servidor, al que no hay acceso desde
 * fuera; en mensajes_clientes se ve lo que salió, no por qué. Ese mismo día
 * hubo que reconstruir a mano tres casos (cfg 1248 lista de oficinas repetida,
 * 968 respuesta rápida en bucle, 1549 variedad vuelta a preguntar).
 *
 * Cómo funciona: procesarMensajeKanban corre dentro de una traza
 * (AsyncLocalStorage) y cada línea que el motor ya manda a debug_log se anota
 * también ahí, sin tocar las ~200 llamadas a log(). Al terminar el turno, si
 * alguna línea es una incidencia (guardia que reemplazó la respuesta, cierre
 * bloqueado, bucle, precio corregido, error del proveedor de IA…) se guarda
 * UNA fila en bot_incidencias_log con la traza completa del turno, el mensaje
 * del cliente, lo que escribió el modelo y lo que se envió. Los turnos
 * normales no se guardan (son decenas de miles al día).
 *
 * Cuentas en vigilancia: una fila en bot_incidencias_vigilar hace que TODOS
 * los turnos de esa cuenta se guarden hasta la fecha indicada, para los
 * reclamos que no dejan una incidencia reconocible
 * (node scripts/incidenciasBot.js vigilar <cfg> [días]).
 *
 * Reglas de la casa: esto NUNCA tumba el turno que registra. Fail-open con
 * warn en consola. Las tablas se crean solas (misma BD dev/prod) y las filas
 * de más de 30 días se purgan.
 */

const als = new AsyncLocalStorage();

const DIAS_RETENCION = 30;
const MAX_LINEAS = 400;
const MAX_TRAZA = 60000;

/* Qué línea del motor es una incidencia, de más a menos grave: la primera
   que calce da el `tipo` de la fila; todas las que calcen quedan en `marcas`.
   Se reconoce por el texto que el motor ya escribe: si se agrega una guardia
   nueva, basta con sumar su patrón acá. */
const PATRONES = [
  ['error_ia', /❌ Error ejecutando|SIN SALDO|Asistente sin respuesta|Mensaje de respaldo enviado/i],
  ['bucle', /🔁 BUCLE|Guardia anti-bucle/i],
  ['cierre_bloqueado', /Cierre de venta BLOQUEADO|Tercer cierre bloqueado/i],
  ['guardia_oficina', /Guardia de oficina de retiro/i],
  ['precio_corregido', /Precio total corregido/i],
  ['direccion_corregida', /Dirección de retiro corregida/i],
  ['cierre_sin_tag', /Cierre narrado SIN tag/i],
  ['respuesta_descartada', /se descarta la respuesta|Respuesta descartada|REEMPLAZADA|no se env[ií]a|no se manda/i],
  ['foto_corregida', /La foto era de otro producto/i],
  ['rapida_omitida', /calzaba una rápida|ya salió \d+ veces/i],
  ['advertencia', /⚠️|🚨 Tercer/],
];

/* Líneas que NO cuentan como incidencia aunque calcen arriba: salen en todos
   los turnos de una cuenta (modelo de respaldo por organización sin
   verificar) o solo avisan que el turno ANTERIOR tuvo una (esa ya tiene su
   fila). Medido contra el debug_log: sin esto la tabla se llena de repetidos. */
const IGNORAR =
  /no está verificada para|del turno anterior|en (el )?turno anterior|inyectad[oa] como contexto/i;

function clasificar(lineas) {
  const utiles = lineas.filter((l) => !IGNORAR.test(l));
  const marcas = [];
  for (const [tipo, re] of PATRONES) {
    if (utiles.some((l) => re.test(l))) marcas.push(tipo);
  }
  return marcas;
}

let tablasListas = false;
async function ensureTablas() {
  if (tablasListas) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS bot_incidencias_log (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      id_configuracion INT NOT NULL,
      id_cliente BIGINT NULL,
      canal VARCHAR(8) NULL,
      columna VARCHAR(60) NULL,
      tipo VARCHAR(40) NOT NULL,
      marcas VARCHAR(255) NULL,
      mensaje_cliente TEXT NULL,
      respuesta_modelo TEXT NULL,
      respuesta_enviada TEXT NULL,
      error VARCHAR(1000) NULL,
      traza MEDIUMTEXT NULL,
      duracion_ms INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY ix_bil_cfg (id_configuracion, created_at),
      KEY ix_bil_cliente (id_cliente, created_at),
      KEY ix_bil_tipo (tipo, created_at),
      KEY ix_bil_fecha (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS bot_incidencias_vigilar (
      id_configuracion INT NOT NULL PRIMARY KEY,
      hasta DATETIME NOT NULL,
      nota VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  tablasListas = true;
}

/* Cuentas en vigilancia, con caché de 2 minutos (se consulta en cada turno). */
let vigiladas = { ts: 0, set: new Set() };
async function enVigilancia(id_configuracion) {
  const ahora = Date.now();
  if (ahora - vigiladas.ts > 120000) {
    try {
      await ensureTablas();
      const filas = await db.query(
        `SELECT id_configuracion FROM bot_incidencias_vigilar WHERE hasta > NOW()`,
        { type: db.QueryTypes.SELECT },
      );
      vigiladas = { ts: ahora, set: new Set(filas.map((f) => Number(f.id_configuracion))) };
    } catch {
      vigiladas = { ts: ahora, set: vigiladas.set };
    }
  }
  return vigiladas.set.has(Number(id_configuracion));
}

const recortar = (v, max) =>
  v === null || typeof v === 'undefined' ? null : String(v).slice(0, max);

let ultimaPurga = 0;
async function purgar() {
  if (Date.now() - ultimaPurga < 6 * 3600 * 1000) return;
  ultimaPurga = Date.now();
  await db.query(
    `DELETE FROM bot_incidencias_log
      WHERE created_at < NOW() - INTERVAL ${DIAS_RETENCION} DAY LIMIT 5000`,
    { type: db.QueryTypes.DELETE },
  );
}

async function guardar(
  t,
  { error = null, respuesta_enviada = null, motivo = null } = {},
) {
  try {
    const marcas = clasificar(t.lineas);
    if (error && !marcas.includes('error_ia')) marcas.unshift('excepcion');
    const vigilada = !marcas.length && (await enVigilancia(t.id_configuracion));
    if (!marcas.length && !vigilada) return;
    await ensureTablas();
    await db.query(
      `INSERT INTO bot_incidencias_log
         (id_configuracion, id_cliente, canal, columna, tipo, marcas,
          mensaje_cliente, respuesta_modelo, respuesta_enviada, error, traza,
          duracion_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          Number(t.id_configuracion) || 0,
          Number(t.id_cliente) || null,
          recortar(t.canal, 8),
          recortar(t.columna, 60),
          marcas[0] || 'vigilancia',
          recortar(marcas.join(','), 255),
          recortar(t.datos.mensaje_cliente ?? t.mensaje, 4000),
          recortar(t.datos.respuesta_modelo, 8000),
          recortar(respuesta_enviada, 8000),
          // Sin excepción, queda el motivo con que terminó el turno
          // (sin_saldo_openai, humano_contesto, pausa_persona…).
          recortar(error || (motivo ? `motivo: ${motivo}` : null), 1000),
          recortar(t.lineas.join('\n'), MAX_TRAZA),
          Date.now() - t.inicio,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
    purgar().catch(() => {});
  } catch (e) {
    console.warn('[bot_incidencias] no se pudo guardar:', e.message);
  }
}

/**
 * Corre un turno del bot dentro de una traza. Devuelve lo que devuelva `fn`
 * y relanza lo que lance: registrar no cambia el comportamiento del turno.
 * @param {{ id_configuracion, id_cliente, canal?, columna?, mensaje? }} ctx
 */
async function conTraza(ctx, fn) {
  const t = {
    id_configuracion: ctx.id_configuracion,
    id_cliente: ctx.id_cliente,
    canal: ctx.canal || 'wa',
    columna: ctx.columna || null,
    mensaje: ctx.mensaje || '',
    inicio: Date.now(),
    lineas: [],
    datos: {},
  };
  return als.run(t, async () => {
    try {
      const r = await fn();
      // Sin await: guardar la fila no demora la respuesta al cliente.
      guardar(t, {
        respuesta_enviada: r?.respuesta_enviada ?? null,
        motivo: r?.motivo ?? null,
      });
      return r;
    } catch (e) {
      guardar(t, { error: e?.message || String(e) });
      throw e;
    }
  });
}

/* Una línea del turno (la llama el log() del motor). Fuera de una traza no
   hace nada. */
function anotar(msg) {
  const t = als.getStore();
  if (!t || t.lineas.length >= MAX_LINEAS) return;
  t.lineas.push(String(msg).slice(0, 2000));
}

/* Un dato con nombre del turno: 'respuesta_modelo', 'mensaje_cliente'. */
function datoTraza(clave, valor) {
  const t = als.getStore();
  if (t) t.datos[clave] = valor;
}

async function vigilar(id_configuracion, dias = 3, nota = null) {
  await ensureTablas();
  await db.query(
    `INSERT INTO bot_incidencias_vigilar (id_configuracion, hasta, nota)
     VALUES (?, NOW() + INTERVAL ? DAY, ?)
     ON DUPLICATE KEY UPDATE hasta = VALUES(hasta), nota = VALUES(nota)`,
    {
      replacements: [Number(id_configuracion), Number(dias) || 3, recortar(nota, 255)],
      type: db.QueryTypes.INSERT,
    },
  );
  vigiladas.ts = 0;
}

module.exports = {
  conTraza,
  anotar,
  datoTraza,
  vigilar,
  ensureTablas,
  clasificar,
  PATRONES,
};
