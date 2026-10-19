// scripts/extraerTextoArchivosConocimiento.js
// Fase 2 Claude: rellena kanban_archivos.texto_extraido para los archivos de
// conocimiento que ya existían antes de la fase (Claude los lee inline; sin
// texto, no los ve). Dos fuentes:
//
//   1. Filas de kanban_archivos con copia local (storage_path) y sin texto:
//      se lee el archivo del disco y se extrae.
//   2. Archivos que solo viven en el vector store de documentos de OpenAI
//      (los subidos desde Kanban antes de hoy no se registraban en BD): se
//      listan por columna, se baja el texto YA PARSEADO por OpenAI
//      (GET /vector_stores/{vs}/files/{id}/content, mismo endpoint que usa
//      normalizarDocumento.js) y se registran con texto. Necesita la llave de
//      OpenAI de la cuenta.
//
// Uso:
//   node scripts/extraerTextoArchivosConocimiento.js --config=10 [--dry]
//   node scripts/extraerTextoArchivosConocimiento.js --todas [--dry]
//     --todas: solo cuentas que responden con Claude.
'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { db } = require('../src/database/config');
const { extraerTexto } = require('../src/utils/claude/textoDeArchivo');
const { llavesDeCuenta } = require('../src/utils/claude/claude');

const arg = (n) => {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  return m ? m.split('=').slice(1).join('=') : null;
};
const tiene = (n) => process.argv.includes(`--${n}`);
const DRY = tiene('dry');
const UPLOADS = path.join(__dirname, '..', 'src', 'uploads');

async function guardarTexto(id_archivo, texto) {
  if (DRY) return;
  await db.query(
    `UPDATE kanban_archivos SET texto_extraido = ?, texto_chars = ? WHERE id = ?`,
    { replacements: [texto, texto.length, id_archivo], type: db.QueryTypes.UPDATE },
  );
}

/* 1. Copias locales sin texto */
async function desdeCopiasLocales(id_configuracion) {
  const filas = await db.query(
    `SELECT id, nombre_original, mime, storage_path FROM kanban_archivos
      WHERE id_configuracion = ? AND deleted_at IS NULL
        AND storage_path IS NOT NULL AND (texto_extraido IS NULL OR texto_extraido = '')`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  let ok = 0;
  for (const f of filas) {
    const ruta = path.join(UPLOADS, f.storage_path);
    if (!fs.existsSync(ruta)) {
      console.log(`  · #${f.id} ${f.nombre_original}: sin copia local en disco`);
      continue;
    }
    const r = await extraerTexto(fs.readFileSync(ruta), {
      mime: f.mime,
      nombre: f.nombre_original,
    }).catch((e) => {
      console.log(`  · #${f.id} ${f.nombre_original}: error ${e.message}`);
      return null;
    });
    if (!r) {
      console.log(`  · #${f.id} ${f.nombre_original}: sin texto legible`);
      continue;
    }
    await guardarTexto(f.id, r.texto);
    ok += 1;
    console.log(`  ✓ #${f.id} ${f.nombre_original}: ${r.chars} chars (local)`);
  }
  return ok;
}

/* 2. Archivos del vector store de documentos no registrados en BD */
async function desdeOpenAI(id_configuracion, apiKey) {
  if (!apiKey) {
    console.log('  · sin llave de OpenAI: no se pueden bajar los documentos del vector store');
    return 0;
  }
  const headers = { Authorization: `Bearer ${apiKey}`, 'OpenAI-Beta': 'assistants=v2' };
  const cols = await db.query(
    `SELECT id, nombre, vector_store_docs_id FROM kanban_columnas
      WHERE id_configuracion = ? AND activo = 1 AND vector_store_docs_id IS NOT NULL`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  let ok = 0;
  for (const col of cols) {
    let files = [];
    try {
      const r = await axios.get(
        `https://api.openai.com/v1/vector_stores/${col.vector_store_docs_id}/files?limit=50`,
        { headers, timeout: 30000 },
      );
      files = r.data?.data || [];
    } catch (e) {
      console.log(`  · columna "${col.nombre}": no se pudo listar el store (${e?.response?.status || e.message})`);
      continue;
    }
    for (const f of files) {
      const [ya] = await db.query(
        `SELECT ka.id, ka.texto_chars FROM kanban_archivos ka
           INNER JOIN kanban_columna_archivos kca ON kca.id_archivo = ka.id AND kca.id_kanban_columna = ?
          WHERE ka.openai_file_id = ? AND ka.deleted_at IS NULL LIMIT 1`,
        { replacements: [col.id, f.id], type: db.QueryTypes.SELECT },
      );
      if (ya && Number(ya.texto_chars) > 0) continue;
      let nombre = f.id;
      let bytes = 0;
      try {
        const meta = await axios.get(`https://api.openai.com/v1/files/${f.id}`, { headers, timeout: 20000 });
        nombre = meta.data?.filename || f.id;
        bytes = meta.data?.bytes || 0;
      } catch (_) {}
      let texto = '';
      try {
        const c = await axios.get(
          `https://api.openai.com/v1/vector_stores/${col.vector_store_docs_id}/files/${f.id}/content`,
          { headers, timeout: 60000 },
        );
        texto = (c.data?.data || [])
          .map((x) => x.text || '')
          .join('\n')
          .replace(/<[A-Z][A-Z ]*FOR PAGE:[^>]*>/g, '')
          .trim();
      } catch (e) {
        console.log(`  · "${nombre}" (${col.nombre}): sin contenido parseado (${e?.response?.status || e.message})`);
        continue;
      }
      if (!texto) {
        console.log(`  · "${nombre}" (${col.nombre}): contenido vacío`);
        continue;
      }
      if (texto.length > 200000) texto = `${texto.slice(0, 200000)}\n[… documento recortado a 200000 caracteres]`;
      if (DRY) {
        console.log(`  ✓ (dry) "${nombre}" (${col.nombre}): ${texto.length} chars`);
        ok += 1;
        continue;
      }
      let id_archivo = ya?.id;
      if (!id_archivo) {
        const [ins] = await db.query(
          `INSERT INTO kanban_archivos (id_configuracion, nombre_original, mime, bytes, openai_file_id, storage_path, status)
           VALUES (?, ?, ?, ?, ?, NULL, 'completed')`,
          {
            replacements: [id_configuracion, nombre, 'application/octet-stream', bytes, f.id],
            type: db.QueryTypes.INSERT,
          },
        );
        id_archivo = ins;
        await db.query(
          `INSERT INTO kanban_columna_archivos (id_kanban_columna, id_archivo, vector_store_id, vector_store_file_id, status)
           VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = VALUES(status)`,
          { replacements: [col.id, id_archivo, col.vector_store_docs_id, f.id, f.status || 'completed'], type: db.QueryTypes.INSERT },
        );
      }
      await guardarTexto(id_archivo, texto);
      ok += 1;
      console.log(`  ✓ "${nombre}" (${col.nombre}): ${texto.length} chars (OpenAI)`);
    }
  }
  return ok;
}

(async () => {
  let configs = [];
  if (arg('config')) configs = [Number(arg('config'))];
  else if (tiene('todas')) {
    configs = (
      await db.query(`SELECT id FROM configuraciones WHERE proveedor_ia = 'claude'`, {
        type: db.QueryTypes.SELECT,
      })
    ).map((r) => r.id);
  } else {
    console.log('Uso: --config=ID | --todas  [--dry]');
    process.exit(1);
  }
  console.log(`${DRY ? '(dry) ' : ''}Cuentas: ${configs.join(', ') || 'ninguna'}`);
  for (const id of configs) {
    console.log(`\n== cfg ${id}`);
    const llaves = await llavesDeCuenta(id);
    const a = await desdeCopiasLocales(id);
    const b = await desdeOpenAI(id, llaves.api_key_openai);
    console.log(`   → ${a} desde copias locales, ${b} desde OpenAI`);
  }
  process.exit(0);
})().catch((e) => {
  console.error('ERROR', e.message);
  process.exit(1);
});
