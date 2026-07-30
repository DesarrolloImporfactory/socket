const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const { db } = require('../database/config');
const ProfesionalesChatCenter = require('../models/profesionales_chat_center.model');

const limpiar = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/* Listar por sede, o por configuración completa si no se manda la sede. */
exports.listar = catchAsync(async (req, res, next) => {
  const { id_configuracion, id_establecimiento, incluir_inactivos } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));

  const where = { id_configuracion, eliminado: 0 };
  if (id_establecimiento) where.id_establecimiento = id_establecimiento;
  if (!incluir_inactivos) where.activo = 1;

  const profesionales = await ProfesionalesChatCenter.findAll({
    where,
    order: [
      ['orden', 'ASC'],
      ['id', 'ASC'],
    ],
  });

  return res.status(200).json({ status: 'success', data: profesionales });
});

exports.crear = catchAsync(async (req, res, next) => {
  const { id_configuracion, id_establecimiento, nombre } = req.body;

  if (!id_configuracion || !id_establecimiento || !limpiar(nombre)) {
    return next(
      new AppError(
        'id_configuracion, id_establecimiento y nombre son obligatorios',
        400,
      ),
    );
  }

  /* La sede tiene que existir y ser de esta cuenta: sin esto se podrían colgar
     profesionales de la sede de otro cliente mandando un id cualquiera. */
  const [sede] = await db.query(
    `SELECT id FROM establecimientos_chat_center
      WHERE id = ? AND id_configuracion = ? AND eliminado = 0 LIMIT 1`,
    {
      replacements: [id_establecimiento, id_configuracion],
      type: db.QueryTypes.SELECT,
    },
  );
  if (!sede) return next(new AppError('La sede no existe en esta cuenta', 404));

  const nuevo = await ProfesionalesChatCenter.create({
    id_configuracion,
    id_establecimiento,
    nombre: limpiar(nombre),
    orden: Number(req.body.orden) || 0,
    activo: Number(req.body.activo) === 0 ? 0 : 1,
  });

  return res.status(201).json({ status: 'success', data: nuevo });
});

exports.actualizar = catchAsync(async (req, res, next) => {
  const { id } = req.body;
  if (!id) return next(new AppError('Falta id', 400));

  const prof = await ProfesionalesChatCenter.findOne({
    where: { id, eliminado: 0 },
  });
  if (!prof) return next(new AppError('Profesional no encontrado', 404));

  if (req.body.nombre !== undefined) {
    const nombre = limpiar(req.body.nombre);
    if (!nombre)
      return next(new AppError('El nombre no puede ir vacío', 400));
    prof.nombre = nombre;
  }
  if (req.body.orden !== undefined) prof.orden = Number(req.body.orden) || 0;
  if (req.body.activo !== undefined)
    prof.activo = Number(req.body.activo) === 0 ? 0 : 1;

  prof.fecha_actualizacion = new Date();
  await prof.save();

  return res.status(200).json({ status: 'success', data: prof });
});

/* Borrado lógico: las citas ya atendidas apuntan aquí y perder de quién eran
   deja el histórico sin sentido. */
exports.eliminar = catchAsync(async (req, res, next) => {
  const { id } = req.body;
  if (!id) return next(new AppError('Falta id', 400));

  const prof = await ProfesionalesChatCenter.findOne({
    where: { id, eliminado: 0 },
  });
  if (!prof) return next(new AppError('Profesional no encontrado', 404));

  const [citas] = await db.query(
    `SELECT COUNT(*) AS n FROM appointments
      WHERE id_profesional = ?
        AND start_utc > UTC_TIMESTAMP()
        AND status IN ('Agendado', 'Confirmado')`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );

  prof.eliminado = 1;
  prof.activo = 0;
  prof.fecha_actualizacion = new Date();
  await prof.save();

  return res.status(200).json({
    status: 'success',
    message: 'Profesional eliminado',
    // Se avisa, no se bloquea: la persona pudo renunciar y esas citas hay que
    // reasignarlas a mano de todos modos.
    citas_futuras_afectadas: Number(citas?.n || 0),
  });
});
