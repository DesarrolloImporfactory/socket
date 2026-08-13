// ═══════════════════════════════════════════════════════════════
// auditarMigracionResponsesApi.js
//
// Solo lectura. Dice qué columnas están listas para pasar de la Assistants API
// a la Responses API, y cuáles romperían.
//
// POR QUÉ HACE FALTA
//
// Las dos APIs sacan el prompt de lugares distintos:
//   Assistants → vive en el assistant DENTRO de OpenAI
//   Responses  → sale de kanban_columnas.instrucciones (tu MySQL)
//
// Mientras se usa Assistants, `instrucciones` es una copia local que nadie
// garantiza que esté al día. Si difiere, el día que la cuenta pase a Responses
// el bot cambia de comportamiento y nadie se entera hasta que un cliente se
// queja. Lo mismo con el modelo.
//
// Contexto: OpenAI apaga la Assistants API el 2026-08-26, así que esto no es
// opcional — hay que mover las 273 configuraciones sí o sí.
//
// USO
//   node scripts/auditarMigracionResponsesApi.js
//   node scripts/auditarMigracionResponsesApi.js 610 666    (solo esas configs)
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const axios = require('axios');
const { db } = require('../src/database/config');

const FILTRO = process.argv.slice(2).map(Number).filter(Boolean);
const norm = (s) => String(s || '').replace(/\r/g, '').trim();
const log = (...a) => console.log(...a);

async function main() {
  const columnas = await db.query(
    `SELECT kc.id, kc.id_configuracion, kc.estado_db, kc.assistant_id,
            kc.instrucciones, kc.modelo, c.api_key_openai
       FROM kanban_columnas kc
       JOIN configuraciones c ON c.id = kc.id_configuracion
      WHERE kc.activo = 1 AND kc.activa_ia = 1
        AND kc.assistant_id IS NOT NULL
        ${FILTRO.length ? `AND kc.id_configuracion IN (${FILTRO.join(',')})` : ''}
      ORDER BY kc.id_configuracion, kc.id`,
    { type: db.QueryTypes.SELECT },
  );

  log(`Columnas a auditar: ${columnas.length}`);
  log('');

  const R = {
    ok: [],
    promptDistinto: [],
    promptVacio: [],
    modeloDistinto: [],
    sinAssistant: [],
    keyMuerta: [],
    sinKey: [],
  };

  // Cache por assistant_id: varias columnas pueden compartir uno.
  const cache = new Map();
  let i = 0;

  for (const col of columnas) {
    i++;
    if (i % 50 === 0) log(`  … ${i}/${columnas.length}`);

    const ref = `cfg ${col.id_configuracion} col ${col.id} (${col.estado_db})`;

    if (!col.api_key_openai) {
      R.sinKey.push(ref);
      continue;
    }

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
        remoto = {
          instructions: norm(r.data?.instructions),
          model: r.data?.model || null,
        };
      } catch (e) {
        remoto = { error: e.response?.status || 'red' };
      }
      cache.set(col.assistant_id, remoto);
    }

    if (remoto.error === 401) {
      R.keyMuerta.push(ref);
      continue;
    }
    if (remoto.error) {
      R.sinAssistant.push(`${ref} → ${remoto.error}`);
      continue;
    }

    const local = norm(col.instrucciones);

    if (!local.length) {
      R.promptVacio.push(`${ref} — OpenAI tiene ${remoto.instructions.length} chars`);
      continue;
    }
    if (local !== remoto.instructions) {
      R.promptDistinto.push(
        `${ref} — BD ${local.length} chars vs OpenAI ${remoto.instructions.length}`,
      );
      continue;
    }
    if (col.modelo && remoto.model && col.modelo !== remoto.model) {
      R.modeloDistinto.push(`${ref} — BD ${col.modelo} vs OpenAI ${remoto.model}`);
      continue;
    }
    R.ok.push(ref);
  }

  const linea = (etiqueta, arr, muestra = 12) => {
    log('');
    log(`${etiqueta}: ${arr.length}`);
    arr.slice(0, muestra).forEach((x) => log(`   ${x}`));
    if (arr.length > muestra) log(`   … y ${arr.length - muestra} más`);
  };

  log('');
  log('═'.repeat(62));
  log('  RESULTADO');
  log('═'.repeat(62));
  log(`✅ LISTAS para migrar          : ${R.ok.length} / ${columnas.length}`);
  linea('⚠️  PROMPT DISTINTO (cambiaría el comportamiento)', R.promptDistinto);
  linea('🚫 PROMPT VACÍO en BD (no se ejecutaría)', R.promptVacio);
  linea('⚠️  MODELO DISTINTO', R.modeloDistinto);
  linea('❌ ASSISTANT NO ENCONTRADO en OpenAI', R.sinAssistant);
  linea('🔑 API KEY MUERTA (401) — ya no funcionan hoy', R.keyMuerta);
  linea('🔑 SIN API KEY configurada', R.sinKey);

  const bloqueantes =
    R.promptDistinto.length + R.promptVacio.length + R.modeloDistinto.length;
  log('');
  log(`Bloqueantes reales a resolver antes de migrar: ${bloqueantes}`);
  log(
    'Las de key muerta o assistant inexistente no funcionan HOY tampoco: no las bloquea la migración.',
  );

  process.exit(0);
}

main().catch((e) => {
  console.error('ERR', e?.response?.data || e.message);
  process.exit(1);
});
