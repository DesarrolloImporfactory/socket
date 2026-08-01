/**
 * Publica uno de los catálogos del repo como PLANTILLA GLOBAL, para que
 * cualquier cliente pueda duplicar el tablero desde su panel sin que nadie se lo
 * monte a mano.
 *
 * Los seguimientos (remarketing) no viajan dentro del JSON de la plantilla: el
 * instalador global los toma del catálogo compartido (`kanban_catalogo_items`) y
 * la plantilla solo dice CUÁLES aplicar. Por eso este script hace las dos
 * cosas: escribe las columnas en la plantilla y deja sus secuencias como ítems
 * del catálogo, referenciadas desde `setup.remarketing_items`.
 *
 * Uso:
 *   node scripts/publicar_plantilla_global.js <id_plantilla> <clinica|estetica> "Nombre visible"
 */

require('dotenv').config();
const { db } = require('../src/database/config');

const CATALOGOS = {
  clinica: () => {
    const m = require('../src/utils/kanban_catalogo_clinica.data');
    return {
      columnas: m.COLUMNAS_CLINICA,
      remarketing: m.REMARKETING_CLINICA,
      icono: 'bx bx-plus-medical',
      color: '#0ea5e9',
      descripcion:
        'Asistente con IA para clínicas y consultorios: filtra por cobertura, agenda consultas, ' +
        'hace seguimiento de controles y deriva urgencias a una persona. Nunca da orientación clínica.',
    };
  },
  estetica: () => {
    const m = require('../src/utils/kanban_catalogo_estetica.data');
    return {
      columnas: m.COLUMNAS_ESTETICA,
      remarketing: m.REMARKETING_ESTETICA,
      icono: 'bx bx-spa',
      color: '#ec4899',
      descripcion:
        'Asistente con IA para centros estéticos, spas y barberías: filtra por cobertura, agenda citas, ' +
        'vende productos del catálogo y acompaña los tratamientos de varias sesiones.',
    };
  },
};

const ID_PLANTILLA = Number(process.argv[2]);
const CATALOGO = process.argv[3];
const NOMBRE = process.argv[4];

if (!ID_PLANTILLA || !CATALOGOS[CATALOGO] || !NOMBRE) {
  console.error(
    'Uso: node scripts/publicar_plantilla_global.js <id_plantilla> <clinica|estetica> "Nombre visible"',
  );
  process.exit(1);
}

async function main() {
  const cat = CATALOGOS[CATALOGO]();

  const [actual] = await db.query(
    `SELECT id, nombre, version FROM kanban_plantillas_globales WHERE id = ? LIMIT 1`,
    { replacements: [ID_PLANTILLA], type: db.QueryTypes.SELECT },
  );
  if (!actual) throw new Error(`No existe la plantilla global ${ID_PLANTILLA}`);

  console.log(`Plantilla #${ID_PLANTILLA}: "${actual.nombre}" → "${NOMBRE}"\n`);

  /* ── Seguimientos como ítems del catálogo ──────────────────────
     Se identifican con un item_key propio del tablero para no chocar con los de
     otros catálogos ni pisar los de fábrica. */
  const claves = [];

  for (const bloque of cat.remarketing) {
    for (const s of bloque.secuencias) {
      const itemKey = `${CATALOGO}_${bloque.estado_contacto}_${s.secuencia}`;

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

      const [ya] = await db.query(
        `SELECT id FROM kanban_catalogo_items
          WHERE tipo = 'remarketing' AND item_key = ? LIMIT 1`,
        { replacements: [itemKey], type: db.QueryTypes.SELECT },
      );

      let id;
      if (ya) {
        await db.query(
          `UPDATE kanban_catalogo_items SET data = ?, activo = 1 WHERE id = ?`,
          { replacements: [JSON.stringify(data), ya.id], type: db.QueryTypes.UPDATE },
        );
        id = ya.id;
      } else {
        const [nuevo] = await db.query(
          `INSERT INTO kanban_catalogo_items (tipo, item_key, data, activo)
           VALUES ('remarketing', ?, ?, 1)`,
          { replacements: [itemKey, JSON.stringify(data)], type: db.QueryTypes.INSERT },
        );
        id = nuevo;
      }

      // Así es como el instalador global identifica un ítem del catálogo.
      claves.push(`custom_${id}`);
      console.log(
        `  📨 ${itemKey} → custom_${id} (${s.tiempo_espera_minutos} min)`,
      );
    }
  }

  /* ── Columnas ──────────────────────────────────────────────────
     Van tal cual las define el catálogo. Los marcadores
     [NOMBRE_ASISTENTE] / [NOMBRE_TIENDA] se resuelven al aplicar, con lo que
     escriba cada cliente. */
  const data = {
    columnas: cat.columnas.map((c) => ({
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
      // Un consultorio no vende con Dropi ni necesita las plantillas Meta del
      // flujo de envíos: activarlas le ensucia la cuenta con cosas que no usa.
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

  await db.query(
    `UPDATE kanban_plantillas_globales
        SET nombre = ?, descripcion = ?, icono = ?, color = ?,
            data = ?, version = version + 1, activo = 1
      WHERE id = ?`,
    {
      replacements: [
        NOMBRE,
        cat.descripcion,
        cat.icono,
        cat.color,
        JSON.stringify(data),
        ID_PLANTILLA,
      ],
      type: db.QueryTypes.UPDATE,
    },
  );

  const [fin] = await db.query(
    `SELECT nombre, version, CHAR_LENGTH(data) AS len, activo
       FROM kanban_plantillas_globales WHERE id = ?`,
    { replacements: [ID_PLANTILLA], type: db.QueryTypes.SELECT },
  );

  console.log(
    `\n✅ "${fin.nombre}" · versión ${fin.version} · ${data.columnas.length} columnas · ` +
      `${claves.length} seguimientos · ${fin.len} caracteres de JSON`,
  );
  console.log('\nColumnas publicadas:');
  for (const c of data.columnas) {
    console.log(
      `  ${String(c.orden).padStart(2)}  ${String(c.estado_db).padEnd(18)} ia=${c.activa_ia} ${String(c.modelo).padEnd(12)} «${c.nombre}»`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('ERROR:', err.message);
    process.exit(1);
  });
