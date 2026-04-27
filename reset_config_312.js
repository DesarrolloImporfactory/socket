// reset_config_312.js
// Borra TODO del kanban de config 312 para empezar de 0
// Uso: node reset_config_312.js

const { db } = require('./src/database/config');

const ID_CONFIG = 312;

(async () => {
  try {
    console.log(`🧹 Reseteando config ${ID_CONFIG}...`);

    await db.query(
      `DELETE FROM kanban_columnas_personalizaciones WHERE id_configuracion = ?`,
      { replacements: [ID_CONFIG] },
    );
    await db.query(`DELETE FROM kanban_acciones WHERE id_configuracion = ?`, {
      replacements: [ID_CONFIG],
    });
    await db.query(`DELETE FROM kanban_columnas WHERE id_configuracion = ?`, {
      replacements: [ID_CONFIG],
    });
    await db.query(
      `DELETE FROM dropi_plantillas_config WHERE id_configuracion = ?`,
      { replacements: [ID_CONFIG] },
    );
    await db.query(
      `UPDATE configuraciones 
       SET kanban_global_activo = 0, kanban_global_id = NULL
       WHERE id = ?`,
      { replacements: [ID_CONFIG] },
    );

    console.log('✅ Listo. Volvé a aplicar plantilla desde el frontend.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
})();
