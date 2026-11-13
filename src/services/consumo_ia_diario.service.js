// services/consumo_ia_diario.service.js
// Resumen diario del consumo del asistente (Jeimy, 13-11-2026).
//
// El panel de consumo recorría los mensajes salientes del bot de todo el
// período en cada entrada: en la cuenta 285 a 90 días son más de 100.000
// filas leídas de disco (158 s en frío), porque mensajes_clientes no cabe en
// el buffer pool. Los días ya cerrados no cambian, así que se guardan
// resumidos y solo el día de HOY se lee en vivo de mensajes_clientes.
//
// Qué se guarda (consumo_ia_diario): un «cubo» por cuenta + día + clase +
// modelo con CANTIDADES (mensajes y tokens), nunca dólares. El costo se sigue
// calculando al leer, con los precios y el modelo de referencia vigentes: es
// lineal en los tokens de cada modelo, así que sumar primero y multiplicar
// después da lo mismo que mensaje por mensaje.
//
//   clase 'ia'     respuestas del bot que llamaron al modelo
//   clase 'rmk'    recordatorios de remarketing redactados por la IA
//   clase 'fijo'   mensaje fijo / wizard / colchón (sin IA)
//   clase 'rapida' respuestas rápidas (sin IA)
//   modelo ''      el mensaje no guardó desglose (se estima al leer)
//
// consumo_ia_diario_clientes guarda a qué clientes les escribió el asistente
// cada día (los «clientes atendidos» de un período no se pueden sumar por
// día). consumo_ia_diario_estado dice qué rango de días tiene resumido cada
// cuenta: se llena la primera vez que alguien abre el panel (esa vez tarda lo
// de siempre) y el cron de la madrugada lo mantiene al día.
//
// CONSUMO_IA_DIARIO=0 en el .env lo apaga: el panel vuelve a leer todo el
// período de mensajes_clientes, como antes.
const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');

// Salen con prefijo IA_ pero NO llaman al modelo (texto fijo): no cuestan.
const SIN_IA = [
  'IA_wizard',
  'IA_mensaje_fijo',
  'IA_respuesta_rapida',
  'IA_colchon',
  'IA_respaldo',
  'IA_flujo_venta',
];
// Recordatorios de remarketing redactados por la IA (cron): no llevan IA_.
const REMARKETING_IA = 'cron_remarketing_ia';

// Días que se conservan resumidos (el panel pide 90 como máximo).
const RETENCION_DIAS = 120;

const habilitado = () => String(process.env.CONSUMO_IA_DIARIO || '1') !== '0';

function leerAnalytics(raw) {
  if (!raw) return null;
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return o && typeof o === 'object' && o.modelo ? o : null;
  } catch {
    return null;
  }
}

const sumarDias = (dia, n) => {
  const d = new Date(`${dia}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Hoy según la base (la sesión va en -05:00, igual que DATE(created_at)). */
async function hoyDeLaBase() {
  const [r] = await db.query(
    `SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS hoy`,
    { type: QueryTypes.SELECT },
  );
  return String(r.hoy);
}

/* ── Lectura de mensajes_clientes ─────────────────────────────────────── */

/* Va en dos mitades (vivos + borrados) a propósito: los índices de la tabla
   llevan deleted_at ANTES de created_at, así que sin fijar deleted_at MariaDB
   no puede acotar por fecha y recorre todos los salientes de la cuenta (cfg
   322: 300.000 filas para devolver 615). Los borrados se cuentan igual: sus
   tokens se pagaron. `hasta` es inclusivo; null = sin tope (hasta ahora). */
async function leerMensajes(id_configuracion, desde, hasta) {
  const CAMPOS = `DATE_FORMAT(created_at, '%Y-%m-%d') AS dia, responsable,
            celular_recibe,
            COALESCE(total_tokens_openai_mensaje, 0) AS tokens,
            json_analytics_mensaje`;
  const tope = hasta ? `AND created_at < DATE_ADD(?, INTERVAL 1 DAY)` : '';
  const FILTRO = `id_configuracion = ?
        AND rol_mensaje = 1
        AND (responsable LIKE 'IA\\_%' OR responsable = ?)
        AND created_at >= ?
        ${tope}`;
  const base = [id_configuracion, REMARKETING_IA, desde];
  if (hasta) base.push(hasta);
  return db.query(
    `SELECT ${CAMPOS}
       FROM mensajes_clientes
      WHERE ${FILTRO}
        AND deleted_at IS NULL
      UNION ALL
     SELECT ${CAMPOS}
       FROM mensajes_clientes
      WHERE ${FILTRO}
        AND deleted_at >= ?`,
    { replacements: [...base, ...base, desde], type: QueryTypes.SELECT },
  );
}

/**
 * Reduce mensajes a cubos { dia, clase, modelo, n, tokens, tk_* } y a los
 * clientes de cada día. Es la ÚNICA regla de qué cuenta cada mensaje: la usan
 * por igual el día en vivo y lo que se guarda.
 */
function reducir(filas) {
  const cubos = new Map();
  const clientes = new Map(); // dia → Set(celular)
  const cubo = (dia, clase, modelo) => {
    const k = `${dia}|${clase}|${modelo}`;
    let c = cubos.get(k);
    if (!c) {
      c = {
        dia,
        clase,
        modelo,
        n: 0,
        tokens: 0,
        tk_entrada: 0,
        tk_escrita: 0,
        tk_cache: 0,
        tk_salida: 0,
      };
      cubos.set(k, c);
    }
    return c;
  };
  const claveModelo = (a) =>
    String(a.modelo).trim().slice(0, 80) || 'desconocido';
  const sumarDesglose = (c, a) => {
    const cached = Number(a.cached) || 0;
    const entrada = Math.max(0, (Number(a.input) || 0) - cached);
    c.tk_entrada += entrada;
    // Lo escrito en caché (Claude, 1,25x) es parte de la entrada.
    c.tk_escrita += Math.min(Number(a.cache_write) || 0, entrada);
    c.tk_cache += cached;
    c.tk_salida += Number(a.output) || 0;
  };

  for (const f of filas) {
    const dia = String(f.dia).slice(0, 10);
    if (f.celular_recibe != null) {
      if (!clientes.has(dia)) clientes.set(dia, new Set());
      clientes.get(dia).add(String(f.celular_recibe));
    }
    const tokens = Number(f.tokens) || 0;
    if (f.responsable === REMARKETING_IA) {
      const a = leerAnalytics(f.json_analytics_mensaje);
      if (!a) {
        cubo(dia, 'rmk', '').n += 1; // sin medir: se estima al leer
        continue;
      }
      const c = cubo(dia, 'rmk', claveModelo(a));
      c.n += 1;
      c.tokens += tokens;
      sumarDesglose(c, a);
      continue;
    }
    if (SIN_IA.includes(f.responsable)) {
      cubo(dia, f.responsable === 'IA_respuesta_rapida' ? 'rapida' : 'fijo', '')
        .n += 1;
      continue;
    }
    const a = leerAnalytics(f.json_analytics_mensaje);
    if (a) {
      const c = cubo(dia, 'ia', claveModelo(a));
      c.n += 1;
      c.tokens += tokens;
      sumarDesglose(c, a);
    } else {
      /* Mensajes viejos sin desglose: se reparten 95/5 entrada/salida (el
         mismo supuesto de costoEstimadoPorTokens) y se cobran al leer con el
         modelo de referencia de la cuenta. */
      const c = cubo(dia, 'ia', '');
      c.n += 1;
      c.tokens += tokens;
      if (tokens > 0) {
        const entrada = Math.round(tokens * 0.95);
        c.tk_entrada += entrada;
        c.tk_salida += tokens - entrada;
      }
    }
  }
  return { cubos: [...cubos.values()], clientes };
}

/* ── Tablas ───────────────────────────────────────────────────────────── */

let tablasListas = null;
function asegurarTablas() {
  if (!tablasListas) {
    tablasListas = (async () => {
      // El mismo SQL está en consumo_ia_diario_migration.sql (registro).
      await db.query(
        `CREATE TABLE IF NOT EXISTS consumo_ia_diario (
           id_configuracion INT NOT NULL,
           dia DATE NOT NULL,
           clase VARCHAR(8) NOT NULL,
           modelo VARCHAR(80) NOT NULL DEFAULT '',
           n INT UNSIGNED NOT NULL DEFAULT 0,
           tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
           tk_entrada BIGINT UNSIGNED NOT NULL DEFAULT 0,
           tk_escrita BIGINT UNSIGNED NOT NULL DEFAULT 0,
           tk_cache BIGINT UNSIGNED NOT NULL DEFAULT 0,
           tk_salida BIGINT UNSIGNED NOT NULL DEFAULT 0,
           PRIMARY KEY (id_configuracion, dia, clase, modelo)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        { type: QueryTypes.RAW },
      );
      await db.query(
        `CREATE TABLE IF NOT EXISTS consumo_ia_diario_clientes (
           id_configuracion INT NOT NULL,
           dia DATE NOT NULL,
           celular_recibe BIGINT UNSIGNED NOT NULL,
           PRIMARY KEY (id_configuracion, dia, celular_recibe),
           KEY idx_cidc_cfg_cel (id_configuracion, celular_recibe, dia)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        { type: QueryTypes.RAW },
      );
      await db.query(
        `CREATE TABLE IF NOT EXISTS consumo_ia_diario_estado (
           id_configuracion INT NOT NULL PRIMARY KEY,
           desde DATE NOT NULL,
           hasta DATE NOT NULL,
           actualizado TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
             ON UPDATE CURRENT_TIMESTAMP
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        { type: QueryTypes.RAW },
      );
    })().catch((e) => {
      tablasListas = null;
      throw e;
    });
  }
  return tablasListas;
}

async function insertarEnTandas(sqlInicio, sqlFin, filas, ancho) {
  const TANDA = 500;
  for (let i = 0; i < filas.length; i += TANDA) {
    const tanda = filas.slice(i, i + TANDA);
    const marcas = tanda
      .map(() => `(${new Array(ancho).fill('?').join(',')})`)
      .join(',');
    await db.query(`${sqlInicio} ${marcas} ${sqlFin}`, {
      replacements: tanda.flat(),
      type: QueryTypes.RAW,
    });
  }
}

/** Lee de mensajes_clientes los días [desde, hasta] y los deja resumidos.
    Es idempotente: volver a resumir un día cerrado escribe lo mismo. */
async function resumirRango(id_configuracion, desde, hasta) {
  const filas = await leerMensajes(id_configuracion, desde, hasta);
  const { cubos, clientes } = reducir(filas);
  await insertarEnTandas(
    `INSERT INTO consumo_ia_diario
       (id_configuracion, dia, clase, modelo, n, tokens,
        tk_entrada, tk_escrita, tk_cache, tk_salida) VALUES`,
    `ON DUPLICATE KEY UPDATE n = VALUES(n), tokens = VALUES(tokens),
       tk_entrada = VALUES(tk_entrada), tk_escrita = VALUES(tk_escrita),
       tk_cache = VALUES(tk_cache), tk_salida = VALUES(tk_salida)`,
    cubos.map((c) => [
      id_configuracion,
      c.dia,
      c.clase,
      c.modelo,
      c.n,
      c.tokens,
      c.tk_entrada,
      c.tk_escrita,
      c.tk_cache,
      c.tk_salida,
    ]),
    10,
  );
  const filasClientes = [];
  for (const [dia, set] of clientes) {
    for (const cel of set) filasClientes.push([id_configuracion, dia, cel]);
  }
  await insertarEnTandas(
    `INSERT IGNORE INTO consumo_ia_diario_clientes
       (id_configuracion, dia, celular_recibe) VALUES`,
    '',
    filasClientes,
    3,
  );
  return { mensajes: filas.length, cubos: cubos.length };
}

async function leerEstado(id_configuracion) {
  const [e] = await db.query(
    `SELECT DATE_FORMAT(desde, '%Y-%m-%d') AS desde,
            DATE_FORMAT(hasta, '%Y-%m-%d') AS hasta
       FROM consumo_ia_diario_estado WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: QueryTypes.SELECT },
  );
  return e || null;
}

/**
 * Deja resumidos los días [inicio, fin] de la cuenta leyendo solo lo que
 * falta. El rango guardado es siempre continuo: se extiende hacia atrás, hacia
 * adelante, o se reemplaza si quedó un hueco (cuenta que nadie abría).
 */
async function cubrir(id_configuracion, inicio, fin) {
  if (fin < inicio) return { leidos: 0 };
  const e = await leerEstado(id_configuracion);
  let desde = inicio;
  let hasta = fin;
  let leidos = 0;
  if (!e || e.hasta < sumarDias(inicio, -1) || e.desde > sumarDias(fin, 1)) {
    leidos += (await resumirRango(id_configuracion, inicio, fin)).mensajes;
  } else {
    if (inicio < e.desde) {
      leidos += (
        await resumirRango(id_configuracion, inicio, sumarDias(e.desde, -1))
      ).mensajes;
    }
    if (fin > e.hasta) {
      leidos += (
        await resumirRango(id_configuracion, sumarDias(e.hasta, 1), fin)
      ).mensajes;
    }
    desde = inicio < e.desde ? inicio : e.desde;
    hasta = fin > e.hasta ? fin : e.hasta;
    if (desde === e.desde && hasta === e.hasta) return { leidos: 0 };
  }
  await db.query(
    `INSERT INTO consumo_ia_diario_estado (id_configuracion, desde, hasta)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE desde = VALUES(desde), hasta = VALUES(hasta)`,
    { replacements: [id_configuracion, desde, hasta], type: QueryTypes.RAW },
  );
  return { leidos };
}

/** Clientes distintos del período: lo guardado + los de hoy que no estaban. */
async function contarClientes(id_configuracion, inicio, ayer, deHoy) {
  const [r] = await db.query(
    `SELECT COUNT(DISTINCT celular_recibe) AS n
       FROM consumo_ia_diario_clientes
      WHERE id_configuracion = ? AND dia BETWEEN ? AND ?`,
    { replacements: [id_configuracion, inicio, ayer], type: QueryTypes.SELECT },
  );
  let total = Number(r?.n) || 0;
  const hoy = [...deHoy];
  let yaContados = 0;
  for (let i = 0; i < hoy.length; i += 1000) {
    const tanda = hoy.slice(i, i + 1000);
    const [c] = await db.query(
      `SELECT COUNT(DISTINCT celular_recibe) AS n
         FROM consumo_ia_diario_clientes
        WHERE id_configuracion = ? AND celular_recibe IN (?)
          AND dia BETWEEN ? AND ?`,
      {
        replacements: [id_configuracion, tanda, inicio, ayer],
        type: QueryTypes.SELECT,
      },
    );
    yaContados += Number(c?.n) || 0;
  }
  total += hoy.length - yaContados;
  return total;
}

/** Todo el período leído de mensajes_clientes, sin resumen (lo de antes). */
async function consumoDirecto({ id_configuracion, dias }) {
  const hoy = await hoyDeLaBase();
  const filas = await leerMensajes(id_configuracion, sumarDias(hoy, -dias), null);
  const { cubos, clientes } = reducir(filas);
  const todos = new Set();
  for (const set of clientes.values()) for (const c of set) todos.add(c);
  return { cubos, clientes_atendidos: todos.size, origen: 'directo' };
}

/**
 * Cubos del consumo de la cuenta en los últimos `dias` (0 = solo hoy) y sus
 * clientes atendidos. Los días cerrados salen del resumen; hoy, en vivo.
 * Ante cualquier falla del resumen responde leyendo todo, como antes.
 */
async function consumoDelPeriodo({ id_configuracion, dias }) {
  if (!habilitado() || !(dias > 0)) {
    return consumoDirecto({ id_configuracion, dias });
  }
  try {
    await asegurarTablas();
    const hoy = await hoyDeLaBase();
    const inicio = sumarDias(hoy, -dias);
    const ayer = sumarDias(hoy, -1);
    await cubrir(id_configuracion, inicio, ayer);
    const [guardados, vivos] = await Promise.all([
      db.query(
        `SELECT DATE_FORMAT(dia, '%Y-%m-%d') AS dia, clase, modelo, n, tokens,
                tk_entrada, tk_escrita, tk_cache, tk_salida
           FROM consumo_ia_diario
          WHERE id_configuracion = ? AND dia BETWEEN ? AND ?`,
        {
          replacements: [id_configuracion, inicio, ayer],
          type: QueryTypes.SELECT,
        },
      ),
      leerMensajes(id_configuracion, hoy, null),
    ]);
    const deHoy = reducir(vivos);
    const numeros = (c) => ({
      dia: String(c.dia),
      clase: c.clase,
      modelo: c.modelo || '',
      n: Number(c.n) || 0,
      tokens: Number(c.tokens) || 0,
      tk_entrada: Number(c.tk_entrada) || 0,
      tk_escrita: Number(c.tk_escrita) || 0,
      tk_cache: Number(c.tk_cache) || 0,
      tk_salida: Number(c.tk_salida) || 0,
    });
    const clientesHoy = new Set();
    for (const set of deHoy.clientes.values()) {
      for (const c of set) clientesHoy.add(c);
    }
    return {
      cubos: [...guardados.map(numeros), ...deHoy.cubos],
      clientes_atendidos: await contarClientes(
        id_configuracion,
        inicio,
        ayer,
        clientesHoy,
      ),
      origen: 'resumen',
    };
  } catch (err) {
    console.error(
      `[consumo-ia-diario] cfg ${id_configuracion}: falló el resumen, se lee directo —`,
      err.message,
    );
    return consumoDirecto({ id_configuracion, dias });
  }
}

/**
 * Cron de la madrugada: pone al día (hasta ayer) las cuentas que ya tienen
 * resumen y borra lo que pasó la retención. Una cuenta a la vez, para no
 * competir con el tráfico.
 */
async function ponerAlDia({ logger = console } = {}) {
  if (!habilitado()) return { cuentas: 0, leidos: 0 };
  await asegurarTablas();
  const hoy = await hoyDeLaBase();
  const ayer = sumarDias(hoy, -1);
  const limite = sumarDias(hoy, -RETENCION_DIAS);
  const cuentas = await db.query(
    `SELECT id_configuracion, DATE_FORMAT(desde, '%Y-%m-%d') AS desde,
            DATE_FORMAT(hasta, '%Y-%m-%d') AS hasta
       FROM consumo_ia_diario_estado WHERE hasta < ?`,
    { replacements: [ayer], type: QueryTypes.SELECT },
  );
  let leidos = 0;
  let fallas = 0;
  for (const c of cuentas) {
    try {
      // Si quedó muy atrás no se rellena el hueco: se rehace el último tramo.
      const inicio =
        c.hasta < limite ? sumarDias(ayer, -90) : sumarDias(c.hasta, 1);
      leidos += (await cubrir(c.id_configuracion, inicio, ayer)).leidos;
    } catch (err) {
      fallas += 1;
      logger.error(
        `[consumo-ia-diario] cfg ${c.id_configuracion}:`,
        err.message,
      );
    }
  }
  await db.query(`DELETE FROM consumo_ia_diario WHERE dia < ?`, {
    replacements: [limite],
    type: QueryTypes.RAW,
  });
  await db.query(`DELETE FROM consumo_ia_diario_clientes WHERE dia < ?`, {
    replacements: [limite],
    type: QueryTypes.RAW,
  });
  await db.query(
    `UPDATE consumo_ia_diario_estado SET desde = ? WHERE desde < ?`,
    { replacements: [limite, limite], type: QueryTypes.RAW },
  );
  return { cuentas: cuentas.length, leidos, fallas };
}

module.exports = {
  SIN_IA,
  REMARKETING_IA,
  reducir,
  consumoDelPeriodo,
  consumoDirecto,
  ponerAlDia,
  asegurarTablas,
};
