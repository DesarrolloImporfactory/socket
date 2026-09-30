/**
 * Trae a nuestro servidor las grabaciones que todavía viven en la nube de
 * Zadarma y las borra allá, para liberar los 200 MB del plan Standard.
 *
 * Correr en el servidor donde vive src/uploads (producción):
 *   node scripts/traerGrabacionesZadarma.js            # solo muestra qué haría
 *   node scripts/traerGrabacionesZadarma.js --aplicar  # descarga y borra
 *
 * Toma las llamadas con grabación (call_id_with_rec) cuya grabacion_url es
 * nula o apunta a Zadarma. Las que ya están en /uploads/telefonia/ se saltan.
 * Las grabaciones de llamadas hechas fuera de ChatCenter (desde el panel de
 * Zadarma) no están en nuestra tabla y hay que borrarlas a mano allá.
 */
process.env.CRONS_ENABLED = 'false';
require('dotenv').config();
const { db } = require('../src/database/config');
const TelefoniaLlamadas = require('../src/models/telefonia_llamadas.model');
const zadarma = require('../src/services/zadarma.service');

const aplicar = process.argv.includes('--aplicar');

(async () => {
  await db.authenticate();
  const filas = await TelefoniaLlamadas.findAll({
    where: db.literal(
      "call_id_with_rec IS NOT NULL AND (grabacion_url IS NULL OR grabacion_url NOT LIKE '%/uploads/telefonia/%')",
    ),
    order: [['id', 'ASC']],
  });
  console.log(`${filas.length} grabación(es) por traer${aplicar ? '' : ' (modo prueba, agrega --aplicar)'}`);
  let ok = 0;
  for (const f of filas) {
    if (!aplicar) {
      console.log(`  #${f.id} cfg ${f.id_configuracion} ${f.inicio_at} → ${f.telefono_cliente}`);
      continue;
    }
    const url = await zadarma.traerGrabacion(f);
    const enCasa = url && url.includes('/uploads/telefonia/');
    if (enCasa) ok += 1;
    console.log(`  #${f.id} ${enCasa ? 'OK' : 'quedó en Zadarma'} ${url || ''}`);
  }
  if (aplicar) console.log(`listas: ${ok} de ${filas.length}`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
