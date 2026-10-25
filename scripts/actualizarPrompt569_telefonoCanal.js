// Cfg 569 (Compra Segura) — Contacto Inicial (columna 3735): el teléfono ya
// no se le pide al cliente; se usa el número desde el que escribe.
//
// Contexto (2026-10-24): la sección "7. Teléfono — LO PIDES TÚ, SIEMPRE / No
// puedes ver el número del chat / si dice 'este mismo' → 'Escríbemelo aquí'"
// era un parche para esquivar el candado anti-invento del cierre, que trataba
// el número del chat como inventado. Ese candado ya acepta el número del
// canal (utils/fichaPedido.js: telefonoCanal). Con el código nuevo en
// producción, esa sección sobra y hace que el bot le pida al cliente que
// escriba un número que el sistema ya tiene.
//
// ⚠️ CORRER SOLO DESPUÉS de que el código con telefonoCanal esté en
// producción: con el código viejo, el número del chat en el resumen bloquea
// el cierre y el bot pediría el teléfono igual.
//
//   node scripts/actualizarPrompt569_telefonoCanal.js            → muestra el cambio
//   node scripts/actualizarPrompt569_telefonoCanal.js --aplicar  → escribe en la BD
//
// El assistant asst_TYsCvRdSOuYwGlicUuEV4fvq (rollback de responsesApi.js)
// NO se toca acá: la 569 corre por Responses API leyendo kanban_columnas.
const ROOT = require('path').join(__dirname, '..');
require(ROOT + '/node_modules/dotenv').config({ path: ROOT + '/.env' });
const fs = require('fs');
const path = require('path');
const { db } = require(ROOT + '/src/database/config');

const APLICAR = process.argv.includes('--aplicar');
const COLUMNA = 3735;

const VIEJA_INICIO = '### 7. Teléfono — LO PIDES TÚ, SIEMPRE';
const VIEJA_FIN = '  escribes en el pedido.\n';

const NUEVA = `### 7. Teléfono — el del chat, sin pedirlo
El sistema YA tiene el número desde el que escribe la persona: está en
"DATOS TÉCNICOS DEL CONTACTO" (y en la FICHA DEL PEDIDO cuando aparece).
Ese número es el teléfono del pedido. NO se lo pidas, NO le pidas que lo
escriba y NO le preguntes si es ese.
- Si el cliente escribió otro número en cualquier mensaje (o lo dijo en un
  audio) → ese manda: es el que quiere que llamen.
- Si no escribió ninguno → usas el de DATOS TÉCNICOS tal cual en el
  resumen y sigues. Cuando vea el resumen, si quiere otro número te lo
  dirá y lo cambias.
- Lo escribes en formato 09XXXXXXXX (si viene con +593 o 593, cambias el
  593 por 0). Nunca inventes un número.
- Una cédula (10 dígitos que no empiezan en 09) no es teléfono: no la
  escribes en el pedido.
`;

(async () => {
  const [col] = await db.query(
    `SELECT id, nombre, instrucciones FROM kanban_columnas WHERE id = ?`,
    { replacements: [COLUMNA], type: db.QueryTypes.SELECT },
  );
  if (!col) throw new Error(`columna ${COLUMNA} no existe`);
  const txt = String(col.instrucciones || '');
  const i = txt.indexOf(VIEJA_INICIO);
  if (i < 0) {
    console.log('La sección vieja ya no está en el prompt; nada que hacer.');
    process.exit(0);
  }
  const j = txt.indexOf(VIEJA_FIN, i);
  if (j < 0) throw new Error('no se encontró el final de la sección 7');
  const vieja = txt.slice(i, j + VIEJA_FIN.length);
  const nuevo = txt.slice(0, i) + NUEVA + txt.slice(j + VIEJA_FIN.length);

  console.log(`── columna ${col.id} "${col.nombre}" (${txt.length} → ${nuevo.length} chars)\n`);
  console.log('ANTES:\n' + vieja);
  console.log('DESPUÉS:\n' + NUEVA);

  if (!APLICAR) {
    console.log('\n(sin --aplicar no se escribe nada)');
    process.exit(0);
  }
  const dir = path.join(ROOT, 'backups_prompts');
  fs.mkdirSync(dir, { recursive: true });
  const bk = path.join(
    dir,
    `569_col${COLUMNA}_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
  );
  fs.writeFileSync(bk, txt, 'utf8');
  await db.query(
    `UPDATE kanban_columnas SET instrucciones = ?, updated_at = NOW() WHERE id = ?`,
    { replacements: [nuevo, COLUMNA], type: db.QueryTypes.UPDATE },
  );
  console.log(`\n✅ Aplicado. Respaldo del prompt anterior: ${bk}`);
  process.exit(0);
})().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
