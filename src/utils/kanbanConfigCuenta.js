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

/* - agenda_automatica: ¿el bot crea la cita en el calendario (true) o deja una
     solicitud para que una persona la confirme (false)? Es el `modo` de TODAS
     las acciones agendar_cita de la cuenta; null si no tiene ninguna. Un solo
     switch porque un tablero con agenda la repite en 4-5 columnas. */
async function accionesAgenda(id_configuracion) {
  return db.query(
    `SELECT ka.id, ka.config
       FROM kanban_acciones ka
       JOIN kanban_columnas kc ON kc.id = ka.id_kanban_columna
      WHERE kc.id_configuracion = ? AND ka.tipo_accion = 'agendar_cita'`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
}

/* - reenviar_media_fija: los videos/imágenes escritos en el prompt salen cada
     vez que el bot responde ese tema (sin la ventana de 48 h del dedupe). Es
     `reenviar_fijos` en TODAS las acciones enviar_media; null si no hay
     ninguna. Apagado por defecto: así se evita el spam de la misma foto. */
async function accionesMedia(id_configuracion) {
  return db.query(
    `SELECT ka.id, ka.config
       FROM kanban_acciones ka
       JOIN kanban_columnas kc ON kc.id = ka.id_kanban_columna
      WHERE kc.id_configuracion = ? AND ka.tipo_accion = 'enviar_media'`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
}

const configDe = (raw) => {
  try {
    let c = raw;
    while (typeof c === 'string') c = JSON.parse(c);
    return c && typeof c === 'object' ? c : {};
  } catch {
    return {};
  }
};

async function getKanbanConfigCuenta(id_configuracion) {
  const out = {
    volver_al_cerrar: true,
    mostrar_membresia: esConfigSoporte(id_configuracion),
    agenda_automatica: null,
    reenviar_media_fija: null,
  };
  if (!id_configuracion) return out;
  try {
    const media = await accionesMedia(id_configuracion);
    if (media.length) {
      out.reenviar_media_fija = media.some(
        (a) => configDe(a.config).reenviar_fijos === true,
      );
    }
  } catch (err) {
    console.warn('[kanbanConfigCuenta] reenviar_media_fija:', err.message);
  }
  try {
    const acciones = await accionesAgenda(id_configuracion);
    if (acciones.length) {
      // Automática solo si NINGUNA quedó en solicitud.
      out.agenda_automatica = acciones.every(
        (a) => configDe(a.config).modo !== 'solicitud',
      );
    }
  } catch (err) {
    console.warn('[kanbanConfigCuenta] agenda_automatica:', err.message);
  }
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
  { volver_al_cerrar, agenda_automatica, reenviar_media_fija } = {},
) {
  if (reenviar_media_fija !== undefined) {
    for (const a of await accionesMedia(id_configuracion)) {
      const config = { ...configDe(a.config) };
      if (reenviar_media_fija) config.reenviar_fijos = true;
      else delete config.reenviar_fijos;
      await db.query(`UPDATE kanban_acciones SET config = ? WHERE id = ?`, {
        replacements: [JSON.stringify(config), a.id],
        type: db.QueryTypes.UPDATE,
      });
    }
  }
  if (agenda_automatica !== undefined) {
    const modo = agenda_automatica ? 'auto' : 'solicitud';
    for (const a of await accionesAgenda(id_configuracion)) {
      const config = { ...configDe(a.config), modo };
      // Sin columna destino la solicitud se guarda igual, pero la tarjeta no
      // tiene a dónde ir: por_agendar es la de las plantillas.
      if (modo === 'solicitud' && !config.estado_solicitud) {
        config.estado_solicitud = 'por_agendar';
      }
      await db.query(`UPDATE kanban_acciones SET config = ? WHERE id = ?`, {
        replacements: [JSON.stringify(config), a.id],
        type: db.QueryTypes.UPDATE,
      });
    }
  }
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
