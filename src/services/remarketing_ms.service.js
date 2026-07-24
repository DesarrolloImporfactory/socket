// services/remarketing_ms.service.js
// -----------------------------------------------------------------------------
// Remarketing kanban para MESSENGER (v1). Mismo patrón que Instagram:
// reutiliza la tabla remarketing_pendientes (source='ms') y configuracion_remarketing.
// Messenger tampoco tiene templates de pago, así que solo es viable dentro de la
// ventana de 24h → v1 soporta únicamente el método IA (metodo_dentro_24h='ia').
//
// La generación del texto IA es agnóstica al canal y se reutiliza desde
// remarketing_ig.service (generarRemarketingIgIA). La cancelación al responder
// usa cancelarRemarketingKanban (kanban_ia.service), agnóstica al canal.
// -----------------------------------------------------------------------------

const { db } = require('../database/config');
const { log } = require('./remarketing_ig.service');

// ─────────────────────────────────────────────────────────────
// programarRemarketingMS
// Agenda un remarketing de Messenger para el estado actual del cliente.
// v1: solo método IA. Si la config del estado no es IA, se omite.
// ─────────────────────────────────────────────────────────────
async function programarRemarketingMS({
  id_configuracion,
  id_cliente, // id del contacto (clientes_chat_center.id, propietario=0)
  page_id,
  external_id, // PSID del cliente
  estado_contacto,
}) {
  try {
    if (!page_id || !external_id) {
      await log(
        `[ms] ⚠️ Falta page_id/external_id — no se programa (cliente=${id_cliente})`,
      );
      return;
    }

    // Cliente con remarketing desactivado → no programar.
    const [cli] = await db.query(
      `SELECT enviar_remarketing FROM clientes_chat_center WHERE id = ? LIMIT 1`,
      { replacements: [id_cliente], type: db.QueryTypes.SELECT },
    );
    if (cli && Number(cli.enviar_remarketing) === 0) {
      await log(`[ms] 🚫 SKIP — cliente=${id_cliente} tiene enviar_remarketing=0`);
      return;
    }

    // Config del estado (secuencia 1).
    const [configRM] = await db.query(
      `SELECT tiempo_espera_horas, tiempo_espera_minutos, estado_destino,
              metodo_dentro_24h, prompt_ia
         FROM configuracion_remarketing
        WHERE id_configuracion = ? AND estado_contacto = ?
          AND secuencia = 1 AND activo = 1
        LIMIT 1`,
      {
        replacements: [id_configuracion, estado_contacto],
        type: db.QueryTypes.SELECT,
      },
    );

    if (!configRM) {
      await log(
        `[ms] ℹ️ Sin configuracion_remarketing (estado="${estado_contacto}", config=${id_configuracion}, secuencia=1, activo=1) — no se programa`,
      );
      return;
    }

    // v1 MS: solo método IA.
    if (configRM.metodo_dentro_24h !== 'ia' || !configRM.prompt_ia) {
      await log(
        `[ms] ℹ️ Estado="${estado_contacto}" no es IA (metodo=${configRM.metodo_dentro_24h}) — MS v1 solo IA, se omite`,
      );
      return;
    }

    // Cancelar pendientes MS previos de este cliente.
    await db.query(
      `UPDATE remarketing_pendientes
          SET cancelado = 1
        WHERE id_cliente_chat_center = ?
          AND id_configuracion = ?
          AND source = 'ms'
          AND enviado = 0
          AND cancelado = 0`,
      {
        replacements: [id_cliente, id_configuracion],
        type: db.QueryTypes.UPDATE,
      },
    );

    const minutos =
      configRM.tiempo_espera_minutos != null
        ? Number(configRM.tiempo_espera_minutos)
        : Number(configRM.tiempo_espera_horas || 0) * 60;

    const tiempoDisparo = new Date(Date.now() + minutos * 60 * 1000);

    await db.query(
      `INSERT INTO remarketing_pendientes
        (telefono, id_cliente_chat_center, id_configuracion,
         source, page_id, external_id,
         estado_contacto_origen, estado_destino, tiempo_disparo,
         metodo_dentro_24h, prompt_ia,
         enviado, cancelado, secuencia)
       VALUES (?, ?, ?, 'ms', ?, ?, ?, ?, ?, 'ia', ?, 0, 0, 1)`,
      {
        replacements: [
          String(external_id).slice(0, 20), // telefono es NOT NULL; guardamos el PSID
          id_cliente,
          id_configuracion,
          page_id,
          external_id,
          estado_contacto,
          configRM.estado_destino || null,
          tiempoDisparo,
          configRM.prompt_ia,
        ],
        type: db.QueryTypes.INSERT,
      },
    );

    await log(
      `[ms] 📅 Remarketing MS programado en ${minutos}min — estado=${estado_contacto} cliente=${id_cliente}`,
    );
  } catch (err) {
    await log(`[ms] ❌ Error programando remarketing MS: ${err.message}`);
  }
}

module.exports = { programarRemarketingMS };
