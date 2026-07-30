const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const { db } = require('../database/config');
const EstablecimientosChatCenter = require('../models/establecimientos_chat_center.model');

/* Campos que el cliente puede editar. Se listan a mano para que un body con
   campos de más no pueda tocar id_configuracion ni eliminado. */
const CAMPOS_EDITABLES = [
  'nombre',
  'ciudad',
  'provincia',
  'direccion',
  'referencia',
  'google_maps_url',
  'telefono',
  'horario',
  'id_calendario',
  'orden',
  'activo',
];

const limpiar = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/* El enlace de Maps se lo mandamos al cliente para que llegue, así que tiene que
   ser un enlace de verdad. Se acepta el pegado tal cual desde la app (incluido
   maps.app.goo.gl sin https://) y se rechaza lo que no sea una URL, en vez de
   guardarlo y descubrirlo recién cuando el bot lo envíe. */
const URL_MAPS_OK =
  /^https?:\/\/([\w-]+\.)*(google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|goo\.gl|maps\.app\.goo\.gl)\//i;

const limpiarUrlMaps = (v) => {
  const s = limpiar(v);
  if (!s) return { ok: true, valor: null };
  const url = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  if (!URL_MAPS_OK.test(url)) return { ok: false, valor: null };
  return { ok: true, valor: url.slice(0, 500) };
};

const ERROR_MAPS =
  'El enlace de Google Maps no es válido. Abre la sede en Google Maps, ' +
  'usa Compartir → Copiar vínculo y pega ese enlace.';

exports.listar = catchAsync(async (req, res, next) => {
  const { id_configuracion, incluir_inactivos } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));

  const where = { id_configuracion, eliminado: 0 };
  if (!incluir_inactivos) where.activo = 1;

  const establecimientos = await EstablecimientosChatCenter.findAll({
    where,
    order: [
      ['orden', 'ASC'],
      ['id', 'ASC'],
    ],
  });

  return res.status(200).json({ status: 'success', data: establecimientos });
});

exports.crear = catchAsync(async (req, res, next) => {
  const { id_configuracion, nombre, ciudad } = req.body;

  if (!id_configuracion || !limpiar(nombre) || !limpiar(ciudad)) {
    return next(
      new AppError('id_configuracion, nombre y ciudad son obligatorios', 400),
    );
  }

  const maps = limpiarUrlMaps(req.body.google_maps_url);
  if (!maps.ok) return next(new AppError(ERROR_MAPS, 400));

  const nuevo = await EstablecimientosChatCenter.create({
    id_configuracion,
    nombre: limpiar(nombre),
    ciudad: limpiar(ciudad),
    provincia: limpiar(req.body.provincia),
    direccion: limpiar(req.body.direccion),
    referencia: limpiar(req.body.referencia),
    google_maps_url: maps.valor,
    telefono: limpiar(req.body.telefono),
    horario: limpiar(req.body.horario),
    id_calendario: req.body.id_calendario || null,
    orden: Number(req.body.orden) || 0,
    activo: Number(req.body.activo) === 0 ? 0 : 1,
  });

  return res.status(201).json({ status: 'success', data: nuevo });
});

exports.actualizar = catchAsync(async (req, res, next) => {
  const { id } = req.body;
  if (!id) return next(new AppError('Falta id', 400));

  const est = await EstablecimientosChatCenter.findOne({
    where: { id, eliminado: 0 },
  });
  if (!est) return next(new AppError('Establecimiento no encontrado', 404));

  for (const campo of CAMPOS_EDITABLES) {
    if (req.body[campo] === undefined) continue;
    if (campo === 'google_maps_url') {
      const maps = limpiarUrlMaps(req.body.google_maps_url);
      if (!maps.ok) return next(new AppError(ERROR_MAPS, 400));
      est.google_maps_url = maps.valor;
    } else if (campo === 'id_calendario') {
      est.id_calendario = req.body.id_calendario || null;
    } else if (campo === 'orden') {
      est.orden = Number(req.body.orden) || 0;
    } else if (campo === 'activo') {
      est.activo = Number(req.body.activo) === 0 ? 0 : 1;
    } else {
      est[campo] = limpiar(req.body[campo]);
    }
  }

  // nombre y ciudad son la identidad de la sede: no pueden quedar vacíos
  if (!est.nombre || !est.ciudad) {
    return next(new AppError('El nombre y la ciudad no pueden ir vacíos', 400));
  }

  est.fecha_actualizacion = new Date();
  await est.save();

  return res.status(200).json({ status: 'success', data: est });
});

/* Borrado lógico: puede haber citas viejas apuntando a esta sede y perder de
   qué sede eran deja el histórico sin sentido. */
exports.eliminar = catchAsync(async (req, res, next) => {
  const { id } = req.body;
  if (!id) return next(new AppError('Falta id', 400));

  const est = await EstablecimientosChatCenter.findOne({
    where: { id, eliminado: 0 },
  });
  if (!est) return next(new AppError('Establecimiento no encontrado', 404));

  const [citas] = await db.query(
    `SELECT COUNT(*) AS n FROM appointments
      WHERE id_establecimiento = ?
        AND start_utc > NOW()
        AND status IN ('Agendado', 'Confirmado')`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );

  est.eliminado = 1;
  est.activo = 0;
  est.fecha_actualizacion = new Date();
  await est.save();

  return res.status(200).json({
    status: 'success',
    message: 'Establecimiento eliminado',
    // Se avisa, no se bloquea: la sede pudo cerrar y esas citas hay que
    // reubicarlas a mano de todos modos.
    citas_futuras_afectadas: Number(citas?.n || 0),
  });
});
