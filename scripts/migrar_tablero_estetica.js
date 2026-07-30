'use strict';

/**
 * Copia un montaje de estética completo de una configuración a otra.
 *
 *   node scripts/migrar_tablero_estetica.js --de 840 --a 818
 *   node scripts/migrar_tablero_estetica.js --de 840 --a 818 --aplicar
 *
 * Simula por defecto. Copia, en este orden:
 *   1. api_key_openai (sin ella no se pueden crear los asistentes en la destino)
 *   2. personalización (nombre del centro, asistente, política de atención)
 *   3. sedes + sus profesionales + enlace de Maps
 *   4. catálogo de servicios y productos
 *
 * NO copia las columnas ni los asistentes: para eso está
 * instalar_tablero_estetica.js, que los crea en OpenAI con la api_key de la
 * cuenta destino. El orden correcto es correr este script y después el
 * instalador.
 *
 * Es idempotente: lo que ya existe en la destino se respeta y se informa.
 */

require('dotenv').config();
const { db } = require('../src/database/config');

const OK = '✅';
const NO = '❌';
const WARN = '⚠️ ';
const SIN_CAMBIO = '·';

const arg = (n, def = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const flag = (n) => process.argv.includes(`--${n}`);

async function copiarApiKey(origen, destino, aplicar) {
  const [o] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = ?`,
    { replacements: [origen], type: db.QueryTypes.SELECT },
  );
  const [d] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = ?`,
    { replacements: [destino], type: db.QueryTypes.SELECT },
  );

  if (!o?.api_key_openai) {
    console.log(`${NO} la configuración ${origen} no tiene api_key de OpenAI`);
    return false;
  }
  if (d?.api_key_openai) {
    console.log(`${SIN_CAMBIO} api_key: la ${destino} ya tiene la suya, no se toca`);
    return true;
  }

  console.log(`+ api_key de OpenAI: se copia de la ${origen}`);
  if (aplicar) {
    await db.query(`UPDATE configuraciones SET api_key_openai = ? WHERE id = ?`, {
      replacements: [o.api_key_openai, destino],
      type: db.QueryTypes.UPDATE,
    });
  }
  return true;
}

/* La personalización se guarda por columna (id_kanban_columna es obligatorio),
   pero los datos del negocio son los mismos en todas. Por eso se copia sobre las
   columnas que ya existan en la destino — y si todavía no hay ninguna, se avisa:
   hay que instalar el tablero primero y volver a pasar por aquí. */
async function copiarPersonalizacion(origen, destino, aplicar) {
  const [o] = await db.query(
    `SELECT nombre_tienda, nombre_asistente_publico, instrucciones_extra,
            info_envio, productos_destacados, tono_personalizado
       FROM kanban_columnas_personalizaciones
      WHERE id_configuracion = ? AND nombre_tienda IS NOT NULL LIMIT 1`,
    { replacements: [origen], type: db.QueryTypes.SELECT },
  );
  if (!o) {
    console.log(`${WARN}la ${origen} no tiene personalización guardada`);
    return;
  }

  const columnas = await db.query(
    `SELECT id FROM kanban_columnas WHERE id_configuracion = ?`,
    { replacements: [destino], type: db.QueryTypes.SELECT },
  );

  if (!columnas.length) {
    console.log(
      `${WARN}personalización: la ${destino} todavía no tiene columnas. ` +
        `Instala el tablero y vuelve a correr este script.`,
    );
    return { pendiente: true, perso: o };
  }

  console.log(
    `+ personalización en ${columnas.length} columna(s): "${o.nombre_tienda}" · ` +
      `asistente "${o.nombre_asistente_publico}"` +
      (o.instrucciones_extra
        ? ` · ${o.instrucciones_extra.length} chars de política`
        : ''),
  );
  if (!aplicar) return {};

  for (const col of columnas) {
    const [ya] = await db.query(
      `SELECT id FROM kanban_columnas_personalizaciones
        WHERE id_kanban_columna = ? LIMIT 1`,
      { replacements: [col.id], type: db.QueryTypes.SELECT },
    );

    const campos = [
      o.nombre_tienda,
      o.nombre_asistente_publico,
      o.instrucciones_extra,
      o.info_envio,
      o.productos_destacados,
      o.tono_personalizado,
    ];

    if (ya) {
      await db.query(
        `UPDATE kanban_columnas_personalizaciones
            SET nombre_tienda = ?, nombre_asistente_publico = ?,
                instrucciones_extra = ?, info_envio = ?,
                productos_destacados = ?, tono_personalizado = ?
          WHERE id_kanban_columna = ?`,
        { replacements: [...campos, col.id], type: db.QueryTypes.UPDATE },
      );
    } else {
      await db.query(
        `INSERT INTO kanban_columnas_personalizaciones
           (id_kanban_columna, id_configuracion, nombre_tienda,
            nombre_asistente_publico, instrucciones_extra, info_envio,
            productos_destacados, tono_personalizado)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        {
          replacements: [col.id, destino, ...campos],
          type: db.QueryTypes.INSERT,
        },
      );
    }
  }
  return {};
}

async function copiarSedes(origen, destino, aplicar) {
  const sedes = await db.query(
    `SELECT * FROM establecimientos_chat_center
      WHERE id_configuracion = ? AND eliminado = 0 ORDER BY orden ASC, id ASC`,
    { replacements: [origen], type: db.QueryTypes.SELECT },
  );
  if (!sedes.length) {
    console.log(`${SIN_CAMBIO} sedes: la ${origen} no tiene ninguna`);
    return;
  }

  for (const s of sedes) {
    const [ya] = await db.query(
      `SELECT id FROM establecimientos_chat_center
        WHERE id_configuracion = ? AND LOWER(nombre) = LOWER(?) AND eliminado = 0
        LIMIT 1`,
      { replacements: [destino, s.nombre], type: db.QueryTypes.SELECT },
    );

    let idNueva = ya?.id || null;

    if (ya) {
      console.log(`${SIN_CAMBIO} sede "${s.nombre}": ya existe en la ${destino}`);
    } else {
      console.log(`+ sede "${s.nombre}" (${s.ciudad})`);
      if (aplicar) {
        const [id] = await db.query(
          `INSERT INTO establecimientos_chat_center
             (id_configuracion, nombre, ciudad, provincia, direccion, referencia,
              google_maps_url, telefono, horario, orden, activo, eliminado)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          {
            replacements: [
              destino,
              s.nombre,
              s.ciudad,
              s.provincia,
              s.direccion,
              s.referencia,
              s.google_maps_url,
              s.telefono,
              s.horario,
              s.orden,
              s.activo,
            ],
            type: db.QueryTypes.INSERT,
          },
        );
        idNueva = id;
      }
    }

    // Quienes atienden en esa sede
    const profs = await db.query(
      `SELECT nombre, orden, activo FROM profesionales_chat_center
        WHERE id_establecimiento = ? AND eliminado = 0 ORDER BY orden ASC, id ASC`,
      { replacements: [s.id], type: db.QueryTypes.SELECT },
    );
    for (const p of profs) {
      if (!idNueva) {
        console.log(`  + profesional "${p.nombre}"`);
        continue;
      }
      const [yaP] = await db.query(
        `SELECT id FROM profesionales_chat_center
          WHERE id_establecimiento = ? AND LOWER(nombre) = LOWER(?) AND eliminado = 0
          LIMIT 1`,
        { replacements: [idNueva, p.nombre], type: db.QueryTypes.SELECT },
      );
      if (yaP) {
        console.log(`  ${SIN_CAMBIO} profesional "${p.nombre}": ya existe`);
        continue;
      }
      console.log(`  + profesional "${p.nombre}"`);
      if (aplicar) {
        await db.query(
          `INSERT INTO profesionales_chat_center
             (id_configuracion, id_establecimiento, nombre, orden, activo, eliminado)
           VALUES (?, ?, ?, ?, ?, 0)`,
          {
            replacements: [destino, idNueva, p.nombre, p.orden, p.activo],
            type: db.QueryTypes.INSERT,
          },
        );
      }
    }
  }
}

async function copiarCatalogo(origen, destino, aplicar) {
  const prods = await db.query(
    `SELECT * FROM productos_chat_center
      WHERE id_configuracion = ? AND (eliminado = 0 OR eliminado IS NULL)
      ORDER BY id ASC`,
    { replacements: [origen], type: db.QueryTypes.SELECT },
  );
  if (!prods.length) {
    console.log(`${SIN_CAMBIO} catálogo: la ${origen} no tiene ítems`);
    return;
  }

  let nuevos = 0;
  let existentes = 0;

  for (const p of prods) {
    const [ya] = await db.query(
      `SELECT id FROM productos_chat_center
        WHERE id_configuracion = ? AND LOWER(nombre) = LOWER(?)
          AND (eliminado = 0 OR eliminado IS NULL) LIMIT 1`,
      { replacements: [destino, p.nombre], type: db.QueryTypes.SELECT },
    );
    if (ya) {
      existentes += 1;
      continue;
    }
    nuevos += 1;
    if (aplicar) {
      await db.query(
        `INSERT INTO productos_chat_center
           (id_configuracion, nombre, descripcion, material, tipo, es_variable,
            precio, precio_proveedor, duracion, imagen_url, video_url,
            landing_url, stock, es_privado, eliminado, fecha_creacion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NOW())`,
        {
          replacements: [
            destino,
            p.nombre,
            p.descripcion,
            p.material,
            p.tipo,
            p.es_variable || 0,
            p.precio,
            p.precio_proveedor,
            p.duracion || 0,
            p.imagen_url,
            p.video_url,
            p.landing_url,
            p.stock || 0,
            p.es_privado || 0,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
    }
  }

  console.log(
    `+ catálogo: ${nuevos} ítem(s) nuevo(s)` +
      (existentes ? ` · ${existentes} ya estaban` : ''),
  );
}

(async () => {
  const origen = Number(arg('de'));
  const destino = Number(arg('a'));
  const aplicar = flag('aplicar');

  if (!origen || !destino) {
    console.log(
      'Uso: node scripts/migrar_tablero_estetica.js --de <id> --a <id> [--aplicar]',
    );
    process.exit(1);
  }

  const cfgs = await db.query(
    `SELECT id, nombre_configuracion, telefono, suspendido,
            (token IS NOT NULL AND token <> '') AS tiene_token
       FROM configuraciones WHERE id IN (?, ?)`,
    { replacements: [origen, destino], type: db.QueryTypes.SELECT },
  );
  const o = cfgs.find((c) => Number(c.id) === origen);
  const d = cfgs.find((c) => Number(c.id) === destino);
  if (!o || !d) {
    console.log(`${NO} no existe alguna de las dos configuraciones`);
    process.exit(1);
  }

  console.log(`\n${'═'.repeat(66)}`);
  console.log(`DE  ${o.id} — ${o.nombre_configuracion}`);
  console.log(
    `A   ${d.id} — ${d.nombre_configuracion} · tel ${d.telefono}` +
      (Number(d.tiene_token) ? ' · WhatsApp conectado' : ' · SIN WhatsApp'),
  );
  console.log('═'.repeat(66));

  if (d.suspendido) console.log(`${WARN}la conexión destino está SUSPENDIDA`);

  const hayKey = await copiarApiKey(origen, destino, aplicar);
  const perso = (await copiarPersonalizacion(origen, destino, aplicar)) || {};
  await copiarSedes(origen, destino, aplicar);
  await copiarCatalogo(origen, destino, aplicar);

  console.log(`\n${'─'.repeat(66)}`);
  if (!aplicar) {
    console.log(`${WARN}SIMULACIÓN — nada se escribió. Agrega --aplicar.`);
  } else if (perso.pendiente) {
    /* La personalización cuelga de las columnas, así que el orden es: copiar
       datos → instalar tablero (pasándole el nombre para que los prompts no
       salgan con el nombre de la conexión) → volver aquí a copiar la política
       → recompilar los prompts con ella dentro. */
    const p = perso.perso;
    console.log(`${OK} datos copiados. Falta el tablero, en este orden:`);
    console.log(
      `   1. node scripts/instalar_tablero_estetica.js ${destino} --tienda "${p.nombre_tienda}" --asistente "${p.nombre_asistente_publico}" --aplicar`,
    );
    console.log(
      `   2. node scripts/migrar_tablero_estetica.js --de ${origen} --a ${destino} --aplicar   (ya con columnas, copia la política)`,
    );
    console.log(
      `   3. node scripts/instalar_tablero_estetica.js ${destino} --actualizar-prompts --aplicar`,
    );
    if (!hayKey)
      console.log(`   ${WARN}sin api_key el instalador no podrá crear los asistentes`);
  } else {
    console.log(`${OK} todo copiado.`);
    console.log(
      `   Recompila los prompts para que entre la política de atención:\n` +
        `   node scripts/instalar_tablero_estetica.js ${destino} --actualizar-prompts --aplicar`,
    );
  }

  await db.close();
  process.exit(0);
})();
