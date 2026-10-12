/**
 * Cambia la base de fichas del bot de soporte de Expertos.
 *
 * Valida el archivo nuevo (lista de fichas con id, tema, pais, preguntas,
 * respuesta_base, pasos, enlace, pasar_a…) y, si está bien, lo copia a
 * src/utils/soporteExpertos/fichas_bot.json. No toca la base de datos ni el
 * prompt: las fichas viajan por turno, así que basta con publicar el archivo
 * y reiniciar el servicio.
 *
 *   node scripts/actualizarFichasExpertos.js <archivo.json>            → solo valida
 *   node scripts/actualizarFichasExpertos.js <archivo.json> --copiar   → valida y copia
 */
const fs = require('fs');
const path = require('path');
const { validarFichas, crearBuscador, RUTA_FICHAS } = require('../src/utils/soporteExpertos/fichas');

const origen = process.argv[2];
const COPIAR = process.argv.includes('--copiar');
if (!origen) {
  console.error('Uso: node scripts/actualizarFichasExpertos.js <archivo.json> [--copiar]');
  process.exit(1);
}

const crudo = JSON.parse(fs.readFileSync(path.resolve(origen), 'utf8'));
const { fichas, errores } = validarFichas(crudo);
const graves = errores.filter((e) => !/sin «preguntas»/.test(e));
const b = crearBuscador(fichas);

console.log(`${b.version}`);
const porTema = {};
for (const f of fichas) porTema[f.tema || '(sin tema)'] = (porTema[f.tema || '(sin tema)'] || 0) + 1;
console.log(Object.entries(porTema).map(([t, n]) => `  ${t}: ${n}`).join('\n'));
console.log(`  con pasos: ${fichas.filter((f) => f.pasos.length).length} · con enlace: ${fichas.filter((f) => f.enlace).length} · que pasan a una persona: ${fichas.filter((f) => f.pasar_a).length}`);
if (errores.length) console.log(`\nAvisos (${errores.length}):\n${errores.map((e) => `  - ${e}`).join('\n')}`);

if (graves.length || !fichas.length) {
  console.error('\n❌ El archivo tiene fichas que no se pueden usar. No se copia.');
  process.exit(1);
}
if (!COPIAR) {
  console.log('\n(sin --copiar: no se cambió nada)');
  process.exit(0);
}
fs.writeFileSync(RUTA_FICHAS, `${JSON.stringify(crudo, null, 1)}\n`);
console.log(`\n✅ Copiado a ${path.relative(process.cwd(), RUTA_FICHAS)}. Corre node scripts/probar_soporte_expertos.js antes de publicar.`);
