// services/planes_chat_center.service.js
const PlanesChatCenter = require('../models/planes_chat_center.model');

exports.getPlanById = async (id_plan) => {
  return await PlanesChatCenter.findOne({
    where: { id_plan },
    raw: true, // devuelve objeto plano (ideal para Stripe y validaciones)
  });
};
