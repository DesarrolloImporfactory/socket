// scripts/generarAgenciasServientrega.js
// ─────────────────────────────────────────────────────────────
// Convierte el PDF de agencias Servientrega (el reporte tabular
// REGIONAL/PROVINCIA/CIUDAD/CS/DIRECCION/HABILITADO) en un TXT indexable
// para file_search: una agencia por línea con campos etiquetados, agrupadas
// por ciudad. Ese TXT es el que se sube como archivo de conocimiento.
//
//   node scripts/generarAgenciasServientrega.js <agencias.pdf> <salida.txt>
//
// POR QUÉ EXISTE: la capa de texto del PDF está desalineada — extraída en
// modo columnas (-layout), la dirección de una agencia cae en la fila de la
// siguiente, y así lo indexa OpenAI: fragmentos con parejas nombre-dirección
// corridas. Por eso el bot de la 569 (2026-08-18) no encontraba
// "QUITO_AV. DEL MAESTRO" o daba la dirección de otra agencia. En modo flujo
// (-raw) las filas salen bien pareadas pero sin frontera entre el nombre de
// la agencia y la dirección, así que este script cruza las dos extracciones:
// toma los nombres de -layout y el pareo de -raw.
//
// Requiere pdftotext (poppler) en el PATH — en Windows viene con Git Bash.
// Las filas sin "SI" en HABILITADO RETIRO OFICINA se descartan: ofrecer una
// agencia sin retiro es peor que no ofrecerla.
// ─────────────────────────────────────────────────────────────
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [pdf, salida] = process.argv.slice(2);
if (!pdf || !salida) {
  console.error('Uso: node scripts/generarAgenciasServientrega.js <agencias.pdf> <salida.txt>');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agencias-'));
const layoutTxt = path.join(tmp, 'layout.txt');
const rawTxt = path.join(tmp, 'raw.txt');
execFileSync('pdftotext', ['-layout', pdf, layoutTxt]);
execFileSync('pdftotext', ['-raw', pdf, rawTxt]);

// 1. Nombres de agencia (CS) desde -layout: columnas separadas por 2+
//    espacios; el campo con "_" es el CS completo ("CIUDAD_NOMBRE").
const nombresCS = new Set();
for (const linea of fs.readFileSync(layoutTxt, 'utf8').split('\n')) {
  for (const campo of linea.trim().split(/\s{2,}/)) {
    if (campo.includes('_')) nombresCS.add(campo.trim());
  }
}

// Ciudad → nombres de agencia sin el prefijo, más largos primero para que el
// prefix-match no se quede con un nombre que es prefijo de otro.
const porCiudad = new Map();
for (const cs of nombresCS) {
  const i = cs.indexOf('_');
  const ciudad = cs.slice(0, i).trim();
  if (!porCiudad.has(ciudad)) porCiudad.set(ciudad, []);
  porCiudad.get(ciudad).push(cs.slice(i + 1).trim());
}
for (const lista of porCiudad.values()) lista.sort((a, b) => b.length - a.length);

// 2. Filas bien pareadas desde -raw. Un registro termina en " SI" o " NO";
//    si una línea no termina así, continúa en la siguiente.
const crudas = fs.readFileSync(rawTxt, 'utf8')
  .split('\n').map((l) => l.trim()).filter(Boolean)
  .filter((l) => !/^REGIONA/.test(l) && !/^L PROVINCIA/.test(l) && !/^\f/.test(l));

const registros = [];
let buffer = '';
for (const l of crudas) {
  buffer = buffer ? `${buffer} ${l}` : l;
  if (/\s(SI|NO)$/.test(buffer)) {
    registros.push(buffer);
    buffer = '';
  }
}
if (buffer) registros.push(buffer);

// 3. ZONA PROVINCIA CIUDAD CIUDAD_NOMBRE DIRECCION SI|NO — la ciudad aparece
//    dos veces (columna propia + prefijo del CS): backreference.
const agencias = [];
const fallidos = [];
for (const r of registros) {
  const m = r.match(/^(\S+)\s+(.+?)\s+(.+?)\s+\3_(.+?)\s+(SI|NO)$/);
  if (!m) {
    fallidos.push(r);
    continue;
  }
  const [, , provincia, ciudad, resto, habilitado] = m;
  if (habilitado !== 'SI') continue;

  let nombre = null;
  let direccion = null;
  for (const n of porCiudad.get(ciudad) || []) {
    if (resto === n) { nombre = n; direccion = ''; break; }
    if (resto.startsWith(n + ' ')) { nombre = n; direccion = resto.slice(n.length).trim(); break; }
  }
  if (nombre === null) {
    fallidos.push(r);
    continue;
  }
  agencias.push({ provincia, ciudad, nombre, direccion });
}

// 4. Redactar agrupado por ciudad: los fragmentos de 800 tokens quedan casi
//    mono-ciudad y la búsqueda "agencias en X" cae en el fragmento correcto.
agencias.sort((a, b) => a.ciudad.localeCompare(b.ciudad) || a.nombre.localeCompare(b.nombre));
const lineas = [
  'AGENCIAS SERVIENTREGA ECUADOR HABILITADAS PARA RETIRO EN OFICINA',
  'Cada línea es una agencia: nombre | ciudad | provincia | dirección.',
  'Solo se listan agencias donde el cliente SÍ puede retirar su pedido.',
  '',
];
let ciudadActual = '';
for (const a of agencias) {
  if (a.ciudad !== ciudadActual) {
    ciudadActual = a.ciudad;
    lineas.push('', `== CIUDAD: ${a.ciudad} (Provincia: ${a.provincia}) ==`);
  }
  lineas.push(
    `Agencia Servientrega ${a.nombre} | Ciudad: ${a.ciudad} | Provincia: ${a.provincia} | Dirección: ${a.direccion || '(consultar en agencia)'} | Retiro en oficina: SÍ`,
  );
}
fs.writeFileSync(salida, lineas.join('\n'), 'utf8');

console.log(`✅ ${agencias.length} agencias habilitadas → ${salida}`);
if (fallidos.length) {
  console.log(`⚠️ ${fallidos.length} fila(s) no parseadas — revisarlas y agregarlas a mano:`);
  for (const f of fallidos) console.log(`   ${f}`);
}
