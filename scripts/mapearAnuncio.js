/* Mapear a mano un anuncio a su producto.
   ─────────────────────────────────────────────────────────────
   Los anuncios cuyo título es puro marketing ("¿Fritas sin desastre? 🍟") no
   contienen ningún nombre de producto, así que ningún nivel de texto puede
   resolverlos: son ~1 de cada 4, y sus clientes entran sin ancla — el bot
   puede terminar hablando de otra cosa.

   El vínculo se declara UNA vez acá y vale para siempre: todo cliente que
   entre por ese anuncio recibe la ficha exacta desde el primer mensaje.

   USO
     node scripts/mapearAnuncio.js --pendientes [cfg]   qué anuncios faltan,
                                                        ordenados por clientes
     node scripts/mapearAnuncio.js --productos <cfg> [texto]   ids del catálogo
     node scripts/mapearAnuncio.js <cfg> <source_id> <id_producto>   mapear
*/

require('dotenv').config();

const { db } = require('../src/database/config');

const args = process.argv.slice(2);

(async () => {
  if (args[0] === '--pendientes') {
    const cfg = args[1] ? 'AND a.id_configuracion = ?' : '';
    const filas = await db.query(
      `SELECT a.id_configuracion cfg, a.source_id,
              MAX(a.headline) headline, COUNT(*) clientes
         FROM cliente_productos_ad a
         LEFT JOIN anuncios_producto m
           ON m.id_configuracion = a.id_configuracion AND m.source_id = a.source_id
        WHERE a.created_at > DATE_SUB(NOW(), INTERVAL 60 DAY)
          AND a.source_id IS NOT NULL AND m.id IS NULL ${cfg}
        GROUP BY a.id_configuracion, a.source_id
        ORDER BY clientes DESC
        LIMIT 30`,
      { replacements: args[1] ? [args[1]] : [], type: db.QueryTypes.SELECT },
    );
    /* No todos los pendientes urgen igual. Se anota qué logra el texto en
       runtime: "ninguno" = el cliente entra SIN ancla (mapear primero);
       "palabras" = se resuelve por coincidencia difusa (funciona, pero es una
       adivinanza por mensaje: conviene fijarlo); exacto/contenido no deberían
       aparecer acá, porque esos se aprenden solos con la próxima entrada. */
    const {
      resolverProductoAnuncio,
    } = require('../src/utils/webhook_whatsapp/buscar_producto_referral');

    console.log('Anuncios SIN producto mapeado (60 días, por volumen):\n');
    for (const f of filas) {
      // Sin source_id a propósito: el reporte no aprende, solo mira.
      const r = await resolverProductoAnuncio(f.cfg, f.headline, null);
      const estado = !r
        ? '❌ SIN ANCLA — mapear primero'
        : r.via === 'palabras'
          ? `≈ difuso → ${String(r.producto.nombre).slice(0, 32)} (fijar si es correcto)`
          : `✓ ${r.via} → se aprende solo`;
      console.log(
        `  cfg ${String(f.cfg).padEnd(4)} ${String(f.clientes).padStart(4)} clientes · ` +
          `source_id ${f.source_id}\n` +
          `        "${String(f.headline || '').slice(0, 60)}"  ${estado}`,
      );
    }
    console.log(
      '\nPara mapear: node scripts/mapearAnuncio.js <cfg> <source_id> <id_producto>',
    );
    process.exit(0);
  }

  if (args[0] === '--productos') {
    const [, cfg, texto] = args;
    if (!cfg) {
      console.log('Falta la configuración: --productos <cfg> [texto]');
      process.exit(1);
    }
    const filtro = texto ? 'AND nombre LIKE ?' : '';
    const filas = await db.query(
      `SELECT id, nombre, precio FROM productos_chat_center
        WHERE id_configuracion = ? AND eliminado = 0 ${filtro}
        ORDER BY nombre LIMIT 60`,
      {
        replacements: texto ? [cfg, `%${texto}%`] : [cfg],
        type: db.QueryTypes.SELECT,
      },
    );
    filas.forEach((f) =>
      console.log(`  ${String(f.id).padStart(6)}  $${f.precio}  ${f.nombre}`),
    );
    process.exit(0);
  }

  const [cfg, source_id, id_producto] = args;
  if (!cfg || !source_id || !id_producto) {
    console.log('Uso: node scripts/mapearAnuncio.js <cfg> <source_id> <id_producto>');
    console.log('     node scripts/mapearAnuncio.js --pendientes [cfg]');
    console.log('     node scripts/mapearAnuncio.js --productos <cfg> [texto]');
    process.exit(1);
  }

  // El producto tiene que existir en ESA cuenta: un id ajeno anclaría a todos
  // los clientes del anuncio a un producto de otra tienda.
  const [p] = await db.query(
    `SELECT id, nombre FROM productos_chat_center
      WHERE id = ? AND id_configuracion = ? AND eliminado = 0 LIMIT 1`,
    { replacements: [id_producto, cfg], type: db.QueryTypes.SELECT },
  );
  if (!p) {
    console.log(`❌ El producto ${id_producto} no existe en la configuración ${cfg}.`);
    process.exit(1);
  }

  const [ad] = await db.query(
    `SELECT MAX(headline) h FROM cliente_productos_ad
      WHERE id_configuracion = ? AND source_id = ?`,
    { replacements: [cfg, source_id], type: db.QueryTypes.SELECT },
  );

  await db.query(
    `INSERT INTO anuncios_producto
       (id_configuracion, source_id, id_producto, headline, via)
     VALUES (?, ?, ?, ?, 'manual')
     ON DUPLICATE KEY UPDATE id_producto = VALUES(id_producto), via = 'manual'`,
    {
      replacements: [cfg, source_id, p.id, ad?.h || null],
      type: db.QueryTypes.INSERT,
    },
  );

  console.log(
    `✅ Anuncio ${source_id} ("${String(ad?.h || '').slice(0, 50)}") → "${p.nombre}".\n` +
      `   Todo cliente que entre por ese anuncio recibe este producto desde el primer mensaje.`,
  );
  process.exit(0);
})().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
