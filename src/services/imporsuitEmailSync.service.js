/**
 * Sincroniza el email de imporsuit hacia clientes_chat_center (imporchat).
 *
 * Regla de negocio (definida con el equipo):
 *  - Match por TELÉFONO con dígitos EXACTOS: plataformas.whatsapp (imporsuit)
 *    == clientes_chat_center.celular_cliente (imporchat). celular_cliente ya se
 *    guarda como solo dígitos; el whatsapp se normaliza a solo dígitos también.
 *  - Se copia users.email_users (el email del dueño de la plataforma en imporsuit).
 *  - Solo se rellena email_cliente si está VACÍO (nunca se sobreescribe).
 *  - Alcance: TODAS las coincidencias por celular (cualquier id_configuracion /
 *    propietario).
 *
 * Topología: son dos instancias MySQL distintas en el mismo host:
 *  - db   -> chat_center       (imporchat, destino: clientes_chat_center)
 *  - db_2 -> imporsuitpro_new  (imporsuit, origen: users/plataformas/usuario_plataforma)
 */
const { db, db_2 } = require('../database/config');

// Deja solo dígitos (mismo criterio con el que se guarda celular_cliente).
function soloDigitos(v) {
  return String(v ?? '').replace(/\D/g, '');
}

/**
 * Devuelve el email_users del dueño de imporsuit cuyo whatsapp de plataforma
 * coincide (dígitos exactos) con el celular dado. Null si no hay coincidencia.
 * Si una plataforma tiene varios usuarios, prioriza al dueño (email == plataformas.email)
 * y luego el id_users más bajo, de forma determinista.
 */
async function resolverEmailImporsuitPorCelular(celular) {
  const cel = soloDigitos(celular);
  if (!cel) return null;

  const rows = await db_2.query(
    `SELECT u.email_users AS email
       FROM plataformas p
       JOIN usuario_plataforma up ON up.id_plataforma = p.id_plataforma
       JOIN users u ON u.id_users = up.id_usuario
      WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
              p.whatsapp, '+',''), ' ',''), '-',''), '(',''), ')',''), '.','') = ?
        AND u.email_users LIKE '%@%'
      ORDER BY (u.email_users = p.email) DESC, u.id_users ASC
      LIMIT 1`,
    { replacements: [cel], type: db_2.QueryTypes.SELECT },
  );

  return rows?.[0]?.email || null;
}

/**
 * HOOK "al crear cliente": rellena email_cliente desde imporsuit si está vacío.
 * Se puede llamar con el celular (recomendado) o con el id del cliente.
 * Nunca lanza: si algo falla, no debe romper el flujo de creación del cliente.
 *
 * @returns {Promise<{email:string, affected:number}|null>}
 */
async function rellenarEmailClienteSiVacio({ id = null, celular = null } = {}) {
  try {
    let cel = soloDigitos(celular);

    // Si no llegó el celular pero sí el id, lo resolvemos (y verificamos vacío).
    if (!cel && id) {
      const [row] = await db.query(
        `SELECT celular_cliente, email_cliente
           FROM clientes_chat_center WHERE id = ? LIMIT 1`,
        { replacements: [id], type: db.QueryTypes.SELECT },
      );
      if (!row) return null;
      if (row.email_cliente && String(row.email_cliente).trim() !== '') {
        return null; // ya tiene email
      }
      cel = soloDigitos(row.celular_cliente);
    }

    if (!cel) return null;

    const email = await resolverEmailImporsuitPorCelular(cel);
    if (!email) return null;

    // Alcance: TODAS las coincidencias por celular con email vacío.
    const [, affected] = await db.query(
      `UPDATE clientes_chat_center
          SET email_cliente = ?, updated_at = NOW()
        WHERE celular_cliente = ?
          AND (email_cliente IS NULL OR email_cliente = '')`,
      { replacements: [email, cel], type: db.QueryTypes.UPDATE },
    );

    if (affected) {
      console.log(
        `[imporsuitEmailSync] email='${email}' aplicado a ${affected} cliente(s) con celular=${cel}`,
      );
    }
    return { email, affected: affected || 0 };
  } catch (e) {
    console.error(
      '[imporsuitEmailSync] rellenarEmailClienteSiVacio error:',
      e?.message || e,
    );
    return null; // jamás romper la creación del cliente
  }
}

/**
 * Carga un mapa { celularDigitos -> email } desde imporsuit (plataformas/users),
 * priorizando dueño y luego id_users más bajo. Normaliza el whatsapp en JS
 * (solo dígitos) para máxima robustez en el backfill.
 */
async function cargarMapaEmailsImporsuit() {
  const rows = await db_2.query(
    `SELECT p.whatsapp     AS whatsapp,
            p.email        AS plat_email,
            u.email_users  AS email,
            u.id_users     AS id_users
       FROM plataformas p
       JOIN usuario_plataforma up ON up.id_plataforma = p.id_plataforma
       JOIN users u ON u.id_users = up.id_usuario
      WHERE p.whatsapp IS NOT NULL AND p.whatsapp <> ''
        AND u.email_users LIKE '%@%'`,
    { type: db_2.QueryTypes.SELECT },
  );

  const mapa = new Map(); // phone -> { email, esOwner, idUsers }
  for (const r of rows) {
    const phone = soloDigitos(r.whatsapp);
    if (!phone) continue;

    const esOwner =
      !!r.plat_email &&
      String(r.plat_email).toLowerCase() === String(r.email).toLowerCase();

    const prev = mapa.get(phone);
    const mejor =
      !prev ||
      (esOwner && !prev.esOwner) ||
      (esOwner === prev.esOwner && Number(r.id_users) < Number(prev.idUsers));

    if (mejor) {
      mapa.set(phone, { email: r.email, esOwner, idUsers: r.id_users });
    }
  }
  return mapa;
}

/**
 * BACKFILL idempotente para datos existentes: recorre clientes_chat_center con
 * celular y email vacío, y rellena el email desde el mapa de imporsuit.
 * Re-ejecutable las veces que sea. Con { dryRun:true } no escribe, solo cuenta.
 */
async function backfill({ dryRun = false, pageSize = 1000 } = {}) {
  const mapa = await cargarMapaEmailsImporsuit();

  let candidatos = 0;
  let actualizados = 0;
  let revisados = 0;
  let lastId = 0;

  for (;;) {
    const clientes = await db.query(
      `SELECT id, celular_cliente
         FROM clientes_chat_center
        WHERE id > ?
          AND (email_cliente IS NULL OR email_cliente = '')
          AND celular_cliente IS NOT NULL AND celular_cliente <> ''
        ORDER BY id ASC
        LIMIT ?`,
      { replacements: [lastId, pageSize], type: db.QueryTypes.SELECT },
    );

    if (!clientes.length) break;

    for (const c of clientes) {
      lastId = c.id;
      revisados++;
      const hit = mapa.get(soloDigitos(c.celular_cliente));
      if (!hit?.email) continue;
      candidatos++;

      if (!dryRun) {
        const [, affected] = await db.query(
          `UPDATE clientes_chat_center
              SET email_cliente = ?, updated_at = NOW()
            WHERE id = ? AND (email_cliente IS NULL OR email_cliente = '')`,
          { replacements: [hit.email, c.id], type: db.QueryTypes.UPDATE },
        );
        actualizados += affected || 0;
      }
    }
  }

  return {
    dryRun,
    imporsuit_pares: mapa.size,
    clientes_revisados: revisados,
    candidatos,
    actualizados,
  };
}

module.exports = {
  soloDigitos,
  resolverEmailImporsuitPorCelular,
  rellenarEmailClienteSiVacio,
  cargarMapaEmailsImporsuit,
  backfill,
};
