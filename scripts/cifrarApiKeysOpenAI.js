// ════════════════════════════════════════════════════════════
// cifrarApiKeysOpenAI.js
// Cifra las API keys de OpenAI que quedaron en texto plano en
// configuraciones.api_key_openai (ver src/utils/openia/apiKeyOpenAI.js).
//
//   node scripts/cifrarApiKeysOpenAI.js                 → simulación, no escribe
//   node scripts/cifrarApiKeysOpenAI.js --aplicar       → cifra las planas
//   node scripts/cifrarApiKeysOpenAI.js --aplicar --id=610   → solo una config
//   node scripts/cifrarApiKeysOpenAI.js --revertir --aplicar → vuelve a plano
//
// ⚠ ANTES DE --aplicar
// Desarrollo y producción comparten la base. Si algún proceso todavía corre
// código SIN leerApiKeyOpenAI, al cifrar su fila va a mandar el texto cifrado
// como Bearer y ese bot queda mudo. Orden obligatorio:
//   1) Código con el lector tolerante desplegado en TODOS los entornos.
//   2) Probar con una sola: --aplicar --id=<config de prueba>, escribirle al bot.
//   3) Recién ahí --aplicar sin --id.
// La DROPI_TOKEN_ENC_KEY tiene que ser LA MISMA en todos los entornos: con otra
// llave el texto no se descifra. --revertir es la salida de emergencia.
// ════════════════════════════════════════════════════════════
require('dotenv').config();
const { db } = require('../src/database/config');
const { encryptToken, decryptToken } = require('../src/utils/cryptoToken');
const { estaCifrada } = require('../src/utils/openia/apiKeyOpenAI');

const args = process.argv.slice(2);
const APLICAR = args.includes('--aplicar');
const REVERTIR = args.includes('--revertir');
const soloId = Number(
  (args.find((a) => a.startsWith('--id=')) || '').split('=')[1] || 0,
);

(async () => {
  const filas = await db.query(
    `SELECT id, nombre_configuracion, api_key_openai
       FROM configuraciones
      WHERE api_key_openai IS NOT NULL AND api_key_openai <> ''
        ${soloId ? 'AND id = ?' : ''}
      ORDER BY id`,
    { replacements: soloId ? [soloId] : [], type: db.QueryTypes.SELECT },
  );

  let cambiadas = 0;
  let yaEstaban = 0;
  let raras = 0;
  let fallidas = 0;

  for (const f of filas) {
    const actual = String(f.api_key_openai);
    const cifrada = estaCifrada(actual);

    if (REVERTIR ? !cifrada : cifrada) {
      yaEstaban++;
      continue;
    }

    // Ni "sk-…" ni iv.tag.datos: basura pegada a mano. No se toca.
    if (!REVERTIR && !actual.trim().startsWith('sk-')) {
      raras++;
      console.log(
        `  ? cfg ${f.id} (${f.nombre_configuracion}): valor que no parece una key, se deja igual`,
      );
      continue;
    }

    let nuevo;
    try {
      if (REVERTIR) {
        nuevo = decryptToken(actual.trim());
      } else {
        nuevo = encryptToken(actual.trim());
        // Ida y vuelta antes de escribir: si no vuelve idéntica, no se guarda.
        if (decryptToken(nuevo) !== actual.trim()) {
          throw new Error('la verificación de ida y vuelta no coincide');
        }
      }
    } catch (err) {
      fallidas++;
      console.log(`  ✗ cfg ${f.id}: ${err.message}`);
      continue;
    }

    if (APLICAR) {
      // El AND api_key_openai = ? evita pisar una key que el cliente cambió
      // mientras corría el script.
      await db.query(
        `UPDATE configuraciones SET api_key_openai = ?
          WHERE id = ? AND api_key_openai = ?`,
        { replacements: [nuevo, f.id, actual], type: db.QueryTypes.UPDATE },
      );
    }
    cambiadas++;
    console.log(
      `  ${APLICAR ? '✓' : '·'} cfg ${f.id} (${f.nombre_configuracion}) …${actual.trim().slice(-4)} → ${REVERTIR ? 'plano' : 'cifrada'}`,
    );
  }

  console.log(
    `\n${APLICAR ? 'APLICADO' : 'SIMULACIÓN (nada escrito; usar --aplicar)'} · modo: ${REVERTIR ? 'revertir' : 'cifrar'}`,
  );
  console.log(
    `  filas con key: ${filas.length} | ${APLICAR ? 'cambiadas' : 'por cambiar'}: ${cambiadas} | ya estaban: ${yaEstaban} | raras: ${raras} | fallidas: ${fallidas}`,
  );
  await db.close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
