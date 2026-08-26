'use strict';

/**
 * Auditoría de la API pública: listar y REVERTIR cambios de terceros (CRMs)
 * sobre bot, flujos y respuestas rápidas.
 *
 * UNA sola implementación para dos consumidores:
 *  - scripts/revertirCambioApi.js (línea de comandos, soporte interno)
 *  - la pestaña "Actividad" de /api-metricas (el dueño se auto-atiende)
 * Duplicar esta lógica ya sabemos cómo termina (ver dedupeMedia).
 *
 * Toda reversión deja SU PROPIA fila de auditoría (accion 'revert', recurso
 * "<recurso>#<id revertido>") para que la historia nunca se rompa.
 */

const { db } = require('../database/config');

const j = (v) => {
  try {
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch (_) {
    return null;
  }
};

async function listarAuditoria(id_configuracion, limit = 30) {
  return db.query(
    `SELECT a.id, a.recurso, a.accion, a.created_at,
            k.nombre AS llave, a.detalle_previo IS NOT NULL AS reversible
       FROM api_public_auditoria a
       LEFT JOIN api_keys k ON k.id = a.id_api_key
      WHERE a.id_configuracion = ?
      ORDER BY a.id DESC LIMIT ${Math.min(Math.max(Number(limit) || 30, 1), 100)}`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
}

async function obtenerCambio(id, id_configuracion) {
  const [fila] = await db.query(
    `SELECT a.*, k.nombre AS llave FROM api_public_auditoria a
       LEFT JOIN api_keys k ON k.id = a.id_api_key
      WHERE a.id = ? AND a.id_configuracion = ? LIMIT 1`,
    { replacements: [id, id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!fila) return null;
  return {
    ...fila,
    previo: j(fila.detalle_previo),
    nuevo: j(fila.detalle_nuevo),
  };
}

async function auditarRevert({ fila, id_configuracion, aplicado, actor }) {
  await db.query(
    `INSERT INTO api_public_auditoria
       (id_api_key, id_configuracion, recurso, accion, detalle_previo, detalle_nuevo)
     VALUES (0, ?, ?, 'revert', ?, ?)`,
    {
      replacements: [
        id_configuracion,
        `${fila.recurso}#${fila.id}${actor ? `@${actor}` : ''}`.slice(0, 80),
        fila.detalle_nuevo,
        JSON.stringify(aplicado).slice(0, 60000),
      ],
      type: db.QueryTypes.INSERT,
    },
  );
}

/**
 * Aplica el estado PREVIO del cambio auditado.
 * @returns {{ ok:boolean, mensaje:string }}
 * @throws Error con .statusCode cuando la petición es inválida
 */
async function revertirCambio({ id, id_configuracion, actor = 'panel' }) {
  const fila = await obtenerCambio(id, id_configuracion);
  if (!fila) {
    const e = new Error('Ese cambio no existe en esta conexión.');
    e.statusCode = 404;
    throw e;
  }
  if (fila.accion === 'revert') {
    const e = new Error(
      'Eso ya es una reversión. Si quieres volver al estado que ella deshizo, revierte el cambio original otra vez.',
    );
    e.statusCode = 422;
    throw e;
  }
  const previo = fila.previo;
  const recurso = String(fila.recurso || '');

  // ── bot.columna.<id> → restaurar instrucciones ──
  let m = recurso.match(/^bot\.columna\.(\d+)$/);
  if (m) {
    if (!previo?.instrucciones) {
      const e = new Error('El cambio no tiene el prompt previo guardado.');
      e.statusCode = 422;
      throw e;
    }
    await db.query(
      `UPDATE kanban_columnas SET instrucciones = ?
        WHERE id = ? AND id_configuracion = ?`,
      {
        replacements: [previo.instrucciones, Number(m[1]), id_configuracion],
        type: db.QueryTypes.UPDATE,
      },
    );
    await auditarRevert({ fila, id_configuracion, aplicado: previo, actor });
    return {
      ok: true,
      mensaje: `Prompt de la columna restaurado. Aplica desde el siguiente mensaje (se lee en vivo).`,
    };
  }

  // ── flujos.remarketing.<estado> → reponer la secuencia completa ──
  m = recurso.match(/^flujos\.remarketing\.(.+)$/);
  if (m) {
    const estado = m[1];
    if (!Array.isArray(previo)) {
      const e = new Error('El cambio no tiene las secuencias previas guardadas.');
      e.statusCode = 422;
      throw e;
    }
    await db.query(
      `DELETE FROM configuracion_remarketing
        WHERE id_configuracion = ? AND estado_contacto = ?`,
      {
        replacements: [id_configuracion, estado],
        type: db.QueryTypes.DELETE,
      },
    );
    for (const s of previo) {
      const minutos = Number(s.tiempo_espera_minutos) || 60;
      await db.query(
        `INSERT INTO configuracion_remarketing
           (id_configuracion, estado_contacto, secuencia,
            tiempo_espera_horas, tiempo_espera_minutos,
            nombre_template, language_code, estado_destino,
            metodo_dentro_24h, prompt_ia, usar_respuesta_rapida, activo)
         VALUES (?, ?, ?, ?, ?, ?, 'es', ?, ?, ?, ?, ?)`,
        {
          replacements: [
            id_configuracion,
            estado,
            s.secuencia,
            Math.round(minutos / 60),
            minutos,
            s.nombre_template || '',
            s.estado_destino || estado,
            s.metodo_dentro_24h || 'ninguno',
            s.prompt_ia || null,
            s.metodo_dentro_24h === 'respuesta_rapida' ? 1 : 0,
            s.activo == null ? 1 : s.activo,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
    }
    await auditarRevert({ fila, id_configuracion, aplicado: previo, actor });
    return {
      ok: true,
      mensaje: `Remarketing de "${estado}" restaurado (${previo.length} paso(s)).`,
    };
  }

  // ── rapidas.<atajo> → según la acción original ──
  m = recurso.match(/^rapidas\.(.+)$/);
  if (m) {
    const atajo = m[1];
    if (fila.accion === 'create') {
      await db.query(
        `DELETE FROM templates_chat_center
          WHERE id_configuracion = ? AND atajo = ?`,
        { replacements: [id_configuracion, atajo], type: db.QueryTypes.DELETE },
      );
      await auditarRevert({
        fila,
        id_configuracion,
        aplicado: { eliminado: atajo },
        actor,
      });
      return { ok: true, mensaje: `Atajo "${atajo}" eliminado (se revirtió su creación).` };
    }
    if (fila.accion === 'update') {
      await db.query(
        `UPDATE templates_chat_center SET mensaje = ?
          WHERE id_configuracion = ? AND atajo = ?`,
        {
          replacements: [previo?.mensaje || '', id_configuracion, atajo],
          type: db.QueryTypes.UPDATE,
        },
      );
      await auditarRevert({ fila, id_configuracion, aplicado: previo, actor });
      return { ok: true, mensaje: `Atajo "${atajo}" restaurado a su mensaje anterior.` };
    }
    if (fila.accion === 'delete') {
      await db.query(
        `INSERT INTO templates_chat_center
           (id_configuracion, id_plataforma, atajo, mensaje, tipo_mensaje, principal)
         VALUES (?, NULL, ?, ?, 'text', 0)`,
        {
          replacements: [id_configuracion, atajo, previo?.mensaje || ''],
          type: db.QueryTypes.INSERT,
        },
      );
      await auditarRevert({ fila, id_configuracion, aplicado: previo, actor });
      return { ok: true, mensaje: `Atajo "${atajo}" recreado (se revirtió su borrado).` };
    }
  }

  if (/^plantillas_meta\./.test(recurso)) {
    const e = new Error(
      'Las plantillas de Meta no se revierten desde aquí: se eliminan en el administrador de WhatsApp o desde la pantalla de plantillas.',
    );
    e.statusCode = 422;
    throw e;
  }

  const e = new Error(`No sé revertir el recurso "${recurso}".`);
  e.statusCode = 422;
  throw e;
}

module.exports = { listarAuditoria, obtenerCambio, revertirCambio };
