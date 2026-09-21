// scripts/chequearRequires.js
// ────────────────────────────────────────────────────────
// Verifica que cada require() relativo de src/ apunte a un archivo que existe
// en el repositorio CON LA MISMA CAPITALIZACIÓN.
//
// POR QUÉ EXISTE
//
// El 2026-09-21 cayeron desarrollo y producción a la vez (Apache 503 en toda
// la API) por una sola línea: require('../utils/AppError') cuando el archivo es
// utils/appError.js. En Windows, donde desarrollamos, eso resuelve igual; en
// el servidor (Linux) es "Cannot find module" al arrancar y el proceso muere.
// `node --check` no lo ve: valida sintaxis, no resuelve módulos.
//
// Es estático: no arranca la app, no toca la base ni usa ninguna API key. Por
// eso puede correr en CUALQUIER push y en GitHub Actions, en menos de un
// segundo. Compara contra `git ls-files`, así que da el mismo resultado en
// Windows que en Linux.
//
//   node scripts/chequearRequires.js     → código 1 si algo no resuelve
// ────────────────────────────────────────────────────────
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');

/* Archivos viejos que requieren módulos que nunca se versionaron. Nadie los
   importa (no se montan en app.js), así que no participan del arranque. Están
   acá para que el chequeo pueda ser estricto con TODO lo demás: un require
   roto nuevo falla aunque estos sigan existiendo. Si se borran, se quitan. */
const MUERTOS_CONOCIDOS = new Set([
  'src/routes/kanban_acciones.routes.js',
  'src/routes/stripepro_pagos.routes.js',
  'src/services/post.service.js',
]);

const versionados = new Set(
  execSync('git ls-files', { cwd: RAIZ, maxBuffer: 1 << 26 })
    .toString()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean),
);
const enMinusculas = new Map([...versionados].map((f) => [f.toLowerCase(), f]));

// Quita comentarios para no tropezar con un require() comentado.
function sinComentarios(txt) {
  return txt
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

const problemas = [];
let revisados = 0;

for (const archivo of versionados) {
  if (!archivo.startsWith('src/') || !archivo.endsWith('.js')) continue;
  if (MUERTOS_CONOCIDOS.has(archivo)) continue;

  const txt = sinComentarios(fs.readFileSync(path.join(RAIZ, archivo), 'utf8'));
  const re = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(txt))) {
    revisados++;
    const base = path.posix.normalize(
      path.posix.join(path.posix.dirname(archivo), m[1]),
    );
    const candidatos = [base, `${base}.js`, `${base}.json`, `${base}/index.js`];
    if (candidatos.some((c) => versionados.has(c))) continue;

    const parecido = candidatos
      .map((c) => enMinusculas.get(c.toLowerCase()))
      .find(Boolean);
    problemas.push({ archivo, pedido: m[1], parecido });
  }
}

if (!problemas.length) {
  console.log(`✅ requires: ${revisados} revisados, todos resuelven (con mayúsculas exactas).`);
  process.exit(0);
}

console.error(`\n❌ ${problemas.length} require() que NO van a resolver en el servidor (Linux):\n`);
for (const p of problemas) {
  console.error(`   ${p.archivo}`);
  console.error(`     require('${p.pedido}')`);
  console.error(
    p.parecido
      ? `     → el archivo es "${p.parecido}": cambia las mayúsculas del require.\n`
      : `     → ese archivo no está en el repositorio (¿faltó el git add?).\n`,
  );
}
console.error('En Windows esto funciona igual; en el servidor tumba el arranque completo.\n');
process.exit(1);
