'use strict';

/**
 * utils/unified/dedupeContacto.js
 *
 * Identidad ÚNICA de un contacto en la tabla unificada
 * (clientes_chat_center), para los 3 canales.
 *
 * CONTEXTO
 * Antes cada canal tenía su tabla; al unificarlos quedó `ensureUnifiedClient`
 * como puerta de entrada. Messenger e Instagram quedaron protegidos por el
 * índice único uq_ccc_cfg_source_page_external (id_configuracion, source,
 * page_id, external_id) — y de hecho NO tienen ni un duplicado.
 *
 * WhatsApp nunca entró a ese índice: sus page_id/external_id van NULL y en
 * MySQL los NULL no colisionan entre sí. Resultado: para WA el único
 * "candado" era un SELECT seguido de un INSERT, que no es atómico. Dos
 * webhooks simultáneos (típico: el texto del cliente + el `referral` del
 * anuncio CTWA, con 1-2 segundos de diferencia) creaban dos contactos con el
 * mismo número. A eso se sumaba que la búsqueda era por igualdad EXACTA del
 * texto del teléfono, así que el mismo número guardado en otro formato
 * (0969..., 593969..., +593969...) tampoco se encontraba.
 *
 * ESTE MÓDULO aporta las dos piezas que faltaban:
 *  1. `claveDedupe` — identidad canónica por canal, que la BD hace única.
 *  2. `buscarContactoWa` — búsqueda por los últimos 9 dígitos (columna
 *     generada `celular_last9` + índice idx_ccc_cfg_last9), inmune al formato.
 *  3. `esErrorDuplicado` — para que quien inserte pueda releer en vez de
 *     reventar cuando pierde la carrera.
 */

const { db } = require('../../database/config');

/** Solo dígitos, últimos 9 (mismo criterio que la columna celular_last9). */
function last9(telefono) {
  return String(telefono || '')
    .replace(/\D/g, '')
    .slice(-9);
}

/**
 * Identidad canónica del contacto. Debe coincidir EXACTAMENTE con lo que
 * calcula el trigger trg_ccc_dedupe_bi (ver contactos_dedupe_migration.sql):
 * si los dos criterios se separan, el índice deja de proteger.
 *
 *   wa     → "<cfg>:wa:<last9>"
 *   ms/ig  → "<cfg>:<source>:<page_id>:<external_id>"
 *
 * Devuelve null cuando no hay identidad suficiente (teléfono corto o
 * incompleto, ids de Meta vacíos): en ese caso NO se fuerza unicidad, porque
 * una clave a medias juntaría contactos que no son el mismo.
 */
function claveDedupe({
  id_configuracion,
  source = 'wa',
  telefono = null,
  page_id = null,
  external_id = null,
}) {
  if (!id_configuracion) return null;

  if (source === 'wa') {
    const tel = last9(telefono);
    return tel.length >= 8 ? `${id_configuracion}:wa:${tel}` : null;
  }

  if (source === 'ms' || source === 'ig') {
    const pid = String(page_id || '').trim();
    const eid = String(external_id || '').trim();
    if (!pid || !eid) return null;
    return `${id_configuracion}:${source}:${pid}:${eid}`;
  }

  return null;
}

/**
 * Contacto de WhatsApp por teléfono, sin importar el formato guardado.
 * Usa celular_last9 (columna STORED GENERATED) para no depender de cómo lo
 * escribió quien lo creó.
 *
 * Si hay varios (duplicados históricos, que NO se están fusionando), devuelve
 * siempre el más antiguo: es el que arrastra la conversación y las
 * referencias de las otras tablas. Ser determinista importa tanto como
 * acertar — si cada llamada eligiera uno distinto, la conversación se
 * seguiría partiendo aunque ya no se creen filas nuevas.
 */
async function buscarContactoWa({ id_configuracion, telefono }) {
  const tel = last9(telefono);
  if (!id_configuracion || tel.length < 8) return null;

  const [row] = await db.query(
    `SELECT id FROM clientes_chat_center
      WHERE id_configuracion = ?
        AND deleted_at IS NULL
        AND celular_last9 = ?
      ORDER BY id ASC
      LIMIT 1`,
    {
      replacements: [id_configuracion, tel],
      type: db.QueryTypes.SELECT,
    },
  );
  return row?.id || null;
}

/**
 * ¿El error viene de chocar contra el índice único de identidad?
 * Cubre Sequelize (UniqueConstraintError) y mysql2 crudo (ER_DUP_ENTRY).
 * Quien inserta debe releer y quedarse con el contacto que ya existe, no
 * propagar el error: perder la carrera es un caso normal, no un fallo.
 */
function esErrorDuplicado(err) {
  const code = err?.parent?.code || err?.original?.code || err?.code;
  return (
    code === 'ER_DUP_ENTRY' ||
    err?.name === 'SequelizeUniqueConstraintError' ||
    Number(err?.parent?.errno) === 1062
  );
}

/**
 * Contacto de WhatsApp por teléfono; lo crea si no existe. Devuelve el id.
 *
 * Es la forma segura de hacer el "buscar o crear" que hasta ahora estaba
 * repetido a mano en ~10 sitios, cada uno con su propio criterio de búsqueda:
 *  - busca por celular_last9, así que no se le escapa un contacto guardado en
 *    otro formato (0969…, 593969…, +593969…);
 *  - si pierde la carrera contra otro proceso, relee en vez de propagar el
 *    error. Sin esto, con el índice uq_ccc_dedupe activo, el segundo en llegar
 *    revienta — y en flujos como el cron de remarketing eso significa un
 *    mensaje ya enviado al cliente que nunca queda registrado en el chat.
 *
 * @returns {Promise<number|null>} id del contacto, o null si no hay teléfono
 *          utilizable (no se inventa un contacto sin identidad).
 */
async function obtenerOCrearContactoWa({
  id_configuracion,
  telefono,
  uid_cliente = null,
  nombre_cliente = '',
  apellido_cliente = '',
}) {
  const tel = String(telefono || '').trim();
  if (!id_configuracion || last9(tel).length < 8) return null;

  const existente = await buscarContactoWa({ id_configuracion, telefono: tel });
  if (existente) return existente;

  // require perezoso: el modelo arrastra la config de Sequelize y este módulo
  // lo cargan utilidades muy tempranas del arranque.
  const ClientesChatCenter = require('../../models/clientes_chat_center.model');

  try {
    const creado = await ClientesChatCenter.create({
      id_configuracion,
      uid_cliente,
      nombre_cliente: nombre_cliente || '',
      apellido_cliente: apellido_cliente || '',
      celular_cliente: tel,
    });
    return creado?.id || null;
  } catch (err) {
    if (!esErrorDuplicado(err)) throw err;
    // Otro proceso lo creó entre nuestro SELECT y nuestro INSERT.
    const ganador = await buscarContactoWa({ id_configuracion, telefono: tel });
    if (ganador) return ganador;
    throw err; // colisión que no sabemos explicar → que se vea
  }
}

module.exports = {
  claveDedupe,
  buscarContactoWa,
  obtenerOCrearContactoWa,
  esErrorDuplicado,
  last9,
};
