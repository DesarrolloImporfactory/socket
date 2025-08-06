const Calendar = require('../models/calendar.model');
const AppError = require('../utils/appError');

async function listCalendars({ account_id }) {
  if (!account_id) throw new AppError('account_id es obligatorio.', 400);
  return await Calendar.findAll({
    where: { account_id, is_active: 1 },
    order: [['name', 'ASC']],
  });
}

async function createCalendar({
  account_id,
  name,
  time_zone = 'America/Guayaquil',
  color_hex = null,
  created_by = null,
}) {
  if (!account_id || !name)
    throw new AppError('account_id y name son obligatorios.', 400);
  return await Calendar.create({
    account_id,
    name,
    time_zone,
    color_hex,
    created_by,
  });
}

async function ensureDefaultCalendar({
  account_id,
  name = 'Calendario principal',
  time_zone = 'America/Guayaquil',
  created_by = null,
}) {
  let cal = await Calendar.findOne({
    where: { account_id, is_active: 1 },
    order: [['id', 'ASC']],
  });
  if (!cal) {
    cal = await Calendar.create({
      account_id,
      name,
      time_zone,
      color_hex: '#3b82f6',
      is_active: 1,
      created_by,
    });
  }
  return cal;
}

module.exports = { listCalendars, createCalendar, ensureDefaultCalendar };
