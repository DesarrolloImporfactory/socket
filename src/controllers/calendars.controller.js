const catchAsync = require('../utils/catchAsync');
const svc = require('../services/calendars.service');

exports.list = catchAsync(async (req, res) => {
  const { account_id } = req.query;
  const calendars = await svc.listCalendars({ account_id: Number(account_id) });
  res.status(200).json({ status: 'success', calendars });
});

exports.create = catchAsync(async (req, res) => {
  const calendar = await svc.createCalendar(req.body);
  res.status(201).json({ status: 'success', calendar });
});

exports.ensure = catchAsync(async (req, res) => {
  const { account_id, name, created_by } = req.body; // o req.query si prefieres
  if (!account_id) throw new AppError('account_id es obligatorio', 400);

  const cal = await svc.ensureDefaultCalendar({
    account_id: Number(account_id),
    name,
    created_by: created_by,
  });
  res.status(200).json({ status: 'success', calendar: cal });
});
