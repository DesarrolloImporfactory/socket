/**
 * Instala el bot de soporte IMPORFACTORY EXPERTOS (utils/prompt_soporte_expertos)
 * en una cuenta. Pensado para la 265 (real) y la 10 (pruebas).
 *
 * El bot de la 265 cubre SOLO fuera del horario del equipo, así que este
 * instalador no deja la columna lista sin su horario: prompt y ajustes van
 * juntos, y sin un horario válido no escribe nada.
 *
 * Qué hace (todo en una transacción, con backup antes):
 *   - Columna principal (contacto_inicial): prompt, modelo, max_tokens, IA
 *     activa y un assistant_id local si no tiene (por Responses no se usa,
 *     pero kanban_ia exige uno). Suelta el catálogo: este bot no vende.
 *   - Apaga (activo = 0, no borra) TODAS las acciones de esa columna: el bot
 *     no mueve chats. La 265 traía un cambiar_estado con el trigger vacío, que
 *     con la IA encendida coincidiría con cualquier respuesta.
 *   - ia_split_mensajes = 0: la respuesta sale en un solo mensaje.
 *   - configuraciones.ia_ajustes: espera de 20 s, mensaje de respaldo, pausa
 *     cuando una persona escribió hace poco, HORARIO del bot y, mientras se
 *     prueba, la lista blanca de teléfonos (solo_numeros).
 *   - ia_ajustes.soporte_expertos (versión 2): enciende, para esta cuenta, la
 *     consulta de la carga del cliente por su teléfono, las fichas de la base
 *     por turno y la guardia de respuestas (utils/soporteExpertos/turno.js).
 *
 * Qué NO hace: no prende el interruptor del bot (eso es en Asistentes), no
 * toca la llave de OpenAI de la cuenta, no crea ni borra columnas y no mueve
 * contactos.
 *
 *   node scripts/instalarBotSoporteExpertos.js --cfg=265 --solo=5939XXXXXXXX            → muestra qué haría
 *   node scripts/instalarBotSoporteExpertos.js --cfg=265 --solo=5939XXXXXXXX --aplicar  → lo aplica
 *   ... --desde=16:00 --hasta=08:00   franja del bot (esos son los valores por defecto)
 *   ... --dias-completos=0            días en que contesta las 24 h (0 = domingo … 6 = sábado)
 *   ... --excluir=593...,593...       teléfonos del equipo a los que nunca contesta
 *   ... --abrir-a-todos               quita la lista blanca: el bot contesta a TODOS
 *                                     los clientes de la línea dentro del horario
 *   ... --sin-cargas                  no consulta la carga del cliente (el bot pide la
 *                                     marca o la cotización y pasa a logística, como la v1)
 *   ... --sin-fichas                  no manda fichas por turno: pega la base ENTERA en el
 *                                     prompt (más caro en cada mensaje)
 *   ... --herramientas                el bot (solo con Claude) puede consultar la carga a
 *                                     mitad de la respuesta y pasar a un asesor
 *
 * Antes de instalar conviene ver qué leería el bot de un número real, sin
 * escribir nada:  node scripts/probarCargaExpertos.js --telefono=5939XXXXXXXX
 *
 * Sin --solo y sin --abrir-a-todos no instala: la 265 tiene decenas de miles de
 * contactos en la columna de entrada y el bot les contestaría a todos.
 * Antes de escribir deja un backup en backups_prompts/ (gitignored).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { db } = require('../src/database/config');
const {
  promptSoporteExpertos,
  MENSAJE_FALLBACK,
  SECCION_HERRAMIENTAS,
} = require('../src/utils/prompt_soporte_expertos.data');
const { buscadorDeArchivo } = require('../src/utils/soporteExpertos/fichas');
const ajustesIA = require('../src/utils/ajustesIA');
const { mezclarSoporteExpertos } = require('./soporte_expertos/mezclarAjustes');

const arg = (k) =>
  (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=');
const lista = (k) =>
  arg(k)
    .split(',')
    .map((n) => n.replace(/\D/g, ''))
    .filter(Boolean);
const APLICAR = process.argv.includes('--aplicar');
const ABRIR = process.argv.includes('--abrir-a-todos');
const CFG = Number(arg('cfg'));
const MODELO = arg('modelo') || 'gpt-4.1';
const MAX_TOKENS = 900;
const DESDE = arg('desde') || '16:00';
const HASTA = arg('hasta') || '08:00';
const DIAS_COMPLETOS = arg('dias-completos')
  .split(',')
  .filter((d) => d !== '')
  .map(Number);
const SOLO = lista('solo');
const EXCLUIR = lista('excluir');
const SIN_CARGAS = process.argv.includes('--sin-cargas');
// Herramientas de Claude (consultar la carga a mitad de la respuesta, pasar a
// un asesor). Solo sirven si la cuenta usa Claude; ver utils/claude/herramientas.js.
const HERRAMIENTAS = process.argv.includes('--herramientas');
const SIN_FICHAS = process.argv.includes('--sin-fichas');
if (HERRAMIENTAS && SIN_CARGAS) {
  // El prompt de herramientas describe ver_mi_carga, que con la carga apagada no se ofrece.
  console.error('--herramientas y --sin-cargas no van juntos: las herramientas necesitan la carga encendida.');
  process.exit(1);
}

// La pausa vale en la columna donde vive el bot: de 16:00 a 17:00 el equipo
// todavía atiende, y si un asesor escribió hace poco el chat es suyo.
const PAUSA_HUMANO = { minutos: 45, estados: ['contacto_inicial'] };

/* config viene como objeto, string JSON o string JSON doblemente codificado. */
function parseConfig(c) {
  try {
    let x = c;
    while (typeof x === 'string') x = JSON.parse(x);
    return x && typeof x === 'object' ? x : {};
  } catch {
    return {};
  }
}

async function q(sql, replacements = [], type = 'SELECT') {
  return db.query(sql, { replacements, type: db.QueryTypes[type] });
}

async function main() {
  if (!CFG) throw new Error('Falta --cfg=<id_configuracion>');
  if (typeof ajustesIA.dentroDeHorario !== 'function') {
    throw new Error('Este código todavía no tiene el horario del bot (utils/ajustesIA.dentroDeHorario). No se instala.');
  }
  if (!SOLO.length && !ABRIR) {
    throw new Error('Falta --solo=<teléfonos de prueba>. Para abrirlo a todos los clientes de la línea, --abrir-a-todos.');
  }
  if (SOLO.length && ABRIR) throw new Error('--solo y --abrir-a-todos no van juntos.');

  if (typeof ajustesIA.calladoPorHorarioOLista !== 'function') {
    throw new Error('Este código todavía no tiene el bot de soporte v2 (utils/ajustesIA.calladoPorHorarioOLista). No se instala.');
  }
  // Sin un archivo de fichas válido no se instala: el bot quedaría sin base.
  const base = buscadorDeArchivo();
  if (!base.total) throw new Error('src/utils/soporteExpertos/fichas_bot.json no tiene fichas válidas. No se instala.');

  const prompt =
    promptSoporteExpertos({ baseCompleta: SIN_FICHAS ? base.fichas : null }) +
    (HERRAMIENTAS ? `\n\n${SECCION_HERRAMIENTAS}` : '');
  // El panel no deja guardar un prompt de más de 60.000 caracteres
  // (public_config.controller → botEditarColumna): si se instala uno más
  // largo, después nadie lo puede editar desde ahí.
  if (prompt.length > 60000) {
    throw new Error(
      `El prompt quedaría en ${prompt.length} caracteres y el panel admite 60.000. ` +
        'Con esta base no se puede pegar entera (--sin-fichas): instala con las fichas por turno.',
    );
  }

  const [cfg] = await q(
    `SELECT id, nombre_configuracion, ia_split_mensajes, ia_ajustes,
            (api_key_openai IS NOT NULL AND api_key_openai <> '') AS tiene_llave
       FROM configuraciones WHERE id = ?`,
    [CFG],
  );
  if (!cfg) throw new Error(`No existe la configuración ${CFG}`);

  const [col] = await q(
    `SELECT * FROM kanban_columnas
      WHERE id_configuracion = ? AND estado_db = 'contacto_inicial' AND activo = 1
        AND id_tablero IS NULL LIMIT 1`,
    [CFG],
  );
  if (!col) throw new Error(`La cfg ${CFG} no tiene columna contacto_inicial activa`);

  const acciones = await q(`SELECT * FROM kanban_acciones WHERE id_kanban_columna = ?`, [col.id]);
  const [interruptor] = await q(
    `SELECT activo FROM openai_assistants
      WHERE id_configuracion = ? AND tipo = 'ventas' AND deleted_at IS NULL LIMIT 1`,
    [CFG],
  );

  /* Ajustes: se conserva lo que la cuenta ya tenga y se pisa solo lo de este bot. */
  const previo = parseConfig(cfg.ia_ajustes);
  const horario = { desde: DESDE, hasta: HASTA };
  if (DIAS_COMPLETOS.length) horario.dias_completos = DIAS_COMPLETOS;
  const ajustesNuevos = {
    ...previo,
    espera_rafaga_seg: 20,
    mensaje_fallback: MENSAJE_FALLBACK,
    pausa_humano: PAUSA_HUMANO,
    horario,
    solo_numeros: ABRIR ? [] : [...new Set([...(previo.solo_numeros || []), ...SOLO])],
    numeros_excluidos: [...new Set([...(previo.numeros_excluidos || []), ...EXCLUIR])],
    soporte_expertos: mezclarSoporteExpertos(previo, { cargas: !SIN_CARGAS, fichas: !SIN_FICHAS, herramientas: HERRAMIENTAS }),
  };
  const leidos = ajustesIA.normalizar(ajustesNuevos);
  if (leidos.horario_invalido || !leidos.horario) {
    throw new Error(`El horario ${DESDE} → ${HASTA} no se entiende. No se instala.`);
  }
  if (!ABRIR && !leidos.solo_numeros.length) {
    throw new Error('Ningún teléfono de --solo es válido. No se instala.');
  }

  const assistantId = col.assistant_id || `local_${col.id}_${Date.now()}`;
  const aApagar = acciones.filter((a) => Number(a.activo) === 1);

  console.log(`Cfg ${CFG} (${cfg.nombre_configuracion}) · columna ${col.id} "${col.nombre}"`);
  console.log(`  prompt: ${String(col.instrucciones || '').length} → ${prompt.length} chars · base: ${base.version}${SIN_FICHAS ? ' (pegada entera en el prompt)' : ' (viaja por turno, 3 fichas por mensaje)'}`);
  console.log(`  bot de soporte v2: carga del cliente por su teléfono ${SIN_CARGAS ? 'APAGADA' : 'encendida (solo lectura, base de Imporsuit)'} · fichas por turno ${SIN_FICHAS ? 'APAGADAS' : 'encendidas'} · guardia de respuestas encendida · herramientas ${HERRAMIENTAS ? 'ENCENDIDAS (solo con Claude)' : 'apagadas'}`);
  console.log(`  modelo: ${col.modelo} → ${MODELO} · max_tokens ${col.max_tokens} → ${MAX_TOKENS}`);
  console.log(`  IA de la columna: ${col.activa_ia} → 1 · assistant_id: ${col.assistant_id || '—'} → ${assistantId}`);
  console.log(`  catálogo: vector ${col.vector_store_id || '—'} · inline ${col.catalogo_inline_tokens || 0} tokens → sin catálogo`);
  console.log(`  acciones de la columna que se apagan: ${aApagar.length ? aApagar.map((a) => `${a.id} ${a.tipo_accion}`).join(', ') : 'ninguna'}`);
  console.log(`  ia_split_mensajes: ${cfg.ia_split_mensajes} → 0 (un solo mensaje por respuesta)`);
  console.log(`  ia_ajustes → ${JSON.stringify(ajustesNuevos)}`);
  console.log(
    `  horario del bot: ${DESDE} → ${HASTA}` +
      (leidos.horario.dias_completos.length ? ` + días completos ${leidos.horario.dias_completos.join(',')}` : '') +
      ` · ahora mismo ${ajustesIA.dentroDeHorario(leidos) ? 'contestaría' : 'callaría'}`,
  );
  console.log(
    ABRIR
      ? '  ⚠️  SIN lista blanca: contesta a TODOS los clientes de la línea dentro del horario.'
      : `  en prueba: solo contesta a ${leidos.solo_numeros.length} teléfono(s).`,
  );
  console.log(`  interruptor del bot (Asistentes): ${interruptor ? (Number(interruptor.activo) ? 'ENCENDIDO' : 'apagado') : 'nunca se activó'} — este script no lo toca`);
  console.log(`  llave de OpenAI de la cuenta: ${Number(cfg.tiene_llave) ? 'sí' : 'NO tiene (sin llave el bot no contesta)'} — este script no la toca`);

  if (!APLICAR) {
    console.log('\n(sin --aplicar: no se escribió nada)');
    return;
  }

  const dir = path.join(__dirname, '..', 'backups_prompts');
  fs.mkdirSync(dir, { recursive: true });
  const archivo = path.join(dir, `soporte_expertos_cfg${CFG}_${Date.now()}.json`);
  fs.writeFileSync(
    archivo,
    JSON.stringify(
      { columna: col, acciones, ia_split_mensajes: cfg.ia_split_mensajes, ia_ajustes: cfg.ia_ajustes },
      null,
      2,
    ),
  );
  console.log(`\n💾 backup: ${archivo}`);

  await db.transaction(async (t) => {
    const o = (replacements, type = 'UPDATE') => ({ replacements, type: db.QueryTypes[type], transaction: t });
    // Primero los ajustes: si algo falla después, la columna no queda con IA y sin horario.
    await db.query(`UPDATE configuraciones SET ia_ajustes = ?, ia_split_mensajes = 0 WHERE id = ?`, o([JSON.stringify(ajustesNuevos), CFG]));
    for (const a of aApagar) {
      await db.query(`UPDATE kanban_acciones SET activo = 0 WHERE id = ?`, o([a.id]));
    }
    await db.query(
      `UPDATE kanban_columnas
          SET instrucciones = ?, modelo = ?, max_tokens = ?, activa_ia = 1, assistant_id = ?,
              vector_store_id = NULL, catalogo_inline = NULL, catalogo_inline_tokens = NULL
        WHERE id = ?`,
      o([prompt, MODELO, MAX_TOKENS, assistantId, col.id]),
    );
  });
  ajustesIA.invalidarAjustesIA(CFG);
  console.log(
    '✅ Instalado: columna principal + ajustes (horario' +
      (ABRIR ? '' : ' y lista blanca') +
      '). El interruptor del bot y la llave de OpenAI no se tocaron.',
  );
}

main()
  .then(() => db.close())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('ERROR', e.message);
    process.exit(1);
  });
