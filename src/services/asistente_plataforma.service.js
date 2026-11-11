/**
 * asistente_plataforma.service.js
 *
 * Con qué llave responde el asistente flotante («¿Cómo empiezo?» en
 * /conexiones y «Pregúntale a tu cuenta» dentro de una conexión) cuando paga
 * la plataforma y no el cliente.
 *
 * Hasta el 11-11-2026 esa llave era una sola variable del .env
 * (OPENAI_API_KEY_SOPORTE): se quedó sin saldo, el flotante empezó a contestar
 * «está recibiendo muchas consultas» y nadie del equipo recordaba de dónde
 * salía. Ahora el super admin la configura en /administrador-asistente:
 *   · una llave de OpenAI y/o una de Claude, guardadas cifradas (mismo
 *     AES-256-GCM de utils/cryptoToken que las llaves de los clientes);
 *   · cuál de las dos responde primero. La otra queda de respaldo, y la del
 *     .env, si sigue puesta, es el último recurso;
 *   · el tope de preguntas por usuario y día;
 *   · el último error de cada llave (sin saldo, inválida…), que antes solo
 *     quedaba en la consola del servidor.
 *
 * El uso diario se guarda en BD: el contador en memoria se reiniciaba con cada
 * deploy y no se compartía entre los dos procesos que corren contra la misma
 * base (dev y prod).
 *
 * Las tablas se crean solas la primera vez (misma BD dev/prod). Si la base
 * falla, leerConfig devuelve la configuración vacía: el asistente sigue con la
 * llave del .env como hasta ahora.
 */
'use strict';

const { db } = require('../database/config');
const {
  leerApiKeyOpenAI,
  prepararApiKeyParaGuardar,
  enmascararApiKeyOpenAI,
} = require('../utils/openia/apiKeyOpenAI');
const {
  leerApiKeyClaude,
  prepararApiKeyClaudeParaGuardar,
  enmascararApiKeyClaude,
} = require('../utils/claude/apiKeyClaude');
const { MODELO_CLAUDE_DEFECTO, IDS_CLAUDE } = require('../utils/claude/claude');

const PROVEEDORES = ['openai', 'claude'];

/* Modelos de OpenAI que puede usar la llave de la plataforma. Solo los que
   aceptan la llamada tal como la hace el asistente (chat/completions con
   max_tokens y temperature): la familia gpt-5 rechaza esos dos parámetros y
   además exige organización verificada, por eso no está en la lista. */
const MODELO_OPENAI_DEFECTO = 'gpt-4o-mini';
const MODELOS_OPENAI = [
  { value: 'gpt-4o-mini', label: 'GPT-4o mini (el más económico)' },
  { value: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
  { value: 'gpt-4.1', label: 'GPT-4.1' },
  { value: 'gpt-4o', label: 'GPT-4o' },
];
const IDS_OPENAI = MODELOS_OPENAI.map((m) => m.value);
const TOPE_DIARIO_DEFECTO = 40;
const TOPE_DIARIO_MAX = 500;
// Dos procesos comparten la base: lo que guarda uno, el otro lo ve en 30 s.
const TTL_MS = 30 * 1000;

const POR_PROVEEDOR = {
  openai: {
    leer: leerApiKeyOpenAI,
    cifrar: prepararApiKeyParaGuardar,
    enmascarar: enmascararApiKeyOpenAI,
  },
  claude: {
    leer: leerApiKeyClaude,
    cifrar: prepararApiKeyClaudeParaGuardar,
    enmascarar: enmascararApiKeyClaude,
  },
};

const CONFIG_VACIA = Object.freeze({
  proveedor: 'openai',
  modelo_claude: MODELO_CLAUDE_DEFECTO,
  modelo_openai: MODELO_OPENAI_DEFECTO,
  tope_diario: TOPE_DIARIO_DEFECTO,
  llaves: { openai: null, claude: null },
  enmascaradas: { openai: null, claude: null },
  cuentas: { openai: null, claude: null },
  errores: { openai: null, claude: null },
  updated_at: null,
  updated_by: null,
});

function validarProveedor(proveedor) {
  const p = String(proveedor || '').toLowerCase();
  if (!PROVEEDORES.includes(p)) throw new Error(`Proveedor desconocido: ${proveedor}`);
  return p;
}

let tablasListas = false;
async function ensureTablas() {
  if (tablasListas) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS asistente_plataforma_config (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      proveedor ENUM('openai','claude') NOT NULL DEFAULT 'openai',
      modelo_claude VARCHAR(60) NULL,
      tope_diario INT NOT NULL DEFAULT ${TOPE_DIARIO_DEFECTO},
      api_key_openai TEXT NULL,
      api_key_claude TEXT NULL,
      openai_cuenta TEXT NULL,
      claude_cuenta TEXT NULL,
      openai_error_codigo VARCHAR(20) NULL,
      openai_error_msg VARCHAR(300) NULL,
      openai_error_at DATETIME NULL,
      claude_error_codigo VARCHAR(20) NULL,
      claude_error_msg VARCHAR(300) NULL,
      claude_error_at DATETIME NULL,
      updated_by VARCHAR(255) NULL,
      updated_at DATETIME NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS asistente_plataforma_uso (
      sujeto VARCHAR(40) NOT NULL,
      fecha DATE NOT NULL,
      origen VARCHAR(12) NOT NULL,
      preguntas INT NOT NULL DEFAULT 0,
      tokens BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (sujeto, fecha, origen),
      KEY ix_apu_fecha (fecha)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await db.query(
    `INSERT IGNORE INTO asistente_plataforma_config (id, proveedor) VALUES (1, 'openai')`,
  );
  // La tabla pudo crearse antes de que existiera el modelo de OpenAI.
  const cols = await db.query(
    `SHOW COLUMNS FROM asistente_plataforma_config LIKE 'modelo_openai'`,
    { type: db.QueryTypes.SELECT },
  );
  if (!cols.length) {
    await db.query(
      `ALTER TABLE asistente_plataforma_config
         ADD COLUMN modelo_openai VARCHAR(60) NULL AFTER modelo_claude`,
    );
  }
  tablasListas = true;
}

function parsearJson(valor) {
  if (!valor) return null;
  if (typeof valor === 'object') return valor;
  try {
    return JSON.parse(valor);
  } catch (_) {
    return null;
  }
}

function errorDeFila(row, p) {
  const codigo = row[`${p}_error_codigo`];
  if (!codigo) return null;
  return {
    codigo,
    mensaje: row[`${p}_error_msg`] || '',
    at: row[`${p}_error_at`] || null,
  };
}

let cache = null; // { ts, valor }

/** La configuración con las llaves ya descifradas. Nunca lanza. */
async function leerConfig({ fresco = false } = {}) {
  if (!fresco && cache && Date.now() - cache.ts < TTL_MS) return cache.valor;
  let valor = CONFIG_VACIA;
  try {
    await ensureTablas();
    const [row] = await db.query(
      `SELECT * FROM asistente_plataforma_config WHERE id = 1 LIMIT 1`,
      { type: db.QueryTypes.SELECT },
    );
    if (row) {
      const tope = Number(row.tope_diario);
      valor = {
        proveedor: row.proveedor === 'claude' ? 'claude' : 'openai',
        modelo_claude: IDS_CLAUDE.includes(row.modelo_claude)
          ? row.modelo_claude
          : MODELO_CLAUDE_DEFECTO,
        modelo_openai: IDS_OPENAI.includes(row.modelo_openai)
          ? row.modelo_openai
          : MODELO_OPENAI_DEFECTO,
        tope_diario: tope > 0 ? Math.min(tope, TOPE_DIARIO_MAX) : TOPE_DIARIO_DEFECTO,
        llaves: {
          openai: leerApiKeyOpenAI(row.api_key_openai),
          claude: leerApiKeyClaude(row.api_key_claude),
        },
        enmascaradas: {
          openai: enmascararApiKeyOpenAI(row.api_key_openai),
          claude: enmascararApiKeyClaude(row.api_key_claude),
        },
        cuentas: {
          openai: parsearJson(row.openai_cuenta),
          claude: parsearJson(row.claude_cuenta),
        },
        errores: {
          openai: errorDeFila(row, 'openai'),
          claude: errorDeFila(row, 'claude'),
        },
        updated_at: row.updated_at || null,
        updated_by: row.updated_by || null,
      };
    }
  } catch (err) {
    console.warn('[AsistentePlataforma] no se pudo leer la configuración:', err.message);
  }
  cache = { ts: Date.now(), valor };
  return valor;
}

function invalidar() {
  cache = null;
}

async function guardarAjustes({
  proveedor,
  modelo_claude,
  modelo_openai,
  tope_diario,
  actor,
}) {
  await ensureTablas();
  const tope = Math.round(Number(tope_diario));
  await db.query(
    `UPDATE asistente_plataforma_config
        SET proveedor = ?, modelo_claude = ?, modelo_openai = ?, tope_diario = ?,
            updated_by = ?, updated_at = NOW()
      WHERE id = 1`,
    {
      replacements: [
        validarProveedor(proveedor),
        IDS_CLAUDE.includes(modelo_claude) ? modelo_claude : MODELO_CLAUDE_DEFECTO,
        IDS_OPENAI.includes(modelo_openai) ? modelo_openai : MODELO_OPENAI_DEFECTO,
        tope > 0 ? Math.min(tope, TOPE_DIARIO_MAX) : TOPE_DIARIO_DEFECTO,
        String(actor || '').slice(0, 255) || null,
      ],
      type: db.QueryTypes.UPDATE,
    },
  );
  invalidar();
}

/** Guarda la llave cifrada, la cuenta a la que pertenece y borra el error anterior. */
async function guardarLlave(proveedor, plana, cuenta, actor) {
  const p = validarProveedor(proveedor);
  await ensureTablas();
  await db.query(
    `UPDATE asistente_plataforma_config
        SET api_key_${p} = ?, ${p}_cuenta = ?,
            ${p}_error_codigo = NULL, ${p}_error_msg = NULL, ${p}_error_at = NULL,
            updated_by = ?, updated_at = NOW()
      WHERE id = 1`,
    {
      replacements: [
        POR_PROVEEDOR[p].cifrar(plana),
        cuenta ? JSON.stringify(cuenta) : null,
        String(actor || '').slice(0, 255) || null,
      ],
      type: db.QueryTypes.UPDATE,
    },
  );
  invalidar();
}

async function eliminarLlave(proveedor, actor) {
  const p = validarProveedor(proveedor);
  await ensureTablas();
  await db.query(
    `UPDATE asistente_plataforma_config
        SET api_key_${p} = NULL, ${p}_cuenta = NULL,
            ${p}_error_codigo = NULL, ${p}_error_msg = NULL, ${p}_error_at = NULL,
            updated_by = ?, updated_at = NOW()
      WHERE id = 1`,
    {
      replacements: [String(actor || '').slice(0, 255) || null],
      type: db.QueryTypes.UPDATE,
    },
  );
  invalidar();
}

/** Deja anotado por qué falló la llave de la plataforma. Nunca lanza. */
async function marcarError(proveedor, codigo, mensaje) {
  try {
    const p = validarProveedor(proveedor);
    await ensureTablas();
    await db.query(
      `UPDATE asistente_plataforma_config
          SET ${p}_error_codigo = ?, ${p}_error_msg = ?, ${p}_error_at = NOW()
        WHERE id = 1`,
      {
        replacements: [
          String(codigo || 'ERROR').slice(0, 20),
          String(mensaje || '').replace(/\s+/g, ' ').slice(0, 300),
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
    invalidar();
  } catch (err) {
    console.warn('[AsistentePlataforma] no se pudo anotar el error:', err.message);
  }
}

/** La llave volvió a responder: se quita el aviso. Nunca lanza. */
async function limpiarError(proveedor) {
  try {
    const p = validarProveedor(proveedor);
    await ensureTablas();
    await db.query(
      `UPDATE asistente_plataforma_config
          SET ${p}_error_codigo = NULL, ${p}_error_msg = NULL, ${p}_error_at = NULL
        WHERE id = 1 AND ${p}_error_codigo IS NOT NULL`,
      { type: db.QueryTypes.UPDATE },
    );
    invalidar();
  } catch (err) {
    console.warn('[AsistentePlataforma] no se pudo limpiar el error:', err.message);
  }
}

/* ── Uso diario ───────────────────────────────────────────────────────────
   Si la base falla se cae a un contador en memoria: el tope sigue frenando
   abuso aunque sea solo dentro de este proceso. */
const usoMemoria = new Map(); // `${sujeto}|${fecha}` -> n

async function usoDeHoy(sujeto, fecha) {
  try {
    await ensureTablas();
    const [row] = await db.query(
      `SELECT COALESCE(SUM(preguntas), 0) AS n
         FROM asistente_plataforma_uso
        WHERE sujeto = ? AND fecha = ?`,
      { replacements: [sujeto, fecha], type: db.QueryTypes.SELECT },
    );
    return Number(row?.n) || 0;
  } catch (err) {
    return usoMemoria.get(`${sujeto}|${fecha}`) || 0;
  }
}

/** origen: 'propia' (llave del cliente), 'openai' / 'claude' (plataforma) o 'env'. */
async function registrarUso(sujeto, fecha, origen, tokens) {
  for (const k of usoMemoria.keys()) {
    if (!k.endsWith(`|${fecha}`)) usoMemoria.delete(k);
  }
  const k = `${sujeto}|${fecha}`;
  usoMemoria.set(k, (usoMemoria.get(k) || 0) + 1);
  try {
    await ensureTablas();
    await db.query(
      `INSERT INTO asistente_plataforma_uso (sujeto, fecha, origen, preguntas, tokens)
       VALUES (?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE preguntas = preguntas + 1, tokens = tokens + VALUES(tokens)`,
      {
        replacements: [
          String(sujeto).slice(0, 40),
          fecha,
          String(origen || 'openai').slice(0, 12),
          Math.max(0, Math.round(Number(tokens) || 0)),
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  } catch (err) {
    console.warn('[AsistentePlataforma] no se pudo registrar el uso:', err.message);
  }
}

/** Preguntas y tokens por día y por llave, para el panel del super admin. */
async function resumenUso(dias = 7) {
  await ensureTablas();
  return db.query(
    `SELECT DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, origen,
            SUM(preguntas) AS preguntas, SUM(tokens) AS tokens,
            COUNT(DISTINCT sujeto) AS usuarios
       FROM asistente_plataforma_uso
      WHERE fecha >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY fecha, origen
      ORDER BY fecha DESC, origen ASC`,
    {
      replacements: [Math.min(Math.max(Number(dias) || 7, 1), 60)],
      type: db.QueryTypes.SELECT,
    },
  );
}

module.exports = {
  PROVEEDORES,
  MODELOS_OPENAI,
  IDS_OPENAI,
  MODELO_OPENAI_DEFECTO,
  TOPE_DIARIO_DEFECTO,
  TOPE_DIARIO_MAX,
  ensureTablas,
  leerConfig,
  guardarAjustes,
  guardarLlave,
  eliminarLlave,
  marcarError,
  limpiarError,
  usoDeHoy,
  registrarUso,
  resumenUso,
};
