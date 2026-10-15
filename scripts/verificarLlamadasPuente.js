/**
 * ¿Quedó lista la llamada por conexión puente?
 *   node scripts/verificarLlamadasPuente.js
 * Revisa: migración aplicada, qué conexiones llaman por cuál, llamadas
 * encendidas en el puente y estado de la plantilla de permiso. No escribe en
 * la BD; lo único que hace es crear la plantilla en Meta si al puente le falta.
 */
require('dotenv').config();
const { db } = require('../src/database/config');
const Configuraciones = require('../src/models/configuraciones.model');
const llamadas = require('../src/services/llamadas_whatsapp.service');

const q = (sql, replacements = []) =>
  db.query(sql, { replacements, type: db.QueryTypes.SELECT, logging: false });

(async () => {
  const cols = await q(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'configuraciones'
        AND COLUMN_NAME IN ('id_configuracion_llamadas', 'nombre_llamadas')`,
  );
  console.log(`1) Migración: ${cols.length === 2 ? 'APLICADA' : `FALTA (columnas: ${cols.map((c) => c.COLUMN_NAME).join(', ') || 'ninguna'})`}`);
  if (cols.length < 2) process.exit(0);

  const vinc = await q(
    `SELECT c.id, c.nombre_configuracion, c.nombre_llamadas,
            p.id AS id_puente, p.nombre_configuracion AS puente, p.id_usuario = c.id_usuario AS misma_cuenta
       FROM configuraciones c
       LEFT JOIN configuraciones p ON p.id = c.id_configuracion_llamadas
      WHERE c.id_configuracion_llamadas IS NOT NULL`,
  );
  console.log('\n2) Conexiones que llaman por otra:');
  if (!vinc.length) console.log('   ninguna todavía (falta elegir el puente en la tarjeta de llamadas)');
  else console.table(vinc);

  const puentes = [...new Set(vinc.map((v) => v.id_puente).filter(Boolean))];
  for (const id of puentes) {
    const cfg = await Configuraciones.findByPk(id, { logging: false });
    const est = await llamadas.leerConfiguracionLlamadas(id).catch((e) => ({ error: e.message }));
    const tpl = await llamadas.asegurarPlantillaPermiso(cfg).catch((e) => ({ status: 'ERROR', error: e.message }));
    console.log(`\n3) Puente ${id} · ${cfg.nombre_configuracion}`);
    console.log(`   Llamadas encendidas: ${est.activo ? 'SÍ' : `NO ${est.error ? `(${est.error})` : ''}`}`);
    console.log(`   Plantilla permiso_llamada_whatsapp: ${tpl.status}${tpl.error ? ` (${tpl.error})` : ''}${tpl.rejected_reason && tpl.rejected_reason !== 'NONE' ? ` (${tpl.rejected_reason})` : ''}`);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
