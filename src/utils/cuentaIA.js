// ════════════════════════════════════════════════════════════
// cuentaIA.js — a qué cuenta pertenece la llave de IA guardada, SIN preguntar
// a OpenAI/Anthropic cada vez.
//
// POR QUÉ EXISTE ESTE ARCHIVO
//
// Hasta el 2026-10-22 la vista de Asistentes consultaba en vivo (GET /v1/me de
// OpenAI, /v1/organizations/me de Anthropic) cada vez que se abría, y saber
// "en qué conexión está la llave del correo X" obligaba a recorrer las 740
// llaves con un script. La cuenta de una llave NO cambia mientras la llave
// sea la misma, así que se guarda en configuraciones.openai_cuenta /
// claude_cuenta (JSON) y solo se vuelve a consultar cuando:
//   1) el cliente guarda una llave nueva (actualizar_api_key_*), o
//   2) nunca se consultó (llaves cargadas antes de esta columna), o
//   3) la consulta anterior falló (cuenta NULL) y pasó más de un día —así una
//      llave revocada no dispara una llamada por cada visita a la vista—, o
//   4) se pide explícito con ?refrescar=1.
// Al borrar la llave se borra la cuenta: sin llave no hay dónde recargar.
//
// Anthropic no entrega el correo con una llave normal (solo con una Admin API
// key, sk-ant-admin…, vía /v1/organizations/users): para Claude se guarda el
// nombre e ids de la organización, que es donde se recarga.
// ════════════════════════════════════════════════════════════
'use strict';

const { db } = require('../database/config');
const { leerApiKeyOpenAI } = require('./openia/apiKeyOpenAI');
const { obtenerCuentaOpenAI } = require('./openia/cuentaOpenAI');
const { leerApiKeyClaude } = require('./claude/apiKeyClaude');
const { obtenerCuentaClaude } = require('./claude/cuentaClaude');

const PROVEEDORES = {
  openai: {
    colKey: 'api_key_openai',
    colCuenta: 'openai_cuenta',
    colAt: 'openai_cuenta_at',
    leer: leerApiKeyOpenAI,
    consultar: obtenerCuentaOpenAI,
  },
  claude: {
    colKey: 'api_key_claude',
    colCuenta: 'claude_cuenta',
    colAt: 'claude_cuenta_at',
    leer: leerApiKeyClaude,
    consultar: obtenerCuentaClaude,
  },
};

// Reintento para una consulta que falló (cuenta NULL con fecha): un día.
const REINTENTO_FALLIDA_MS = 24 * 60 * 60 * 1000;

function proveedorDe(nombre) {
  const p = PROVEEDORES[String(nombre || '').toLowerCase()];
  if (!p) throw new Error(`Proveedor de IA desconocido: ${nombre}`);
  return p;
}

// MySQL devuelve la columna JSON ya parseada o como string según el driver.
function parsearCuenta(valor) {
  if (valor == null || valor === '') return null;
  if (typeof valor === 'object') return valor;
  try {
    return JSON.parse(valor);
  } catch (_) {
    return null;
  }
}

// Persiste la cuenta (o NULL si no se pudo averiguar) y la fecha de consulta.
async function guardarCuentaIA(id_configuracion, proveedor, cuenta) {
  const p = proveedorDe(proveedor);
  await db.query(
    `UPDATE configuraciones
        SET ${p.colCuenta} = ?, ${p.colAt} = NOW()
      WHERE id = ?`,
    {
      replacements: [cuenta ? JSON.stringify(cuenta) : null, id_configuracion],
      type: db.QueryTypes.UPDATE,
    },
  );
}

// Al borrar la llave: deja ambas columnas en NULL.
async function limpiarCuentaIA(id_configuracion, proveedor) {
  const p = proveedorDe(proveedor);
  await db.query(
    `UPDATE configuraciones
        SET ${p.colCuenta} = NULL, ${p.colAt} = NULL
      WHERE id = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.UPDATE },
  );
}

// Consulta en vivo con la llave plana y guarda el resultado. Devuelve la cuenta.
async function consultarYGuardarCuentaIA(id_configuracion, proveedor, apiKey) {
  const p = proveedorDe(proveedor);
  const cuenta = apiKey ? await p.consultar(apiKey) : null;
  await guardarCuentaIA(id_configuracion, proveedor, cuenta);
  return cuenta;
}

/* Cuenta de la llave guardada de una configuración.
   Devuelve { cuenta, consultada_at, origen } donde origen es 'bd' si salió de
   la base o 'proveedor' si hubo que preguntar en vivo. null en cuenta cuando
   no hay llave o no se pudo averiguar. Lanza si la configuración no existe. */
async function obtenerCuentaIA(
  id_configuracion,
  proveedor,
  { refrescar = false } = {},
) {
  const p = proveedorDe(proveedor);
  const [row] = await db.query(
    `SELECT ${p.colKey} AS api_key, ${p.colCuenta} AS cuenta, ${p.colAt} AS cuenta_at
       FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!row) return null;

  const apiKey = p.leer(row.api_key);
  if (!apiKey) {
    // Sin llave no hay cuenta; si quedó algo guardado de una llave anterior, fuera.
    if (row.cuenta || row.cuenta_at)
      await limpiarCuentaIA(id_configuracion, proveedor);
    return { cuenta: null, consultada_at: null, origen: 'bd' };
  }

  const guardada = parsearCuenta(row.cuenta);
  const consultadaAt = row.cuenta_at ? new Date(row.cuenta_at) : null;
  const fallidaVieja =
    !guardada &&
    consultadaAt &&
    Date.now() - consultadaAt.getTime() > REINTENTO_FALLIDA_MS;

  if (!refrescar && consultadaAt && !fallidaVieja) {
    return { cuenta: guardada, consultada_at: consultadaAt, origen: 'bd' };
  }

  const cuenta = await consultarYGuardarCuentaIA(
    id_configuracion,
    proveedor,
    apiKey,
  );
  return { cuenta, consultada_at: new Date(), origen: 'proveedor' };
}

module.exports = {
  guardarCuentaIA,
  limpiarCuentaIA,
  consultarYGuardarCuentaIA,
  obtenerCuentaIA,
  parsearCuenta,
};
