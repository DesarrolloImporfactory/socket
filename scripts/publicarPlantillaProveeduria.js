/**
 * Publica el "Agente de Proveeduría" como plantillas globales: UNA por país
 * (EC, MX, CO, PE, GT) unidas por `grupo`, que es como el modal del front las
 * muestra en una sola tarjeta con selector de país (igual que e-commerce).
 *
 * Igual que publicar_plantilla_global.js: los seguimientos (remarketing) y
 * las respuestas rápidas propias van al catálogo compartido
 * (`kanban_catalogo_items`) y la plantilla solo dice cuáles aplicar en su
 * `setup`. Plantillas Meta y config Dropi quedan apagadas: un proveedor no
 * hace el seguimiento de guías de cada pedido, eso lo hace el dropshipper.
 * `setup.es_proveedor: true` hace que aplicarGlobal marque
 * configuraciones.es_proveedor = 1 (catálogo con ID Dropi y stock).
 *
 * Por defecto se publica con la etiqueta interna en el nombre, que solo ven
 * las configs internas (CONFIGS_INTERNAS de kanban_plantillas.controller):
 * así se prueba en la 10 o la 277 antes de que lo vea todo el mundo.
 *
 *   node scripts/publicarPlantillaProveeduria.js            → muestra qué haría
 *   node scripts/publicarPlantillaProveeduria.js --aplicar  → publica (interna)
 *   node scripts/publicarPlantillaProveeduria.js --aplicar --publico → nombre público
 *
 * Idempotente: si la plantilla del país ya existe (mismo grupo + país) la
 * actualiza y sube la versión +0.1; si no, la crea en v1.0.
 */
require('dotenv').config();
const { db } = require('../src/database/config');
const cat = require('../src/utils/kanban_catalogo_proveeduria.data');

const APLICAR = process.argv.includes('--aplicar');
const PUBLICO = process.argv.includes('--publico');
const GRUPO = 'Agente de Proveeduría';
const TAG_INTERNA = 'PRUEBAS DANIEL'; // = PLANTILLA_INTERNA_TAG del controller
const NOMBRE = PUBLICO ? GRUPO : `🧪 ${GRUPO} (${TAG_INTERNA})`;

async function upsertItem(tipo, itemKey, data) {
  const [ya] = await db.query(
    `SELECT id FROM kanban_catalogo_items WHERE tipo = ? AND item_key = ? LIMIT 1`,
    { replacements: [tipo, itemKey], type: db.QueryTypes.SELECT },
  );
  if (!APLICAR) return ya ? ya.id : `(nuevo:${itemKey})`;
  if (ya) {
    await db.query(
      `UPDATE kanban_catalogo_items SET data = ?, activo = 1 WHERE id = ?`,
      {
        replacements: [JSON.stringify(data), ya.id],
        type: db.QueryTypes.UPDATE,
      },
    );
    return ya.id;
  }
  const [id] = await db.query(
    `INSERT INTO kanban_catalogo_items (tipo, item_key, data, activo) VALUES (?, ?, ?, 1)`,
    {
      replacements: [tipo, itemKey, JSON.stringify(data)],
      type: db.QueryTypes.INSERT,
    },
  );
  return id;
}

async function main() {
  /* 1. Seguimientos → catálogo compartido, referenciados por custom_<id> */
  const clavesRemarketing = [];
  for (const bloque of cat.REMARKETING_PROVEEDURIA) {
    for (const s of bloque.secuencias) {
      const itemKey = `proveeduria_${bloque.estado_contacto}_${s.secuencia}`;
      const data = {
        estado_contacto: bloque.estado_contacto,
        secuencia: s.secuencia,
        tiempo_espera_minutos: s.tiempo_espera_minutos,
        tiempo_espera_horas: Math.max(
          1,
          Math.ceil(s.tiempo_espera_minutos / 60),
        ),
        nombre_template: s.nombre_template || '',
        language_code: s.language_code || 'es',
        estado_destino: s.estado_destino,
        header_format: s.header_format || null,
        metodo_dentro_24h: s.metodo_dentro_24h,
        prompt_ia: s.prompt_ia,
        activo: 1,
      };
      const id = await upsertItem('remarketing', itemKey, data);
      clavesRemarketing.push(`custom_${id}`);
      console.log(
        `  📨 ${itemKey} → custom_${id} (${s.tiempo_espera_minutos} min → ${s.estado_destino})`,
      );
    }
  }

  /* 2. Respuestas rápidas propias → catálogo compartido, referenciadas por atajo */
  const clavesRapidas = [];
  for (const rr of cat.RESPUESTAS_RAPIDAS_PROVEEDURIA) {
    const data = { atajo: rr.atajo, mensaje: rr.mensaje, tipo_mensaje: 'text' };
    const id = await upsertItem('respuestas_rapidas', rr.atajo, data);
    clavesRapidas.push(rr.atajo);
    console.log(`  💬 ${rr.atajo} → item ${id}`);
  }

  /* 3. Una plantilla por país */
  for (const pais of cat.PAISES_PROVEEDURIA) {
    const columnas = cat.COLUMNAS_PROVEEDURIA(pais).map((c) => ({
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
    }));
    const data = {
      columnas,
      setup: {
        templates_meta: false,
        dropi_config: false,
        respuestas_rapidas: true,
        remarketing: true,
        templates_meta_items: [],
        respuestas_rapidas_items: clavesRapidas,
        remarketing_items: clavesRemarketing,
        dropi_config_items: [],
        es_proveedor: true,
      },
    };
    const json = JSON.stringify(data);
    const [ya] = await db.query(
      `SELECT id, nombre, version FROM kanban_plantillas_globales WHERE grupo = ? AND pais = ? LIMIT 1`,
      { replacements: [GRUPO, pais], type: db.QueryTypes.SELECT },
    );
    const ia = columnas.filter((c) => c.activa_ia).length;
    const chars = columnas.reduce(
      (a, c) => a + String(c.instrucciones || '').length,
      0,
    );
    if (!APLICAR) {
      console.log(
        `  ${pais}: ${ya ? `actualizaría #${ya.id} v${ya.version} → v${Math.round((Number(ya.version) + 0.1) * 10) / 10}` : 'crearía v1.0'} · ${columnas.length} columnas (${ia} con IA, ${chars} chars de prompt) · ${json.length} bytes`,
      );
      continue;
    }
    if (ya) {
      await db.query(
        `UPDATE kanban_plantillas_globales
            SET nombre = ?, descripcion = ?, icono = ?, color = ?, paises = ?, data = ?,
                version = ROUND(version + 0.1, 1), activo = 1
          WHERE id = ?`,
        {
          replacements: [
            NOMBRE,
            cat.DESCRIPCION_PROVEEDURIA,
            cat.ICONO_PROVEEDURIA,
            cat.COLOR_PROVEEDURIA,
            pais,
            json,
            ya.id,
          ],
          type: db.QueryTypes.UPDATE,
        },
      );
      console.log(
        `  ✔ ${pais}: plantilla #${ya.id} actualizada (v${Math.round((Number(ya.version) + 0.1) * 10) / 10})`,
      );
    } else {
      const [id] = await db.query(
        `INSERT INTO kanban_plantillas_globales
           (nombre, descripcion, icono, color, pais, paises, grupo, version, data, activo)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, ?, 1)`,
        {
          replacements: [
            NOMBRE,
            cat.DESCRIPCION_PROVEEDURIA,
            cat.ICONO_PROVEEDURIA,
            cat.COLOR_PROVEEDURIA,
            pais,
            pais,
            GRUPO,
            json,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
      console.log(`  ✔ ${pais}: plantilla #${id} creada (v1.0)`);
    }
  }
  console.log(
    APLICAR
      ? `\n✅ "${NOMBRE}" publicada en ${cat.PAISES_PROVEEDURIA.length} países${PUBLICO ? '' : ' (solo visible para configs internas hasta correr con --publico)'}`
      : '\n(sin --aplicar: no se escribió nada)',
  );
}

main()
  .then(() => db.close())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('ERROR', e.message);
    process.exit(1);
  });
