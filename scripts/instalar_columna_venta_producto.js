/**
 * Instala la columna "Venta de producto" en una cuenta que ya tiene el tablero
 * de estética montado.
 *
 * Por qué existe: vender un producto no es agendar una cita. Mezclarlas hacía
 * que el bot creara "citas de recogida" que ocupaban un cupo real de la agenda,
 * y que las ventas de producto quedaran escondidas entre las de tratamiento sin
 * forma de contarlas. Mandarlas a "Asesor" tampoco sirve: esa columna es para lo
 * que el bot NO pudo resolver, y aquí sí resolvió — hay una venta lista.
 *
 * Uso:
 *   node scripts/instalar_columna_venta_producto.js <id_configuracion>
 *
 * Es idempotente: si la columna ya existe, no la duplica.
 * NO reescribe los prompts existentes; solo inserta el tag [venta_producto]:true
 * en las columnas que derivan hacia ella, y solo si todavía no lo tienen.
 */

require('dotenv').config();
const axios = require('axios');
const { db } = require('../src/database/config');
const {
  COLUMNAS_ESTETICA,
} = require('../src/utils/kanban_catalogo_estetica.data');

const ID_CONFIG = Number(process.argv[2]);

if (!ID_CONFIG) {
  console.error('Falta el id_configuracion. Ej: node scripts/instalar_columna_venta_producto.js 818');
  process.exit(1);
}

/* El prompt del catálogo trae marcadores que cada cuenta reemplaza por lo suyo.
   Se resuelven con los mismos valores que ya usan las otras columnas de ESTA
   cuenta, para que el asistente nuevo hable igual que sus hermanos. */
async function compilarPrompt(plantilla, id_configuracion) {
  const [muestra] = await db.query(
    `SELECT instrucciones FROM kanban_columnas
      WHERE id_configuracion = ? AND activa_ia = 1 AND activo = 1
        AND instrucciones LIKE 'Eres %'
      ORDER BY orden LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  let nombreAsistente = 'Sofía';
  let nombreTienda = '';

  const m = String(muestra?.instrucciones || '').match(
    /^Eres ([^,]+), (?:de|del equipo de) ([^,.]+)/,
  );
  if (m) {
    nombreAsistente = m[1].trim();
    nombreTienda = m[2].trim();
  }

  if (!nombreTienda) {
    const [cfg] = await db.query(
      `SELECT nombre_configuracion FROM configuraciones WHERE id = ?`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    nombreTienda = cfg?.nombre_configuracion || 'nuestro centro';
  }

  /* Las reglas extra de la tienda (política de atención, formas de pago) viven
     al final de los prompts existentes. Se copian tal cual: son de la cuenta,
     no de la columna. */
  const reglas = String(muestra?.instrucciones || '').match(
    /===== REGLAS ADICIONALES DE LA TIENDA =====[\s\S]*$/,
  );

  return (
    plantilla
      .replace(/\[NOMBRE_ASISTENTE\]/g, nombreAsistente)
      .replace(/\[NOMBRE_TIENDA\]/g, nombreTienda)
      .replace(/\[BLOQUE_TONO_PERSONALIZADO\]/g, '')
      .replace(/\[BLOQUE_INSTRUCCIONES_EXTRA\]/g, '')
      .trimEnd() + (reglas ? `\n\n${reglas[0]}` : '')
  );
}

async function main() {
  const def = COLUMNAS_ESTETICA.find((c) => c.estado_db === 'venta_producto');
  if (!def) throw new Error('El catálogo no tiene la columna venta_producto');

  const [cfg] = await db.query(
    `SELECT id, api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
  );
  if (!cfg) throw new Error(`No existe la configuración ${ID_CONFIG}`);
  if (!cfg.api_key_openai)
    throw new Error(`La configuración ${ID_CONFIG} no tiene api_key_openai`);

  const headers = {
    Authorization: `Bearer ${cfg.api_key_openai}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };

  const [existente] = await db.query(
    `SELECT id FROM kanban_columnas
      WHERE id_configuracion = ? AND estado_db = 'venta_producto' LIMIT 1`,
    { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
  );

  let idColumna = existente?.id || null;

  if (idColumna) {
    console.log(`ℹ️  La columna ya existe (id=${idColumna}); no se recrea.`);
  } else {
    const instrucciones = await compilarPrompt(def.instrucciones, ID_CONFIG);

    const { data: asistente } = await axios.post(
      'https://api.openai.com/v1/assistants',
      {
        name: `${def.nombre} - ${ID_CONFIG}`,
        instructions: instrucciones,
        model: def.modelo,
        tools: [{ type: 'file_search' }],
      },
      { headers, timeout: 30000 },
    );
    console.log(`✅ Asistente creado: ${asistente.id}`);

    /* Hueco en el orden: la columna va después de "Calificado" y antes de
       "Cita agendada", que es el recorrido que sigue una persona. */
    await db.query(
      `UPDATE kanban_columnas SET orden = orden + 1
        WHERE id_configuracion = ? AND orden >= ?`,
      { replacements: [ID_CONFIG, def.orden], type: db.QueryTypes.UPDATE },
    );

    const [ins] = await db.query(
      `INSERT INTO kanban_columnas
         (id_configuracion, nombre, estado_db, color_fondo, color_texto, icono,
          orden, activo, es_estado_final, es_principal, es_dropi_principal,
          activa_ia, max_tokens, modelo, assistant_id, instrucciones)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 1, ?, ?, ?, ?)`,
      {
        replacements: [
          ID_CONFIG,
          def.nombre,
          def.estado_db,
          def.color_fondo,
          def.color_texto,
          def.icono,
          def.orden,
          def.max_tokens,
          def.modelo,
          asistente.id,
          instrucciones,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
    idColumna = ins;
    console.log(`✅ Columna creada: id=${idColumna}, orden=${def.orden}`);

    for (const a of def.acciones) {
      await db.query(
        `INSERT INTO kanban_acciones
           (id_kanban_columna, id_configuracion, tipo_accion, config, activo, orden)
         VALUES (?, ?, ?, ?, ?, ?)`,
        {
          replacements: [
            idColumna,
            ID_CONFIG,
            a.tipo_accion,
            JSON.stringify(a.config || {}),
            a.activo ?? 1,
            a.orden ?? 0,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
    }
    console.log(`✅ ${def.acciones.length} acciones creadas`);
  }

  /* Quien deriva hacia la columna nueva. Sin esta acción el tag que escriba el
     bot no mueve nada y la ficha se queda donde estaba. */
  for (const origen of ['contacto_inicial', 'califica']) {
    const [col] = await db.query(
      `SELECT id FROM kanban_columnas
        WHERE id_configuracion = ? AND estado_db = ? AND activo = 1 LIMIT 1`,
      { replacements: [ID_CONFIG, origen], type: db.QueryTypes.SELECT },
    );
    if (!col) continue;

    const [ya] = await db.query(
      `SELECT id FROM kanban_acciones
        WHERE id_kanban_columna = ? AND tipo_accion = 'cambiar_estado'
          AND config LIKE '%venta_producto%' LIMIT 1`,
      { replacements: [col.id], type: db.QueryTypes.SELECT },
    );
    if (ya) {
      console.log(`ℹ️  ${origen} ya deriva a venta_producto`);
      continue;
    }

    const [{ n }] = await db.query(
      `SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM kanban_acciones
        WHERE id_kanban_columna = ?`,
      { replacements: [col.id], type: db.QueryTypes.SELECT },
    );

    await db.query(
      `INSERT INTO kanban_acciones
         (id_kanban_columna, id_configuracion, tipo_accion, config, activo, orden)
       VALUES (?, ?, 'cambiar_estado', ?, 1, ?)`,
      {
        replacements: [
          col.id,
          ID_CONFIG,
          JSON.stringify({
            trigger: '[venta_producto]:true',
            estado_destino: 'venta_producto',
          }),
          n,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
    console.log(`✅ ${origen} ahora deriva a venta_producto`);
  }

  console.log('\nTablero resultante:');
  const cols = await db.query(
    `SELECT orden, estado_db, nombre, activa_ia FROM kanban_columnas
      WHERE id_configuracion = ? AND activo = 1 ORDER BY orden`,
    { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
  );
  for (const c of cols)
    console.log(
      `  ${String(c.orden).padStart(2)}  ${String(c.estado_db).padEnd(18)} ia=${c.activa_ia}  «${c.nombre}»`,
    );

  console.log(
    '\n⚠️  Falta sincronizar el catálogo de la columna nueva para que tenga ' +
      'precios y fichas:\n    node scripts/sync_catalogo_columna.js ' +
      idColumna,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('ERROR:', err.response?.data?.error?.message || err.message);
    process.exit(1);
  });
