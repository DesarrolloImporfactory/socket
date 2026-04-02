const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');

/**
 * POST /api/v1/webhook_contactos/inbound
 *
 * Body (JSON):
 *   nombre, apellido, email, celular,
 *   respuesta_1, respuesta_2, respuesta_3,
 *   id_configuracion (opcional, default 265)
 *
 * Header: x-webhook-secret
 */
exports.inbound = async (req, res) => {
  const body = req.body || {};
  console.log('[webhook_contactos] FULL BODY:', JSON.stringify(body));
  return res.status(200).json({ ok: true, recibido: body });
};
