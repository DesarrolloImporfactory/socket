/**
 * Plantilla de permiso de llamada (permiso_llamada_whatsapp) en la WABA de una
 * conexión: se usa cuando el cliente no escribió en 24 h.
 *   node scripts/crearPlantillaPermisoLlamada.js --buscar imporfactory   (lista conexiones)
 *   node scripts/crearPlantillaPermisoLlamada.js <id_configuracion>      (crea o muestra su estado)
 * Si ya existe no la duplica; solo dice en qué estado está en Meta.
 */
require('dotenv').config();
const { db } = require('../src/database/config');
const Configuraciones = require('../src/models/configuraciones.model');
const { asegurarPlantillaPermiso } = require('../src/services/llamadas_whatsapp.service');

(async () => {
  const [arg, valor] = process.argv.slice(2);

  if (arg === '--buscar') {
    const rows = await db.query(
      `SELECT c.id, c.nombre_configuracion, c.telefono, c.id_usuario, c.suspendido,
              (c.id_whatsapp IS NOT NULL AND c.id_whatsapp <> '') AS tiene_waba
         FROM configuraciones c
        WHERE c.nombre_configuracion LIKE ?
        ORDER BY c.id_usuario, c.id`,
      { replacements: [`%${valor || ''}%`], type: db.QueryTypes.SELECT, logging: false },
    );
    console.table(rows);
    process.exit(0);
  }

  const id = Number(arg);
  if (!id) {
    console.log('Uso: --buscar <texto>  |  <id_configuracion>');
    process.exit(1);
  }
  const cfg = await Configuraciones.findByPk(id, { logging: false });
  if (!cfg) {
    console.log(`No existe la conexión ${id}`);
    process.exit(1);
  }
  console.log(`Conexión ${cfg.id} · ${cfg.nombre_configuracion} · WABA ${cfg.id_whatsapp}`);
  const r = await asegurarPlantillaPermiso(cfg);
  console.log('Plantilla permiso_llamada_whatsapp →', r);
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
