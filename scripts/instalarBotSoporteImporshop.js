/**
 * Instala el bot de soporte IMPORSHOP PROVEEDOR (utils/prompt_soporte_imporshop)
 * en una cuenta. Pensado para la 261 (real) y la 10 (pruebas).
 *
 * Va por FASES porque no todo depende de lo mismo:
 *
 * 1) Columna principal (contacto_inicial) — siempre. No depende del deploy.
 *   - prompt nuevo, modelo y max_tokens;
 *   - suelta el catálogo (vector store e inline; el bot no cotiza productos: manda el
 *     link del catálogo). El id viejo queda en el backup;
 *   - deja activas SOLO las acciones [asesor]:true, [resuelto]:true y
 *     enviar_media (las demás se apagan con activo=0, no se borran) y normaliza
 *     el JSON de esas acciones;
 *   - enviar_media queda con fijos_con_plantilla + fijos_no_repetir_horas (el
 *     video solo sale con su plantilla y no se repite en 24 h);
 *   - apaga ia_split_mensajes: la respuesta sale en UN solo mensaje.
 *   Crea las columnas `asesor` / `resuelto` solo si faltan.
 *
 * 2) --ajustes  → configuraciones.ia_ajustes (utils/ajustesIA): espera de 20 s,
 *    mensaje de respaldo si OpenAI falla, pausa del bot en "asesor" cuando una
 *    persona escribió hace poco y, con --excluir=593...,593..., los números
 *    del equipo. Necesita la migración ia_ajustes_migration.sql.
 *
 * 3) --espera   → prende el bot en la columna Asesor con el prompt de "modo
 *    espera" (plantilla / "¡Recibido! ✅" una vez / silencio). SOLO con el
 *    código nuevo ya en producción y los ajustes del paso 2 puestos: sin la
 *    pausa_humano el bot se metería en la conversación del asesor.
 *
 * NUNCA borra columnas ni mueve contactos. NO prende el interruptor del bot:
 * eso se hace desde Asistentes.
 *
 *   node scripts/instalarBotSoporteImporshop.js --cfg=10 --media=media.json            → muestra qué haría
 *   node scripts/instalarBotSoporteImporshop.js --cfg=10 --media=media.json --aplicar  → aplica la fase 1
 *   ... --ajustes --excluir=593991234567 --aplicar   → además la fase 2
 *   ... --espera --aplicar                           → además la fase 3
 *   ... --reenviar-media  → además prende "reenviar videos fijos" en la columna
 *
 * media.json: { video_material, video_estado_guia, video_retener,
 *               video_novedades, imagen_horarios, video_garantia? } con URLs
 *               directas (mp4/png). Sin video_garantia la garantía va sin video.
 * Antes de escribir deja un backup en backups_prompts/ (gitignored).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { db } = require('../src/database/config');
const {
  promptSoporteImporshop,
  promptSoporteImporshopEspera,
  MENSAJE_FALLBACK,
} = require('../src/utils/prompt_soporte_imporshop.data');

const arg = (k) =>
  (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=');
const APLICAR = process.argv.includes('--aplicar');
const CON_AJUSTES = process.argv.includes('--ajustes');
const CON_ESPERA = process.argv.includes('--espera');
const CFG = Number(arg('cfg'));
const MODELO = arg('modelo') || 'gpt-4.1';
const MAX_TOKENS = 1200;
const MAX_TOKENS_ESPERA = 700;
const EXCLUIR = arg('excluir')
  .split(',')
  .map((n) => n.replace(/\D/g, ''))
  .filter(Boolean);

const accionEstado = (estado) =>
  JSON.stringify({
    trigger: `[${estado}]:true`,
    estado_destino: estado,
    palabras_clave: { tipo: 'CONTAINS', valor: `[${estado}]:true` },
    accion: { tipo: 'cambiar_estado', estado_destino: estado },
  });

// --reenviar-media: los videos tutoriales salen cada vez que se responde el
// tema (reenviar_fijos, sin la ventana de 48 h del dedupe). Sin la bandera se
// respeta lo que ya tenga: lo maneja el switch de la configuración del kanban.
const REENVIAR = process.argv.includes('--reenviar-media');

/* enviar_media: lo que ya tenía la acción + las dos opciones del manual. */
const OPCIONES_MEDIA = { fijos_con_plantilla: true, fijos_no_repetir_horas: 24 };
const configMedia = (actual) =>
  JSON.stringify({
    ...parseConfig(actual),
    ...OPCIONES_MEDIA,
    ...(REENVIAR ? { reenviar_fijos: true } : {}),
  });

const AJUSTES = {
  espera_rafaga_seg: 20,
  mensaje_fallback: MENSAJE_FALLBACK,
  pausa_humano: { minutos: 15, estados: ['asesor'] },
};

const COLUMNAS_NECESARIAS = [
  { estado_db: 'asesor', nombre: 'Asesor', color_fondo: '#FFF7ED', color_texto: '#C2410C', icono: 'bx bx-user' },
  { estado_db: 'resuelto', nombre: 'Resuelto', color_fondo: '#F0FDF4', color_texto: '#15803D', icono: 'bx bx-check-circle' },
];

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
  const media = JSON.parse(fs.readFileSync(arg('media') || '', 'utf8'));
  const prompt = promptSoporteImporshop(media);
  const promptEspera = promptSoporteImporshopEspera(media);

  const [cfg] = await q(
    `SELECT id, nombre_configuracion, ia_split_mensajes FROM configuraciones WHERE id = ?`,
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
  const columnas = await q(
    `SELECT id, estado_db, activo FROM kanban_columnas WHERE id_configuracion = ? AND id_tablero IS NULL`,
    [CFG],
  );

  console.log(`Cfg ${CFG} (${cfg.nombre_configuracion}) · columna ${col.id} "${col.nombre}"`);
  console.log(`  prompt: ${String(col.instrucciones || '').length} → ${prompt.length} chars`);
  console.log(`  modelo: ${col.modelo} → ${MODELO} · max_tokens ${col.max_tokens} → ${MAX_TOKENS}`);
  console.log(`  catálogo: vector ${col.vector_store_id || '—'} · inline ${col.catalogo_inline_tokens || 0} tokens → sin catálogo`);
  console.log(`  video de garantía: ${media.video_garantia ? 'sí' : 'NO (la garantía va sin video)'}`);
  console.log(`  ia_split_mensajes: ${cfg.ia_split_mensajes} → 0 (un solo mensaje por respuesta)`);

  /* Plan de acciones: por cada destino nos quedamos con UNA activa (la primera
     que ya exista) y apagamos el resto. */
  const plan = [];
  const vistas = new Set();
  // Las activas primero: se conserva la que ya está corriendo.
  for (const a of [...acciones].sort((x, y) => Number(y.activo) - Number(x.activo))) {
    const cfgA = parseConfig(a.config);
    const destino = cfgA.estado_destino || cfgA.accion?.estado_destino;
    let quiere = 0;
    let config = null;
    if (a.tipo_accion === 'enviar_media' && !vistas.has('media')) {
      vistas.add('media');
      quiere = 1;
      config = configMedia(a.config);
    } else if (
      a.tipo_accion === 'cambiar_estado' &&
      ['asesor', 'resuelto'].includes(destino) &&
      !vistas.has(destino)
    ) {
      vistas.add(destino);
      quiere = 1;
      config = accionEstado(destino);
    }
    const cambiaConfig = config && config !== a.config;
    if (Number(a.activo) !== quiere || cambiaConfig) {
      plan.push({ id: a.id, tipo: a.tipo_accion, destino, activo: quiere, config });
    }
  }
  const nuevas = [];
  if (!vistas.has('media')) nuevas.push({ tipo: 'enviar_media', config: configMedia(null), orden: 3 });
  for (const d of ['asesor', 'resuelto']) {
    if (!vistas.has(d)) nuevas.push({ tipo: 'cambiar_estado', config: accionEstado(d), orden: 1 });
  }
  for (const p of plan)
    console.log(`  acción ${p.id} ${p.tipo}${p.destino ? `→${p.destino}` : ''}: activo=${p.activo}${p.config ? ` ${p.tipo === 'enviar_media' ? p.config : '(config normalizada)'}` : ''}`);
  for (const n of nuevas) console.log(`  acción nueva ${n.tipo} ${n.config}`);

  const faltanCols = COLUMNAS_NECESARIAS.filter(
    (c) => !columnas.some((x) => x.estado_db === c.estado_db && Number(x.activo) === 1),
  );
  for (const c of faltanCols) console.log(`  columna nueva "${c.nombre}" (${c.estado_db})`);

  /* ── Fase 2: ajustes de la cuenta ── */
  let ajustesNuevos = null;
  if (CON_AJUSTES) {
    let actual;
    try {
      [actual] = await q(`SELECT ia_ajustes FROM configuraciones WHERE id = ?`, [CFG]);
    } catch (e) {
      throw new Error(
        `No existe configuraciones.ia_ajustes: aplica primero ia_ajustes_migration.sql (${e.message})`,
      );
    }
    const previo = parseConfig(actual?.ia_ajustes);
    const excluidos = [...new Set([...(previo.numeros_excluidos || []), ...EXCLUIR])];
    ajustesNuevos = { ...previo, ...AJUSTES, numeros_excluidos: excluidos };
    console.log(`  ia_ajustes → ${JSON.stringify(ajustesNuevos)}`);
  }

  /* ── Fase 3: modo espera en la columna Asesor ── */
  let colAsesor = null;
  let accionesAsesor = [];
  if (CON_ESPERA) {
    [colAsesor] = await q(
      `SELECT * FROM kanban_columnas
        WHERE id_configuracion = ? AND estado_db = 'asesor' AND activo = 1
          AND id_tablero IS NULL LIMIT 1`,
      [CFG],
    );
    if (!colAsesor) throw new Error('--espera: la cuenta todavía no tiene columna "asesor" (corre primero la fase 1)');
    accionesAsesor = await q(`SELECT * FROM kanban_acciones WHERE id_kanban_columna = ?`, [colAsesor.id]);
    let tieneAjustes = false;
    try {
      const [a] = await q(`SELECT ia_ajustes FROM configuraciones WHERE id = ?`, [CFG]);
      tieneAjustes = Boolean(parseConfig(a?.ia_ajustes).pausa_humano) || CON_AJUSTES;
    } catch (_) {}
    if (!tieneAjustes) {
      throw new Error('--espera: la cuenta no tiene pausa_humano en ia_ajustes. Corre con --ajustes (el bot se metería en la conversación del asesor).');
    }
    console.log(`  columna ${colAsesor.id} "${colAsesor.nombre}": IA ${colAsesor.activa_ia} → 1 · prompt de espera ${promptEspera.length} chars · ${MODELO} · max_tokens ${MAX_TOKENS_ESPERA}`);
    console.log('  ⚠️  --espera solo con el código nuevo YA en producción (pausa_humano y rescate de turnos).');
  }

  if (!APLICAR) {
    console.log('\n(sin --aplicar: no se escribió nada)');
    return;
  }

  const dir = path.join(__dirname, '..', 'backups_prompts');
  fs.mkdirSync(dir, { recursive: true });
  const archivo = path.join(dir, `soporte_imporshop_cfg${CFG}_${Date.now()}.json`);
  fs.writeFileSync(
    archivo,
    JSON.stringify({ columna: col, acciones, ia_split_mensajes: cfg.ia_split_mensajes, colAsesor, accionesAsesor }, null, 2),
  );
  console.log(`\n💾 backup: ${archivo}`);

  await db.transaction(async (t) => {
    const o = (replacements, type = 'UPDATE') => ({ replacements, type: db.QueryTypes[type], transaction: t });
    await db.query(
      `UPDATE kanban_columnas
          SET instrucciones = ?, modelo = ?, max_tokens = ?, activa_ia = 1, vector_store_id = NULL,
              catalogo_inline = NULL, catalogo_inline_tokens = NULL
        WHERE id = ?`,
      o([prompt, MODELO, MAX_TOKENS, col.id]),
    );
    await db.query(`UPDATE configuraciones SET ia_split_mensajes = 0 WHERE id = ?`, o([CFG]));
    for (const p of plan) {
      if (p.config) {
        await db.query(`UPDATE kanban_acciones SET activo = ?, config = ? WHERE id = ?`, o([p.activo, p.config, p.id]));
      } else {
        await db.query(`UPDATE kanban_acciones SET activo = ? WHERE id = ?`, o([p.activo, p.id]));
      }
    }
    for (const n of nuevas) {
      await db.query(
        `INSERT INTO kanban_acciones (id_kanban_columna, id_configuracion, tipo_accion, config, activo, orden)
         VALUES (?, ?, ?, ?, 1, ?)`,
        o([col.id, CFG, n.tipo, n.config, n.orden], 'INSERT'),
      );
    }
    if (faltanCols.length) {
      const [{ maxOrden }] = await db.query(
        `SELECT COALESCE(MAX(orden), 0) AS maxOrden FROM kanban_columnas WHERE id_configuracion = ? AND id_tablero IS NULL`,
        o([CFG], 'SELECT'),
      );
      let orden = Number(maxOrden);
      for (const c of faltanCols) {
        orden += 1;
        await db.query(
          `INSERT INTO kanban_columnas
             (id_configuracion, nombre, estado_db, color_fondo, color_texto, icono, orden, activo, es_estado_final, activa_ia, max_tokens)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 0, 500)`,
          o([CFG, c.nombre, c.estado_db, c.color_fondo, c.color_texto, c.icono, orden], 'INSERT'),
        );
      }
    }

    if (ajustesNuevos) {
      await db.query(`UPDATE configuraciones SET ia_ajustes = ? WHERE id = ?`, o([JSON.stringify(ajustesNuevos), CFG]));
    }

    if (colAsesor) {
      /* assistant_id: por Responses el prompt sale de la BD y el id no se usa,
         pero kanban_ia exige que la columna tenga uno para correr. */
      await db.query(
        `UPDATE kanban_columnas
            SET instrucciones = ?, modelo = ?, max_tokens = ?, activa_ia = 1,
                assistant_id = COALESCE(assistant_id, ?)
          WHERE id = ?`,
        o([promptEspera, MODELO, MAX_TOKENS_ESPERA, col.assistant_id || 'responses', colAsesor.id]),
      );
      const mediaAsesor = accionesAsesor.find((a) => a.tipo_accion === 'enviar_media');
      // En espera el video sale siempre con su plantilla: reenviar_fijos igual que la principal.
      const cfgMediaAsesor = JSON.stringify({ ...parseConfig(configMedia(mediaAsesor?.config)), reenviar_fijos: true });
      if (mediaAsesor) {
        await db.query(`UPDATE kanban_acciones SET activo = 1, config = ? WHERE id = ?`, o([cfgMediaAsesor, mediaAsesor.id]));
      } else {
        await db.query(
          `INSERT INTO kanban_acciones (id_kanban_columna, id_configuracion, tipo_accion, config, activo, orden)
           VALUES (?, ?, 'enviar_media', ?, 1, 1)`,
          o([colAsesor.id, CFG, cfgMediaAsesor], 'INSERT'),
        );
      }
    }
  });
  console.log(
    '✅ Instalado: columna principal' +
      (ajustesNuevos ? ' + ajustes de la cuenta' : '') +
      (colAsesor ? ' + modo espera en Asesor' : '') +
      '. El interruptor del bot (Asistentes) no se tocó.',
  );
}

main()
  .then(() => db.close())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('ERROR', e.message);
    process.exit(1);
  });
