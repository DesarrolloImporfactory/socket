// scripts/generarPalabrasFrecuentes.js
// ─────────────────────────────────────────────────────────────
// Mide qué palabras escriben los clientes en TODAS las cuentas y genera
// src/utils/palabrasFrecuentesChat.json, la lista de palabras que el selector
// de productos (contextoColumna) debe ignorar.
//
// POR QUÉ MEDIDA Y NO CURADA A MANO
// El selector empareja palabras del mensaje contra nombres de catálogo. Caso
// real (config 285): el cliente aceptó un combo con "Está bien" y la palabra
// "esta" coincidió con "Deja de Roncar Desde ESTA Noche" — el bot cambió de
// producto justo al cierre. Curar "esta", "aja", "listo"… a mano es un parche
// que envejece: cada semana aparece una muletilla nueva. Acá se mide.
//
// EL CRITERIO: UBICUIDAD, NO SOLO FRECUENCIA
// Una palabra entra a la lista si es frecuente EN LA MAYORÍA de las cuentas.
// - "esta", "gracias", "ok" son gramática/cortesía: frecuentes en TODAS las
//   verticales → entran.
// - "licuadora" solo es frecuente donde venden licuadoras, y "casa" donde
//   venden casas → NO entran, y el selector las sigue usando para identificar
//   producto, que es exactamente lo que se quiere.
// Frecuencia global a secas se equivoca: "casa" puede ser globalmente frecuente
// solo porque las inmobiliarias pesan mucho en el corpus.
//
// USO
//   node scripts/generarPalabrasFrecuentes.js            → reporte + escribe el JSON
//   node scripts/generarPalabrasFrecuentes.js --dry      → solo reporte, no escribe
//
// Correrlo de vez en cuando (o tras sumar una vertical nueva) mantiene la
// lista al día. El runtime NO depende de que exista: sin el JSON, contextoColumna
// usa solo su lista base.
// ─────────────────────────────────────────────────────────────

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { db } = require('../src/database/config');

const DRY = process.argv.includes('--dry');

// Muestra: los últimos N ids de mensajes_clientes (rango por PK a propósito:
// un WHERE por fecha sin índice sobre esta tabla es el hotspot documentado).
const RANGO_IDS = 600000;
// Una cuenta opina solo si tiene volumen: con 20 mensajes cualquier palabra
// parece frecuente.
const MIN_MENSAJES_POR_CONFIG = 300;
// "Frecuente" dentro de una cuenta: aparece en ≥1% de los mensajes de clientes.
// Entra a la lista si además es frecuente en ≥50% de las cuentas con volumen.
//
// Calibrado contra la muestra del 2026-08-17 (116.697 msgs, 68 cuentas):
//   2% / 60% → 18 palabras, solo gramática pura; se le escapan "listo",
//              "cuesta", "estoy" y —lo importante— las ciudades.
//   1% / 50% → 50 palabras. Entran las ciudades y el courier ("quito",
//              "guayaquil", "servientrega"): un cliente que responde "Quito" a
//              la pregunta de ciudad es una palabra suelta que puede calzar con
//              un nombre de catálogo — la misma forma del caso "Está bien".
//              Ningún sustantivo de producto entró ("casa", "licuadora",
//              "mascara" quedan fuera porque solo son frecuentes en SU
//              vertical, que es el criterio funcionando).
// Si al regenerar aparece un sustantivo de producto en la lista, subir los
// umbrales antes de escribir.
const UMBRAL_FRECUENCIA = 0.01;
const UMBRAL_UBICUIDAD = 0.5;

// Misma normalización que contextoColumna: lo que se filtra tiene que ser
// exactamente lo que el selector compara.
const normalizar = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

(async () => {
  const [{ maxId }] = await db.query(
    'SELECT MAX(id) AS maxId FROM mensajes_clientes',
    { type: db.QueryTypes.SELECT },
  );
  const desde = Number(maxId) - RANGO_IDS;

  console.log(`Muestra: mensajes_clientes id > ${desde} (últimos ${RANGO_IDS})`);
  const filas = await db.query(
    `SELECT id_configuracion, LEFT(texto_mensaje, 200) AS texto
       FROM mensajes_clientes
      WHERE id > ? AND rol_mensaje = 0 AND tipo_mensaje = 'text'
        AND texto_mensaje IS NOT NULL AND texto_mensaje <> ''`,
    { replacements: [desde], type: db.QueryTypes.SELECT },
  );
  console.log(`Mensajes de clientes en la muestra: ${filas.length}`);

  // docFreq por cuenta: en cuántos MENSAJES de esa cuenta aparece cada palabra
  // (no cuántas veces: repetirla en un mensaje no la hace más muletilla).
  const porConfig = new Map(); // cfg -> { total, palabras: Map<palabra, nDocs> }
  for (const f of filas) {
    const cfg = Number(f.id_configuracion);
    if (!porConfig.has(cfg)) porConfig.set(cfg, { total: 0, palabras: new Map() });
    const c = porConfig.get(cfg);
    c.total += 1;
    const unicas = new Set(
      normalizar(f.texto)
        .split(' ')
        .filter((t) => t.length > 2 && !/^\d+$/.test(t)),
    );
    for (const t of unicas) c.palabras.set(t, (c.palabras.get(t) || 0) + 1);
  }

  const conVolumen = [...porConfig.entries()].filter(
    ([, c]) => c.total >= MIN_MENSAJES_POR_CONFIG,
  );
  console.log(
    `Cuentas con volumen (≥${MIN_MENSAJES_POR_CONFIG} msgs): ${conVolumen.length} de ${porConfig.size}`,
  );
  if (conVolumen.length < 5) {
    console.error('Muy pocas cuentas con volumen: sube RANGO_IDS. No se escribe nada.');
    process.exit(1);
  }

  // ¿En cuántas cuentas es frecuente cada palabra?
  const ubicuidad = new Map(); // palabra -> nº de cuentas donde es frecuente
  for (const [, c] of conVolumen) {
    for (const [palabra, nDocs] of c.palabras) {
      if (nDocs / c.total >= UMBRAL_FRECUENCIA) {
        ubicuidad.set(palabra, (ubicuidad.get(palabra) || 0) + 1);
      }
    }
  }

  const minCuentas = Math.ceil(conVolumen.length * UMBRAL_UBICUIDAD);
  const lista = [...ubicuidad.entries()]
    .filter(([, n]) => n >= minCuentas)
    .sort((a, b) => b[1] - a[1])
    .map(([palabra]) => palabra);

  console.log(`\nPalabras frecuentes en ≥${minCuentas}/${conVolumen.length} cuentas: ${lista.length}`);
  for (const p of lista) console.log(`  ${p}  (${ubicuidad.get(p)} cuentas)`);

  // Aviso de colisiones: palabras de la lista que aparecen en nombres de
  // productos. Que "esta" salga acá es EL CASO que esto arregla; si saliera un
  // sustantivo real ("casa", "reloj") habría que revisar los umbrales.
  const productos = await db.query(
    'SELECT nombre FROM productos_chat_center WHERE eliminado = 0',
    { type: db.QueryTypes.SELECT },
  );
  const enNombres = new Set();
  for (const p of productos) {
    for (const t of normalizar(p.nombre).split(' ')) {
      if (lista.includes(t)) enNombres.add(t);
    }
  }
  if (enNombres.size) {
    console.log(
      `\n⚠️ De la lista, aparecen en nombres de catálogo (dejarán de matchear ahí): ${[...enNombres].join(', ')}`,
    );
  }

  if (DRY) {
    console.log('\n--dry: no se escribió el JSON.');
    process.exit(0);
  }

  const destino = path.join(__dirname, '..', 'src', 'utils', 'palabrasFrecuentesChat.json');
  fs.writeFileSync(destino, JSON.stringify(lista, null, 2) + '\n');
  console.log(`\nEscrito ${destino} (${lista.length} palabras).`);
  process.exit(0);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
