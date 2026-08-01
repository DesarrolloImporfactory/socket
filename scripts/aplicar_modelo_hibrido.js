/**
 * Modelo híbrido por columna en un tablero de servicios.
 *
 * Por qué: con gpt-4o-mini el bot conversa bien pero falla justo al cerrar.
 * Medido sobre la config 818, misma conversación y mismo prompt:
 *   - mini: al pedirle una hora LIBRE contestaba "ya está lleno" o "la sede
 *     está cerrada", y daba tres vueltas sin llegar nunca al bloque de cita.
 *   - 4o : aceptaba la hora, escribía el bloque y disparaba el tag en UN mensaje.
 * No era el prompt ni el contexto —los huecos libres se le entregan calculados—:
 * era el modelo.
 *
 * Dónde está el volumen y dónde está la plata no es lo mismo. Contacto Inicial
 * recibe todos los mensajes y solo tiene que conversar; las columnas que cierran
 * reciben una fracción y cada conversación vale una venta. Por eso mini arriba y
 * 4o donde se cierra.
 *
 * Uso:
 *   node scripts/aplicar_modelo_hibrido.js <id_configuracion> [--revertir]
 *
 * Escribe en los dos lados: kanban_columnas.modelo y el asistente de OpenAI
 * (que es de donde sale el modelo que corre de verdad en el camino de
 * Assistants). Si solo se cambiara uno, el tablero mostraría una cosa y el bot
 * usaría otra.
 */

require('dotenv').config();
const axios = require('axios');
const { db } = require('../src/database/config');

const ID_CONFIG = Number(process.argv[2]);
const REVERTIR = process.argv.includes('--revertir');

const MODELO_CIERRE = 'gpt-4o';
const MODELO_CHARLA = 'gpt-4o-mini';

// Donde se cierra: se agenda una cita o se cierra una venta.
const COLUMNAS_CIERRE = new Set([
  'califica',
  'venta_producto',
  'cita_agendada',
  'asistio',
  'en_tratamiento',
  'no_asistio',
]);

if (!ID_CONFIG) {
  console.error(
    'Falta el id_configuracion. Ej: node scripts/aplicar_modelo_hibrido.js 818',
  );
  process.exit(1);
}

async function main() {
  const [cfg] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
  );
  if (!cfg?.api_key_openai)
    throw new Error(`La configuración ${ID_CONFIG} no tiene api_key_openai`);

  const headers = {
    Authorization: `Bearer ${cfg.api_key_openai}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };

  const columnas = await db.query(
    `SELECT id, estado_db, nombre, assistant_id, modelo FROM kanban_columnas
      WHERE id_configuracion = ? AND activo = 1 AND activa_ia = 1
      ORDER BY orden`,
    { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
  );

  for (const col of columnas) {
    const objetivo =
      REVERTIR || !COLUMNAS_CIERRE.has(col.estado_db)
        ? MODELO_CHARLA
        : MODELO_CIERRE;

    if (col.modelo === objetivo) {
      console.log(`  ⏭️  ${String(col.estado_db).padEnd(18)} ya está en ${objetivo}`);
    } else {
      await db.query(`UPDATE kanban_columnas SET modelo = ? WHERE id = ?`, {
        replacements: [objetivo, col.id],
        type: db.QueryTypes.UPDATE,
      });
    }

    if (!col.assistant_id) continue;

    try {
      await axios.post(
        `https://api.openai.com/v1/assistants/${col.assistant_id}`,
        { model: objetivo },
        { headers, timeout: 30000 },
      );
      console.log(`  ✅ ${String(col.estado_db).padEnd(18)} → ${objetivo}`);
    } catch (err) {
      console.log(
        `  ❌ ${String(col.estado_db).padEnd(18)} no se pudo cambiar en OpenAI: ` +
          (err.response?.data?.error?.message || err.message),
      );
    }
  }

  console.log('\nVerificación contra OpenAI:');
  for (const col of columnas) {
    if (!col.assistant_id) continue;
    try {
      const { data } = await axios.get(
        `https://api.openai.com/v1/assistants/${col.assistant_id}`,
        { headers, timeout: 20000 },
      );
      const [fila] = await db.query(
        `SELECT modelo FROM kanban_columnas WHERE id = ?`,
        { replacements: [col.id], type: db.QueryTypes.SELECT },
      );
      const coincide = fila.modelo === data.model;
      console.log(
        `  ${coincide ? '✅' : '⚠️ '} ${String(col.estado_db).padEnd(18)} bd=${fila.modelo} · openai=${data.model}`,
      );
    } catch {
      console.log(`  ⚠️  ${col.estado_db}: asistente inaccesible`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('ERROR:', err.response?.data?.error?.message || err.message);
    process.exit(1);
  });
