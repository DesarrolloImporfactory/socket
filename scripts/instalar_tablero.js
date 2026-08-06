/**
 * Instala un tablero completo (columnas + asistentes + acciones + seguimientos)
 * en una configuración, desde uno de los catálogos del repo.
 *
 * Existe para no montar cada cuenta a mano: el tablero de estética se armó paso
 * a paso y esa forma no escala a los ~100 clientes que vienen. Acá el catálogo
 * es la fuente y la cuenta se genera desde él.
 *
 * Uso:
 *   node scripts/instalar_tablero.js <id_configuracion> <catalogo> ["Nombre asistente"] ["Nombre negocio"]
 *
 *   catalogo: clinica | estetica | inmobiliaria
 *
 * Es idempotente: si la columna ya existe, no la duplica ni le pisa el prompt
 * (los clientes editan sus prompts a mano y perder eso sería peor que no
 * instalar). Con --forzar-prompt sí los reescribe.
 */

require('dotenv').config();
const axios = require('axios');
const { db } = require('../src/database/config');

const CATALOGOS = {
  clinica: () => {
    const m = require('../src/utils/kanban_catalogo_clinica.data');
    return { columnas: m.COLUMNAS_CLINICA, remarketing: m.REMARKETING_CLINICA };
  },
  estetica: () => {
    const m = require('../src/utils/kanban_catalogo_estetica.data');
    return { columnas: m.COLUMNAS_ESTETICA, remarketing: m.REMARKETING_ESTETICA };
  },
  inmobiliaria: () => {
    const m = require('../src/utils/kanban_catalogo_inmobiliaria.data');
    return {
      columnas: m.COLUMNAS_INMOBILIARIA,
      remarketing: m.REMARKETING_INMOBILIARIA,
    };
  },
};

const ID_CONFIG = Number(process.argv[2]);
const CATALOGO = process.argv[3];
const NOMBRE_ASISTENTE = process.argv[4] || 'Sofía';
const NOMBRE_NEGOCIO = process.argv[5] || null;
const FORZAR_PROMPT = process.argv.includes('--forzar-prompt');

if (!ID_CONFIG || !CATALOGOS[CATALOGO]) {
  console.error(
    'Uso: node scripts/instalar_tablero.js <id_configuracion> <clinica|estetica|inmobiliaria> ["Asistente"] ["Negocio"]',
  );
  process.exit(1);
}

const compilar = (plantilla, negocio) =>
  plantilla
    .replace(/\[NOMBRE_ASISTENTE\]/g, NOMBRE_ASISTENTE)
    .replace(/\[NOMBRE_TIENDA\]/g, negocio)
    .replace(/\[BLOQUE_TONO_PERSONALIZADO\]/g, '')
    .replace(/\[BLOQUE_INSTRUCCIONES_EXTRA\]/g, '')
    .trimEnd();

async function main() {
  const { columnas, remarketing } = CATALOGOS[CATALOGO]();

  const [cfg] = await db.query(
    `SELECT id, nombre_configuracion, api_key_openai
       FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
  );
  if (!cfg) throw new Error(`No existe la configuración ${ID_CONFIG}`);
  if (!cfg.api_key_openai)
    throw new Error(`La configuración ${ID_CONFIG} no tiene api_key_openai`);

  const negocio = NOMBRE_NEGOCIO || cfg.nombre_configuracion || 'nuestra clínica';

  const headers = {
    Authorization: `Bearer ${cfg.api_key_openai}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };

  console.log(
    `Instalando tablero "${CATALOGO}" en la config ${ID_CONFIG} (${negocio})\n` +
      `Asistente: ${NOMBRE_ASISTENTE}\n`,
  );

  for (const def of columnas) {
    const [existente] = await db.query(
      `SELECT id, assistant_id FROM kanban_columnas
        WHERE id_configuracion = ? AND estado_db = ? LIMIT 1`,
      { replacements: [ID_CONFIG, def.estado_db], type: db.QueryTypes.SELECT },
    );

    const instrucciones = def.instrucciones
      ? compilar(def.instrucciones, negocio)
      : '';

    let idColumna = existente?.id || null;
    let assistantId = existente?.assistant_id || null;

    if (existente) {
      if (FORZAR_PROMPT && instrucciones) {
        await db.query(
          `UPDATE kanban_columnas SET instrucciones = ? WHERE id = ?`,
          { replacements: [instrucciones, existente.id], type: db.QueryTypes.UPDATE },
        );
        if (assistantId) {
          await axios.post(
            `https://api.openai.com/v1/assistants/${assistantId}`,
            { instructions: instrucciones },
            { headers, timeout: 30000 },
          );
        }
        console.log(`  ♻️  ${def.estado_db}: prompt reescrito`);
      } else {
        console.log(`  ⏭️  ${def.estado_db}: ya existe, no se toca`);
      }
      continue;
    }

    /* Las columnas sin IA (Urgencia, Perdidos, Asesor) no necesitan asistente:
       ahí lo que hace falta es que lo vea una persona. */
    if (def.activa_ia && instrucciones) {
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
      assistantId = asistente.id;
    }

    const [insertId] = await db.query(
      `INSERT INTO kanban_columnas
         (id_configuracion, nombre, estado_db, color_fondo, color_texto, icono,
          orden, activo, es_estado_final, es_principal, es_dropi_principal,
          activa_ia, max_tokens, modelo, assistant_id, instrucciones)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          ID_CONFIG,
          def.nombre,
          def.estado_db,
          def.color_fondo,
          def.color_texto,
          def.icono,
          def.orden,
          def.activo,
          def.es_estado_final,
          def.es_principal,
          def.activa_ia,
          def.max_tokens,
          def.modelo,
          assistantId,
          instrucciones,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
    idColumna = insertId;

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

    console.log(
      `  ✅ ${def.estado_db}: columna ${idColumna}` +
        `${assistantId ? ` · asistente ${assistantId}` : ' · sin IA'}` +
        ` · ${def.acciones.length} acciones`,
    );
  }

  // ── Seguimientos ────────────────────────────────────────────────
  for (const bloque of remarketing) {
    for (const s of bloque.secuencias) {
      const [ya] = await db.query(
        `SELECT id FROM configuracion_remarketing
          WHERE id_configuracion = ? AND estado_contacto = ? AND secuencia = ?
          LIMIT 1`,
        {
          replacements: [ID_CONFIG, bloque.estado_contacto, s.secuencia],
          type: db.QueryTypes.SELECT,
        },
      );
      if (ya) continue;

      /* `tiempo_espera_horas` es la columna vieja y sigue siendo NOT NULL: el
         motor usa los minutos, pero sin las horas el INSERT no pasa. Se guarda
         el equivalente redondeado hacia arriba para que las dos cuenten lo
         mismo si algo llegara a leer la vieja. */
      await db.query(
        `INSERT INTO configuracion_remarketing
           (id_configuracion, estado_contacto, secuencia, tiempo_espera_horas,
            tiempo_espera_minutos, nombre_template, language_code,
            estado_destino, header_format, metodo_dentro_24h, prompt_ia, activo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        {
          replacements: [
            ID_CONFIG,
            bloque.estado_contacto,
            s.secuencia,
            Math.max(1, Math.ceil(s.tiempo_espera_minutos / 60)),
            s.tiempo_espera_minutos,
            s.nombre_template || '',
            s.language_code || 'es',
            s.estado_destino,
            s.header_format,
            s.metodo_dentro_24h,
            s.prompt_ia,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
    }
    console.log(
      `  📨 seguimiento de "${bloque.estado_contacto}": ${bloque.secuencias.length} secuencia(s)`,
    );
  }

  console.log('\nTablero resultante:');
  const finales = await db.query(
    `SELECT orden, estado_db, nombre, activa_ia, modelo FROM kanban_columnas
      WHERE id_configuracion = ? AND activo = 1 ORDER BY orden`,
    { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
  );
  for (const c of finales) {
    console.log(
      `  ${String(c.orden).padStart(2)}  ${String(c.estado_db).padEnd(18)} ia=${c.activa_ia} ${String(c.modelo || '').padEnd(12)} «${c.nombre}»`,
    );
  }

  console.log(
    '\nFalta para que el bot pueda trabajar:\n' +
      '  1. Cargar los servicios en Productos (con su duración y su plan de sesiones)\n' +
      '  2. Cargar las sedes con su horario en Sedes\n' +
      '  3. Sincronizar el catálogo de cada columna:\n' +
      `     node scripts/sync_catalogo_columna.js <id_columna>\n` +
      '  4. Encender el bot desde la pantalla de Asistentes',
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('ERROR:', err.response?.data?.error?.message || err.message);
    process.exit(1);
  });
