/**
 * Publica el "Agente de Agencias de Marketing" (utils/kanban_catalogo_agencia)
 * como plantilla global. Igual que publicarPlantillaProveeduria: los
 * seguimientos van al catálogo compartido y la plantilla los referencia.
 *
 * Por defecto lleva la etiqueta interna en el nombre: solo la ven las configs
 * internas (10 y 277) hasta correrlo con --publico.
 *
 *   node scripts/publicarPlantillaAgencia.js            → muestra qué haría
 *   node scripts/publicarPlantillaAgencia.js --aplicar  → publica (interna)
 *   node scripts/publicarPlantillaAgencia.js --aplicar --publico
 *
 * Idempotente: si ya existe una plantilla con el mismo grupo la actualiza y
 * sube la versión +0.1.
 */
require('dotenv').config();
const { db } = require('../src/database/config');
const cat = require('../src/utils/kanban_catalogo_agencia.data');

const APLICAR = process.argv.includes('--aplicar');
const PUBLICO = process.argv.includes('--publico');
const GRUPO = cat.NOMBRE_AGENCIA;
const TAG_INTERNA = 'PRUEBAS DANIEL'; // = PLANTILLA_INTERNA_TAG del controller
const NOMBRE = PUBLICO ? GRUPO : `🧪 ${GRUPO} (${TAG_INTERNA})`;
const PAIS = 'EC';

async function upsertRemarketing(itemKey, data) {
  const [ya] = await db.query(
    `SELECT id FROM kanban_catalogo_items WHERE tipo = 'remarketing' AND item_key = ? LIMIT 1`,
    { replacements: [itemKey], type: db.QueryTypes.SELECT },
  );
  if (!APLICAR) return ya ? ya.id : `(nuevo:${itemKey})`;
  if (ya) {
    await db.query(`UPDATE kanban_catalogo_items SET data = ?, activo = 1 WHERE id = ?`, {
      replacements: [JSON.stringify(data), ya.id],
      type: db.QueryTypes.UPDATE,
    });
    return ya.id;
  }
  const [id] = await db.query(
    `INSERT INTO kanban_catalogo_items (tipo, item_key, data, activo) VALUES ('remarketing', ?, ?, 1)`,
    { replacements: [itemKey, JSON.stringify(data)], type: db.QueryTypes.INSERT },
  );
  return id;
}

async function main() {
  const claves = [];
  for (const bloque of cat.REMARKETING_AGENCIA) {
    for (const s of bloque.secuencias) {
      const itemKey = `agencia_${bloque.estado_contacto}_${s.secuencia}`;
      const id = await upsertRemarketing(itemKey, {
        estado_contacto: bloque.estado_contacto,
        secuencia: s.secuencia,
        tiempo_espera_minutos: s.tiempo_espera_minutos,
        tiempo_espera_horas: Math.max(1, Math.ceil(s.tiempo_espera_minutos / 60)),
        nombre_template: s.nombre_template || '',
        language_code: s.language_code || 'es',
        estado_destino: s.estado_destino,
        header_format: s.header_format || null,
        metodo_dentro_24h: s.metodo_dentro_24h,
        prompt_ia: s.prompt_ia,
        activo: 1,
      });
      claves.push(`custom_${id}`);
      console.log(`  📨 ${itemKey} → custom_${id} (${s.tiempo_espera_minutos} min → ${s.estado_destino})`);
    }
  }

  const data = {
    columnas: cat.COLUMNAS_AGENCIA.map((c) => ({
      nombre: c.nombre,
      estado_db: c.estado_db,
      color_fondo: c.color_fondo,
      color_texto: c.color_texto,
      icono: c.icono,
      orden: c.orden,
      activo: c.activo,
      es_estado_final: c.es_estado_final,
      es_principal: c.es_principal,
      es_dropi_principal: c.es_dropi_principal,
      activa_ia: c.activa_ia,
      max_tokens: c.max_tokens,
      modelo: c.modelo,
      instrucciones: c.instrucciones || null,
      acciones: c.acciones || [],
    })),
    setup: {
      templates_meta: false,
      dropi_config: false,
      respuestas_rapidas: false,
      remarketing: true,
      templates_meta_items: [],
      respuestas_rapidas_items: [],
      remarketing_items: claves,
      dropi_config_items: [],
    },
  };
  const json = JSON.stringify(data);
  const [ya] = await db.query(
    `SELECT id, version FROM kanban_plantillas_globales WHERE grupo = ? AND pais = ? LIMIT 1`,
    { replacements: [GRUPO, PAIS], type: db.QueryTypes.SELECT },
  );
  const ia = data.columnas.filter((c) => c.activa_ia).length;
  console.log(
    `  ${data.columnas.length} columnas (${ia} con IA) · ${json.length} bytes · ` +
      (ya ? `actualiza #${ya.id} v${ya.version}` : 'crea v1.0'),
  );
  if (!APLICAR) {
    console.log('\n(sin --aplicar: no se escribió nada)');
    return;
  }
  if (ya) {
    await db.query(
      `UPDATE kanban_plantillas_globales
          SET nombre = ?, descripcion = ?, icono = ?, color = ?, paises = ?, data = ?,
              version = ROUND(version + 0.1, 1), activo = 1
        WHERE id = ?`,
      {
        replacements: [NOMBRE, cat.DESCRIPCION_AGENCIA, cat.ICONO_AGENCIA, cat.COLOR_AGENCIA, PAIS, json, ya.id],
        type: db.QueryTypes.UPDATE,
      },
    );
    console.log(`✔ plantilla #${ya.id} actualizada`);
  } else {
    const [id] = await db.query(
      `INSERT INTO kanban_plantillas_globales
         (nombre, descripcion, icono, color, pais, paises, grupo, version, data, activo)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, ?, 1)`,
      {
        replacements: [NOMBRE, cat.DESCRIPCION_AGENCIA, cat.ICONO_AGENCIA, cat.COLOR_AGENCIA, PAIS, PAIS, GRUPO, json],
        type: db.QueryTypes.INSERT,
      },
    );
    console.log(`✔ plantilla #${id} creada (v1.0)`);
  }
  console.log(PUBLICO ? '✅ Visible para todos' : '✅ Solo visible para configs internas (10, 277)');
}

main()
  .then(() => db.close())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('ERROR', e.message);
    process.exit(1);
  });
