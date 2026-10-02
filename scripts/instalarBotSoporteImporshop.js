/**
 * Instala el bot de soporte IMPORSHOP PROVEEDOR (utils/prompt_soporte_imporshop)
 * en la columna Contacto Inicial de una cuenta. Pensado para la 261 (real) y
 * la 10 (pruebas).
 *
 * Qué hace en la columna principal (contacto_inicial):
 *   - prompt nuevo, modelo y max_tokens;
 *   - suelta el catálogo (vector store e inline; el bot no cotiza productos: manda el
 *     link del catálogo). El id viejo queda en el backup;
 *   - deja activas SOLO las acciones [asesor]:true, [resuelto]:true y
 *     enviar_media (las demás se apagan con activo=0, no se borran) y normaliza
 *     el JSON de esas acciones.
 * Crea las columnas `asesor` / `resuelto` solo si faltan. NUNCA borra columnas
 * ni mueve contactos. NO prende el bot: eso se hace desde Asistentes.
 *
 *   node scripts/instalarBotSoporteImporshop.js --cfg=10 --media=media.json            → muestra qué haría
 *   node scripts/instalarBotSoporteImporshop.js --cfg=10 --media=media.json --aplicar  → aplica
 *   ... --reenviar-media  → además prende "reenviar videos fijos" en la columna
 *
 * media.json: { video_material, video_estado_guia, video_retener,
 *               video_novedades, imagen_horarios } con URLs directas (mp4/png).
 * Antes de escribir deja un backup en backups_prompts/ (gitignored).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { db } = require('../src/database/config');
const { promptSoporteImporshop } = require('../src/utils/prompt_soporte_imporshop.data');

const arg = (k) =>
  (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=');
const APLICAR = process.argv.includes('--aplicar');
const CFG = Number(arg('cfg'));
const MODELO = arg('modelo') || 'gpt-4.1';
const MAX_TOKENS = 1200;

const accionEstado = (estado) =>
  JSON.stringify({
    trigger: `[${estado}]:true`,
    estado_destino: estado,
    palabras_clave: { tipo: 'CONTAINS', valor: `[${estado}]:true` },
    accion: { tipo: 'cambiar_estado', estado_destino: estado },
  });

// --reenviar-media: los videos tutoriales salen cada vez que se responde el
// tema (reenviar_fijos, sin la ventana de 48 h del dedupe). Sin la bandera no
// se toca: lo maneja el switch de la configuración del kanban.
const REENVIAR = process.argv.includes('--reenviar-media');
const CONFIG_MEDIA = REENVIAR ? JSON.stringify({ reenviar_fijos: true }) : null;

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

  const [cfg] = await q(`SELECT id, nombre_configuracion FROM configuraciones WHERE id = ?`, [CFG]);
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
      config = CONFIG_MEDIA;
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
  if (!vistas.has('media')) nuevas.push({ tipo: 'enviar_media', config: CONFIG_MEDIA || '{}', orden: 3 });
  for (const d of ['asesor', 'resuelto']) {
    if (!vistas.has(d)) nuevas.push({ tipo: 'cambiar_estado', config: accionEstado(d), orden: 1 });
  }
  for (const p of plan)
    console.log(`  acción ${p.id} ${p.tipo}${p.destino ? `→${p.destino}` : ''}: activo=${p.activo}${p.config ? ' (config normalizada)' : ''}`);
  for (const n of nuevas) console.log(`  acción nueva ${n.tipo} ${n.config}`);

  const faltanCols = COLUMNAS_NECESARIAS.filter(
    (c) => !columnas.some((x) => x.estado_db === c.estado_db && Number(x.activo) === 1),
  );
  for (const c of faltanCols) console.log(`  columna nueva "${c.nombre}" (${c.estado_db})`);

  if (!APLICAR) {
    console.log('\n(sin --aplicar: no se escribió nada)');
    return;
  }

  const dir = path.join(__dirname, '..', 'backups_prompts');
  fs.mkdirSync(dir, { recursive: true });
  const archivo = path.join(dir, `soporte_imporshop_cfg${CFG}_${Date.now()}.json`);
  fs.writeFileSync(archivo, JSON.stringify({ columna: col, acciones }, null, 2));
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
  });
  console.log('✅ Instalado. El interruptor del bot (Asistentes) no se tocó.');
}

main()
  .then(() => db.close())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('ERROR', e.message);
    process.exit(1);
  });
