// Plantilla global "Agente de E-commerce" de MÉXICO (id 25) — Contacto Inicial:
// el bot pide el CÓDIGO POSTAL junto con la dirección y lo escribe en el
// resumen de cierre ("📮 Codigo postal: 12345"). Dropi MX no cotiza el envío
// sin él ("Debe ingresar un código postal": ~10 auto-órdenes/día a manual en
// sep-2026). Versión +0.1 (6.1 → 6.2).
//
// El runtime (Responses API) lee kanban_columnas.instrucciones, así que las
// cuentas que ya aplicaron la plantilla NO cambian solas: con --cuentas se
// parchan también sus columnas Contacto Inicial cuando el texto viejo está
// intacto (misma sustitución por anclas; si el cliente editó su prompt y el
// ancla no está, esa cuenta se deja como está y se lista). Además, la regla
// viaja en el contexto de columna (utils/contextoColumna.js) para toda cuenta
// con integración Dropi MX, tenga o no el prompt nuevo.
//
//   node scripts/actualizarPlantillaMX_codigoPostal.js              → muestra los cambios
//   node scripts/actualizarPlantillaMX_codigoPostal.js --aplicar    → escribe la plantilla global
//   node scripts/actualizarPlantillaMX_codigoPostal.js --aplicar --cuentas → además parcha las columnas de las cuentas MX
const ROOT = require('path').join(__dirname, '..');
require(ROOT + '/node_modules/dotenv').config({ path: ROOT + '/.env' });
const fs = require('fs');
const path = require('path');
const { db } = require(ROOT + '/src/database/config');

const APLICAR = process.argv.includes('--aplicar');
const CUENTAS = process.argv.includes('--cuentas');
const ID_PLANTILLA_MX = 25;
const S = path.join(ROOT, 'logs', 'plantillas');
fs.mkdirSync(S, { recursive: true });

/* [ancla vieja, texto nuevo, descripción, veces esperadas (1 si se omite)].
   La ancla debe aparecer exactamente esas veces; se reemplazan todas. */
const CAMBIOS = [
  [
    '"Ultimo paso! Dame tu nombre completo, telefono y direccion exacta (2 calles + referencia). Pagas al recibir!"',
    '"Ultimo paso! Dame tu nombre completo, telefono, direccion exacta (calle, numero, colonia + referencia) y tu codigo postal. Pagas al recibir!"',
    'INTERACCION 5 (y el ejemplo) piden el código postal con la dirección',
    2,
  ],
  [
    'Cliente: "Michael Ordonez, 3312345678, calle A y calle B frente al parque"',
    'Cliente: "Michael Ordonez, 3312345678, calle A y calle B frente al parque, CP 44100"',
    'el cliente del ejemplo da su código postal',
  ],
  [
    /(📍 Ciudad: Guadalajara\n🏡 Direccion: [^\n]*\n)/,
    '$1📮 Codigo postal: 44100\n',
    'el resumen del ejemplo lleva la línea de código postal',
  ],
  [
    '¿su direccion REAL? ¿ya respondio domicilio o agencia?',
    '¿su direccion REAL? ¿su codigo postal (5 digitos, escrito por el cliente)? ¿ya respondio domicilio o agencia?',
    'INTERACCION 6 revisa el código postal antes de cerrar',
  ],
  [
    'Si tiene Nombre + Telefono + Direccion COMPLETOS,',
    'Si tiene Nombre + Telefono + Direccion + Codigo postal COMPLETOS,',
    'condición del cierre incluye el código postal',
  ],
  [
    '🏡 Direccion: [direccion exacta]\n',
    '🏡 Direccion: [direccion exacta]\n📮 Codigo postal: [codigo postal de 5 digitos que dio el cliente]\n',
    'línea "📮 Codigo postal:" en el resumen',
  ],
];

function aplicarCambios(texto, etiqueta) {
  let t = texto;
  const hechos = [];
  const faltantes = [];
  for (const [vieja, nueva, desc, veces = 1] of CAMBIOS) {
    const n =
      vieja instanceof RegExp
        ? (t.match(new RegExp(vieja.source, 'g')) || []).length
        : t.split(vieja).length - 1;
    if (n !== veces) {
      faltantes.push(`${desc} (ancla encontrada ${n} veces, se esperaban ${veces})`);
      continue;
    }
    t = vieja instanceof RegExp ? t.replace(vieja, nueva) : t.split(vieja).join(nueva);
    hechos.push(desc);
  }
  return { texto: t, hechos, faltantes, etiqueta };
}

(async () => {
  const [p] = await db.query(
    `SELECT id, nombre, pais, version, data FROM kanban_plantillas_globales WHERE id = ? LIMIT 1`,
    { replacements: [ID_PLANTILLA_MX], type: db.QueryTypes.SELECT },
  );
  if (!p) throw new Error(`No existe la plantilla ${ID_PLANTILLA_MX}`);
  if (String(p.pais).toUpperCase() !== 'MX')
    throw new Error(`La plantilla ${p.id} es de ${p.pais}, no de MX`);

  const data = JSON.parse(p.data);
  const ci = data.columnas.find((c) => c.estado_db === 'contacto_inicial');
  if (!ci?.instrucciones) throw new Error('Contacto Inicial sin instrucciones');

  if (/Codigo postal:/.test(ci.instrucciones)) {
    console.log(`La plantilla ${p.id} (v${p.version}) YA pide el código postal. Nada que hacer en la global.`);
  } else {
    const r = aplicarCambios(ci.instrucciones, `plantilla ${p.id}`);
    if (r.faltantes.length)
      throw new Error(`Plantilla ${p.id}: anclas no encontradas → ${r.faltantes.join(' | ')}`);
    fs.writeFileSync(path.join(S, `mx_${p.id}_antes.txt`), ci.instrucciones);
    fs.writeFileSync(path.join(S, `mx_${p.id}_despues.txt`), r.texto);
    const versionNueva = Math.round((Number(p.version) + 0.1) * 10) / 10;
    console.log(
      `Plantilla ${p.id} ${p.pais} v${p.version} → v${versionNueva}: ${ci.instrucciones.length} → ${r.texto.length} chars\n   - ${r.hechos.join('\n   - ')}`,
    );
    if (APLICAR) {
      ci.instrucciones = r.texto;
      await db.query(
        `UPDATE kanban_plantillas_globales SET data = ?, version = ROUND(version + 0.1, 1) WHERE id = ?`,
        { replacements: [JSON.stringify(data), p.id], type: db.QueryTypes.UPDATE },
      );
      console.log('   ✔ plantilla global actualizada');
    }
  }

  /* Columnas Contacto Inicial de las cuentas con Dropi MX. */
  const cols = await db.query(
    `SELECT kc.id, kc.id_configuracion, c.nombre_configuracion, kc.instrucciones
       FROM kanban_columnas kc
       JOIN configuraciones c ON c.id = kc.id_configuracion
      WHERE kc.estado_db = 'contacto_inicial' AND kc.activo = 1
        AND EXISTS (SELECT 1 FROM dropi_integrations i
                     WHERE i.id_configuracion = kc.id_configuracion
                       AND i.is_active = 1 AND i.deleted_at IS NULL
                       AND i.country_code = 'MX')`,
    { type: db.QueryTypes.SELECT },
  );
  let ya = 0;
  const parchables = [];
  const intocables = [];
  for (const col of cols) {
    const txt = String(col.instrucciones || '');
    if (/Codigo postal:/.test(txt)) {
      ya += 1;
      continue;
    }
    const r = aplicarCambios(txt, `cfg ${col.id_configuracion}`);
    if (r.faltantes.length) intocables.push({ col, faltantes: r.faltantes });
    else parchables.push({ col, texto: r.texto });
  }
  console.log(
    `\nCuentas MX con Contacto Inicial: ${cols.length} · ya piden CP: ${ya} · parchables: ${parchables.length} · con prompt propio (no se tocan): ${intocables.length}`,
  );
  for (const { col, faltantes } of intocables.slice(0, 15))
    console.log(`   - cfg ${col.id_configuracion} ${col.nombre_configuracion}: ${faltantes[0]}`);

  if (APLICAR && CUENTAS && parchables.length) {
    for (const { col, texto } of parchables) {
      fs.writeFileSync(path.join(S, `mx_col_${col.id}_antes.txt`), col.instrucciones);
      await db.query(`UPDATE kanban_columnas SET instrucciones = ? WHERE id = ?`, {
        replacements: [texto, col.id],
        type: db.QueryTypes.UPDATE,
      });
    }
    console.log(`   ✔ ${parchables.length} columnas de cuentas MX parchadas (respaldo en logs/plantillas/)`);
  } else if (parchables.length) {
    console.log(
      `   (con --aplicar --cuentas se parchan: ${parchables.map((x) => x.col.id_configuracion).join(', ')})`,
    );
  }

  await db.close();
  process.exit(0);
})().catch((e) => {
  console.error('ERROR', e.message);
  process.exit(1);
});
