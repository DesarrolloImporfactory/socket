// Ajustes v+0.1 en las 5 plantillas globales "Agente de E-commerce"
// (13 EC, 25 MX, 26 CO, 27 PE, 28 GT) — Contacto Inicial:
//   1. Objeción "¿puedo retirar en agencia?": ya no responde "el punto más
//      cercano + dame nombre/teléfono/ciudad"; pregunta la modalidad y, si
//      elige retiro, en EC manda la sección del directorio (switch) y en el
//      resto pide nombre/referencia de la oficina.
//   2. Combos: si pide N unidades y hay combo de N, el total es el del combo.
//   3. "¿De dónde son?": respuesta estándar con el nombre de la tienda.
//   MX además: "agencia servientrega" → "agencia" (en México no hay Servientrega).
//
//   node scripts/actualizarPlantillasEcommerce_2026_09.js            → muestra los cambios
//   node scripts/actualizarPlantillasEcommerce_2026_09.js --aplicar  → escribe (requiere version DECIMAL)
const ROOT = require('path').join(__dirname, '..');
require(ROOT + '/node_modules/dotenv').config({ path: ROOT + '/.env' });
const fs = require('fs');
const path = require('path');
const { db } = require(ROOT + '/src/database/config');

const APLICAR = process.argv.includes('--aplicar');
const S = path.join(__dirname, '..', 'logs', 'plantillas'); fs.mkdirSync(S, { recursive: true });

const PAIS_TXT = { EC: 'a todo el Ecuador', MX: 'a todo México', CO: 'a toda Colombia', PE: 'a todo el Perú', GT: 'a toda Guatemala' };

const OBJECION_VIEJA =
  /- Si el cliente pregunta si puede retirar en agencia \/ oficina \/ punto de retiro:\n"¡Claro! Puedes retirar tu pedido en [^\n]*"\nLuego continúa el flujo normal pidiendo los datos que falten, y al cerrar pon 🚚 Envio: agencia(?: servientrega)?\./;

const OBJECION_NUEVA = {
  EC:
    `- Si el cliente pregunta si puede retirar en agencia / oficina / punto de retiro:\n` +
    `"¡Claro! Puedes retirarlo en una oficina Servientrega y pagas al momento de recogerlo 😊 ¿Prefieres retirarlo en oficina o que te lo enviemos a tu domicilio?"\n` +
    `No le ofrezcas ninguna oficina ni le pidas datos hasta que elija. Si elige oficina: si estas instrucciones traen la sección "RETIRO EN AGENCIA SERVIENTREGA", esa sección manda (ofreces oficinas REALES del directorio, nunca "la más cercana"); si no la traen, pídele el nombre o una referencia (sector, calle) de la oficina donde quiere retirar. Al cerrar pon 🚚 Envio: agencia servientrega.`,
  CO:
    `- Si el cliente pregunta si puede retirar en agencia / oficina / punto de retiro:\n` +
    `"¡Claro! Puedes retirarlo en una oficina Servientrega y pagas al momento de recogerlo 😊 ¿Prefieres retirarlo en oficina o que te lo enviemos a tu domicilio?"\n` +
    `No le pidas datos hasta que elija. Si elige oficina, pídele el nombre o una referencia (ciudad y sector o calle) de la oficina Servientrega donde quiere retirar; nunca digas "la más cercana" sin saber cuál es. Al cerrar pon 🚚 Envio: agencia servientrega.`,
  MX:
    `- Si el cliente pregunta si puede retirar en agencia / oficina / punto de retiro:\n` +
    `"¡Claro! Puedes retirarlo en la sucursal de la paquetería y pagas al momento de recogerlo 😊 ¿Prefieres retirarlo ahí o que te lo enviemos a tu domicilio?"\n` +
    `No le pidas datos hasta que elija. Si elige retiro, pídele el nombre o una referencia (ciudad y colonia o calle) de la sucursal donde quiere retirar; nunca digas "la más cercana" sin saber cuál es. Al cerrar pon 🚚 Envio: agencia.`,
  PE:
    `- Si el cliente pregunta si puede retirar en agencia / oficina / punto de retiro:\n` +
    `"¡Claro! Puedes retirarlo en la agencia de nuestra transportadora y pagas al momento de recogerlo 😊 ¿Prefieres retirarlo ahí o que te lo enviemos a tu domicilio?"\n` +
    `No le pidas datos hasta que elija. Si elige retiro, pídele el nombre o una referencia (ciudad y distrito o calle) de la agencia donde quiere retirar; nunca digas "la más cercana" sin saber cuál es. Al cerrar pon 🚚 Envio: agencia.`,
  GT:
    `- Si el cliente pregunta si puede retirar en agencia / oficina / punto de retiro:\n` +
    `"¡Claro! Puedes retirarlo en la agencia de la transportadora y pagas al momento de recogerlo 😊 ¿Prefieres retirarlo ahí o que te lo enviemos a tu domicilio?"\n` +
    `No le pidas datos hasta que elija. Si elige retiro, pídele el nombre o una referencia (ciudad y zona o calle) de la agencia donde quiere retirar; nunca digas "la más cercana" sin saber cuál es. Al cerrar pon 🚚 Envio: agencia.`,
};

const COMBOS_ANCLA = /(que no este en file_search\.)(\n6\. VARIEDAD)/;
const COMBOS_EXTRA =
  ` Y al revés: si el cliente pide 2 o más unidades y SÍ existe un combo para esa cantidad, el precio total es EL DEL COMBO, nunca el unitario multiplicado (si 1 cuesta $20 y el combo de 2 cuesta $25, dos unidades = $25, NUNCA $40).`;

const ESTILO_ANCLA = /(\nESTILO\n- SIEMPRE responde en español[^\n]*\n)/;
const dondeSomos = (pais) =>
  `- Si preguntan de dónde somos o dónde estamos: "[NOMBRE_TIENDA] envía ${PAIS_TXT[pais]} con pago contra entrega 😊" (si la política de la tienda indica ciudad u horario, úsalos) y en el mismo mensaje sigue con el paso que toca. Nunca dejes esa pregunta sin responder.\n`;

// MX: en México no existe Servientrega; el resumen decía "agencia servientrega".
const MX_FIX = [
  [/🚚 Envio: \[domicilio  \|  agencia servientrega\]/g, '🚚 Envio: [domicilio  |  agencia]'],
  [/🚚 Envio: escribe "agencia servientrega" SOLO si/g, '🚚 Envio: escribe "agencia" SOLO si'],
];

function aplicarCambios(texto, pais) {
  const cambios = [];
  let t = texto;

  if (!OBJECION_VIEJA.test(t)) throw new Error(`${pais}: no encontré la objeción de retiro`);
  t = t.replace(OBJECION_VIEJA, OBJECION_NUEVA[pais]);
  cambios.push('objeción de retiro → pregunta la modalidad');

  if (!COMBOS_ANCLA.test(t)) throw new Error(`${pais}: no encontré el ancla de COMBOS`);
  t = t.replace(COMBOS_ANCLA, `$1${COMBOS_EXTRA}$2`);
  cambios.push('regla del precio del combo');

  if (!ESTILO_ANCLA.test(t)) throw new Error(`${pais}: no encontré el ancla de ESTILO`);
  t = t.replace(ESTILO_ANCLA, `$1${dondeSomos(pais)}`);
  cambios.push('"¿de dónde son?" respondido');

  if (pais === 'MX') {
    for (const [re, nuevo] of MX_FIX) {
      if (!re.test(t)) throw new Error('MX: no encontré "agencia servientrega" del resumen');
      t = t.replace(re, nuevo);
    }
    cambios.push('MX: "agencia servientrega" → "agencia"');
  }
  return { texto: t, cambios };
}

(async () => {
  const [col] = await db.query(
    `SELECT COLUMN_TYPE FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'kanban_plantillas_globales' AND column_name = 'version'`,
    { type: db.QueryTypes.SELECT },
  );
  const esDecimal = /decimal/i.test(col?.COLUMN_TYPE || '');
  console.log(`version es ${col?.COLUMN_TYPE} ${esDecimal ? '(OK)' : '(FALTA la migración plantillas_version_decimal_migration.sql)'}`);
  if (APLICAR && !esDecimal) {
    console.log('No se aplica nada: primero la migración, si no 7.1 se guardaría como 7.');
    process.exit(1);
  }

  const plantillas = await db.query(
    `SELECT id, nombre, pais, version, data FROM kanban_plantillas_globales
      WHERE id IN (13, 25, 26, 27, 28) AND activo = 1 ORDER BY id`,
    { type: db.QueryTypes.SELECT },
  );
  fs.writeFileSync(path.join(S, `respaldo_plantillas_${Date.now()}.json`), JSON.stringify(plantillas, null, 1));

  for (const p of plantillas) {
    const data = typeof p.data === 'string' ? JSON.parse(p.data) : p.data;
    const ci = data.columnas.find((c) => c.estado_db === 'contacto_inicial');
    const { texto, cambios } = aplicarCambios(ci.instrucciones, p.pais);
    fs.writeFileSync(path.join(S, `plantilla_${p.id}_${p.pais}_nueva.txt`), texto);
    const versionNueva = Math.round((Number(p.version) + 0.1) * 10) / 10;
    console.log(`\n${p.id} ${p.pais} v${p.version} → v${versionNueva}: ${ci.instrucciones.length} → ${texto.length} chars\n   - ${cambios.join('\n   - ')}`);
    if (!APLICAR) continue;
    ci.instrucciones = texto;
    await db.query(
      `UPDATE kanban_plantillas_globales SET data = ?, version = ROUND(version + 0.1, 1) WHERE id = ?`,
      { replacements: [JSON.stringify(data), p.id] },
    );
    console.log('   ✔ aplicada');
  }
  process.exit(0);
})().catch((e) => {
  console.error('ERROR', e.message);
  process.exit(1);
});
