// ════════════════════════════════════════════════════════════
// textoDeArchivo.js — saca el texto de un archivo de conocimiento.
//
// Para OpenAI el archivo va a un vector store y OpenAI lo parsea. Para
// Claude no hay file_search: el texto se extrae acá al subir el archivo y se
// guarda en kanban_archivos.texto_extraido, de donde utils/claude/documentos.js
// lo mete inline en las instrucciones del bot.
//
// Formatos: PDF (pdf-parse), DOCX (mammoth), XLSX/XLS/CSV (xlsx → una línea
// por fila, celdas separadas por « | »), TXT/MD/JSON/HTML (texto plano; al
// HTML se le quitan las etiquetas). PPTX y DOC viejos no se leen: devuelven
// null y el archivo queda solo para OpenAI.
//
// Tope MAX_CHARS por archivo: lo que pase de ahí se recorta con aviso.
// ════════════════════════════════════════════════════════════
'use strict';

const path = require('path');

const MAX_CHARS = 200000;

function normalizar(texto) {
  return String(texto || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function recortar(texto) {
  if (texto.length <= MAX_CHARS) return texto;
  return `${texto.slice(0, MAX_CHARS)}\n[… documento recortado a ${MAX_CHARS} caracteres]`;
}

function tipoDe(mime, nombre) {
  const m = String(mime || '').toLowerCase();
  const ext = path.extname(String(nombre || '')).toLowerCase();
  if (m === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (
    m ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === '.docx'
  )
    return 'docx';
  if (
    m === 'application/vnd.ms-excel' ||
    m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    ext === '.xlsx' ||
    ext === '.xls'
  )
    return 'xlsx';
  if (m === 'text/csv' || ext === '.csv') return 'csv';
  if (m === 'text/html' || ext === '.html' || ext === '.htm') return 'html';
  if (
    m.startsWith('text/') ||
    m === 'application/json' ||
    ['.txt', '.md', '.json', '.py', '.js', '.ts'].includes(ext)
  )
    return 'texto';
  return null;
}

async function textoPdf(buffer) {
  const pdfParse = require('pdf-parse');
  const r = await pdfParse(buffer);
  return r?.text || '';
}

async function textoDocx(buffer) {
  const mammoth = require('mammoth');
  const r = await mammoth.extractRawText({ buffer });
  return r?.value || '';
}

function textoHoja(buffer) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const partes = [];
  for (const nombre of wb.SheetNames) {
    const filas = XLSX.utils.sheet_to_json(wb.Sheets[nombre], {
      header: 1,
      defval: '',
      blankrows: false,
    });
    if (!filas.length) continue;
    const lineas = filas.map((f) =>
      f.map((c) => String(c ?? '').trim()).join(' | '),
    );
    partes.push(
      wb.SheetNames.length > 1 ? `--- Hoja: ${nombre} ---\n${lineas.join('\n')}` : lineas.join('\n'),
    );
  }
  return partes.join('\n\n');
}

function textoHtml(buffer) {
  return buffer
    .toString('utf8')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]{2,}/g, ' ');
}

/**
 * @param {Buffer} buffer
 * @param {{mime?:string, nombre?:string}} info
 * @returns {Promise<{texto:string, chars:number, tipo:string}|null>} null si el
 *   formato no se lee o el archivo no trae texto.
 */
async function extraerTexto(buffer, { mime, nombre } = {}) {
  const tipo = tipoDe(mime, nombre);
  if (!tipo || !buffer?.length) return null;
  let crudo = '';
  if (tipo === 'pdf') crudo = await textoPdf(buffer);
  else if (tipo === 'docx') crudo = await textoDocx(buffer);
  else if (tipo === 'xlsx') crudo = textoHoja(buffer);
  else if (tipo === 'csv') crudo = buffer.toString('utf8');
  else if (tipo === 'html') crudo = textoHtml(buffer);
  else crudo = buffer.toString('utf8');
  const texto = recortar(normalizar(crudo));
  if (!texto) return null;
  return { texto, chars: texto.length, tipo };
}

/** Qué formatos lee Claude (para el aviso de la UI). */
const FORMATOS_LEGIBLES_CLAUDE = 'PDF, DOCX, XLSX, CSV, TXT, MD, JSON, HTML';

module.exports = { extraerTexto, tipoDe, MAX_CHARS, FORMATOS_LEGIBLES_CLAUDE };
