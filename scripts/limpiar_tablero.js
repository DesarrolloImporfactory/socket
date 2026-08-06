/**
 * Borra el tablero de UNA configuración: columnas, acciones y seguimientos.
 *
 * Existe porque instalar_tablero.js es idempotente y no pisa lo que ya está:
 * correrlo encima de otro tablero deja columnas de los dos mezcladas y los
 * prompts viejos intactos. Para cambiar de rubro hay que limpiar primero.
 *
 * Uso:
 *   node scripts/limpiar_tablero.js <id_configuracion>              (solo muestra)
 *   node scripts/limpiar_tablero.js <id_configuracion> --confirmar  (borra)
 *
 * Sin --confirmar no toca nada. Los contactos que estén en una columna que
 * desaparece se devuelven a 'contacto_inicial': si se quedan con un
 * estado_contacto que ya no existe, no aparecen en ninguna columna del tablero.
 */

require('dotenv').config();
const axios = require('axios');
const { db } = require('../src/database/config');

const ID_CONFIG = Number(process.argv[2]);
const CONFIRMAR = process.argv.includes('--confirmar');

if (!ID_CONFIG) {
  console.error('Uso: node scripts/limpiar_tablero.js <id_configuracion> [--confirmar]');
  process.exit(1);
}

async function main() {
  const [cfg] = await db.query(
    `SELECT id, nombre_configuracion, api_key_openai
       FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
  );
  if (!cfg) throw new Error(`No existe la configuración ${ID_CONFIG}`);

  const columnas = await db.query(
    `SELECT id, nombre, estado_db, activa_ia, assistant_id
       FROM kanban_columnas WHERE id_configuracion = ? ORDER BY orden`,
    { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
  );

  const [{ n: nAcciones }] = await db.query(
    `SELECT COUNT(*) n FROM kanban_acciones WHERE id_configuracion = ?`,
    { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
  );
  const [{ n: nRemarketing }] = await db.query(
    `SELECT COUNT(*) n FROM configuracion_remarketing WHERE id_configuracion = ?`,
    { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
  );

  const porEstado = await db.query(
    `SELECT estado_contacto, COUNT(*) n FROM clientes_chat_center
      WHERE id_configuracion = ? GROUP BY estado_contacto`,
    { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
  );

  console.log(`Configuración ${ID_CONFIG} — ${cfg.nombre_configuracion}\n`);
  console.log(`Se borrarían ${columnas.length} columnas:`);
  for (const c of columnas) {
    const contactos = porEstado.find((p) => p.estado_contacto === c.estado_db)?.n || 0;
    console.log(
      `  ${String(c.estado_db).padEnd(20)} ia=${c.activa_ia} ` +
        `${c.assistant_id ? 'asistente ' + c.assistant_id : 'sin asistente'} · ${contactos} contacto(s)`,
    );
  }
  console.log(`\nY además: ${nAcciones} acciones · ${nRemarketing} seguimientos`);

  const huerfanos = porEstado.filter(
    (p) => p.estado_contacto && p.estado_contacto !== 'contacto_inicial',
  );
  if (huerfanos.length) {
    const total = huerfanos.reduce((s, h) => s + Number(h.n), 0);
    console.log(`${total} contacto(s) volverían a "contacto_inicial"`);
  }

  if (!CONFIRMAR) {
    console.log('\nNada se tocó. Agrega --confirmar para borrar de verdad.');
    return;
  }

  console.log('\n── Borrando ──');

  /* Los asistentes de OpenAI se borran aparte: viven en la cuenta del cliente y
     si solo se borra la fila quedan colgados ahí para siempre. Que falle uno no
     puede frenar la limpieza. */
  if (cfg.api_key_openai) {
    for (const c of columnas.filter((x) => x.assistant_id)) {
      try {
        await axios.delete(`https://api.openai.com/v1/assistants/${c.assistant_id}`, {
          headers: {
            Authorization: `Bearer ${cfg.api_key_openai}`,
            'OpenAI-Beta': 'assistants=v2',
          },
          timeout: 20000,
        });
        console.log(`  🗑️  asistente ${c.assistant_id} (${c.estado_db})`);
      } catch (e) {
        console.log(
          `  ⚠️  asistente ${c.assistant_id}: ${e.response?.data?.error?.message || e.message}`,
        );
      }
    }
  } else {
    console.log('  ⚠️  sin api_key_openai: los asistentes quedan en la cuenta de OpenAI');
  }

  await db.query(`DELETE FROM kanban_acciones WHERE id_configuracion = ?`, {
    replacements: [ID_CONFIG],
    type: db.QueryTypes.DELETE,
  });
  await db.query(`DELETE FROM kanban_columnas WHERE id_configuracion = ?`, {
    replacements: [ID_CONFIG],
    type: db.QueryTypes.DELETE,
  });
  await db.query(`DELETE FROM configuracion_remarketing WHERE id_configuracion = ?`, {
    replacements: [ID_CONFIG],
    type: db.QueryTypes.DELETE,
  });
  await db.query(
    `UPDATE clientes_chat_center SET estado_contacto = 'contacto_inicial'
      WHERE id_configuracion = ?`,
    { replacements: [ID_CONFIG], type: db.QueryTypes.UPDATE },
  );

  console.log(
    `  ✅ ${columnas.length} columnas · ${nAcciones} acciones · ${nRemarketing} seguimientos\n\n` +
      `Listo. Ahora: node scripts/instalar_tablero.js ${ID_CONFIG} <catalogo> "Asistente" "Negocio"`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('ERROR:', err.response?.data?.error?.message || err.message);
    process.exit(1);
  });
