const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const fs = require('fs');
const path = require('path');

const DepartamentosChatCenter = require('../models/departamentos_chat_center.model');
const Sub_usuarios_departamento = require('../models/sub_usuarios_departamento.model');
const { sequelize } = require('../models/initModels');

exports.listarDepartamentos = catchAsync(async (req, res, next) => {
  const { id_usuario } = req.body;

  const departamentos = await DepartamentosChatCenter.findAll({
    where: { id_usuario },
  });

  if (!departamentos || departamentos.length === 0) {
    return res.status(200).json({
      status: 'success',
      data: [],
      message: 'No existen departamentos para este usuario.',
    });
  }

  const departamentosConUsuarios = await Promise.all(
    departamentos.map(async (dep) => {
      const asignaciones = await Sub_usuarios_departamento.findAll({
        where: { id_departamento: dep.id_departamento },
        attributes: ['id_sub_usuario'],
      });

      return {
        ...dep.toJSON(),
        usuarios_asignados: asignaciones.map((a) => a.id_sub_usuario),
      };
    })
  );

  res.status(200).json({
    status: 'success',
    data: departamentosConUsuarios,
  });
});

exports.agregarDepartamento = catchAsync(async (req, res, next) => {
  const {
    id_usuario,
    nombre_departamento,
    color,
    mensaje_saludo,
    usuarios_asignados = [], // Array de id_sub_usuario
  } = req.body;

  // Validaciones mínimas
  if (!id_usuario || !nombre_departamento || !color) {
    return res.status(400).json({
      status: 'fail',
      message: 'No ha llenado los datos del departamento.',
    });
  }

  // TIP: si quieres atomicidad total, usa una transacción:
  // const t = await sequelize.transaction();
  // try { ... await t.commit(); } catch (e) { await t.rollback(); throw e; }

  // 1) Crear el departamento
  const nuevoDepartamento = await DepartamentosChatCenter.create({
    id_usuario,
    nombre_departamento,
    color,
    mensaje_saludo,
  });

  const id_departamento = nuevoDepartamento.id_departamento;

  // 2) Insertar asignaciones (si llegan)
  if (Array.isArray(usuarios_asignados) && usuarios_asignados.length > 0) {
    const filas = usuarios_asignados.map((id_sub_usuario) => ({
      id_departamento,
      id_sub_usuario,
    }));

    // Si tienes un índice único (id_departamento, id_sub_usuario),
    // puedes usar ignoreDuplicates para evitar error si se repite algún ID:
    await Sub_usuarios_departamento.bulkCreate(filas, {
      ignoreDuplicates: true,
    });
  }

  // 3) Responder incluyendo los usuarios asignados
  res.status(201).json({
    status: 'success',
    data: {
      ...nuevoDepartamento.toJSON(),
      usuarios_asignados,
    },
  });
});

exports.actualizarDepartamento = catchAsync(async (req, res, next) => {
  const {
    id_departamento,
    nombre_departamento,
    color,
    mensaje_saludo,
    usuarios_asignados = [],
  } = req.body;

  if (!nombre_departamento || !color) {
    return res.status(400).json({
      status: 'fail',
      message: 'Faltan datos obligatorios: nombre_departamento o color',
    });
  }

  const departamento = await DepartamentosChatCenter.findByPk(id_departamento);
  if (!departamento) {
    return res.status(404).json({
      status: 'fail',
      message: 'Departamento no encontrado',
    });
  }

  const incoming = Array.from(
    new Set(
      (Array.isArray(usuarios_asignados) ? usuarios_asignados : []).map(Number)
    )
  );

  // ✅ instancia tomada del modelo
  const t = await DepartamentosChatCenter.sequelize.transaction();
  try {
    // 1) Actualizar datos del departamento
    await departamento.update(
      { nombre_departamento, color, mensaje_saludo },
      { transaction: t }
    );

    // 2) Obtener asignaciones actuales
    const actuales = await Sub_usuarios_departamento.findAll({
      where: { id_departamento },
      attributes: ['id_sub_usuario'],
      raw: true,
      transaction: t,
    });
    const actualesIds = new Set(actuales.map((a) => Number(a.id_sub_usuario)));

    // 3) Diff
    const toAdd = incoming.filter((id) => !actualesIds.has(id));
    const toRemove = [...actualesIds].filter((id) => !incoming.includes(id));

    // 4) Eliminar los no seleccionados
    if (toRemove.length > 0) {
      await Sub_usuarios_departamento.destroy({
        where: { id_departamento, id_sub_usuario: toRemove },
        transaction: t,
      });
    }

    // 5) Insertar nuevos
    if (toAdd.length > 0) {
      const filas = toAdd.map((id_sub_usuario) => ({
        id_departamento,
        id_sub_usuario,
      }));
      await Sub_usuarios_departamento.bulkCreate(filas, {
        ignoreDuplicates: true, // requiere índice único compuesto recomendado
        transaction: t,
      });
    }

    await t.commit();

    return res.status(200).json({
      status: 'success',
      data: { ...departamento.toJSON(), usuarios_asignados: incoming },
    });
  } catch (err) {
    await t.rollback();
    return next(err);
  }
});

exports.eliminarDepartamento = catchAsync(async (req, res, next) => {
  const { id_departamento } = req.body;

  const departamento = await DepartamentosChatCenter.findByPk(id_departamento);

  if (!departamento) {
    return res.status(404).json({
      status: 'fail',
      message: 'Departamento no encontrado.',
    });
  }

  await departamento.destroy();

  res.status(200).json({
    status: 'success',
    message: 'Departamento eliminado correctamente.',
  });
});
