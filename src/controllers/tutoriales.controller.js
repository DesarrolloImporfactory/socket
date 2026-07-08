const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db, db_2 } = require('../database/config');

/* ═══════════════════════════════════════════════════════════
   Tutoriales
   Trae cursos/módulos/contenidos desde db_2 (imporsuitpro) y los
   expone a los clientes de Imporchat. Qué módulos se muestran lo
   decide el super admin via CRUD (tabla tutoriales_modulos, db
   principal). El progreso por sub-usuario vive en tutoriales_progreso.
   Solo LECTURA hacia db_2 (no se duplica lógica de cursos).
   ═══════════════════════════════════════════════════════════ */

// util: lista de enteros segura para un IN (...)
function toIntList(arr) {
  return (arr || [])
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n));
}

/* ── PÚBLICO: módulos habilitados + contenidos + progreso del usuario ── */
exports.listPublic = catchAsync(async (req, res) => {
  const idSubUsuario = Number(req.sessionUser?.id_sub_usuario) || 0;

  const habilitados = await db.query(
    `SELECT id_curso, id_modulo, titulo, descripcion, orden
       FROM tutoriales_modulos
      WHERE activo = 1
      ORDER BY orden ASC, id ASC`,
    { type: db.QueryTypes.SELECT },
  );

  if (!habilitados.length) {
    return res.json({ success: true, data: { modulos: [] } });
  }

  const moduloIds = toIntList(habilitados.map((h) => h.id_modulo));

  // Nombres de módulo + curso (db_2)
  const modsInfo = await db_2.query(
    `SELECT m.id_modulo, m.id_curso, m.nombre AS nombre_modulo,
            c.nombre AS nombre_curso
       FROM cursos_modulos m
       LEFT JOIN cursos c ON c.id_curso = m.id_curso
      WHERE m.id_modulo IN (${moduloIds.join(',')})`,
    { type: db_2.QueryTypes.SELECT },
  );
  const modInfoById = new Map(modsInfo.map((m) => [String(m.id_modulo), m]));

  // Contenidos visibles de esos módulos (db_2)
  const contenidos = await db_2.query(
    `SELECT id_contenido, id_modulo, tipo, titulo, orden,
            video_url, video_provider, video_descripcion,
            contenido_html, thumbnail, duracion_segundos
       FROM cursos_contenidos
      WHERE id_modulo IN (${moduloIds.join(',')})
        AND visible = 1
      ORDER BY id_modulo ASC, orden ASC, id_contenido ASC`,
    { type: db_2.QueryTypes.SELECT },
  );

  // Progreso del usuario
  const progreso = idSubUsuario
    ? await db.query(
        `SELECT id_contenido FROM tutoriales_progreso
          WHERE id_sub_usuario = ? AND completado = 1`,
        { replacements: [idSubUsuario], type: db.QueryTypes.SELECT },
      )
    : [];
  const completados = new Set(progreso.map((p) => String(p.id_contenido)));

  const contenidosByModulo = new Map();
  for (const c of contenidos) {
    const key = String(c.id_modulo);
    if (!contenidosByModulo.has(key)) contenidosByModulo.set(key, []);
    contenidosByModulo.get(key).push({
      id_contenido: c.id_contenido,
      tipo: c.tipo,
      titulo: c.titulo,
      orden: c.orden,
      video_url: c.video_url,
      video_provider: c.video_provider,
      video_descripcion: c.video_descripcion,
      contenido_html: c.contenido_html,
      thumbnail: c.thumbnail,
      duracion_segundos: c.duracion_segundos,
      completado: completados.has(String(c.id_contenido)),
    });
  }

  const modulos = habilitados
    .map((h) => {
      const info = modInfoById.get(String(h.id_modulo));
      if (!info) return null; // módulo ya no existe/está inactivo en db_2
      const items = contenidosByModulo.get(String(h.id_modulo)) || [];
      return {
        id_modulo: h.id_modulo,
        id_curso: h.id_curso,
        nombre_modulo: h.titulo || info.nombre_modulo,
        nombre_curso: info.nombre_curso,
        descripcion: h.descripcion || null,
        orden: h.orden,
        total: items.length,
        completados: items.filter((i) => i.completado).length,
        contenidos: items,
      };
    })
    .filter(Boolean);

  res.json({ success: true, data: { modulos } });
});

/* ── PÚBLICO: marcar/desmarcar un contenido como completado ── */
exports.marcarProgreso = catchAsync(async (req, res, next) => {
  const idSubUsuario = Number(req.sessionUser?.id_sub_usuario) || 0;
  const idContenido = Number(req.body?.id_contenido);
  const completado = req.body?.completado ? 1 : 0;

  if (!idSubUsuario) return next(new AppError('Sesión inválida', 401));
  if (!idContenido) return next(new AppError('id_contenido es requerido', 400));

  await db.query(
    `INSERT INTO tutoriales_progreso
        (id_sub_usuario, id_contenido, completado, completado_at)
     VALUES (?, ?, ?, ${completado ? 'NOW()' : 'NULL'})
     ON DUPLICATE KEY UPDATE
        completado = VALUES(completado),
        completado_at = ${completado ? 'NOW()' : 'NULL'}`,
    {
      replacements: [idSubUsuario, idContenido, completado],
      type: db.QueryTypes.INSERT,
    },
  );

  res.json({ success: true });
});

/* ── ADMIN: catálogo de cursos/módulos de db_2 + estado de habilitación ── */
exports.adminListCursos = catchAsync(async (req, res) => {
  const cursos = await db_2.query(
    `SELECT id_curso, nombre, paquete FROM cursos WHERE activo = 1 ORDER BY nombre ASC`,
    { type: db_2.QueryTypes.SELECT },
  );

  const modulos = await db_2.query(
    `SELECT m.id_modulo, m.id_curso, m.nombre AS nombre_modulo, m.orden,
            (SELECT COUNT(*) FROM cursos_contenidos cc
              WHERE cc.id_modulo = m.id_modulo AND cc.visible = 1) AS total_contenidos
       FROM cursos_modulos m
      WHERE m.activo = 1
      ORDER BY m.id_curso ASC, m.orden ASC`,
    { type: db_2.QueryTypes.SELECT },
  );

  const habilitados = await db.query(
    `SELECT id_modulo, titulo, descripcion, orden, activo FROM tutoriales_modulos`,
    { type: db.QueryTypes.SELECT },
  );
  const habById = new Map(habilitados.map((h) => [String(h.id_modulo), h]));

  const modsByCurso = new Map();
  for (const m of modulos) {
    const h = habById.get(String(m.id_modulo));
    const item = {
      id_modulo: m.id_modulo,
      id_curso: m.id_curso,
      nombre_modulo: m.nombre_modulo,
      total_contenidos: Number(m.total_contenidos) || 0,
      habilitado: !!h,
      activo: h ? !!h.activo : false,
      orden: h ? h.orden : 0,
      titulo_override: h?.titulo || null,
      descripcion_override: h?.descripcion || null,
    };
    const key = String(m.id_curso);
    if (!modsByCurso.has(key)) modsByCurso.set(key, []);
    modsByCurso.get(key).push(item);
  }

  const data = cursos.map((c) => ({
    id_curso: c.id_curso,
    nombre: c.nombre,
    paquete: c.paquete,
    modulos: modsByCurso.get(String(c.id_curso)) || [],
  }));

  res.json({ success: true, data });
});

/* ── ADMIN: crear/actualizar la habilitación de un módulo ── */
exports.adminUpsertModulo = catchAsync(async (req, res, next) => {
  const idCurso = Number(req.body?.id_curso);
  const idModulo = Number(req.body?.id_modulo);
  const orden = Number.isInteger(Number(req.body?.orden))
    ? Number(req.body.orden)
    : 0;
  const activo = req.body?.activo ? 1 : 0;
  const titulo = req.body?.titulo?.trim() || null;
  const descripcion = req.body?.descripcion?.trim() || null;

  if (!idCurso || !idModulo) {
    return next(new AppError('id_curso e id_modulo son requeridos', 400));
  }

  await db.query(
    `INSERT INTO tutoriales_modulos
        (id_curso, id_modulo, titulo, descripcion, orden, activo)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
        id_curso = VALUES(id_curso),
        titulo = VALUES(titulo),
        descripcion = VALUES(descripcion),
        orden = VALUES(orden),
        activo = VALUES(activo)`,
    {
      replacements: [idCurso, idModulo, titulo, descripcion, orden, activo],
      type: db.QueryTypes.INSERT,
    },
  );

  res.json({ success: true });
});

/* ── ADMIN: quitar un módulo de la lista de tutoriales ── */
exports.adminDeleteModulo = catchAsync(async (req, res, next) => {
  const idModulo = Number(req.params?.id_modulo);
  if (!idModulo) return next(new AppError('id_modulo inválido', 400));

  await db.query(`DELETE FROM tutoriales_modulos WHERE id_modulo = ?`, {
    replacements: [idModulo],
    type: db.QueryTypes.DELETE,
  });

  res.json({ success: true });
});
