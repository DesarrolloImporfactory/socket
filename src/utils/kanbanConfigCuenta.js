/* ═══════════════════════════════════════════════════════════
   Ajustes del kanban a nivel de cuenta

   - volver_al_cerrar (configuraciones.kanban_volver_al_cerrar): ¿cerrar un
     chat desde /chat devuelve el contacto a la columna principal? 1 = sí
     (histórico, embudos con bot). 0 = no (embudos de atención/seguimiento
     donde cerrar no es retroceder). Se edita en /kanban_config.
   - mostrar_membresia: ¿las tarjetas del kanban muestran la membresía
     Imporsuit del contacto? No es un campo: lo decide la lista de cuentas de
     SOPORTE (utils/configsSoporte.js). Una tienda con bot no es usuaria de
     Imporsuit, así que ni se le ofrece el ajuste.

   Está acá y no inline en cada controlador porque lo leen varios caminos (el
   cierre del chat, el listado del tablero y la pantalla /kanban_config) y
   tienen que interpretar los mismos defaults.

   Si la columna todavía no existe en la BD se responde el default en vez de
   tumbar el cierre del chat.
   ═══════════════════════════════════════════════════════════ */
const { db } = require('../database/config');
const { esConfigSoporte } = require('./configsSoporte');

let avisoSinMigrar = false;

async function getKanbanConfigCuenta(id_configuracion) {
  const out = {
    volver_al_cerrar: true,
    mostrar_membresia: esConfigSoporte(id_configuracion),
  };
  if (!id_configuracion) return out;
  try {
    const [row] = await db.query(
      `SELECT kanban_volver_al_cerrar FROM configuraciones WHERE id = ? LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    if (row) out.volver_al_cerrar = Number(row.kanban_volver_al_cerrar) !== 0;
  } catch (err) {
    if (!avisoSinMigrar) {
      avisoSinMigrar = true;
      console.warn(
        '[kanbanConfigCuenta] No se pudo leer kanban_volver_al_cerrar (¿falta la migración?):',
        err.message,
      );
    }
  }
  return out;
}

async function setKanbanConfigCuenta(
  id_configuracion,
  { volver_al_cerrar } = {},
) {
  if (volver_al_cerrar === undefined) return;
  await db.query(
    `UPDATE configuraciones SET kanban_volver_al_cerrar = ? WHERE id = ?`,
    {
      replacements: [volver_al_cerrar ? 1 : 0, id_configuracion],
      type: db.QueryTypes.UPDATE,
    },
  );
}

module.exports = { getKanbanConfigCuenta, setKanbanConfigCuenta };
