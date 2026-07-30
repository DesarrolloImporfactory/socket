'use strict';

/**
 * Instala la columna "Retiro en agencia" CON su asistente de cierre en las
 * plantillas globales del kanban.
 *
 *   node scripts/instalar_columna_retiro_agencia.js --todas            (simula)
 *   node scripts/instalar_columna_retiro_agencia.js --todas --aplicar
 *   node scripts/instalar_columna_retiro_agencia.js 3 7 --aplicar
 *   node scripts/instalar_columna_retiro_agencia.js 3 --aplicar --forzar
 *
 * Por defecto SIMULA: imprime qué cambiaría y no escribe nada. Con --aplicar
 * escribe el `data` de la plantilla. Con --forzar además pisa las instrucciones
 * de una columna que ya tenga prompt propio (sin --forzar se respetan).
 *
 * Esto NO le toca el tablero a ningún cliente. Solo deja la columna en la
 * plantilla global; cada cliente la recibe cuando pulsa "Actualizar tablero"
 * (personalizacionResincronizar), que es quien le crea el asistente en OpenAI
 * con SU api_key y le inserta la acción.
 */

require('dotenv').config();
const { db } = require('../src/database/config');
const {
  COLUMNA_RETIRO_AGENCIA,
  REMARKETING_POR_DEFECTO,
} = require('../src/utils/kanban_catalogo.data');
const {
  getTemplatesMetaMerged,
} = require('../src/utils/kanban_catalogo.provider');

const OK = '✅';
const NO = '❌';
const WARN = '⚠️ ';
const SIN_CAMBIO = '·';

const ESTADO = COLUMNA_RETIRO_AGENCIA.estado_db;
// Todas las columnas a las que la IA puede mover el contacto desde aquí: cada
// una tiene que existir en el tablero o el contacto quedaría en un estado sin
// columna y el bot dejaría de responderle.
const ESTADOS_DESTINO = [
  ...new Set(COLUMNA_RETIRO_AGENCIA.acciones.map((a) => a.config.estado_destino)),
];

// Plantillas Meta que la secuencia de esta columna necesita para poder enviar
// fuera de la ventana de 24h.
const TEMPLATES_SEGUIMIENTO = (() => {
  const bloque = REMARKETING_POR_DEFECTO.find(
    (b) => b.estado_contacto === ESTADO,
  );
  return [
    ...new Set(
      (bloque?.secuencias || []).map((s) => s.nombre_template).filter(Boolean),
    ),
  ];
})();

function parseData(raw) {
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// Se empareja por (tipo_accion, estado_destino) y NO por trigger: si el trigger
// cambió es justo lo que hay que corregir, no un motivo para dejar dos acciones
// apuntando al mismo lado.
function buscarAccion(acciones, esperada) {
  return (acciones || []).find(
    (a) =>
      a?.tipo_accion === esperada.tipo_accion &&
      parseData(a?.config)?.estado_destino === esperada.config.estado_destino,
  );
}

/**
 * `data.setup.templates_meta_items` es la lista blanca de qué plantillas Meta se
 * mandan a crear en la cuenta del cliente al aplicar o actualizar el tablero
 * (null = todas). Si la secuencia de agencia está instalada pero sus plantillas
 * no están marcadas, la cuenta nueva se queda sin ellas — y el super admin las
 * ve desmarcadas en el editor, que es peor: parece que no van.
 *
 * Pasa cuando la lista se guardó ANTES de que existieran esas plantillas: al ser
 * explícita, lo nuevo del catálogo no entra solo.
 */
function ajustarSetup(data, cambios, nombresValidos) {
  const setup = data.setup;
  if (!setup || !Array.isArray(setup.templates_meta_items)) return;

  const faltan = TEMPLATES_SEGUIMIENTO.filter(
    (n) => !setup.templates_meta_items.includes(n),
  );
  if (faltan.length) {
    setup.templates_meta_items = [...setup.templates_meta_items, ...faltan];
    cambios.push(`plantillas Meta marcadas para crear: ${faltan.join(', ')}`);
  }

  // Nombres seleccionados que ya no existen ni en fábrica ni en los custom
  // (típicamente una plantilla renombrada). No hacen daño —nunca coinciden— pero
  // descuadran el contador del editor: "15 de 19" con 16 marcadas.
  // Se compara contra el catálogo COMPLETO (fábrica + custom) para no
  // desmarcar sin querer un ítem custom legítimo.
  if (nombresValidos instanceof Set && nombresValidos.size) {
    const fantasmas = setup.templates_meta_items.filter(
      (n) => !nombresValidos.has(n),
    );
    if (fantasmas.length) {
      setup.templates_meta_items = setup.templates_meta_items.filter((n) =>
        nombresValidos.has(n),
      );
      cambios.push(
        `selecciones que ya no existen en el catálogo, quitadas: ${fantasmas.join(', ')}`,
      );
    }
  }
}

/**
 * Devuelve { cambios: [], data } con el data ya modificado en memoria.
 * Si cambios viene vacío, no hay nada que escribir.
 */
function aplicarEnData(data, { forzar, nombresValidos }) {
  const cambios = [];
  ajustarSetup(data, cambios, nombresValidos);

  const cols = Array.isArray(data.columnas) ? data.columnas : [];
  const idx = cols.findIndex(
    (c) => String(c.estado_db || '').toLowerCase() === ESTADO,
  );

  if (idx === -1) {
    const ordenMax = cols.reduce((m, c) => Math.max(m, Number(c.orden) || 0), 0);
    cols.push({ ...COLUMNA_RETIRO_AGENCIA, orden: ordenMax + 1 });
    data.columnas = cols;
    cambios.push('columna nueva con asistente y acción de cierre');
    return { cambios, data };
  }

  const col = cols[idx];

  // Prompt: solo se pisa uno existente con --forzar. Una plantilla puede tener
  // la columna con un prompt que alguien escribió a mano.
  if (!col.instrucciones) {
    col.instrucciones = COLUMNA_RETIRO_AGENCIA.instrucciones;
    cambios.push('instrucciones (estaba sin prompt)');
  } else if (col.instrucciones !== COLUMNA_RETIRO_AGENCIA.instrucciones) {
    if (forzar) {
      col.instrucciones = COLUMNA_RETIRO_AGENCIA.instrucciones;
      cambios.push('instrucciones REEMPLAZADAS (--forzar)');
    } else {
      cambios.push(`${WARN}ya tiene prompt propio → se respeta (usa --forzar)`);
    }
  }

  if (!Number(col.activa_ia)) {
    col.activa_ia = 1;
    cambios.push('activa_ia = 1');
  }
  if (!col.modelo) {
    col.modelo = COLUMNA_RETIRO_AGENCIA.modelo;
    cambios.push(`modelo = ${COLUMNA_RETIRO_AGENCIA.modelo}`);
  }
  if (!Number.isInteger(col.max_tokens)) {
    col.max_tokens = COLUMNA_RETIRO_AGENCIA.max_tokens;
    cambios.push(`max_tokens = ${COLUMNA_RETIRO_AGENCIA.max_tokens}`);
  }

  const acciones = Array.isArray(col.acciones) ? col.acciones : [];
  for (const esperada of COLUMNA_RETIRO_AGENCIA.acciones) {
    const existente = buscarAccion(acciones, esperada);

    if (!existente) {
      const ordenMax = acciones.reduce(
        (m, a) => Math.max(m, Number(a.orden) || 0),
        0,
      );
      acciones.push({ ...esperada, orden: ordenMax + 1 });
      cambios.push(
        `acción ${esperada.tipo_accion} "${esperada.config.trigger}" → ${esperada.config.estado_destino}`,
      );
      continue;
    }

    // Existe pero con el trigger viejo (o apagada): se corrige en su lugar.
    const cfgActual = parseData(existente.config) || {};
    if (cfgActual.trigger !== esperada.config.trigger) {
      cambios.push(
        `trigger corregido: "${cfgActual.trigger}" → "${esperada.config.trigger}"`,
      );
      existente.config = { ...cfgActual, ...esperada.config };
    }
    if (Number(existente.activo) === 0) {
      existente.activo = 1;
      cambios.push(`acción "${esperada.config.trigger}" reactivada`);
    }
  }
  col.acciones = acciones;

  cols[idx] = col;
  data.columnas = cols;
  return { cambios, data };
}

async function procesar(p, { aplicar, forzar, bump, nombresValidos }) {
  console.log(`\n${'═'.repeat(66)}`);
  console.log(`PLANTILLA ${p.id} — ${p.nombre}${p.activo ? '' : ' [INACTIVA]'}`);
  console.log('═'.repeat(66));

  let data;
  try {
    data = parseData(p.data);
  } catch (e) {
    console.log(`${NO} data ilegible: ${e.message}`);
    return false;
  }
  if (!data || !Array.isArray(data.columnas)) {
    console.log(`${NO} la plantilla no tiene data.columnas`);
    return false;
  }

  const estadosTablero = new Set(
    data.columnas.map((c) => String(c.estado_db || '').toLowerCase()),
  );
  const destinosFaltantes = ESTADOS_DESTINO.filter(
    (d) => !estadosTablero.has(d),
  );
  if (destinosFaltantes.length) {
    console.log(
      `${WARN}no tiene la columna "${destinosFaltantes.join('", "')}": la IA movería el contacto a un estado sin columna. Se omite esta plantilla.`,
    );
    return false;
  }

  const { cambios } = aplicarEnData(data, { forzar, nombresValidos });
  const reales = cambios.filter((c) => !c.startsWith(WARN));

  if (!cambios.length) {
    console.log(`${SIN_CAMBIO} ya estaba al día en su data`);
    // Sin cambios pero con --bump: sirve para el caso de una data ya aplicada a
    // la que le faltó subir la versión, que es lo único que hace aparecer el
    // aviso "hay una versión más nueva" en el tablero del cliente.
    if (!bump) return false;
  } else {
    for (const c of cambios)
      console.log(`   ${c.startsWith(WARN) ? '' : '+ '}${c}`);
    if (!reales.length) return false;
  }

  if (!aplicar) {
    console.log(`\n   ${WARN}SIMULACIÓN — nada se escribió (agrega --aplicar)`);
    return false;
  }

  // version + 1 SIEMPRE que se escribe, igual que hace el admin al guardar
  // (kanban_plantillas_admin.controller.js). El aviso del tablero se calcula
  // como configuraciones.prompt_version < plantilla.version: si la data cambia
  // y la versión no, el cliente nunca se entera de que hay algo nuevo y el
  // botón "Actualizar tablero" ni aparece.
  await db.query(
    `UPDATE kanban_plantillas_globales
        SET data = ?, version = version + 1, updated_at = NOW()
      WHERE id = ?`,
    {
      replacements: [JSON.stringify(data), p.id],
      type: db.QueryTypes.UPDATE,
    },
  );
  const [row] = await db.query(
    `SELECT version FROM kanban_plantillas_globales WHERE id = ? LIMIT 1`,
    { replacements: [p.id], type: db.QueryTypes.SELECT },
  );
  console.log(`\n   ${OK} guardado — versión ahora ${row?.version}`);
  return true;
}

(async () => {
  const args = process.argv.slice(2);
  const aplicar = args.includes('--aplicar');
  const forzar = args.includes('--forzar');
  const todas = args.includes('--todas');
  const bump = args.includes('--bump');
  const ids = args.map(Number).filter(Boolean);

  if (!todas && !ids.length) {
    console.log(
      'Uso: node scripts/instalar_columna_retiro_agencia.js (--todas | <id>...) [--aplicar] [--forzar] [--bump]',
    );
    process.exit(1);
  }

  const plantillas = todas
    ? await db.query(
        `SELECT id, nombre, activo, data FROM kanban_plantillas_globales
          WHERE activo = 1 ORDER BY id`,
        { type: db.QueryTypes.SELECT },
      )
    : await db.query(
        `SELECT id, nombre, activo, data FROM kanban_plantillas_globales
          WHERE id IN (:ids) ORDER BY id`,
        { replacements: { ids }, type: db.QueryTypes.SELECT },
      );

  if (!plantillas.length) {
    console.log(`${NO} no se encontró ninguna plantilla`);
    process.exit(1);
  }

  // Catálogo completo (fábrica + custom) para saber qué selecciones del setup
  // siguen siendo válidas.
  let nombresValidos = new Set();
  try {
    const merged = await getTemplatesMetaMerged();
    nombresValidos = new Set(merged.map((t) => t.name));
  } catch (e) {
    console.log(`${WARN}no se pudo leer el catálogo de plantillas: ${e.message}`);
  }

  let escritas = 0;
  for (const p of plantillas) {
    if (await procesar(p, { aplicar, forzar, bump, nombresValidos })) escritas++;
  }

  console.log(`\n${'─'.repeat(66)}`);
  console.log(
    `${plantillas.length} plantilla(s) revisada(s) · ${escritas} actualizada(s)`,
  );
  if (escritas) {
    console.log(
      '\nFalta el último paso: cada cliente debe pulsar "Actualizar tablero"\n' +
        '(o corre el resincronizador masivo) para que se le cree el asistente\n' +
        'con su api_key. Verifica el resultado con:\n' +
        '  node scripts/verificar_seguimiento_agencia.js <id_configuracion>',
    );
  }
  console.log('');
  process.exit(0);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
