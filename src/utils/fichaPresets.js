'use strict';

/* Datos que solo existen en un nicho.
   ─────────────────────────────────────────────────────────────
   Cuántos dormitorios tiene una casa es imprescindible en inmobiliaria y no
   significa nada en dropshipping. Como columnas de `productos_chat_center`
   obligarían a todas las cuentas a ver campos vacíos que no entienden, y como
   texto suelto dentro de la descripción el bot tiene que adivinarlos —que es
   justo lo que se venía haciendo, con el resultado esperable: inventaba metros
   cuadrados.

   Acá se define QUÉ campos tiene la ficha de cada nicho. Los valores viven en
   `productos_chat_center.atributos_json` y la cuenta elige su preset en
   `configuraciones.ficha_preset`. Sin preset, nada de esto existe: ni el
   formulario lo muestra ni el asistente lo recibe.

   Los campos son deliberadamente de texto libre. "3" y "3 y un estudio" son
   respuestas válidas de un propietario, y un input numérico obliga a mentir. */

const PRESETS = {
  inmobiliaria: {
    nombre: 'Inmuebles',
    descripcion: 'Dormitorios, baños, metros y todo lo que se pregunta de una propiedad',
    /* Columnas que solo existen en un tablero de este rubro. Sirven para saber
       a qué se dedica la cuenta sin preguntárselo: ver más abajo por qué. */
    señas: ['captacion', 'por_agendar'],
    /* Un inmueble se carga como servicio: es lo que permite agendarle una
       visita (procesarAgendarCita bloquea las citas sobre productos) y hace que
       `duracion` sea lo que dura mostrarlo. */
    tipo_item: 'servicio',
    duracion_sugerida: 45,
    // Se va a verlo donde está, así que la ubicación del ítem importa.
    usa_ubicacion: true,
    campos: [
      { clave: 'operacion', etiqueta: 'Operación', ejemplo: 'venta / arriendo' },
      { clave: 'tipo_inmueble', etiqueta: 'Tipo', ejemplo: 'casa, departamento, terreno, local, bodega' },
      { clave: 'dormitorios', etiqueta: 'Dormitorios', ejemplo: '3' },
      { clave: 'banos', etiqueta: 'Baños', ejemplo: '2 y medio' },
      { clave: 'parqueaderos', etiqueta: 'Parqueaderos', ejemplo: '1' },
      { clave: 'area_construccion', etiqueta: 'Área de construcción', ejemplo: '120 m²' },
      { clave: 'area_terreno', etiqueta: 'Área del terreno', ejemplo: '200 m²' },
      { clave: 'piso', etiqueta: 'Piso', ejemplo: '4to' },
      { clave: 'antiguedad', etiqueta: 'Antigüedad', ejemplo: '5 años / a estrenar' },
      { clave: 'amoblado', etiqueta: 'Amoblado', ejemplo: 'sí / no / semi' },
      { clave: 'alicuota', etiqueta: 'Alícuota', ejemplo: '$60 mensuales' },
      { clave: 'estado_ocupacion', etiqueta: 'Estado', ejemplo: 'vacío / habitado / arrendado' },
    ],
  },

  /* Vehículos: el otro nicho donde el ítem se va a ver donde está y la ficha
     decide la conversación entera. Va de ejemplo vivo de que el mecanismo no es
     "el parche de inmobiliaria". */
  vehiculos: {
    nombre: 'Vehículos',
    descripcion: 'Año, kilometraje, motor y el resto de la ficha de un auto',
    señas: ['prueba_manejo', 'test_drive'],
    // Igual que un inmueble: se agenda ir a verlo al patio donde está.
    tipo_item: 'servicio',
    duracion_sugerida: 30,
    usa_ubicacion: true,
    campos: [
      { clave: 'marca', etiqueta: 'Marca', ejemplo: 'Toyota' },
      { clave: 'modelo', etiqueta: 'Modelo', ejemplo: 'Hilux' },
      { clave: 'anio', etiqueta: 'Año', ejemplo: '2021' },
      { clave: 'kilometraje', etiqueta: 'Kilometraje', ejemplo: '68.000 km' },
      { clave: 'transmision', etiqueta: 'Transmisión', ejemplo: 'mecánica / automática' },
      { clave: 'combustible', etiqueta: 'Combustible', ejemplo: 'diésel' },
      { clave: 'motor', etiqueta: 'Motor', ejemplo: '2.4' },
      { clave: 'traccion', etiqueta: 'Tracción', ejemplo: '4x4' },
      { clave: 'placa_termina', etiqueta: 'Placa termina en', ejemplo: '7' },
    ],
  },
};

const obtenerPreset = (clave) => PRESETS[String(clave || '').trim()] || null;

/* ── Saber el rubro sin preguntárselo a nadie ──────────────────
   La primera versión de esto tenía un botón "Ficha" donde el cliente elegía su
   rubro. Es un paso de configuración que no aporta nada: el sistema YA sabe a
   qué se dedica la cuenta, porque su tablero se lo dice. Un tablero con una
   columna de captación de propietarios y otra de visitas por agendar es una
   inmobiliaria, y no hace falta que nadie lo confirme con un clic.

   La cuenta puede fijarlo a mano igual (`configuraciones.ficha_preset` manda
   siempre sobre lo inferido); es el escape para el caso raro, no el camino
   normal. */
function inferirPreset(estadosDb) {
  const estados = new Set(
    (estadosDb || []).map((e) => String(e || '').toLowerCase().trim()),
  );
  for (const [clave, def] of Object.entries(PRESETS)) {
    if ((def.señas || []).some((s) => estados.has(s))) return clave;
  }
  return null;
}

/**
 * Preset efectivo de una configuración: el elegido a mano, o el que se deduce
 * de su tablero. Cuando se deduce, se guarda —así se resuelve una sola vez y
 * el resto del sistema lee un dato y no una heurística.
 *
 * @param {object} db  instancia de Sequelize (se pasa para no crear un ciclo
 *                     de require entre utils y database/config)
 */
async function resolverPreset(db, id_configuracion) {
  const [cfg] = await db.query(
    `SELECT ficha_preset FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!cfg) return null;
  if (cfg.ficha_preset) return cfg.ficha_preset;

  const columnas = await db.query(
    `SELECT estado_db FROM kanban_columnas
      WHERE id_configuracion = ? AND activo = 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  const inferido = inferirPreset(columnas.map((c) => c.estado_db));
  if (!inferido) return null;

  await db.query(`UPDATE configuraciones SET ficha_preset = ? WHERE id = ?`, {
    replacements: [inferido, id_configuracion],
    type: db.QueryTypes.UPDATE,
  });

  return inferido;
}

/* Los atributos se guardan como llegan pero solo los del preset: si mañana el
   preset cambia, lo que quedó guardado de más no se pierde —se ignora— y no
   ensucia el prompt con claves que ya nadie sabe qué significan. */
function normalizarAtributos(preset, valores) {
  const def = obtenerPreset(preset);
  if (!def) return null;

  let crudo = valores;
  if (typeof crudo === 'string') {
    try {
      crudo = JSON.parse(crudo);
    } catch {
      return null;
    }
  }
  if (!crudo || typeof crudo !== 'object' || Array.isArray(crudo)) return null;

  const salida = {};
  for (const campo of def.campos) {
    const v = crudo[campo.clave];
    if (v === undefined || v === null) continue;
    const texto = String(v).trim().slice(0, 120);
    if (texto) salida[campo.clave] = texto;
  }
  return Object.keys(salida).length ? salida : null;
}

/* Ficha legible para el asistente. Solo los campos con valor: un "Dormitorios:
   no especificado" invita al modelo a rellenarlo por su cuenta. */
function fichaLegible(preset, valores) {
  const def = obtenerPreset(preset);
  if (!def) return '';

  let crudo = valores;
  if (typeof crudo === 'string') {
    try {
      crudo = JSON.parse(crudo);
    } catch {
      return '';
    }
  }
  if (!crudo || typeof crudo !== 'object') return '';

  return def.campos
    .filter((c) => String(crudo[c.clave] || '').trim())
    .map((c) => `${c.etiqueta}: ${String(crudo[c.clave]).trim()}`)
    .join(' · ');
}

module.exports = {
  PRESETS,
  obtenerPreset,
  inferirPreset,
  resolverPreset,
  normalizarAtributos,
  fichaLegible,
};
