// controllers/kanban_columnas.controller.js
// CRUD de columnas Kanban por configuración + tableros secundarios
// ─────────────────────────────────────────────────────────────
//
// Tableros: el PRINCIPAL vive en clientes_chat_center.estado_contacto y sus
// columnas tienen id_tablero = NULL (lo lee el bot, remarketing, webhook…).
// Los SECUNDARIOS (kanban_tableros) guardan el estado de cada contacto en
// clientes_estados_tablero, así un mismo cliente puede estar en un embudo de
// ecommerce y en otro de importaciones sin que el bot se entere.
// estado_db sigue siendo único por cuenta: una columna se identifica con su
// estado_db esté en el tablero que esté.

const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const { db } = require('../database/config');
const {
  syncCatalogoKanbanColumna,
} = require('../services/syncCatalogoKanbanColumna.service');
const {
  getKanbanConfigCuenta,
  setKanbanConfigCuenta,
} = require('../utils/kanbanConfigCuenta');

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Normaliza el `id_tablero` que manda el front:
 *   undefined / null / '' / 'principal' → null   (tablero principal)
 *   'todos'                             → 'todos' (todas las columnas)
 *   número                              → id del tablero secundario
 */
function parseTablero(v) {
  if (v === undefined || v === null || v === '' || v === 'principal')
    return null;
  if (v === 'todos') return 'todos';
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Fragmento WHERE + params para acotar a un tablero. */
function whereTablero(tablero, alias = '') {
  if (tablero === 'todos') return { frag: '', params: [] };
  if (tablero === null)
    return { frag: ` AND ${alias}id_tablero IS NULL`, params: [] };
  return { frag: ` AND ${alias}id_tablero = ?`, params: [tablero] };
}

/** Devuelve las columnas de una configuración (por defecto, del principal). */
async function getColumnas(id_configuracion, tablero = null) {
  const t = whereTablero(tablero);
  return db.query(
    `SELECT id, id_tablero, nombre, estado_db, color_fondo, color_texto, icono,
        orden, activo, es_estado_final, es_principal, es_dropi_principal,
        activa_ia, max_tokens, assistant_id, vector_store_id,
        vector_store_docs_id, catalog_file_id, catalog_synced_at
     FROM kanban_columnas
     WHERE id_configuracion = ?${t.frag}
     ORDER BY id_tablero IS NOT NULL, id_tablero, orden ASC`,
    {
      replacements: [id_configuracion, ...t.params],
      type: db.QueryTypes.SELECT,
    },
  );
}

/** Tableros secundarios activos de la cuenta, con su conteo de columnas. */
async function getTableros(id_configuracion) {
  return db.query(
    `SELECT t.id, t.nombre, t.descripcion, t.orden,
            (SELECT COUNT(*) FROM kanban_columnas kc
              WHERE kc.id_tablero = t.id) AS columnas
       FROM kanban_tableros t
      WHERE t.id_configuracion = ? AND t.activo = 1
      ORDER BY t.orden ASC, t.id ASC`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
}

/** id_tablero (o null) de una columna, para responder la lista correcta. */
async function tableroDeColumna(id, id_configuracion) {
  const [col] = await db.query(
    `SELECT id_tablero FROM kanban_columnas
      WHERE id = ? AND id_configuracion = ? LIMIT 1`,
    { replacements: [id, id_configuracion], type: db.QueryTypes.SELECT },
  );
  return col ? (col.id_tablero ?? null) : null;
}

async function tableroValido(id_tablero, id_configuracion) {
  const [t] = await db.query(
    `SELECT id FROM kanban_tableros
      WHERE id = ? AND id_configuracion = ? AND activo = 1 LIMIT 1`,
    {
      replacements: [id_tablero, id_configuracion],
      type: db.QueryTypes.SELECT,
    },
  );
  return !!t;
}

/** Orden consecutivo 1..n dentro de un tablero. */
async function compactarOrden(id_configuracion, tablero) {
  const t = whereTablero(tablero);
  const restantes = await db.query(
    `SELECT id FROM kanban_columnas
      WHERE id_configuracion = ?${t.frag} ORDER BY orden ASC`,
    {
      replacements: [id_configuracion, ...t.params],
      type: db.QueryTypes.SELECT,
    },
  );
  await Promise.all(
    restantes.map((c, i) =>
      db.query(`UPDATE kanban_columnas SET orden = ? WHERE id = ?`, {
        replacements: [i + 1, c.id],
        type: db.QueryTypes.UPDATE,
      }),
    ),
  );
}

// ─── Listar columnas ──────────────────────────────────────────
// POST /kanban_columnas/listar
// Body: { id_configuracion, id_tablero? }  (null/omitido = principal, 'todos', id)
exports.listarColumnas = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));

  const tablero = parseTablero(req.body.id_tablero);

  const [columnas, config, tableros] = await Promise.all([
    getColumnas(id_configuracion, tablero),
    getKanbanConfigCuenta(id_configuracion),
    getTableros(id_configuracion),
  ]);

  /* `config` (ajustes por cuenta) y `tableros` (secundarios) van como claves
     hermanas de `data` para no romper a los consumidores que solo leen la
     lista de columnas del principal (chat, remarketing, plantillas…). */
  return res
    .status(200)
    .json({ success: true, data: columnas, config, tableros });
});

// ─── Ajustes del tablero a nivel de cuenta ────────────────────
// POST /kanban_columnas/actualizar_config
// Body: { id_configuracion, volver_al_cerrar }
exports.actualizarConfig = catchAsync(async (req, res, next) => {
  const { id_configuracion, volver_al_cerrar } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));
  if (volver_al_cerrar === undefined)
    return next(new AppError('No se enviaron ajustes para actualizar', 400));

  try {
    await setKanbanConfigCuenta(id_configuracion, { volver_al_cerrar });
  } catch (err) {
    console.error('[kanban_columnas/actualizar_config]', err.message);
    return next(
      new AppError(
        'No se pudo guardar el ajuste. Verifica que las migraciones del kanban estén aplicadas.',
        500,
      ),
    );
  }

  const config = await getKanbanConfigCuenta(id_configuracion);
  return res.status(200).json({ success: true, config });
});

// ─── Tableros secundarios ─────────────────────────────────────
// POST /kanban_columnas/tableros_crear   { id_configuracion, nombre, descripcion? }
exports.crearTablero = catchAsync(async (req, res, next) => {
  const { id_configuracion, nombre, descripcion = null } = req.body;
  if (!id_configuracion || !String(nombre || '').trim())
    return next(new AppError('Faltan id_configuracion y nombre', 400));

  const [{ maxOrden }] = await db.query(
    `SELECT COALESCE(MAX(orden), 0) AS maxOrden
       FROM kanban_tableros WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  const [id] = await db.query(
    `INSERT INTO kanban_tableros (id_configuracion, nombre, descripcion, orden)
     VALUES (?, ?, ?, ?)`,
    {
      replacements: [
        id_configuracion,
        String(nombre).trim(),
        descripcion ? String(descripcion).trim() : null,
        maxOrden + 1,
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  const tableros = await getTableros(id_configuracion);
  return res.status(201).json({ success: true, id, tableros });
});

// POST /kanban_columnas/tableros_actualizar   { id, id_configuracion, nombre?, descripcion?, orden? }
exports.actualizarTablero = catchAsync(async (req, res, next) => {
  const { id, id_configuracion, nombre, descripcion, orden } = req.body;
  if (!id || !id_configuracion)
    return next(new AppError('Faltan id e id_configuracion', 400));

  const sets = [];
  const params = [];
  if (nombre !== undefined) {
    if (!String(nombre).trim())
      return next(new AppError('El nombre no puede quedar vacío', 400));
    sets.push('nombre = ?');
    params.push(String(nombre).trim());
  }
  if (descripcion !== undefined) {
    sets.push('descripcion = ?');
    params.push(descripcion ? String(descripcion).trim() : null);
  }
  if (orden !== undefined) {
    sets.push('orden = ?');
    params.push(parseInt(orden, 10) || 0);
  }
  if (!sets.length)
    return next(new AppError('No se enviaron campos para actualizar', 400));

  await db.query(
    `UPDATE kanban_tableros SET ${sets.join(', ')}
      WHERE id = ? AND id_configuracion = ?`,
    {
      replacements: [...params, id, id_configuracion],
      type: db.QueryTypes.UPDATE,
    },
  );

  const tableros = await getTableros(id_configuracion);
  return res.status(200).json({ success: true, tableros });
});

// POST /kanban_columnas/tableros_eliminar   { id, id_configuracion }
// Solo se borra vacío: mover o eliminar sus columnas primero. Así nunca
// quedan estados de contactos apuntando a un tablero inexistente.
exports.eliminarTablero = catchAsync(async (req, res, next) => {
  const { id, id_configuracion } = req.body;
  if (!id || !id_configuracion)
    return next(new AppError('Faltan id e id_configuracion', 400));

  if (!(await tableroValido(id, id_configuracion)))
    return next(new AppError('Tablero no encontrado', 404));

  const [{ total }] = await db.query(
    `SELECT COUNT(*) AS total FROM kanban_columnas WHERE id_tablero = ?`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );
  if (Number(total) > 0)
    return next(
      new AppError(
        'El tablero todavía tiene columnas. Muévelas al principal o elimínalas antes de borrarlo.',
        400,
      ),
    );

  await db.query(`DELETE FROM clientes_estados_tablero WHERE id_tablero = ?`, {
    replacements: [id],
    type: db.QueryTypes.DELETE,
  });
  await db.query(
    `DELETE FROM kanban_tableros WHERE id = ? AND id_configuracion = ?`,
    { replacements: [id, id_configuracion], type: db.QueryTypes.DELETE },
  );

  const tableros = await getTableros(id_configuracion);
  return res.status(200).json({ success: true, tableros });
});

// POST /kanban_columnas/mover_a_tablero   { id, id_configuracion, id_tablero }
// Cambia una columna de tablero llevándose a sus contactos:
//   principal → secundario: los contactos entran al tablero secundario en esa
//     columna y en el principal vuelven a la columna principal (o la primera).
//   secundario → principal: sus contactos pasan a estado_contacto = esa
//     columna (pisa el estado principal que tuvieran) y salen del secundario.
//   secundario → secundario: se reasignan de tablero.
exports.moverColumnaATablero = catchAsync(async (req, res, next) => {
  const { id, id_configuracion } = req.body;
  if (!id || !id_configuracion)
    return next(new AppError('Faltan id e id_configuracion', 400));

  const destino = parseTablero(req.body.id_tablero);
  if (destino === 'todos')
    return next(new AppError('Tablero destino inválido', 400));
  if (destino !== null && !(await tableroValido(destino, id_configuracion)))
    return next(new AppError('Tablero destino no encontrado', 404));

  const [col] = await db.query(
    `SELECT id, id_tablero, estado_db, es_principal, es_dropi_principal
       FROM kanban_columnas WHERE id = ? AND id_configuracion = ? LIMIT 1`,
    { replacements: [id, id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!col) return next(new AppError('Columna no encontrada', 404));

  const origen = col.id_tablero ?? null;
  if (origen === destino)
    return res.status(200).json({
      success: true,
      data: await getColumnas(id_configuracion, destino),
      tableros: await getTableros(id_configuracion),
    });

  if (col.es_principal || col.es_dropi_principal)
    return next(
      new AppError(
        'Esta columna es la principal (o la de Dropi). Marca otra antes de moverla de tablero.',
        400,
      ),
    );

  let contactos_movidos = 0;

  if (origen === null) {
    // principal → secundario
    const [principal] = await db.query(
      `SELECT estado_db FROM kanban_columnas
        WHERE id_configuracion = ? AND id_tablero IS NULL AND id != ?
        ORDER BY es_principal DESC, orden ASC LIMIT 1`,
      { replacements: [id_configuracion, id], type: db.QueryTypes.SELECT },
    );
    if (!principal)
      return next(
        new AppError(
          'No puedes mover la única columna del tablero principal.',
          400,
        ),
      );

    const [, ins] = await db.query(
      `INSERT INTO clientes_estados_tablero (id_configuracion, id_tablero, id_cliente, estado_db)
       SELECT id_configuracion, ?, id, estado_db
         FROM clientes_chat_center
        WHERE id_configuracion = ? AND estado_contacto = ? AND deleted_at IS NULL
       ON DUPLICATE KEY UPDATE estado_db = VALUES(estado_db)`,
      {
        replacements: [destino, id_configuracion, col.estado_db],
        type: db.QueryTypes.INSERT,
      },
    );
    contactos_movidos = ins?.affectedRows ?? ins ?? 0;

    await db.query(
      `UPDATE clientes_chat_center SET estado_contacto = ?
        WHERE id_configuracion = ? AND estado_contacto = ?`,
      {
        replacements: [principal.estado_db, id_configuracion, col.estado_db],
        type: db.QueryTypes.UPDATE,
      },
    );
  } else if (destino === null) {
    // secundario → principal
    const [, upd] = await db.query(
      `UPDATE clientes_chat_center c
         JOIN clientes_estados_tablero cet
           ON cet.id_cliente = c.id AND cet.id_tablero = ? AND cet.estado_db = ?
          SET c.estado_contacto = cet.estado_db`,
      {
        replacements: [origen, col.estado_db],
        type: db.QueryTypes.UPDATE,
      },
    );
    contactos_movidos = upd?.affectedRows ?? upd ?? 0;
    await db.query(
      `DELETE FROM clientes_estados_tablero WHERE id_tablero = ? AND estado_db = ?`,
      { replacements: [origen, col.estado_db], type: db.QueryTypes.DELETE },
    );
  } else {
    // secundario → secundario. Si el contacto ya estaba en el tablero destino
    // en otra columna, gana la que se mueve (se reemplaza).
    await db.query(
      `DELETE cet FROM clientes_estados_tablero cet
         JOIN clientes_estados_tablero o
           ON o.id_cliente = cet.id_cliente AND o.id_tablero = ? AND o.estado_db = ?
        WHERE cet.id_tablero = ?`,
      {
        replacements: [origen, col.estado_db, destino],
        type: db.QueryTypes.DELETE,
      },
    );
    const [, upd] = await db.query(
      `UPDATE clientes_estados_tablero SET id_tablero = ?
        WHERE id_tablero = ? AND estado_db = ?`,
      {
        replacements: [destino, origen, col.estado_db],
        type: db.QueryTypes.UPDATE,
      },
    );
    contactos_movidos = upd?.affectedRows ?? upd ?? 0;
  }

  // La columna cambia de tablero. Fuera del principal no hay IA ni remarketing.
  const [{ maxOrden }] = await db.query(
    `SELECT COALESCE(MAX(orden), 0) AS maxOrden FROM kanban_columnas
      WHERE id_configuracion = ? ${destino === null ? 'AND id_tablero IS NULL' : 'AND id_tablero = ?'}`,
    {
      replacements:
        destino === null ? [id_configuracion] : [id_configuracion, destino],
      type: db.QueryTypes.SELECT,
    },
  );
  await db.query(
    `UPDATE kanban_columnas
        SET id_tablero = ?, orden = ?,
            activa_ia = IF(? IS NULL, activa_ia, 0),
            tiempo_remarketing = IF(? IS NULL, tiempo_remarketing, NULL)
      WHERE id = ? AND id_configuracion = ?`,
    {
      replacements: [
        destino,
        maxOrden + 1,
        destino,
        destino,
        id,
        id_configuracion,
      ],
      type: db.QueryTypes.UPDATE,
    },
  );
  await compactarOrden(id_configuracion, origen);

  return res.status(200).json({
    success: true,
    contactos_movidos: Number(contactos_movidos) || 0,
    data: await getColumnas(id_configuracion, origen),
    tableros: await getTableros(id_configuracion),
  });
});

// ─── Crear columna ────────────────────────────────────────────
// POST /kanban_columnas/crear
exports.crearColumna = catchAsync(async (req, res, next) => {
  const {
    id_configuracion,
    nombre,
    estado_db,
    color_fondo = '#e3f2fd',
    color_texto = '#1a237e',
    icono = null,
    es_estado_final = 0,
  } = req.body;

  if (!id_configuracion || !nombre || !estado_db)
    return next(new AppError('Faltan campos obligatorios', 400));

  const tablero = parseTablero(req.body.id_tablero);
  if (tablero === 'todos')
    return next(new AppError('Indica en qué tablero va la columna', 400));
  if (tablero !== null && !(await tableroValido(tablero, id_configuracion)))
    return next(new AppError('Tablero no encontrado', 404));

  // Sanitizar estado_db → lowercase snake_case
  const estado_db_clean = estado_db.trim().toLowerCase().replace(/\s+/g, '_');

  // Verificar duplicado (único por cuenta, sin importar el tablero)
  const [dup] = await db.query(
    `SELECT id FROM kanban_columnas
     WHERE id_configuracion = ? AND estado_db = ?`,
    {
      replacements: [id_configuracion, estado_db_clean],
      type: db.QueryTypes.SELECT,
    },
  );
  if (dup)
    return next(new AppError('Ya existe una columna con ese estado_db', 409));

  // Obtener el máximo orden actual del tablero
  const t = whereTablero(tablero);
  const [{ maxOrden }] = await db.query(
    `SELECT COALESCE(MAX(orden), 0) AS maxOrden
     FROM kanban_columnas WHERE id_configuracion = ?${t.frag}`,
    {
      replacements: [id_configuracion, ...t.params],
      type: db.QueryTypes.SELECT,
    },
  );

  const [id] = await db.query(
    `INSERT INTO kanban_columnas
       (id_configuracion, id_tablero, nombre, estado_db, color_fondo, color_texto, icono, orden, es_estado_final)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    {
      replacements: [
        id_configuracion,
        tablero,
        nombre.trim(),
        estado_db_clean,
        color_fondo,
        color_texto,
        icono,
        maxOrden + 1,
        es_estado_final ? 1 : 0,
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  const columnas = await getColumnas(id_configuracion, tablero);
  return res.status(201).json({ success: true, id, data: columnas });
});

// ─── Actualizar columna ───────────────────────────────────────
// POST /kanban_columnas/actualizar
exports.actualizarColumna = catchAsync(async (req, res, next) => {
  const {
    id,
    id_configuracion,
    nombre,
    estado_db,
    color_fondo,
    color_texto,
    icono,
    activo,
    es_estado_final,
  } = req.body;

  if (!id || !id_configuracion)
    return next(new AppError('Faltan campos obligatorios', 400));

  const sets = [];
  const params = [];

  if (nombre !== undefined) {
    sets.push('nombre = ?');
    params.push(nombre.trim());
  }
  if (estado_db !== undefined) {
    const clean = estado_db.trim().toLowerCase().replace(/\s+/g, '_');
    sets.push('estado_db = ?');
    params.push(clean);
  }
  if (color_fondo !== undefined) {
    sets.push('color_fondo = ?');
    params.push(color_fondo);
  }
  if (color_texto !== undefined) {
    sets.push('color_texto = ?');
    params.push(color_texto);
  }
  if (icono !== undefined) {
    sets.push('icono = ?');
    params.push(icono);
  }
  if (activo !== undefined) {
    sets.push('activo = ?');
    params.push(activo ? 1 : 0);
  }
  if (es_estado_final !== undefined) {
    sets.push('es_estado_final = ?');
    params.push(es_estado_final ? 1 : 0);
  }

  if (!sets.length)
    return next(new AppError('No se enviaron campos para actualizar', 400));

  await db.query(
    `UPDATE kanban_columnas SET ${sets.join(', ')}
     WHERE id = ? AND id_configuracion = ?`,
    {
      replacements: [...params, id, id_configuracion],
      type: db.QueryTypes.UPDATE,
    },
  );

  const columnas = await getColumnas(
    id_configuracion,
    await tableroDeColumna(id, id_configuracion),
  );
  return res.status(200).json({ success: true, data: columnas });
});

// ─── Eliminar columna ─────────────────────────────────────────
// POST /kanban_columnas/eliminar
// Body: { id, id_configuracion, mover_a_estado_db? }
exports.eliminarColumna = catchAsync(async (req, res, next) => {
  const { id, id_configuracion, mover_a_estado_db } = req.body;
  if (!id || !id_configuracion)
    return next(new AppError('Faltan id e id_configuracion', 400));

  // 1. Obtener la columna a eliminar
  const [columna] = await db.query(
    `SELECT id, id_tablero, estado_db, nombre, es_principal, es_dropi_principal
     FROM kanban_columnas
     WHERE id = ? AND id_configuracion = ? LIMIT 1`,
    { replacements: [id, id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!columna) return next(new AppError('Columna no encontrada', 404));

  const tablero = columna.id_tablero ?? null;
  const t = whereTablero(tablero);

  // 2. Bloquear si es principal
  if (columna.es_principal) {
    return next(
      new AppError(
        'No puedes eliminar la columna principal. Primero marca otra como principal.',
        400,
      ),
    );
  }

  // 3. Bloquear si es dropi principal
  if (columna.es_dropi_principal) {
    return next(
      new AppError(
        'No puedes eliminar la conexión principal de Dropi. Primero asigna esa conexión a otra columna.',
        400,
      ),
    );
  }

  // 4. Bloquear si es la única columna del tablero principal. En un tablero
  //    secundario sí se puede vaciar: sus contactos simplemente salen de él.
  const [{ total }] = await db.query(
    `SELECT COUNT(*) AS total FROM kanban_columnas
      WHERE id_configuracion = ?${t.frag}`,
    {
      replacements: [id_configuracion, ...t.params],
      type: db.QueryTypes.SELECT,
    },
  );
  if (tablero === null && total <= 1) {
    return next(
      new AppError('No puedes eliminar la única columna del kanban.', 400),
    );
  }

  // 5. Determinar destino de los chats existentes (dentro del mismo tablero)
  let destinoEstadoDb = mover_a_estado_db;

  if (destinoEstadoDb) {
    // Validar que la columna destino exista en el mismo tablero y NO sea la que se va a borrar
    const [destinoOk] = await db.query(
      `SELECT id FROM kanban_columnas
       WHERE id_configuracion = ? AND estado_db = ? AND id != ?${t.frag} LIMIT 1`,
      {
        replacements: [id_configuracion, destinoEstadoDb, id, ...t.params],
        type: db.QueryTypes.SELECT,
      },
    );
    if (!destinoOk) {
      return next(new AppError('La columna destino no es válida.', 400));
    }
  } else if (tablero === null) {
    // Si no envió destino → usar la principal, o la primera disponible
    const [principal] = await db.query(
      `SELECT estado_db FROM kanban_columnas
       WHERE id_configuracion = ? AND id_tablero IS NULL AND es_principal = 1 AND id != ? LIMIT 1`,
      { replacements: [id_configuracion, id], type: db.QueryTypes.SELECT },
    );
    if (principal) {
      destinoEstadoDb = principal.estado_db;
    } else {
      const [primera] = await db.query(
        `SELECT estado_db FROM kanban_columnas
         WHERE id_configuracion = ? AND id_tablero IS NULL AND id != ?
         ORDER BY orden ASC LIMIT 1`,
        { replacements: [id_configuracion, id], type: db.QueryTypes.SELECT },
      );
      destinoEstadoDb = primera?.estado_db;
    }
  } else {
    const [primera] = await db.query(
      `SELECT estado_db FROM kanban_columnas
       WHERE id_configuracion = ? AND id_tablero = ? AND id != ?
       ORDER BY orden ASC LIMIT 1`,
      {
        replacements: [id_configuracion, tablero, id],
        type: db.QueryTypes.SELECT,
      },
    );
    destinoEstadoDb = primera?.estado_db || null; // null = salen del tablero
  }

  if (tablero === null && !destinoEstadoDb) {
    return next(
      new AppError('No hay columna destino para mover los chats.', 400),
    );
  }

  // 6. Mover chats existentes al destino
  if (tablero === null) {
    await db.query(
      `UPDATE clientes_chat_center
       SET estado_contacto = ?
       WHERE estado_contacto = ? AND id_configuracion = ?`,
      {
        replacements: [destinoEstadoDb, columna.estado_db, id_configuracion],
        type: db.QueryTypes.UPDATE,
      },
    );
  } else if (destinoEstadoDb) {
    await db.query(
      `UPDATE clientes_estados_tablero SET estado_db = ?
        WHERE id_tablero = ? AND estado_db = ?`,
      {
        replacements: [destinoEstadoDb, tablero, columna.estado_db],
        type: db.QueryTypes.UPDATE,
      },
    );
  } else {
    await db.query(
      `DELETE FROM clientes_estados_tablero WHERE id_tablero = ? AND estado_db = ?`,
      {
        replacements: [tablero, columna.estado_db],
        type: db.QueryTypes.DELETE,
      },
    );
  }

  // 7. Eliminar acciones asociadas (por si no hay ON DELETE CASCADE)
  await db.query(`DELETE FROM kanban_acciones WHERE id_kanban_columna = ?`, {
    replacements: [id],
    type: db.QueryTypes.DELETE,
  });

  // 8. Eliminar remarketings asociados (si la tabla existe)
  try {
    await db.query(
      `DELETE FROM kanban_remarketings WHERE id_kanban_columna = ?`,
      { replacements: [id], type: db.QueryTypes.DELETE },
    );
  } catch (_) {
    /* si la tabla no existe o el campo se llama distinto, ignorar */
  }

  // 9. Eliminar la columna
  await db.query(
    `DELETE FROM kanban_columnas WHERE id = ? AND id_configuracion = ?`,
    { replacements: [id, id_configuracion], type: db.QueryTypes.DELETE },
  );

  // 10. Reordenar columnas restantes del tablero (orden consecutivo sin huecos)
  await compactarOrden(id_configuracion, tablero);

  const columnas = await getColumnas(id_configuracion, tablero);
  return res.status(200).json({
    success: true,
    data: columnas,
    chats_movidos_a: destinoEstadoDb || 'fuera del tablero',
  });
});

// ─── Reordenar columnas ───────────────────────────────────────
// POST /kanban_columnas/reordenar
// Body: { id_configuracion, orden: [{ id, orden }] }
exports.reordenarColumnas = catchAsync(async (req, res, next) => {
  const { id_configuracion, orden } = req.body;

  if (!id_configuracion || !Array.isArray(orden) || !orden.length)
    return next(new AppError('Faltan datos para reordenar', 400));

  // Actualizar en batch (una query por fila — simple y seguro)
  await Promise.all(
    orden.map(({ id, orden: o }) =>
      db.query(
        `UPDATE kanban_columnas SET orden = ?
         WHERE id = ? AND id_configuracion = ?`,
        { replacements: [o, id, id_configuracion], type: db.QueryTypes.UPDATE },
      ),
    ),
  );

  const columnas = await getColumnas(
    id_configuracion,
    await tableroDeColumna(orden[0].id, id_configuracion),
  );
  return res.status(200).json({ success: true, data: columnas });
});

// ─── Obtener columna por id ───────────────────────────────────
// POST /kanban_columnas/obtener
exports.obtenerColumna = catchAsync(async (req, res, next) => {
  const { id, id_configuracion } = req.body;
  if (!id || !id_configuracion)
    return next(new AppError('Faltan id e id_configuracion', 400));

  const [columna] = await db.query(
    `SELECT * FROM kanban_columnas WHERE id = ? AND id_configuracion = ?`,
    { replacements: [id, id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (!columna) return next(new AppError('Columna no encontrada', 404));
  return res.status(200).json({ success: true, data: columna });
});

// ── sync_catalogo ─────────────────────────────────────────────
exports.syncCatalogo = catchAsync(async (req, res, next) => {
  const { id_kanban_columna } = req.body;
  if (!id_kanban_columna)
    return next(new AppError('Falta id_kanban_columna', 400));

  const resultado = await syncCatalogoKanbanColumna(id_kanban_columna);

  if (resultado.skipped) {
    return res
      .status(200)
      .json({ success: true, skipped: true, message: resultado.reason });
  }

  return res.status(200).json({
    success: true,
    vector_store_id: resultado.vector_store_id,
    catalog_file_id: resultado.catalog_file_id,
    total_items: resultado.total_items,
  });
});

exports.sincronizarCatalogo = catchAsync(async (req, res, next) => {
  const { id } = req.body;
  if (!id) return next(new AppError('Falta id', 400));

  // Marcar como procesando ANTES de responder
  await db.query(
    `UPDATE kanban_columnas SET sync_status = 'procesando', sync_at = NOW() WHERE id = ?`,
    { replacements: [id], type: db.QueryTypes.UPDATE },
  );

  // Responder inmediatamente
  res.status(200).json({ success: true, procesando: true });

  // Procesar en background
  setImmediate(async () => {
    try {
      await syncCatalogoKanbanColumna(id, {
        logger: async (msg) => console.log(`[sync_catalogo] ${msg}`),
      });
      await db.query(
        `UPDATE kanban_columnas SET sync_status = 'completado', sync_at = NOW() WHERE id = ?`,
        { replacements: [id], type: db.QueryTypes.UPDATE },
      );
      console.log(`[sync_catalogo] ✅ Completado columna id=${id}`);
    } catch (err) {
      await db.query(
        `UPDATE kanban_columnas SET sync_status = 'error', sync_at = NOW() WHERE id = ?`,
        { replacements: [id], type: db.QueryTypes.UPDATE },
      );
      console.error(`[sync_catalogo] ❌ Error: ${err.message}`);
    }
  });
});

exports.syncStatus = catchAsync(async (req, res, next) => {
  const { id } = req.body;
  if (!id) return next(new AppError('Falta id', 400));

  const [col] = await db.query(
    `SELECT sync_status, sync_at FROM kanban_columnas WHERE id = ? LIMIT 1`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );

  return res.json({ success: true, data: col });
});

exports.marcarPrincipal = catchAsync(async (req, res, next) => {
  const { id, id_configuracion } = req.body;
  if (!id || !id_configuracion)
    return next(new AppError('Faltan id e id_configuracion', 400));

  // Solo una columna del tablero principal puede recibir los chats cerrados
  if ((await tableroDeColumna(id, id_configuracion)) !== null)
    return next(
      new AppError(
        'La columna principal debe estar en el tablero principal.',
        400,
      ),
    );

  // Desmarcar todas las columnas de esta configuración
  await db.query(
    `UPDATE kanban_columnas SET es_principal = 0 WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.UPDATE },
  );

  // Marcar solo la seleccionada
  await db.query(
    `UPDATE kanban_columnas SET es_principal = 1 WHERE id = ? AND id_configuracion = ?`,
    { replacements: [id, id_configuracion], type: db.QueryTypes.UPDATE },
  );

  const columnas = await getColumnas(id_configuracion);
  return res.status(200).json({ success: true, data: columnas });
});

exports.quitarPrincipal = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));

  await db.query(
    `UPDATE kanban_columnas SET es_principal = 0 WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.UPDATE },
  );

  const columnas = await getColumnas(id_configuracion);
  return res.status(200).json({ success: true, data: columnas });
});

// ─── Marcar como columna principal de Dropi ───────────────────
// POST /kanban_columnas/marcar_dropi_principal
exports.marcarDropiPrincipal = catchAsync(async (req, res, next) => {
  const { id, id_configuracion } = req.body;
  if (!id || !id_configuracion)
    return next(new AppError('Faltan id e id_configuracion', 400));

  if ((await tableroDeColumna(id, id_configuracion)) !== null)
    return next(
      new AppError(
        'La conexión de Dropi debe apuntar a una columna del tablero principal.',
        400,
      ),
    );

  // Desmarcar todas las columnas de esta configuración
  await db.query(
    `UPDATE kanban_columnas SET es_dropi_principal = 0 WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.UPDATE },
  );

  // Marcar solo la seleccionada
  await db.query(
    `UPDATE kanban_columnas SET es_dropi_principal = 1
     WHERE id = ? AND id_configuracion = ?`,
    { replacements: [id, id_configuracion], type: db.QueryTypes.UPDATE },
  );

  const columnas = await getColumnas(id_configuracion);
  return res.status(200).json({ success: true, data: columnas });
});

// ─── Quitar columna principal de Dropi ────────────────────────
// POST /kanban_columnas/quitar_dropi_principal
exports.quitarDropiPrincipal = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));

  await db.query(
    `UPDATE kanban_columnas SET es_dropi_principal = 0 WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.UPDATE },
  );

  const columnas = await getColumnas(id_configuracion);
  return res.status(200).json({ success: true, data: columnas });
});

exports._internal = { parseTablero, getColumnas, getTableros };
