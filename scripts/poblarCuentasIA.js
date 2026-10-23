// ════════════════════════════════════════════════════════════
// poblarCuentasIA.js
// Llena configuraciones.openai_cuenta / claude_cuenta para las llaves que ya
// estaban cargadas antes de la columna (ver cuentas_ia_migration.sql y
// src/utils/cuentaIA.js). Pregunta a OpenAI (/v1/me) y Anthropic
// (/v1/organizations/me) UNA vez por llave y lo deja guardado; de ahí en
// adelante la vista de Asistentes lee de la BD.
//
//   node scripts/poblarCuentasIA.js                         → simulación, no escribe
//   node scripts/poblarCuentasIA.js --aplicar               → consulta y guarda las que faltan
//   node scripts/poblarCuentasIA.js --aplicar --todas       → también las que ya tienen cuenta
//   node scripts/poblarCuentasIA.js --aplicar --id=1154     → solo una configuración
//   node scripts/poblarCuentasIA.js --correo=x@gmail.com    → busca ese correo (en BD y,
//                                                             si falta, consultando)
//
// Idempotente: sin --todas solo toca las filas con *_cuenta_at NULL. Las que
// fallan (llave revocada → 401) quedan con cuenta NULL y fecha, y la vista
// reintenta recién al día siguiente. Corre de a 5 llaves en paralelo.
// ════════════════════════════════════════════════════════════
require('dotenv').config();
const { db } = require('../src/database/config');
const { leerApiKeyOpenAI } = require('../src/utils/openia/apiKeyOpenAI');
const { leerApiKeyClaude } = require('../src/utils/claude/apiKeyClaude');
const { obtenerCuentaOpenAI } = require('../src/utils/openia/cuentaOpenAI');
const { obtenerCuentaClaude } = require('../src/utils/claude/cuentaClaude');
const { guardarCuentaIA, parsearCuenta } = require('../src/utils/cuentaIA');

const args = process.argv.slice(2);
const APLICAR = args.includes('--aplicar');
const TODAS = args.includes('--todas');
const soloId = Number(
  (args.find((a) => a.startsWith('--id=')) || '').split('=')[1] || 0,
);
const correoBuscado = String(
  (args.find((a) => a.startsWith('--correo=')) || '').split('=')[1] || '',
)
  .trim()
  .toLowerCase();

const PROVEEDORES = [
  {
    nombre: 'openai',
    colKey: 'api_key_openai',
    colCuenta: 'openai_cuenta',
    colAt: 'openai_cuenta_at',
    leer: leerApiKeyOpenAI,
    consultar: obtenerCuentaOpenAI,
  },
  {
    nombre: 'claude',
    colKey: 'api_key_claude',
    colCuenta: 'claude_cuenta',
    colAt: 'claude_cuenta_at',
    leer: leerApiKeyClaude,
    consultar: obtenerCuentaClaude,
  },
];

async function procesarProveedor(p) {
  const filas = await db.query(
    `SELECT id, nombre_configuracion, ${p.colKey} AS api_key, ${p.colCuenta} AS cuenta, ${p.colAt} AS cuenta_at
       FROM configuraciones
      WHERE ${p.colKey} IS NOT NULL AND ${p.colKey} <> ''
        ${soloId ? 'AND id = ?' : ''}
        ${TODAS || correoBuscado ? '' : `AND ${p.colAt} IS NULL`}
      ORDER BY id`,
    { replacements: soloId ? [soloId] : [], type: db.QueryTypes.SELECT },
  );

  const r = {
    proveedor: p.nombre,
    candidatas: filas.length,
    consultadas: 0,
    ok: 0,
    fallidas: 0,
    deBD: 0,
    guardadas: 0,
  };
  const coincidencias = [];

  for (let i = 0; i < filas.length; i += 5) {
    await Promise.all(
      filas.slice(i, i + 5).map(async (f) => {
        let cuenta = parsearCuenta(f.cuenta);
        const yaConsultada = Boolean(f.cuenta_at);

        // Buscando un correo: lo que ya está en BD no se vuelve a consultar.
        if (correoBuscado && yaConsultada && !TODAS) {
          r.deBD++;
        } else {
          const key = p.leer(f.api_key);
          cuenta = key ? await p.consultar(key) : null;
          r.consultadas++;
          if (cuenta) r.ok++;
          else r.fallidas++;
          if (APLICAR) {
            await guardarCuentaIA(f.id, p.nombre, cuenta);
            r.guardadas++;
          }
        }

        if (correoBuscado) {
          const email = String(cuenta?.email || '').toLowerCase();
          if (email === correoBuscado) {
            coincidencias.push({
              id: f.id,
              nombre: f.nombre_configuracion,
              organizacion: cuenta.organizacion,
              proyecto: cuenta.proyecto,
            });
          }
        }
      }),
    );
    if ((i + 5) % 100 === 0)
      console.log(
        `  ${p.nombre}: ${Math.min(i + 5, filas.length)}/${filas.length}`,
      );
  }

  return { resumen: r, coincidencias };
}

(async () => {
  console.log(
    APLICAR
      ? '>> MODO APLICAR: se escribe en configuraciones'
      : '>> SIMULACIÓN: no se escribe nada (usa --aplicar)',
  );
  const resumenes = [];
  for (const p of PROVEEDORES) {
    // Con --correo solo tiene sentido OpenAI (Claude no entrega correo).
    if (correoBuscado && p.nombre !== 'openai') continue;
    const { resumen, coincidencias } = await procesarProveedor(p);
    resumenes.push(resumen);
    if (correoBuscado) {
      console.log(`\n=== ${correoBuscado} ===`);
      console.table(
        coincidencias.length
          ? coincidencias
          : [{ resultado: 'sin coincidencias' }],
      );
    }
  }
  console.log('\n=== RESUMEN ===');
  console.table(resumenes);
  await db.close();
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  try {
    await db.close();
  } catch (_) {}
  process.exit(1);
});
