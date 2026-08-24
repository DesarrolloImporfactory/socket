// controllers/pruebas_webhook.controller.js
// "Probar como cliente real": inyecta un mensaje por el MISMO webhook de
// WhatsApp (el mismo payload que manda Meta) en el servidor donde corre este
// backend —local, desarrollo o producción, según a cuál esté conectado el
// panel—, y deja leer lo que respondió el bot. Sirve para probar el flujo
// completo (webhook → kanban_ia → WhatsApp) con los cambios locales, sin
// desplegar y sin tocar la consola.
//
// ⚠️ No es una simulación: el bot responde por la API real de WhatsApp al
// número de prueba, y todo queda grabado en la misma base (mensajes, columna,
// órdenes si el flujo llega ahí). Por eso el front avisa a qué número se
// escribe y contra qué servidor.
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');
const webhookCtrl = require('./webhook_meta_whatsapp.controller');
const {
  ultimoErrorEnvio,
  limpiarErrorEnvio,
} = require('../utils/webhook_whatsapp/erroresEnvio');

function soloDigitos(v) {
  return String(v || '').replace(/\D+/g, '');
}

async function cargarCfg(id_configuracion) {
  const [cfg] = await db.query(
    `SELECT id, id_telefono, id_whatsapp, telefono, nombre_configuracion
       FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return cfg || null;
}

async function contactoDe(id_configuracion, telefono) {
  const [cli] = await db.query(
    `SELECT id, nombre_cliente, apellido_cliente, estado_contacto, bot_openia
       FROM clientes_chat_center
      WHERE id_configuracion = ? AND celular_cliente = ?
      ORDER BY id DESC LIMIT 1`,
    { replacements: [id_configuracion, telefono], type: db.QueryTypes.SELECT },
  );
  return cli || null;
}

async function ultimoIdMensaje(id_configuracion, id_cliente) {
  if (!id_cliente) return 0;
  const [r] = await db.query(
    `SELECT COALESCE(MAX(id), 0) AS id FROM mensajes_clientes
      WHERE id_configuracion = ? AND celular_recibe = ?`,
    {
      replacements: [id_configuracion, String(id_cliente)],
      type: db.QueryTypes.SELECT,
    },
  );
  return Number(r?.id) || 0;
}

/**
 * Reinicia la conversación de prueba de un contacto: columna inicial, bot
 * encendido, sin memoria del asistente y corte del recap/ficha/ancla. Es lo
 * mismo que el botón "Reiniciar conversación" del panel.
 */
async function reiniciarContacto({ id_configuracion, contacto, estado = 'contacto_inicial' }) {
  const [col] = await db.query(
    `SELECT id, nombre FROM kanban_columnas
      WHERE id_configuracion = ? AND LOWER(estado_db) = LOWER(?) AND activo = 1
      LIMIT 1`,
    { replacements: [id_configuracion, estado], type: db.QueryTypes.SELECT },
  );
  if (!col) {
    throw new AppError(`No hay una columna activa con estado "${estado}".`, 400);
  }
  await db.query(
    `UPDATE clientes_chat_center SET estado_contacto = ?, bot_openia = 1 WHERE id = ?`,
    { replacements: [estado, contacto.id], type: db.QueryTypes.UPDATE },
  );
  await db.query(`DELETE FROM openai_threads WHERE id_cliente_chat_center = ?`, {
    replacements: [contacto.id],
    type: db.QueryTypes.DELETE,
  });
  await db
    .query(
      `UPDATE clientes_chat_center
          SET reinicio_conversacion_at = NOW(), turnos_sin_avance = 0
        WHERE id = ?`,
      { replacements: [contacto.id], type: db.QueryTypes.UPDATE },
    )
    .catch(() =>
      db
        .query(`UPDATE clientes_chat_center SET turnos_sin_avance = 0 WHERE id = ?`, {
          replacements: [contacto.id],
          type: db.QueryTypes.UPDATE,
        })
        .catch(() => {}),
    );
  return col;
}

/**
 * ¿El número le escribió al negocio en las últimas 24 h DE VERDAD? Solo los
 * mensajes reales abren la ventana de WhatsApp; los que inyecta este panel
 * (wamid PANEL/PRUEBA) no cuentan.
 */
async function ventana24h(id_configuracion, id_cliente) {
  if (!id_cliente) return { abierta: false, ultima_entrada_real_at: null };
  const [r] = await db.query(
    `SELECT MAX(created_at) AS ultima FROM mensajes_clientes
      WHERE id_configuracion = ? AND celular_recibe = ? AND rol_mensaje = 0
        AND (id_wamid_mensaje IS NULL
             OR (id_wamid_mensaje NOT LIKE 'wamid.PANEL%' AND id_wamid_mensaje NOT LIKE 'wamid.PRUEBA%'))
        AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
    {
      replacements: [id_configuracion, String(id_cliente)],
      type: db.QueryTypes.SELECT,
    },
  );
  const ultima = r?.ultima || null;
  return { abierta: Boolean(ultima), ultima_entrada_real_at: ultima };
}

/** Mismo payload que arma Meta en un mensaje de texto (o clic-a-WhatsApp). */
function armarPayload({ cfg, telefono, nombre, mensaje, referral }) {
  const wamid = `wamid.PANEL${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const msg = {
    from: telefono,
    id: wamid,
    timestamp: String(Math.floor(Date.now() / 1000)),
    text: { body: mensaje },
    type: 'text',
  };
  if (referral) msg.referral = referral;
  return {
    wamid,
    payload: {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: cfg.id_whatsapp || '0',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: cfg.telefono,
                  phone_number_id: cfg.id_telefono,
                },
                contacts: [
                  { profile: { name: nombre || 'Prueba' }, wa_id: telefono },
                ],
                messages: [msg],
              },
              field: 'messages',
            },
          ],
        },
      ],
    },
  };
}

/* Llama al controlador del webhook como si fuera el POST de Meta. El webhook
   responde 200 enseguida y procesa en segundo plano, así que acá solo hace
   falta un res de mentira que acepte status/json. */
async function inyectarEnWebhook(payload) {
  const req = {
    method: 'POST',
    body: payload,
    query: {},
    headers: { 'content-type': 'application/json' },
    rawBody: JSON.stringify(payload),
    ip: '127.0.0.1',
  };
  const res = {
    statusCode: 200,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json() {
      return this;
    },
    send() {
      return this;
    },
    sendStatus(c) {
      this.statusCode = c;
      return this;
    },
    set() {
      return this;
    },
  };
  await webhookCtrl.webhook_whatsapp(req, res, (err) => {
    if (err) throw err;
  });
  return res.statusCode;
}

/* POST /enviar  { id_configuracion, telefono, mensaje, referral_source_id?, headline? } */
exports.enviar = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(req.body?.id_configuracion);
  const telefono = soloDigitos(req.body?.telefono);
  const mensaje = String(req.body?.mensaje || '').trim();
  if (!id_configuracion || !telefono || !mensaje) {
    return next(
      new AppError('id_configuracion, telefono y mensaje son obligatorios.', 400),
    );
  }
  const cfg = await cargarCfg(id_configuracion);
  if (!cfg) return next(new AppError('Configuración no encontrada.', 404));
  if (!cfg.id_telefono) {
    return next(
      new AppError(
        'La configuración no tiene id_telefono: el webhook no la reconocería.',
        400,
      ),
    );
  }

  let referral = null;
  /* Dos formas de simular la pauta: un anuncio ya mapeado (source_id) o un
     título escrito a mano (headline sin source_id). Sin source_id el resolver
     busca el producto solo por el texto y NO aprende el vínculo, así una prueba
     no contamina el mapa anuncio→producto. */
  const source_id = String(req.body?.referral_source_id || '').trim();
  let headline = String(req.body?.headline || '').trim().slice(0, 300);
  if (source_id || headline) {
    if (source_id && !headline) {
      const [ad] = await db.query(
        `SELECT headline FROM anuncios_producto
          WHERE id_configuracion = ? AND source_id = ? LIMIT 1`,
        { replacements: [id_configuracion, source_id], type: db.QueryTypes.SELECT },
      );
      headline = ad?.headline || '';
    }
    referral = {
      source_url: source_id ? `https://fb.me/${source_id}` : 'https://fb.me/prueba',
      source_id,
      source_type: 'ad',
      headline,
      body: '',
      media_type: 'image',
      ctwa_clid: `panel_${Date.now()}`,
    };
  }

  const contacto = await contactoDe(id_configuracion, telefono);
  // Primer mensaje de la prueba: la conversación arranca de cero (columna
  // inicial + sin memoria) para que nada anterior —incluido lo que el bot de
  // producción contestó al "Hola" que abrió la ventana— se mezcle con la prueba.
  let reiniciado = false;
  if (req.body?.reiniciar && contacto) {
    await reiniciarContacto({ id_configuracion, contacto });
    reiniciado = true;
  }
  const desde_id = await ultimoIdMensaje(id_configuracion, contacto?.id);
  const nombre =
    [contacto?.nombre_cliente, contacto?.apellido_cliente].filter(Boolean).join(' ') ||
    String(req.body?.nombre || 'Prueba');

  // Un error viejo de otra prueba no debe confundir a esta.
  limpiarErrorEnvio(telefono);
  const { payload, wamid } = armarPayload({ cfg, telefono, nombre, mensaje, referral });
  const status = await inyectarEnWebhook(payload);

  res.status(200).json({
    status: 'success',
    data: {
      wamid,
      desde_id,
      id_cliente: contacto?.id || null,
      webhook_status: status,
      referral: Boolean(referral),
      reiniciado,
    },
  });
});

/* POST /reiniciar  { id_configuracion, telefono, estado? } — igual que el botón
   "Reiniciar conversación": columna inicial, sin memoria, corte del recap. */
exports.reiniciar = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(req.body?.id_configuracion);
  const telefono = soloDigitos(req.body?.telefono);
  const estado = String(req.body?.estado || 'contacto_inicial');
  if (!id_configuracion || !telefono) {
    return next(new AppError('id_configuracion y telefono son obligatorios.', 400));
  }
  const contacto = await contactoDe(id_configuracion, telefono);
  if (!contacto) {
    return res.status(200).json({
      status: 'success',
      data: { reiniciado: false, motivo: 'El número todavía no existe como contacto.' },
    });
  }
  const col = await reiniciarContacto({ id_configuracion, contacto, estado });
  const desde_id = await ultimoIdMensaje(id_configuracion, contacto.id);
  res.status(200).json({
    status: 'success',
    data: { reiniciado: true, id_cliente: contacto.id, columna: col.nombre, desde_id },
  });
});

/* POST /mensajes  { id_configuracion, telefono, desde_id } — lo nuevo del hilo. */
exports.mensajes = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(req.body?.id_configuracion);
  const telefono = soloDigitos(req.body?.telefono);
  const desde_id = Number(req.body?.desde_id) || 0;
  if (!id_configuracion || !telefono) {
    return next(new AppError('id_configuracion y telefono son obligatorios.', 400));
  }
  const contacto = await contactoDe(id_configuracion, telefono);
  const cfg = await cargarCfg(id_configuracion);
  const ultimo_error = ultimoErrorEnvio(telefono);
  const ventana = await ventana24h(id_configuracion, contacto?.id);
  if (!contacto) {
    return res.status(200).json({
      status: 'success',
      data: {
        mensajes: [],
        contacto: null,
        ultimo_id: desde_id,
        ultimo_error,
        ventana_24h: ventana,
        telefono_negocio: cfg?.telefono || null,
      },
    });
  }
  /* solo_ultimo: el panel recién abre y solo necesita saber desde qué id
     empezar a escuchar (la ventana arranca vacía, sin historial). */
  const soloUltimo = Boolean(req.body?.solo_ultimo);
  const mensajes = soloUltimo
    ? []
    : await db.query(
        `SELECT id, rol_mensaje, responsable, tipo_mensaje, texto_mensaje, ruta_archivo,
                total_tokens_openai_mensaje AS tokens, json_analytics_mensaje, created_at
           FROM mensajes_clientes
          WHERE id_configuracion = ? AND celular_recibe = ? AND id > ?
          ORDER BY id ASC LIMIT 60`,
        {
          replacements: [id_configuracion, String(contacto.id), desde_id],
          type: db.QueryTypes.SELECT,
        },
      );
  const ultimoIdHilo = soloUltimo
    ? await ultimoIdMensaje(id_configuracion, contacto.id)
    : mensajes.length
      ? mensajes[mensajes.length - 1].id
      : desde_id;
  const [col] = await db.query(
    `SELECT nombre, activa_ia FROM kanban_columnas
      WHERE id_configuracion = ? AND LOWER(estado_db) = LOWER(?) AND activo = 1
      LIMIT 1`,
    {
      replacements: [id_configuracion, contacto.estado_contacto || ''],
      type: db.QueryTypes.SELECT,
    },
  );
  res.status(200).json({
    status: 'success',
    data: {
      mensajes,
      contacto: {
        id: contacto.id,
        nombre: [contacto.nombre_cliente, contacto.apellido_cliente].filter(Boolean).join(' '),
        estado_contacto: contacto.estado_contacto,
        columna: col?.nombre || null,
        columna_ia: col ? Number(col.activa_ia) === 1 : null,
        bot_openia: Number(contacto.bot_openia),
      },
      ultimo_id: ultimoIdHilo,
      // Si Meta rechazó la respuesta del bot (p. ej. ventana de 24 h cerrada),
      // el panel lo explica en vez de quedarse esperando.
      ultimo_error,
      ventana_24h: ventana,
      telefono_negocio: cfg?.telefono || null,
    },
  });
});

/* POST /anuncios  { id_configuracion } — anuncios mapeados para simular la
   entrada por publicidad (clic-a-WhatsApp). */
exports.anuncios = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(req.body?.id_configuracion);
  if (!id_configuracion) {
    return next(new AppError('id_configuracion es obligatorio.', 400));
  }
  const filas = await db.query(
    `SELECT ap.source_id, ap.headline, ap.id_producto, ap.veces, p.nombre AS producto,
            (SELECT w.wizard_completado FROM productos_wizard w WHERE w.id_producto = ap.id_producto LIMIT 1) AS wizard
       FROM anuncios_producto ap
       LEFT JOIN productos_chat_center p ON p.id = ap.id_producto
      WHERE ap.id_configuracion = ?
      ORDER BY ap.veces DESC, ap.id DESC
      LIMIT 60`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  res.status(200).json({ status: 'success', data: filas });
});
