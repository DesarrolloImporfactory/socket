'use strict';

/**
 * notificaciones.service.js
 *
 * Notificaciones internas (la campana del encabezado). Genéricas: cualquier
 * módulo llama a notificar() con el destinatario, un título, un mensaje y la
 * ruta a la que lleva el clic. Tabla: notificaciones (ver
 * notificaciones_migration.sql).
 *
 * Una fila por usuario destinatario: cada quien tiene su propio "visto".
 *
 * Tolerante a que la tabla no exista (la migración se aplica a mano): las
 * funciones de escritura no lanzan y las de lectura devuelven vacío.
 */

const { db } = require('../database/config');

let tablaFaltaHasta = 0;

const esTablaFaltante = (e) =>
  (e?.original?.code || e?.parent?.code || e?.code) === 'ER_NO_SUCH_TABLE';

async function seguro(etiqueta, fn, porDefecto) {
  if (tablaFaltaHasta > Date.now()) return porDefecto;
  try {
    return await fn();
  } catch (e) {
    if (esTablaFaltante(e)) {
      tablaFaltaHasta = Date.now() + 5 * 60 * 1000;
      console.warn(
        '[notificaciones] falta la tabla (aplicar notificaciones_migration.sql)',
      );
    } else {
      console.error(`[notificaciones] ${etiqueta}:`, e?.message || e);
    }
    return porDefecto;
  }
}

const recortar = (v, n) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, n) : null;
};

/**
 * Crea la notificación para cada destinatario.
 * - destinatarios: ids de sub_usuarios_chat_center (se quitan repetidos).
 * - clave: si viene, el mismo usuario no recibe dos veces el mismo aviso
 *   (índice único id_sub_usuario + clave_unica).
 * Devuelve cuántas se crearon.
 */
async function notificar({
  destinatarios,
  id_configuracion = null,
  tipo,
  titulo,
  mensaje = null,
  url = null,
  datos = null,
  clave = null,
}) {
  const ids = [...new Set((destinatarios || []).map(Number).filter(Boolean))];
  if (!ids.length || !tipo || !titulo) return 0;

  return seguro(
    'notificar',
    async () => {
      let creadas = 0;
      for (const id of ids) {
        const [, afectadas] = await db.query(
          `INSERT IGNORE INTO notificaciones
             (id_sub_usuario, id_configuracion, tipo, titulo, mensaje, url,
              datos, clave_unica)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          {
            replacements: [
              id,
              id_configuracion || null,
              recortar(tipo, 50),
              recortar(titulo, 200),
              recortar(mensaje, 500),
              recortar(url, 300),
              datos ? JSON.stringify(datos) : null,
              recortar(clave, 190),
            ],
            type: db.QueryTypes.INSERT,
          },
        );
        creadas += afectadas ? 1 : 0;
      }
      return creadas;
    },
    0,
  );
}

/**
 * A quién avisar de algo que pasa en el chat de un cliente:
 *   - el encargado del chat (si tiene), y
 *   - los administradores de la cuenta.
 * Sin encargado quedan solo los administradores.
 *
 * telefono: el del pedido; el chat se busca por los últimos 9 dígitos.
 * Devuelve { ids, encargado: { id, nombre } | null, id_cliente }.
 */
async function destinatariosDeChat({ id_configuracion, telefono }) {
  const vacio = { ids: [], encargado: null, id_cliente: null };
  return seguro(
    'destinatariosDeChat',
    async () => {
      const cfg = Number(id_configuracion);
      if (!cfg) return vacio;

      const last9 = String(telefono || '').replace(/\D/g, '').slice(-9);
      let cliente = null;
      if (last9.length === 9) {
        [cliente] = await db.query(
          `SELECT id, id_encargado
             FROM clientes_chat_center
            WHERE id_configuracion = ? AND deleted_at IS NULL
              AND celular_cliente LIKE ?
            ORDER BY id DESC LIMIT 1`,
          { replacements: [cfg, `%${last9}`], type: db.QueryTypes.SELECT },
        );
      }

      let encargado = null;
      if (cliente?.id_encargado) {
        const [sub] = await db.query(
          `SELECT id_sub_usuario, nombre_encargado
             FROM sub_usuarios_chat_center
            WHERE id_sub_usuario = ? LIMIT 1`,
          { replacements: [cliente.id_encargado], type: db.QueryTypes.SELECT },
        );
        if (sub) {
          encargado = { id: sub.id_sub_usuario, nombre: sub.nombre_encargado };
        }
      }

      const admins = await db.query(
        `SELECT s.id_sub_usuario
           FROM configuraciones c
           JOIN sub_usuarios_chat_center s ON s.id_usuario = c.id_usuario
          WHERE c.id = ? AND s.rol = 'administrador'`,
        { replacements: [cfg], type: db.QueryTypes.SELECT },
      );

      return {
        ids: [
          ...(encargado ? [encargado.id] : []),
          ...admins.map((a) => a.id_sub_usuario),
        ],
        encargado,
        id_cliente: cliente?.id || null,
      };
    },
    vacio,
  );
}

/* Filtro por cuenta: con una conexión elegida se ven las suyas y las
   generales (id_configuracion NULL); sin conexión, todas. */
function filtroCuenta(id_configuracion) {
  return id_configuracion
    ? 'AND (n.id_configuracion = :cfg OR n.id_configuracion IS NULL)'
    : '';
}

async function contarNoLeidas({ id_sub_usuario, id_configuracion = null }) {
  return seguro(
    'contarNoLeidas',
    async () => {
      const [fila] = await db.query(
        `SELECT COUNT(*) AS total FROM notificaciones n
          WHERE n.id_sub_usuario = :usr AND n.leida = 0
            ${filtroCuenta(id_configuracion)}`,
        {
          replacements: { usr: id_sub_usuario, cfg: id_configuracion },
          type: db.QueryTypes.SELECT,
        },
      );
      return Number(fila?.total) || 0;
    },
    0,
  );
}

async function listar({
  id_sub_usuario,
  id_configuracion = null,
  soloNoLeidas = false,
  limit = 20,
  offset = 0,
}) {
  return seguro(
    'listar',
    async () => {
      const filas = await db.query(
        `SELECT n.id, n.id_configuracion, n.tipo, n.titulo, n.mensaje, n.url,
                n.datos, n.leida, n.leida_at, n.created_at,
                c.nombre_configuracion
           FROM notificaciones n
           LEFT JOIN configuraciones c ON c.id = n.id_configuracion
          WHERE n.id_sub_usuario = :usr
            ${soloNoLeidas ? 'AND n.leida = 0' : ''}
            ${filtroCuenta(id_configuracion)}
          ORDER BY n.created_at DESC, n.id DESC
          LIMIT :limit OFFSET :offset`,
        {
          replacements: {
            usr: id_sub_usuario,
            cfg: id_configuracion,
            limit: limit + 1,
            offset,
          },
          type: db.QueryTypes.SELECT,
        },
      );
      const hayMas = filas.length > limit;
      return {
        notificaciones: filas.slice(0, limit).map((f) => {
          let datos = f.datos;
          if (typeof datos === 'string') {
            try {
              datos = JSON.parse(datos);
            } catch (_) {
              datos = null;
            }
          }
          return { ...f, datos, leida: Number(f.leida) === 1 };
        }),
        hayMas,
      };
    },
    { notificaciones: [], hayMas: false },
  );
}

/* Solo marca las del propio usuario: el id_sub_usuario va en el WHERE. */
async function marcarLeida({ id_sub_usuario, id }) {
  return seguro(
    'marcarLeida',
    async () => {
      await db.query(
        `UPDATE notificaciones SET leida = 1, leida_at = NOW()
          WHERE id = ? AND id_sub_usuario = ? AND leida = 0`,
        { replacements: [id, id_sub_usuario], type: db.QueryTypes.UPDATE },
      );
      return true;
    },
    false,
  );
}

async function marcarTodasLeidas({ id_sub_usuario, id_configuracion = null }) {
  return seguro(
    'marcarTodasLeidas',
    async () => {
      await db.query(
        `UPDATE notificaciones n SET n.leida = 1, n.leida_at = NOW()
          WHERE n.id_sub_usuario = :usr AND n.leida = 0
            ${filtroCuenta(id_configuracion)}`,
        {
          replacements: { usr: id_sub_usuario, cfg: id_configuracion },
          type: db.QueryTypes.UPDATE,
        },
      );
      return true;
    },
    false,
  );
}

module.exports = {
  notificar,
  destinatariosDeChat,
  contarNoLeidas,
  listar,
  marcarLeida,
  marcarTodasLeidas,
};
