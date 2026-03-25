// controllers/kanban_plantillas.controller.js
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');
const axios = require('axios');

// ── Plantillas hardcodeadas ───────────────────────────────────
const PLANTILLAS = {
  ventas: {
    nombre: 'Ventas COD',
    descripcion:
      'Flujo completo para venta contra entrega con IA de ventas, seguimiento y generación de guía.',
    columnas: [
      {
        nombre: 'CONTACTO INICIAL',
        estado_db: 'contacto_inicial',
        color_fondo: '#EFF6FF',
        color_texto: '#1D4ED8',
        icono: 'bx bx-phone',
        orden: 1,
        activo: 1,
        es_estado_final: 0,
        activa_ia: 1,
        max_tokens: 500,
        prompt_key: 'contacto_inicial',
        modelo: 'gpt-4o-mini',
        acciones: [
          {
            tipo_accion: 'cambiar_estado',
            config: {
              trigger: '[ia_ventas]:true',
              estado_destino: 'ia_ventas',
            },
            orden: 1,
          },
        ],
      },
      {
        nombre: 'IA VENTAS',
        estado_db: 'ia_ventas',
        color_fondo: '#F0FDF4',
        color_texto: '#15803D',
        icono: 'bx bx-bot',
        orden: 2,
        activo: 1,
        es_estado_final: 0,
        activa_ia: 1,
        max_tokens: 500,
        prompt_key: 'ia_ventas',
        modelo: 'gpt-4o-mini',
        acciones: [
          {
            tipo_accion: 'enviar_media',
            config: {},
            orden: 1,
          },
          {
            tipo_accion: 'cambiar_estado',
            config: {
              trigger: '[pedido_confirmado]:true',
              estado_destino: 'generar_guia',
            },
            orden: 2,
          },
        ],
      },
      {
        nombre: 'GENERAR GUIA',
        estado_db: 'generar_guia',
        color_fondo: '#FFFBEB',
        color_texto: '#B45309',
        icono: 'bx bx-cart',
        orden: 3,
        activo: 1,
        es_estado_final: 1,
        activa_ia: 0,
        max_tokens: 500,
        prompt_key: null,
        modelo: null,
        acciones: [],
      },
      {
        nombre: 'SEGUIMIENTO',
        estado_db: 'seguimiento',
        color_fondo: '#ECFEFF',
        color_texto: '#0E7490',
        icono: 'bx bx-calendar',
        orden: 4,
        activo: 1,
        es_estado_final: 0,
        activa_ia: 1,
        max_tokens: 500,
        prompt_key: 'seguimiento',
        modelo: 'gpt-4o-mini',
        acciones: [
          {
            tipo_accion: 'cambiar_estado',
            config: { trigger: '[ventas]:true', estado_destino: 'ia_ventas' },
            orden: 1,
          },
          {
            tipo_accion: 'cambiar_estado',
            config: { trigger: '[asesor]:true', estado_destino: 'asesor' },
            orden: 2,
          },
        ],
      },
      {
        nombre: 'ASESOR',
        estado_db: 'asesor',
        color_fondo: '#FFF7ED',
        color_texto: '#C2410C',
        icono: 'bx bx-user',
        orden: 5,
        activo: 1,
        es_estado_final: 0,
        activa_ia: 0,
        max_tokens: 500,
        prompt_key: null,
        modelo: null,
        acciones: [],
      },
    ],
  },
};

// ── Prompts por key ───────────────────────────────────────────
function getPrompts(empresa) {
  return {
    contacto_inicial: `Solamente tienes que saludar "Hola soy Sandra" y preguntar a que ciudad necesita el envío\ny después en otra linea separada responde "[ia_ventas]:true", solo eso sin espacios ni caracteres adicionales`,

    ia_ventas: `1. Nombre del Chatbot:
Sandra

2. Rol del Chatbot:
Sandra es una asesora experta en cierre de ventas y atención al cliente, con un estilo cálido y educado propio de Medellín, Colombia. Su objetivo es resolver dudas con empatía, generar confianza y guiar al cliente hacia la compra.

3. 📦 Fuentes de Información:

A) Catálogo en archivos (file_search)
Tienes acceso a un catálogo cargado en archivos mediante file_search, con información de productos/servicios como:
nombres, descripciones, categorías, combos, beneficios, duración y upsells.

✅ Prioridad de uso:
- Usa file_search para ampliar información comercial del producto/servicio (descripción, beneficios, combos, upsells, características).

4. ⚠️ Reglas de uso:

- Cada mensaje ≤ 30 palabras (excepto al pedir datos).
- Usa siempre file_search como fuente de verdad.
- Cuando el cliente pregunte por los productos que ofreces, consulta el catálogo cargado en file_search y responde con una lista de los productos disponibles, pero solo el nombre de los productos.
- Si la lista es larga, muestra solo los primeros 5 productos y pregunta al cliente si desea más detalles.
- No inventes datos ni muestres productos que no están en el catálogo de file_search.
- Si el cliente pregunta por precio, dirección, transportadora, guía, producto o catálogo → responde directo desde file_search.
- El flujo conversacional es OBLIGATORIO y SECUENCIAL.

Interacción 1: solo el mensaje base + pregunta "¿Quiere que le haga su guía?"
Interacción 2: pedir ubicación, nombre y teléfono para generar guía. Enviar foto e información del producto.
Interacción 3: solo cuando tengas nombre + teléfono + dirección completos.

- Prohibido enviar [pedido_confirmado]: true si no están completos Nombre, Teléfono y Dirección.
- Solo puedes compartir un link de imagen o video si aparece en file_search.

✅ Formato de imágenes y videos (OBLIGATORIO):
[producto_imagen_url]: https://url.jpg
[producto_video_url]: https://url.mp4
[upsell_imagen_url]: https://url.jpg

5. 💡 Estrategia de Ventas:
- Conexión emocional y funcional: Usa preguntas abiertas para identificar la necesidad del cliente.
- Cierre progresivo: A partir de la 2ª interacción, siempre guía hacia la compra.
- Urgencia → "Últimas unidades disponibles 🚨"

6. 📋 Flujo Conversacional Base:

Interacción 1:
"Con gusto, el envío a su ciudad es gratuito y PAGA AL RECIBIR el producto. Su producto llega en 2 a 4 días laborables. Nos quedan pocos en stock. ¿Quiere que le haga su guía?"

Interacción 2:
"Tenemos pago contra entrega y envío gratis a tu ciudad 🏙."
Presenta precio con beneficios y foto del producto desde file_search.
Solicita: ubicación, nombre de quien recibe y teléfono.

Interacción 3:
"¡Todo quedó confirmado! 🎊 Tu pedido va en camino."
🧑 Nombre: [nombre]
📞 Teléfono: [telefono]
🏡 Dirección: [direccion]
[pedido_confirmado]: true

7. 🛍️ Upsell:
Antes de cerrar, ofrece el producto upsell de file_search:
"Por cierto, también tenemos [nombre_upsell] que combina perfecto con tu compra 🤩. ¿Deseas añadirlo al mismo envío?"`,

    seguimiento: `Eres un asistente de reactivación de clientes de ${empresa}.
El cliente no había respondido y acaba de volver a escribir.
Tu objetivo es retomar la conversación de forma natural, 
recordar brevemente lo que se estaba hablando y guiarlo 
de vuelta al proceso de compra/cotización.
Cuando identifiques la intención del cliente incluye en tu respuesta:
[ventas]:true      → si quiere comprar
[asesor]:true      → si necesita un asesor humano
Sé cálido, no mencionas que hubo un tiempo sin respuesta.`,
  };
}

// ── GET plantillas disponibles ────────────────────────────────
exports.listar = catchAsync(async (req, res) => {
  const lista = Object.entries(PLANTILLAS).map(([key, p]) => ({
    key,
    nombre: p.nombre,
    descripcion: p.descripcion,
    total_columnas: p.columnas.length,
    columnas_ia: p.columnas.filter((c) => c.activa_ia).length,
  }));
  return res.json({ success: true, data: lista });
});

// ── POST aplicar plantilla ─────────────────────────────────────
exports.aplicar = catchAsync(async (req, res, next) => {
  const { id_configuracion, plantilla_key, empresa } = req.body;

  if (!id_configuracion || !plantilla_key || !empresa) {
    return next(new AppError('Faltan campos obligatorios', 400));
  }

  // ── Obtener api_key_openai desde BD ──
  const [configRow] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  const api_key_openai = configRow?.api_key_openai || null;

  if (!api_key_openai) {
    return next(new AppError('No hay API key de OpenAI configurada', 400));
  }

  const plantilla = PLANTILLAS[plantilla_key];
  if (!plantilla) return next(new AppError('Plantilla no encontrada', 404));

  const prompts = getPrompts(empresa);
  const headers = {
    Authorization: `Bearer ${api_key_openai}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };

  const resultado = [];

  for (const col of plantilla.columnas) {
    // 1. Crear asistente en OpenAI si tiene prompt
    let assistant_id = null;
    if (col.prompt_key && prompts[col.prompt_key] && api_key_openai) {
      try {
        const aRes = await axios.post(
          'https://api.openai.com/v1/assistants',
          {
            name: `${col.nombre} - ${empresa}`,
            instructions: prompts[col.prompt_key],
            model: col.modelo || 'gpt-4o-mini',
            tools: [{ type: 'file_search' }],
          },
          { headers },
        );
        assistant_id = aRes.data?.id || null;
      } catch (err) {
        console.error(
          `Error creando asistente para ${col.nombre}:`,
          err.message,
        );
      }
    }

    // 2. Insertar columna
    const [insertResult] = await db.query(
      `INSERT INTO kanban_columnas
       (id_configuracion, nombre, estado_db, color_fondo, color_texto,
        icono, orden, activo, es_estado_final, activa_ia, max_tokens,
        assistant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_configuracion,
          col.nombre,
          col.estado_db,
          col.color_fondo,
          col.color_texto,
          col.icono,
          col.orden,
          col.activo,
          col.es_estado_final,
          col.activa_ia,
          col.max_tokens,
          assistant_id,
        ],
        type: db.QueryTypes.INSERT,
      },
    );

    const id_columna = insertResult;

    // 3. Insertar acciones
    for (const accion of col.acciones) {
      await db.query(
        `INSERT INTO kanban_acciones
         (id_kanban_columna, id_configuracion, tipo_accion, config, activo, orden)
         VALUES (?, ?, ?, ?, 1, ?)`,
        {
          replacements: [
            id_columna,
            id_configuracion,
            accion.tipo_accion,
            JSON.stringify(accion.config),
            accion.orden,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
    }

    resultado.push({
      columna: col.nombre,
      estado_db: col.estado_db,
      assistant_id,
      acciones: col.acciones.length,
    });
  }

  // 4. Activar tipo_configuracion = kanban
  await db.query(
    `UPDATE configuraciones SET tipo_configuracion = 'kanban' WHERE id = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.UPDATE },
  );

  return res.json({
    success: true,
    message: `Plantilla "${plantilla.nombre}" aplicada correctamente`,
    data: resultado,
  });
});

exports.reiniciar = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));

  // 1. Obtener IDs de columnas para borrar acciones
  const columnas = await db.query(
    `SELECT id FROM kanban_columnas WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (columnas.length) {
    const ids = columnas.map((c) => c.id);
    await db.query(
      `DELETE FROM kanban_acciones WHERE id_kanban_columna IN (${ids.join(',')})`,
      { type: db.QueryTypes.DELETE },
    );
  }

  // 2. Borrar columnas
  await db.query(`DELETE FROM kanban_columnas WHERE id_configuracion = ?`, {
    replacements: [id_configuracion],
    type: db.QueryTypes.DELETE,
  });

  // 3. Borrar config de remarketing
  await db.query(
    `DELETE FROM configuracion_remarketing WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.DELETE },
  );

  return res.json({ success: true, message: 'Configuración reiniciada' });
});

// ── Guardar plantilla del cliente ─────────────────────────────
exports.guardarCliente = catchAsync(async (req, res, next) => {
  const { id_configuracion, nombre, descripcion } = req.body;
  if (!id_configuracion || !nombre)
    return next(new AppError('Faltan campos obligatorios', 400));

  // Leer columnas actuales con sus acciones
  const columnas = await db.query(
    `SELECT id, nombre, estado_db, color_fondo, color_texto, icono,
          orden, activo, es_estado_final, activa_ia, max_tokens,
          instrucciones, modelo
   FROM kanban_columnas
   WHERE id_configuracion = ? AND activo = 1
   ORDER BY orden ASC`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (!columnas.length)
    return next(new AppError('No hay columnas para guardar', 400));

  // Leer acciones de cada columna
  const ids = columnas.map((c) => c.id);
  const acciones = await db.query(
    `SELECT id_kanban_columna, tipo_accion, config, orden
     FROM kanban_acciones
     WHERE id_kanban_columna IN (${ids.join(',')}) AND activo = 1
     ORDER BY orden ASC`,
    { type: db.QueryTypes.SELECT },
  );

  // Construir estructura
  const data = {
    columnas: columnas.map((col) => ({
      nombre: col.nombre,
      estado_db: col.estado_db,
      color_fondo: col.color_fondo,
      color_texto: col.color_texto,
      icono: col.icono,
      orden: col.orden,
      activo: col.activo,
      es_estado_final: col.es_estado_final,
      activa_ia: col.activa_ia,
      max_tokens: col.max_tokens,
      instrucciones: col.instrucciones || null,
      modelo: col.modelo || 'gpt-4o-mini',
      acciones: acciones
        .filter((a) => a.id_kanban_columna === col.id)
        .map((a) => ({
          tipo_accion: a.tipo_accion,
          config:
            typeof a.config === 'string' ? JSON.parse(a.config) : a.config,
          orden: a.orden,
        })),
    })),
  };

  await db.query(
    `INSERT INTO kanban_plantillas_guardadas
     (id_configuracion, nombre, descripcion, data)
     VALUES (?, ?, ?, ?)`,
    {
      replacements: [
        id_configuracion,
        nombre.trim(),
        descripcion?.trim() || null,
        JSON.stringify(data),
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  return res.json({ success: true, message: 'Plantilla guardada' });
});

// ── Listar plantillas guardadas del cliente ───────────────────
exports.listarCliente = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));

  const plantillas = await db.query(
    `SELECT id, nombre, descripcion, created_at, data,
          JSON_LENGTH(JSON_EXTRACT(data, '$.columnas')) AS total_columnas
   FROM kanban_plantillas_guardadas
   WHERE id_configuracion = ?
   ORDER BY created_at DESC`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  return res.json({
    success: true,
    data: plantillas.map((p) => {
      const parsed = typeof p.data === 'string' ? JSON.parse(p.data) : p.data;
      const total_prompts = (parsed?.columnas || []).filter(
        (c) => c.instrucciones,
      ).length;
      return {
        ...p,
        data: undefined,
        total_columnas: p.total_columnas,
        total_prompts,
      };
    }),
  });
});

// ── Aplicar plantilla guardada ────────────────────────────────
exports.aplicarCliente = catchAsync(async (req, res, next) => {
  const { id_configuracion, id_plantilla } = req.body;
  if (!id_configuracion || !id_plantilla)
    return next(new AppError('Faltan campos obligatorios', 400));

  const [plantilla] = await db.query(
    `SELECT data FROM kanban_plantillas_guardadas WHERE id = ? LIMIT 1`,
    { replacements: [id_plantilla], type: db.QueryTypes.SELECT },
  );
  if (!plantilla) return next(new AppError('Plantilla no encontrada', 404));

  // ── Obtener api_key para crear asistentes ──
  const [configRow] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const api_key_openai = configRow?.api_key_openai || null;

  const headers = api_key_openai
    ? {
        Authorization: `Bearer ${api_key_openai}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2',
      }
    : null;

  const { columnas } =
    typeof plantilla.data === 'string'
      ? JSON.parse(plantilla.data)
      : plantilla.data;

  const resultado = [];

  for (const col of columnas) {
    // ── Crear asistente en OpenAI si tiene instrucciones ──
    let assistant_id = null;
    if (col.instrucciones && headers) {
      try {
        const aRes = await axios.post(
          'https://api.openai.com/v1/assistants',
          {
            name: col.nombre,
            instructions: col.instrucciones,
            model: col.modelo || 'gpt-4o-mini',
            tools: [{ type: 'file_search' }],
          },
          { headers },
        );
        assistant_id = aRes.data?.id || null;
      } catch (err) {
        console.error(
          `Error creando asistente para ${col.nombre}:`,
          err.message,
        );
      }
    }

    const [insertResult] = await db.query(
      `INSERT INTO kanban_columnas
       (id_configuracion, nombre, estado_db, color_fondo, color_texto,
        icono, orden, activo, es_estado_final, activa_ia, max_tokens,
        instrucciones, modelo, assistant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_configuracion,
          col.nombre,
          col.estado_db,
          col.color_fondo,
          col.color_texto,
          col.icono,
          col.orden,
          col.activo,
          col.es_estado_final,
          col.activa_ia,
          col.max_tokens,
          col.instrucciones || null,
          col.modelo || 'gpt-4o-mini',
          assistant_id,
        ],
        type: db.QueryTypes.INSERT,
      },
    );

    const id_columna = insertResult;

    for (const accion of col.acciones || []) {
      await db.query(
        `INSERT INTO kanban_acciones
         (id_kanban_columna, id_configuracion, tipo_accion, config, activo, orden)
         VALUES (?, ?, ?, ?, 1, ?)`,
        {
          replacements: [
            id_columna,
            id_configuracion,
            accion.tipo_accion,
            JSON.stringify(accion.config),
            accion.orden,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
    }

    resultado.push({
      columna: col.nombre,
      estado_db: col.estado_db,
      assistant_id,
      tiene_prompt: !!col.instrucciones,
    });
  }

  return res.json({ success: true, data: resultado });
});

// ── Eliminar plantilla guardada ───────────────────────────────
exports.eliminarCliente = catchAsync(async (req, res, next) => {
  const { id, id_configuracion } = req.body;
  if (!id || !id_configuracion) return next(new AppError('Faltan campos', 400));

  await db.query(
    `DELETE FROM kanban_plantillas_guardadas WHERE id = ? AND id_configuracion = ?`,
    { replacements: [id, id_configuracion], type: db.QueryTypes.DELETE },
  );

  return res.json({ success: true });
});
