const { db } = require('../database/config');

/**
 * Auditoría de `configuraciones.suspendido`.
 *
 * La columna guardaba el estado pero no quién lo cambió: cuando un cliente
 * reclamaba que su conexión "se suspendió sola" solo teníamos `suspended_at`.
 * Aquí se registra cada cambio que pasa por la aplicación, distinguiendo al
 * subusuario que apretó el botón del sistema (webhook de Stripe).
 *
 * Reglas de la casa: esto NUNCA debe tumbar la operación que audita. Todo va
 * dentro de try/catch y a lo sumo deja un warn en el log.
 */

/**
 * IP real del cliente. `app.js` no activa `trust proxy`, así que `req.ip`
 * devuelve la del nginx que tenemos delante; el primer valor de
 * x-forwarded-for es el del navegador.
 */
function ipDePeticion(req) {
  const xff = req?.headers?.['x-forwarded-for'];
  if (xff) {
    const primera = String(xff).split(',')[0].trim();
    if (primera) return primera.slice(0, 45);
  }
  const ip = req?.ip || req?.socket?.remoteAddress || null;
  return ip ? String(ip).slice(0, 45) : null;
}

function recortar(valor, max) {
  if (valor === null || typeof valor === 'undefined') return null;
  return String(valor).slice(0, max);
}

/**
 * Inserta una fila en el log. Uso interno; las funciones de abajo son las que
 * se llaman desde los controladores.
 */
async function registrar(datos) {
  try {
    await db.query(
      `INSERT INTO configuraciones_suspension_log
         (id_configuracion, id_usuario, accion, origen, motivo,
          actor_tipo, actor_id_sub_usuario, actor_id_usuario,
          actor_usuario, actor_email, actor_rol,
          ip, user_agent, detalle, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      {
        replacements: [
          Number(datos.id_configuracion),
          datos.id_usuario ? Number(datos.id_usuario) : null,
          datos.accion,
          datos.origen || 'otro',
          recortar(datos.motivo, 50),
          datos.actor_tipo,
          datos.actor_id_sub_usuario
            ? Number(datos.actor_id_sub_usuario)
            : null,
          datos.actor_id_usuario ? Number(datos.actor_id_usuario) : null,
          recortar(datos.actor_usuario, 255),
          recortar(datos.actor_email, 255),
          recortar(datos.actor_rol, 255),
          recortar(datos.ip, 45),
          recortar(datos.user_agent, 255),
          recortar(datos.detalle, 255),
        ],
      },
    );
  } catch (e) {
    // Fail-open a propósito: si la tabla no existe todavía o el INSERT falla,
    // la suspensión/reactivación ya se hizo y no la vamos a revertir por esto.
    console.warn(
      '[suspension_audit] no se pudo registrar el cambio:',
      e?.message,
    );
  }
}

/**
 * Cambio hecho desde el panel por un subusuario con sesión.
 *
 * @param {object} req            petición Express (ya pasó por auth.protect)
 * @param {object} opts
 * @param {number} opts.id_configuracion
 * @param {number} opts.id_usuario  dueño de la conexión
 * @param {'suspender'|'reactivar'} opts.accion
 * @param {string} [opts.motivo]
 * @param {string} [opts.detalle]
 */
async function auditarDesdePanel(req, opts) {
  const s = req?.sessionUser || {};
  return registrar({
    id_configuracion: opts.id_configuracion,
    id_usuario: opts.id_usuario,
    accion: opts.accion,
    origen: 'panel',
    motivo: opts.motivo || null,
    actor_tipo: 'sub_usuario',
    actor_id_sub_usuario: s.id_sub_usuario || null,
    actor_id_usuario: s.id_usuario || null,
    actor_usuario: s.nombre_encargado || s.usuario || null,
    actor_email: s.email || null,
    actor_rol: s.rol || null,
    ip: ipDePeticion(req),
    user_agent: recortar(req?.headers?.['user-agent'], 255),
    detalle: opts.detalle || null,
  });
}

/**
 * Cambio hecho por el propio sistema, sin sesión de usuario (hoy: el webhook
 * de Stripe cuando aplica un downgrade programado).
 */
async function auditarDesdeSistema(opts) {
  return registrar({
    id_configuracion: opts.id_configuracion,
    id_usuario: opts.id_usuario,
    accion: opts.accion,
    origen: opts.origen || 'otro',
    motivo: opts.motivo || null,
    actor_tipo: 'sistema',
    actor_id_sub_usuario: null,
    actor_id_usuario: null,
    actor_usuario: null,
    actor_email: null,
    actor_rol: null,
    ip: null,
    user_agent: null,
    detalle: opts.detalle || null,
  });
}

module.exports = {
  auditarDesdePanel,
  auditarDesdeSistema,
  ipDePeticion,
};
