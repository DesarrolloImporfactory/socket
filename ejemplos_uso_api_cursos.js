// Ejemplo de uso de la relación API <-> Cursos
// Este archivo muestra cómo usar las relaciones en tus controllers

const ImporsuitApi = require('../models/imporsuit/api.model');
const ImporsuitCursos = require('../models/imporsuit/cursos.model');
const ImporsuitApiCursos = require('../models/imporsuit/api_cursos.model');
const User = require('../models/user.model');

// ============================================
// 1. CREAR UNA API Y ASIGNARLE CURSOS
// ============================================
const crearApiConCursos = async (req, res) => {
  try {
    const { identificador, descripcion, id_users, cursos_ids } = req.body;

    // Crear la API
    const nuevaApi = await ImporsuitApi.create({
      identificador,
      descripcion,
      id_users,
    });

    // Asignar cursos a la API (al menos 1 requerido)
    if (!cursos_ids || cursos_ids.length === 0) {
      return res.status(400).json({
        error: 'Debe asignar al menos 1 curso a la API',
      });
    }

    // Crear las relaciones en api_cursos
    const relaciones = cursos_ids.map((id_curso) => ({
      id_api: nuevaApi.id_api,
      id_curso: id_curso,
      activo: true,
    }));

    await ImporsuitApiCursos.bulkCreate(relaciones);

    res.status(201).json({
      success: true,
      message: 'API creada y cursos asignados correctamente',
      data: nuevaApi,
    });
  } catch (error) {
    console.error('[CREATE_API_CURSOS]', error);
    res.status(500).json({ error: error.message });
  }
};

// ============================================
// 2. OBTENER API CON SUS CURSOS
// ============================================
const obtenerApiConCursos = async (req, res) => {
  try {
    const { id_api } = req.params;

    const api = await ImporsuitApi.findOne({
      where: { id_api },
      include: [
        {
          model: User,
          as: 'usuario',
          attributes: ['id_users', 'nombre_users', 'email_users'],
        },
        {
          model: ImporsuitCursos,
          as: 'cursos',
          through: {
            attributes: ['activo', 'fecha_asignacion'], // Datos de la tabla intermedia
            where: { activo: true }, // Solo cursos activos
          },
          include: [
            {
              model: User,
              as: 'instructor_usuario',
              attributes: ['id_users', 'nombre_users'],
            },
          ],
        },
      ],
    });

    if (!api) {
      return res.status(404).json({ error: 'API no encontrada' });
    }

    res.status(200).json({
      success: true,
      data: api,
    });
  } catch (error) {
    console.error('[GET_API_CURSOS]', error);
    res.status(500).json({ error: error.message });
  }
};

// ============================================
// 3. OBTENER CURSO CON SUS APIS
// ============================================
const obtenerCursoConApis = async (req, res) => {
  try {
    const { id_curso } = req.params;

    const curso = await ImporsuitCursos.findOne({
      where: { id_curso },
      include: [
        {
          model: User,
          as: 'instructor_usuario',
          attributes: ['id_users', 'nombre_users', 'email_users'],
        },
        {
          model: ImporsuitApi,
          as: 'apis',
          through: {
            attributes: ['activo', 'fecha_asignacion'],
            where: { activo: true },
          },
          include: [
            {
              model: User,
              as: 'usuario',
              attributes: ['id_users', 'nombre_users'],
            },
          ],
        },
      ],
    });

    if (!curso) {
      return res.status(404).json({ error: 'Curso no encontrado' });
    }

    res.status(200).json({
      success: true,
      data: curso,
    });
  } catch (error) {
    console.error('[GET_CURSO_APIS]', error);
    res.status(500).json({ error: error.message });
  }
};

// ============================================
// 4. AGREGAR MÁS CURSOS A UNA API EXISTENTE
// ============================================
const agregarCursosAApi = async (req, res) => {
  try {
    const { id_api } = req.params;
    const { cursos_ids } = req.body;

    if (!cursos_ids || cursos_ids.length === 0) {
      return res.status(400).json({ error: 'Debe proporcionar cursos_ids' });
    }

    // Verificar que la API existe
    const api = await ImporsuitApi.findByPk(id_api);
    if (!api) {
      return res.status(404).json({ error: 'API no encontrada' });
    }

    // Crear relaciones (si ya existe, el UNIQUE KEY evitará duplicados)
    const relaciones = cursos_ids.map((id_curso) => ({
      id_api,
      id_curso,
      activo: true,
    }));

    await ImporsuitApiCursos.bulkCreate(relaciones, {
      ignoreDuplicates: true, // Ignora duplicados
    });

    res.status(200).json({
      success: true,
      message: 'Cursos agregados correctamente',
    });
  } catch (error) {
    console.error('[ADD_CURSOS_API]', error);
    res.status(500).json({ error: error.message });
  }
};

// ============================================
// 5. REMOVER CURSO DE UNA API (soft delete)
// ============================================
const removerCursoDeApi = async (req, res) => {
  try {
    const { id_api, id_curso } = req.params;

    // Verificar que tenga al menos 2 cursos antes de eliminar
    const cursosActivos = await ImporsuitApiCursos.count({
      where: { id_api, activo: true },
    });

    if (cursosActivos <= 1) {
      return res.status(400).json({
        error: 'No se puede eliminar. La API debe tener al menos 1 curso',
      });
    }

    // Desactivar la relación (soft delete)
    await ImporsuitApiCursos.update(
      { activo: false, fecha_modificacion: new Date() },
      { where: { id_api, id_curso } }
    );

    res.status(200).json({
      success: true,
      message: 'Curso removido de la API',
    });
  } catch (error) {
    console.error('[REMOVE_CURSO_API]', error);
    res.status(500).json({ error: error.message });
  }
};

// ============================================
// 6. LISTAR TODAS LAS APIS CON SUS CURSOS
// ============================================
const listarApisConCursos = async (req, res) => {
  try {
    const apis = await ImporsuitApi.findAll({
      where: { fecha_eliminacion: null },
      include: [
        {
          model: User,
          as: 'usuario',
          attributes: ['id_users', 'nombre_users'],
        },
        {
          model: ImporsuitCursos,
          as: 'cursos',
          through: {
            attributes: ['activo', 'fecha_asignacion'],
            where: { activo: true },
          },
          attributes: ['id_curso', 'nombre', 'paquete', 'activo'],
        },
      ],
    });

    res.status(200).json({
      success: true,
      total: apis.length,
      data: apis,
    });
  } catch (error) {
    console.error('[LIST_APIS_CURSOS]', error);
    res.status(500).json({ error: error.message });
  }
};

// ============================================
// 7. BUSCAR CURSOS DISPONIBLES PARA UNA API
// ============================================
const cursosDisponiblesParaApi = async (req, res) => {
  try {
    const { id_api } = req.params;

    // Obtener cursos que YA están asignados a esta API
    const cursosAsignados = await ImporsuitApiCursos.findAll({
      where: { id_api, activo: true },
      attributes: ['id_curso'],
    });

    const idsAsignados = cursosAsignados.map((c) => c.id_curso);

    // Obtener cursos NO asignados
    const { Op } = require('sequelize');
    const cursosDisponibles = await ImporsuitCursos.findAll({
      where: {
        id_curso: { [Op.notIn]: idsAsignados },
        activo: true,
      },
      include: [
        {
          model: User,
          as: 'instructor_usuario',
          attributes: ['id_users', 'nombre_users'],
        },
      ],
    });

    res.status(200).json({
      success: true,
      total: cursosDisponibles.length,
      data: cursosDisponibles,
    });
  } catch (error) {
    console.error('[CURSOS_DISPONIBLES]', error);
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  crearApiConCursos,
  obtenerApiConCursos,
  obtenerCursoConApis,
  agregarCursosAApi,
  removerCursoDeApi,
  listarApisConCursos,
  cursosDisponiblesParaApi,
};
