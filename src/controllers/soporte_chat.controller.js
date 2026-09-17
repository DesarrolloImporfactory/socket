/**
 * soporte_chat.controller.js
 *
 * - GET /check_dropi → verifica si el id_configuracion tiene integración Dropi
 *
 * El antiguo POST /ask (chatbot de soporte con knowledge base) se eliminó: el
 * front ya no lo usaba (lo reemplazó el asistente de la cuenta,
 * asistente_cuenta.controller.js) y permitía gastar la API key de la
 * plataforma con solo tener sesión.
 */

const { Sequelize } = require('sequelize');
const { db } = require('../database/config');

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/**
 * GET /soporte_chat/check_dropi?id_configuracion=XX
 */
const checkDropi = async (req, res) => {
  try {
    const idc = toInt(req.query.id_configuracion);

    if (!idc) {
      return res.json({ hasDropi: false });
    }

    const [rows] = await db.query(
      `SELECT COUNT(*) as cnt
       FROM dropi_integrations
       WHERE id_configuracion = :idc
         AND is_active = 1
         AND deleted_at IS NULL`,
      {
        replacements: { idc },
        type: Sequelize.QueryTypes.SELECT,
      },
    );

    const cnt = rows?.cnt || (Array.isArray(rows) ? rows[0]?.cnt : 0) || 0;
    return res.json({ hasDropi: Number(cnt) > 0 });
  } catch (err) {
    console.error('[SoporteChat] checkDropi error:', err.message);
    return res.json({ hasDropi: false });
  }
};

module.exports = { checkDropi };
