const axios = require('axios');
const FormDataLib = require('form-data');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const TemplatesIAPrivados = require('../models/templates_ia_privados.model');
const EtapasLanding = require('../models/etapas_landing.model');

// ── Helper: subir imagen a S3 ──
async function uploadPrivateTemplateToS3(fileBuffer, originalName, userId) {
  try {
    const ext = originalName.split('.').pop() || 'png';
    const fileName = `templates-privados/user-${userId}-${Date.now()}.${ext}`;

    const form = new FormDataLib();
    form.append('file', fileBuffer, {
      filename: fileName,
      contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
    });

    const resp = await axios.post(
      'https://uploader.imporfactory.app/api/files/upload',
      form,
      {
        headers: form.getHeaders(),
        timeout: 30000,
        validateStatus: () => true,
      },
    );

    if (
      resp.status >= 200 &&
      resp.status < 300 &&
      resp.data?.success &&
      resp.data?.data?.url
    ) {
      return resp.data.data.url;
    }
    return null;
  } catch (err) {
    console.error('[TemplatesPrivados] S3 upload error:', err.message);
    return null;
  }
}

// ── Listar templates privados del usuario ──
exports.listar = catchAsync(async (req, res) => {
  const id_usuario = req.sessionUser?.id_usuario;

  const templates = await TemplatesIAPrivados.findAll({
    where: { id_usuario, activo: 1 },
    order: [['created_at', 'DESC']],
    attributes: ['id', 'nombre', 'src_url', 'id_etapa', 'created_at'],
    include: [
      {
        model: EtapasLanding,
        as: 'etapa',
        attributes: ['id', 'nombre', 'slug'],
        required: false,
      },
    ],
  });

  return res.json({ isSuccess: true, data: templates });
});

// ── Crear template privado (subir imagen) ──
exports.crear = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const nombre = String(req.body?.nombre || '').trim();
  const id_etapa = req.body?.id_etapa ? Number(req.body.id_etapa) : null;

  if (!nombre) return next(new AppError('El nombre es requerido', 400));

  if (!req.file) return next(new AppError('Debes subir una imagen', 400));

  const src_url = await uploadPrivateTemplateToS3(
    req.file.buffer,
    req.file.originalname,
    id_usuario,
  );

  if (!src_url) return next(new AppError('Error al subir la imagen', 500));

  const template = await TemplatesIAPrivados.create({
    id_usuario,
    nombre,
    src_url,
    id_etapa,
    activo: 1,
  });

  // Recargar con etapa
  const created = await TemplatesIAPrivados.findByPk(template.id, {
    attributes: ['id', 'nombre', 'src_url', 'id_etapa', 'created_at'],
    include: [
      {
        model: EtapasLanding,
        as: 'etapa',
        attributes: ['id', 'nombre', 'slug'],
        required: false,
      },
    ],
  });

  return res.status(201).json({ isSuccess: true, data: created });
});

// ── Eliminar template privado ──
exports.eliminar = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  const { id } = req.params;

  const template = await TemplatesIAPrivados.findOne({
    where: { id, id_usuario },
  });

  if (!template) return next(new AppError('Template no encontrado', 404));

  await template.update({ activo: 0 });

  return res.json({ isSuccess: true, message: 'Template eliminado' });
});
