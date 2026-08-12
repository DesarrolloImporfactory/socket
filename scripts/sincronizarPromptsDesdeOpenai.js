// ═══════════════════════════════════════════════════════════════
// sincronizarPromptsDesdeOpenai.js
//
// Copia a kanban_columnas.instrucciones el prompt que HOY está corriendo
// dentro del assistant de OpenAI.
//
// POR QUÉ
//
// Mientras una cuenta usa la Assistants API, el prompt que manda es el que
// vive en OpenAI; `instrucciones` es apenas una copia local. Al pasar a la
// Responses API la fuente se invierte: el prompt sale de la BD. Si la copia
// está desactualizada, el bot cambia de comportamiento en silencio.
//
// La auditoría del 2026-08-11 encontró 16 columnas donde difieren y 6 con la
// BD vacía. En las que difieren, el prompt de la BD resultó ser un PREFIJO
// EXACTO del de OpenAI: a este último le habían agregado a mano un bloque
// —"REGLA CRITICA DE CIERRE (6 DATOS)", 3.194 caracteres— que nunca se guardó
// localmente. Ese bloque es el que impide cerrar una venta sin cantidad,
// ciudad y modalidad de entrega: migrar sin él haría que el bot empiece a
// generar guías incompletas.
//
// CRITERIO
//
// Manda lo que está corriendo, o sea OpenAI. Pero solo se toca automáticamente
// cuando el cambio es seguro:
//   - BD vacía                       → se copia
//   - BD es prefijo de OpenAI        → se copia (OpenAI tiene todo lo de la BD y más)
//   - difieren SOLO en el nombre de
//     la tienda                      → se copia (ver abajo)
//   - cualquier otro caso            → NO se toca, se reporta para mirarlo a mano
//
// El último caso importa: si la BD tiene texto que OpenAI no tiene, copiar
// encima sería borrar trabajo de alguien.
//
// EL CASO DEL NOMBRE DE LA TIENDA (cfg 408)
//
// La BD guarda el prompt con el nombre viejo hardcodeado ("imporshop") y OpenAI
// lo tiene ya sustituido por el real ("COMPRALO EC"), porque compilarPromptFinal
// reemplaza los NOMBRES_TIENDA_LEGACY antes de subirlo. No son dos prompts
// distintos: son la misma cosa en dos etapas del compilador. Aquí la BD NO es
// prefijo (el texto cambia en medio), pero copiar es igualmente correcto —y de
// hecho necesario—: si no, al pasar a Responses el bot se presentaría como
// "Hola! Soy Sara de imporshop" en una tienda que se llama COMPRALO EC.
//
// Se verifica programáticamente, no a ojo: se neutraliza el nombre en ambos
// lados con un centinela y los textos tienen que quedar idénticos byte a byte.
// Si queda cualquier otra diferencia, la columna cae en "revisar a mano".
//
// USO
//   node scripts/sincronizarPromptsDesdeOpenai.js           (dry-run)
//   node scripts/sincronizarPromptsDesdeOpenai.js --apply
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { db } = require('../src/database/config');
const { NOMBRES_TIENDA_LEGACY } = require('../src/utils/promptCompiler');

const APLICAR = process.argv.includes('--apply');
const norm = (s) => String(s || '').replace(/\r/g, '').trim();
const log = (...a) => console.log(...a);

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const LEGACY_PELADOS = NOMBRES_TIENDA_LEGACY.filter(
  (t) => t && !/\sTIENDA$/i.test(t),
);

// Dado el texto de la BD partido por un nombre legacy, deduce qué puso OpenAI
// en esos huecos. Devuelve el reemplazo solo si es EL MISMO en todos los huecos
// y si el resto del texto encaja exacto de principio a fin; si no, null.
function inferirReemplazo(piezas, remoto) {
  let pos = 0;
  let reemplazo = null;

  for (let i = 0; i < piezas.length; i++) {
    if (!remoto.startsWith(piezas[i], pos)) return null;
    pos += piezas[i].length;
    if (i === piezas.length - 1) break;

    const siguiente = piezas[i + 1];
    const fin = siguiente.length ? remoto.indexOf(siguiente, pos) : remoto.length;
    if (fin < 0) return null;

    const x = remoto.slice(pos, fin);
    if (reemplazo === null) reemplazo = x;
    else if (reemplazo !== x) return null; // huecos inconsistentes: no es un rename
    pos = fin;
  }

  if (pos !== remoto.length) return null;
  // Un nombre de tienda, no un bloque de texto (validarPersonalizacion topa en 100).
  if (!reemplazo || !reemplazo.trim() || reemplazo.length > 100) return null;
  return reemplazo;
}

// ¿La única diferencia entre los dos textos es el nombre de la tienda?
//
// Se neutralizan, en los DOS lados, el nombre real y los nombres legacy, y se
// exige igualdad byte a byte del resto. Solo se usan los nombres "pelados"
// (no las variantes "X TIENDA") a propósito: la BD dice "imporshop TIENDA" y
// OpenAI "COMPRALO EC TIENDA", así que la palabra TIENDA tiene que sobrevivir
// en ambos para que la comparación cuadre.
//
// El nombre real se toma de kanban_columnas_personalizaciones si existe, pero
// no se depende de ella: muchas columnas viejas no tienen esa fila (cfg 408 no
// la tiene). En ese caso se infiere del propio diff. La inferencia es solo una
// pista — lo que autoriza a copiar es la igualdad de abajo, nunca la pista.
function soloCambiaElNombreDeTienda(local, remoto, nombreTienda) {
  const candidatos = [];

  const guardado = (nombreTienda || '').trim();
  if (guardado) candidatos.push(guardado);

  for (const legacy of LEGACY_PELADOS) {
    const re = new RegExp(escapeRegex(legacy), 'gi');
    if (!re.test(local)) continue;
    const piezas = local.split(re);
    if (piezas.length < 2) continue;
    const inferido = inferirReemplazo(piezas, remoto);
    if (inferido) candidatos.push(inferido);
  }

  for (const nombre of candidatos) {
    const tokens = [nombre, ...LEGACY_PELADOS];
    const neutralizar = (texto) =>
      tokens.reduce(
        (acc, t) => acc.replace(new RegExp(escapeRegex(t), 'gi'), '@@TIENDA@@'),
        texto,
      );
    if (neutralizar(local) === neutralizar(remoto)) return nombre;
  }

  return null;
}

async function main() {
  log(APLICAR ? '⚠️  MODO APLICAR — se escribe en kanban_columnas' : '🔍 DRY-RUN — no se escribe nada');
  log('');

  const columnas = await db.query(
    `SELECT kc.id, kc.id_configuracion, kc.estado_db, kc.assistant_id,
            kc.instrucciones, c.api_key_openai, p.nombre_tienda
       FROM kanban_columnas kc
       JOIN configuraciones c ON c.id = kc.id_configuracion
       LEFT JOIN kanban_columnas_personalizaciones p
              ON p.id_kanban_columna = kc.id
      WHERE kc.activo = 1 AND kc.activa_ia = 1
        AND kc.assistant_id IS NOT NULL
        AND c.api_key_openai IS NOT NULL AND c.api_key_openai <> ''
      ORDER BY kc.id_configuracion, kc.id`,
    { type: db.QueryTypes.SELECT },
  );

  log(`Columnas a revisar: ${columnas.length}`);

  const R = { iguales: 0, copiar: [], revisarAMano: [], sinAcceso: 0 };
  const cache = new Map();

  for (const col of columnas) {
    let remoto = cache.get(col.assistant_id);
    if (remoto === undefined) {
      try {
        const r = await axios.get(
          `https://api.openai.com/v1/assistants/${col.assistant_id}`,
          {
            headers: {
              Authorization: `Bearer ${col.api_key_openai}`,
              'OpenAI-Beta': 'assistants=v2',
            },
          },
        );
        remoto = norm(r.data?.instructions);
      } catch (_) {
        remoto = null;
      }
      cache.set(col.assistant_id, remoto);
    }
    if (remoto === null) {
      R.sinAcceso++;
      continue;
    }

    const local = norm(col.instrucciones);
    if (local === remoto) {
      R.iguales++;
      continue;
    }

    const ref = `cfg ${col.id_configuracion} col ${col.id} (${col.estado_db})`;
    let nombreNuevo = null;

    if (!local.length) {
      R.copiar.push({ col, remoto, motivo: `BD vacía → ${remoto.length} chars` });
    } else if (remoto.startsWith(local)) {
      R.copiar.push({
        col,
        remoto,
        motivo: `BD es prefijo: le faltan ${remoto.length - local.length} chars del final`,
      });
    } else if (
      (nombreNuevo = soloCambiaElNombreDeTienda(local, remoto, col.nombre_tienda))
    ) {
      R.copiar.push({
        col,
        remoto,
        motivo: `solo cambia el nombre de tienda → "${nombreNuevo}" (la BD tiene el legacy)`,
      });
    } else {
      // La BD tiene algo que OpenAI no: copiar encima borraría trabajo.
      let i = 0;
      while (i < Math.min(local.length, remoto.length) && local[i] === remoto[i]) i++;
      R.revisarAMano.push(
        `${ref} — BD ${local.length} vs OpenAI ${remoto.length}, divergen en el char ${i}`,
      );
    }
  }

  log('');
  log('═'.repeat(62));
  log(`✅ ya idénticas        : ${R.iguales}`);
  log(`🔑 sin acceso a OpenAI : ${R.sinAcceso}  (key muerta: no las bloquea)`);
  log('');
  log(`📋 A COPIAR desde OpenAI: ${R.copiar.length}`);
  R.copiar.forEach((x) =>
    log(`   cfg ${x.col.id_configuracion} col ${x.col.id} (${x.col.estado_db}) — ${x.motivo}`),
  );

  if (R.revisarAMano.length) {
    log('');
    log(`⚠️  A REVISAR A MANO (la BD tiene texto que OpenAI no): ${R.revisarAMano.length}`);
    R.revisarAMano.forEach((x) => log(`   ${x}`));
    log('   Estas NO se tocan: copiar encima borraría lo que haya escrito alguien.');
  }

  if (!APLICAR) {
    log('');
    log('(dry-run: no se escribió nada — repetir con --apply)');
    process.exit(0);
  }

  // Respaldo ANTES de escribir. Un prompt es trabajo de alguien: si algo sale
  // mal tiene que poder volver exactamente a como estaba, sin depender de un
  // backup de la base entera.
  const dir = path.join(process.cwd(), 'backups_prompts');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivo = path.join(dir, `prompts_antes_${stamp}.json`);

  const respaldo = R.copiar.map((x) => ({
    id_columna: x.col.id,
    id_configuracion: x.col.id_configuracion,
    estado_db: x.col.estado_db,
    motivo: x.motivo,
    instrucciones_antes: x.col.instrucciones,
    instrucciones_despues: x.remoto,
  }));
  fs.writeFileSync(archivo, JSON.stringify(respaldo, null, 2), 'utf8');
  log('');
  log(`🛟 Respaldo escrito: ${archivo}`);
  log(`   Para revertir una columna: UPDATE kanban_columnas SET instrucciones = <instrucciones_antes> WHERE id = <id_columna>;`);

  log('');
  let n = 0;
  for (const x of R.copiar) {
    await db.query(`UPDATE kanban_columnas SET instrucciones = ? WHERE id = ?`, {
      replacements: [x.remoto, x.col.id],
      type: db.QueryTypes.UPDATE,
    });
    n++;
    log(`   💾 col ${x.col.id} actualizada (${x.remoto.length} chars)`);
  }
  log('');
  log(`Listo: ${n} columnas sincronizadas. Respaldo en ${archivo}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('ERR', e?.response?.data || e.message);
  process.exit(1);
});
