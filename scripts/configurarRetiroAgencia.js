// Enciende/apaga el switch de retiro en agencia Servientrega de una cuenta y
// fija su modalidad preferida, con el MISMO código que usa el botón del panel
// (services/kanban_retiro_agencia.service): sube e indexa el directorio en
// los vector stores de las columnas IA e inyecta el bloque en los prompts.
// Tarda 30-60 s por cuenta (llama a OpenAI con la llave de la cuenta).
//
//   node scripts/configurarRetiroAgencia.js --cfg 711 --estado
//   node scripts/configurarRetiroAgencia.js --cfg 711 --activar
//   node scripts/configurarRetiroAgencia.js --cfg 711 --desactivar
//   node scripts/configurarRetiroAgencia.js --cfg 711 --preferir agencia   (o "ninguna")
//
// --preferir necesita la columna configuraciones.modalidad_envio_preferida
// (modalidad_envio_preferida_migration.sql); sin ella avisa y no rompe.
const ROOT = require('path').join(__dirname, '..');
require(ROOT + '/node_modules/dotenv').config({ path: ROOT + '/.env' });
const { db } = require(ROOT + '/src/database/config');
const retiro = require(ROOT + '/src/services/kanban_retiro_agencia.service');

const args = process.argv.slice(2);
const val = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const cfg = Number(val('--cfg'));
if (!cfg) {
  console.error('Falta --cfg <id_configuracion>');
  process.exit(1);
}

(async () => {
  const [row] = await db.query(
    `SELECT id, nombre_configuracion, kanban_global_id, retiro_agencia_activo FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [cfg], type: db.QueryTypes.SELECT },
  );
  if (!row) throw new Error(`No existe la configuración ${cfg}`);
  console.log(
    `cfg ${row.id} ${row.nombre_configuracion} · plantilla ${row.kanban_global_id} · switch=${row.retiro_agencia_activo}`,
  );
  if (!(await retiro.enPiloto(cfg))) {
    throw new Error(
      'Esta cuenta no ve el switch (no tiene la plantilla E-commerce EC): no se toca',
    );
  }

  if (args.includes('--activar')) {
    if (Number(row.retiro_agencia_activo) === 1) {
      console.log('   el switch ya estaba encendido');
    } else {
      console.log(
        '   activando (sube/indexa el directorio y parcha los prompts)…',
      );
      const t0 = Date.now();
      await retiro.activar(cfg, null);
      console.log(`   ✔ activado en ${Math.round((Date.now() - t0) / 1000)} s`);
    }
  }
  if (args.includes('--desactivar')) {
    await retiro.desactivar(cfg);
    console.log('   ✔ desactivado');
  }
  const pref = val('--preferir');
  if (pref) {
    try {
      const v = await retiro.setModalidadPreferida(
        cfg,
        pref === 'ninguna' ? null : pref,
      );
      console.log(
        `   ✔ modalidad preferida = ${v === null ? 'ninguna (pregunta neutra)' : v}`,
      );
    } catch (e) {
      console.log(
        `   ✖ no se pudo fijar la modalidad preferida: ${e.message} (¿falta aplicar modalidad_envio_preferida_migration.sql?)`,
      );
    }
  }

  const estado = await retiro.estado(cfg);
  console.log(
    `   estado: activo=${estado.activo} · preferida=${estado.modalidad_preferida ?? 'ninguna'} · archivo=${estado.archivo?.nombre || '-'} (${estado.archivo?.status || '-'})`,
  );
  await db.close();
  process.exit(0);
})().catch((e) => {
  console.error('ERROR', e.message);
  process.exit(1);
});
