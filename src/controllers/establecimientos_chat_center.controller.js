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
  'horario_json',
  'buffer_minutos',
  'anticipacion_minima_horas',
  'max_citas_dia',
  'id_calendario',
  'orden',
  'activo',
];

/* Cuánto tiempo de traslado se reserva entre citas y cuánta anticipación se
   exige. El tope es alto a propósito (4 horas de traslado, 7 días de aviso):
   son negocios distintos, no hay un valor "razonable" universal. Lo que sí se
   corta es el número imposible, para que un dedo de más no deje la agenda
   inservible sin que nadie entienda por qué. */
const enteroEnRango = (v, { min, max, porDefecto = null }) => {
  if (v === '' || v === null || v === undefined) return porDefecto;
  const n = Number(v);
  if (!Number.isFinite(n)) return porDefecto;
  return Math.min(max, Math.max(min, Math.round(n)));
};

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

/* El horario se guarda estructurado y el texto pasa a ser un resumen generado.
   Como texto libre, el bot tenía que interpretarlo y terminaba ofreciendo citas
   un domingo en un local que cierra el sábado. */
const {
  normalizarHorario,
  resumenHorario,
} = require('../utils/horarioSede');

const prepararHorario = (body) => {
  if (body.horario_json === undefined) return null;

  const limpio = normalizarHorario(body.horario_json);
  if (limpio) {
    return { json: JSON.stringify(limpio), texto: resumenHorario(limpio) };
  }

  /* Sin franjas válidas hay dos casos distintos y no se pueden tratar igual:
     - el cliente vació el horario a propósito → se borra todo, y el bot pasa a
       no tener horario (que es honesto: no lo sabe).
     - llegó algo ilegible por un error → no se toca nada, porque borrar el
       horario de una sede en producción por un payload roto es peor que
       ignorarlo. */
  const vaciadoAdrede =
    body.horario_json === null ||
    (typeof body.horario_json === 'object' &&
      !Array.isArray(body.horario_json) &&
      !body.horario_json.abierto_24h &&
      Object.keys(body.horario_json.dias || {}).length === 0);

  return vaciadoAdrede ? { json: null, texto: null } : { ignorar: true };
};

const ERROR_MAPS =
  'El enlace de Google Maps no es válido. Abre la sede en Google Maps, ' +
  'usa Compartir → Copiar vínculo y pega ese enlace.';

/* ── Recordatorios de cita ──────────────────────────────────────────────
   Cuántos avisos se mandan antes de cada cita, con cuánta anticipación y con
   qué mensaje cada uno. Vive junto a las sedes porque es lo mismo que se está
   configurando: cómo trabaja la agenda. Las horas se guardan separadas por coma
   ("24,2"); NULL = uno a la hora, que es como venía funcionando.

   La plantilla va por hora (JSON {"24":"nombre","2":"otro"}) porque el mismo
   texto a 24 horas y a 1 hora se lee como spam: el de la víspera confirma, el
   de la hora avisa que salga. `template_notificar_calendario` se mantiene como
   respaldo para las cuentas que nunca eligieron una por hora. */
const HORAS_VALIDAS = [48, 24, 12, 4, 2, 1];

const {
  VARIABLES_RECORDATORIO,
  normalizarMapeo,
} = require('../utils/variablesRecordatorio');

/* Cada aviso guarda { plantilla, body, buttons }. `body` es posicional
   (body[0] → {{1}}) y puede ir vacío: una plantilla sin variables se manda tal
   cual, que es lo normal en un recordatorio corto.

   Formato viejo: el valor era el nombre de la plantilla a secas. Se sigue
   leyendo para no dejar sin recordatorios a quien ya lo tenía configurado. */
const leerPlantillasPorHora = (raw) => {
  if (!raw) return {};
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};

    const salida = {};
    for (const [h, valor] of Object.entries(obj)) {
      const hora = Number(h);
      if (!Number.isFinite(hora) || hora <= 0) continue;

      const crudo = typeof valor === 'string' ? { plantilla: valor } : valor;
      const plantilla = String(crudo?.plantilla || '').trim();
      if (!plantilla) continue;

      salida[hora] = {
        plantilla,
        body: normalizarMapeo(crudo?.body),
        buttons: (Array.isArray(crudo?.buttons) ? crudo.buttons : [])
          .map((b) => ({
            index: Number(b?.index) || 0,
            variable: normalizarMapeo([b?.variable])[0],
          }))
          .filter((b) => b.variable),
      };
    }
    return salida;
  } catch {
    return {};
  }
};

exports.obtenerRecordatorios = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));

  const [cfg] = await db.query(
    `SELECT recordatorios_cita, recordatorios_cita_plantillas,
            template_notificar_calendario
       FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!cfg) return next(new AppError('Configuración no encontrada', 404));

  const horas = String(cfg.recordatorios_cita || '1')
    .split(',')
    .map((h) => Number(String(h).trim()))
    .filter((h) => Number.isFinite(h) && h > 0);

  const porHora = leerPlantillasPorHora(cfg.recordatorios_cita_plantillas);

  /* Una cuenta que venía con plantilla única la ve repetida en cada aviso: es
     lo que hoy sale de verdad, así que mostrar otra cosa sería mentir. */
  const respaldo = cfg.template_notificar_calendario || null;
  const finales = horas.length ? horas : [1];
  const plantillas = {};
  for (const h of finales) {
    plantillas[h] =
      porHora[h] ||
      (respaldo ? { plantilla: respaldo, body: [], buttons: [] } : null);
  }

  return res.json({
    status: 'success',
    data: {
      horas: finales,
      opciones: HORAS_VALIDAS,
      // Sin plantilla el aviso no puede salir: a esa hora la ventana de 24h de
      // Meta suele estar cerrada y solo una plantilla aprobada la reabre.
      plantillas,
      plantilla: respaldo,
      /* Catálogo de datos que se pueden poner en las variables, con su ejemplo
         para la vista previa. Sale de acá y no del front para que lo que se ve
         al configurar y lo que manda el cron no puedan separarse. */
      variables: VARIABLES_RECORDATORIO,
      configurado: cfg.recordatorios_cita != null,
    },
  });
});

exports.guardarRecordatorios = catchAsync(async (req, res, next) => {
  const { id_configuracion, horas, plantilla, plantillas } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));

  /* Elegir el mensaje va por acá y no por otra pantalla: es la mitad de la
     misma decisión. Antes el nombre vivía en un campo que el cliente no veía,
     así que activaba los recordatorios y no salía ninguno. */
  if (plantillas && typeof plantillas === 'object') {
    const limpias = leerPlantillasPorHora(plantillas);
    await db.query(
      `UPDATE configuraciones
          SET recordatorios_cita_plantillas = ?,
              template_notificar_calendario = ?
        WHERE id = ?`,
      {
        replacements: [
          Object.keys(limpias).length ? JSON.stringify(limpias) : null,
          // El respaldo apunta al aviso más cercano a la cita, que es el que
          // nunca falta; así lo que ya lea este campo sigue funcionando.
          Object.keys(limpias).length
            ? limpias[Math.min(...Object.keys(limpias).map(Number))].plantilla
            : null,
          id_configuracion,
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
    if (!Array.isArray(horas)) {
      return res.json({ status: 'success', data: { plantillas: limpias } });
    }
  } else if (typeof plantilla !== 'undefined') {
    const nombre = String(plantilla || '').trim();
    await db.query(
      `UPDATE configuraciones SET template_notificar_calendario = ? WHERE id = ?`,
      {
        replacements: [nombre || null, id_configuracion],
        type: db.QueryTypes.UPDATE,
      },
    );
    if (!Array.isArray(horas)) {
      return res.json({ status: 'success', data: { plantilla: nombre || null } });
    }
  }

  if (!Array.isArray(horas))
    return next(new AppError('horas debe ser un arreglo', 400));

  const limpias = [
    ...new Set(
      horas
        .map((h) => Number(h))
        .filter((h) => Number.isFinite(h) && h > 0 && h <= 168),
    ),
  ].sort((a, b) => b - a);

  if (!limpias.length) {
    return next(
      new AppError(
        'Deja al menos un recordatorio: sin ninguno, nadie recibe aviso de su cita.',
        400,
      ),
    );
  }

  await db.query(
    `UPDATE configuraciones SET recordatorios_cita = ? WHERE id = ?`,
    {
      replacements: [limpias.join(','), id_configuracion],
      type: db.QueryTypes.UPDATE,
    },
  );

  return res.json({ status: 'success', data: { horas: limpias } });
});

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
    horario: prepararHorario(req.body)?.texto ?? limpiar(req.body.horario),
    horario_json: prepararHorario(req.body)?.json || null,
    buffer_minutos: enteroEnRango(req.body.buffer_minutos, {
      min: 0,
      max: 240,
      porDefecto: 0,
    }),
    anticipacion_minima_horas: enteroEnRango(
      req.body.anticipacion_minima_horas,
      { min: 0, max: 168, porDefecto: 0 },
    ),
    max_citas_dia: enteroEnRango(req.body.max_citas_dia, {
      min: 1,
      max: 100,
      porDefecto: null,
    }),
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

  /* El horario estructurado manda sobre el texto: el texto es su resumen. */
  const horario = prepararHorario(req.body);

  for (const campo of CAMPOS_EDITABLES) {
    if (req.body[campo] === undefined) continue;
    if (campo === 'google_maps_url') {
      const maps = limpiarUrlMaps(req.body.google_maps_url);
      if (!maps.ok) return next(new AppError(ERROR_MAPS, 400));
      est.google_maps_url = maps.valor;
    } else if (campo === 'horario_json') {
      if (horario?.ignorar) continue;
      est.horario_json = horario?.json ?? null;
      est.horario = horario?.texto ?? null;
    } else if (campo === 'horario') {
      // Si vino el estructurado, el texto sale de ahí y no de lo que manden.
      if (!horario || horario.ignorar) est.horario = limpiar(req.body.horario);
    } else if (campo === 'buffer_minutos') {
      est.buffer_minutos = enteroEnRango(req.body.buffer_minutos, {
        min: 0,
        max: 240,
        porDefecto: 0,
      });
    } else if (campo === 'anticipacion_minima_horas') {
      est.anticipacion_minima_horas = enteroEnRango(
        req.body.anticipacion_minima_horas,
        { min: 0, max: 168, porDefecto: 0 },
      );
    } else if (campo === 'max_citas_dia') {
      est.max_citas_dia = enteroEnRango(req.body.max_citas_dia, {
        min: 1,
        max: 100,
        porDefecto: null,
      });
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
