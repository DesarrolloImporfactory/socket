/* Buscador local de fichas para el bot de soporte de Expertos. SIN inteligencia
   artificial y sin red: lee `fichas_bot.json`, arma un índice en memoria y, por
   cada mensaje del alumno, devuelve las fichas que más se le parecen para
   inyectarlas al contexto del turno. Así el prompt no carga con toda la base
   (la versión 1 llevaba las 52 fichas pegadas: 28.000 caracteres en cada
   mensaje) y el modelo solo ve lo que viene al caso.

   Cómo compara:
     · por RAÍZ de palabra y sin tildes (`texto.js`): «llegó», «llegaria» y
       «llegar» son lo mismo; «cotisacion» calza con «cotización» por cercanía;
     · por RAREZA: una palabra que está en casi todas las fichas («carga»,
       «clase») pesa poco; una que está en una sola («infoaduana», «proforma»)
       pesa mucho;
     · mira dos cosas: cuánto de una de las `preguntas` de la ficha aparece en
       el mensaje, y cuánto del mensaje está en la ficha entera.

   Esquema de cada ficha (lista de objetos, o `{ "fichas": [...] }`):
     id, tema, pais («todos» | «ec» | «mx»), preguntas[] (frases del alumno),
     respuesta_base, pasos[], enlace, pasar_a, pedir, no_decir[]
   Los campos de más (por ejemplo `fuentes`) se ignoran.

   CÓMO SE CAMBIA LA BASE: reemplazar `src/utils/soporteExpertos/fichas_bot.json`
   (o correr `node scripts/actualizarFichasExpertos.js <archivo>`, que la
   valida antes de copiarla) y reiniciar el servicio. No hay que reinstalar el
   prompt: las fichas viajan por turno. */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sinTildes, raices, casiIgual } = require('./texto');

const RUTA_FICHAS = path.join(__dirname, 'fichas_bot.json');
const MAX_FICHAS = 3;
/* Calibrado con 50 frases de las categorías de la prueba en papel sobre la
   base de 228 fichas: la ficha correcta sale entre las 3 primeras en 43 de 44
   (primera en 38) y nunca por debajo de 0,47; por debajo de 0,4 lo que vuelve
   se parece al mensaje en una sola palabra común. No separa todo: una
   pregunta fuera de tema puede traer una ficha que comparte una palabra rara
   («¿quién ganó el mundial?» trae una de ventas). Por eso el prompt manda
   contestar solo si la ficha responde lo que se preguntó. */
const PUNTAJE_MINIMO = 0.4;

/* A quién pasa el caso, en las palabras que sí puede leer el cliente. Los
   cargos internos («pricing», «líder comercial») no salen nunca. */
const AREAS = {
  pricing: 'el área de precios',
  precios: 'el área de precios',
  logistica: 'el área de logística',
  contabilidad: 'cobranza',
  cobranza: 'cobranza',
  ecommerce: 'el equipo de ecommerce',
  'front de ecommerce': 'el equipo de ecommerce',
  'lider comercial': 'la persona responsable',
  supervisor: 'la persona responsable',
  comercial: 'el área comercial',
  asesor: 'un asesor',
};
const areaParaCliente = (pasarA) => {
  const k = sinTildes(pasarA).trim();
  if (!k) return '';
  return AREAS[k] || 'un asesor';
};

const normalizarPais = (p) => {
  const k = sinTildes(p).trim();
  if (k === 'ec' || k.startsWith('ecu')) return 'ec';
  if (k === 'mx' || k.startsWith('mex')) return 'mx';
  return 'todos';
};

const texto = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const listaDe = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(texto).filter(Boolean);

/** Deja una ficha en la forma que usa el buscador; null si no sirve. */
function normalizarFicha(f) {
  if (!f || typeof f !== 'object') return null;
  const id = texto(f.id);
  const respuesta = texto(f.respuesta_base ?? f.hecho);
  const pasarA = texto(f.pasar_a);
  if (!id || (!respuesta && !pasarA)) return null; // ni contesta ni pasa: no aporta
  return {
    id,
    tema: texto(f.tema),
    pais: normalizarPais(f.pais),
    preguntas: listaDe(f.preguntas),
    respuesta_base: respuesta,
    pasos: listaDe(f.pasos),
    enlace: texto(f.enlace),
    pasar_a: pasarA,
    pedir: texto(f.pedir),
    no_decir: listaDe(f.no_decir),
  };
}

/** Revisa un archivo de fichas. Devuelve { fichas, errores }. */
function validarFichas(crudo) {
  const lista = Array.isArray(crudo) ? crudo : Array.isArray(crudo?.fichas) ? crudo.fichas : null;
  if (!lista) return { fichas: [], errores: ['el archivo no es una lista de fichas ni { "fichas": [...] }'] };
  const errores = [];
  const vistos = new Set();
  const fichas = [];
  lista.forEach((f, i) => {
    const n = normalizarFicha(f);
    if (!n) return errores.push(`ficha ${i + 1}: falta «id», o no tiene ni «respuesta_base» ni «pasar_a»`);
    if (vistos.has(n.id)) return errores.push(`ficha ${i + 1}: id repetido «${n.id}»`);
    if (!n.preguntas.length) errores.push(`ficha «${n.id}»: sin «preguntas» (solo se encontrará por su tema y su id)`);
    vistos.add(n.id);
    return fichas.push(n);
  });
  return { fichas, errores };
}

let cache = null; // { ruta, mtimeMs, buscador }

function leerArchivo(ruta) {
  return validarFichas(JSON.parse(fs.readFileSync(ruta, 'utf8'))).fichas;
}

/** El buscador sobre el archivo de fichas (se vuelve a leer si el archivo cambió). */
function buscadorDeArchivo(ruta = RUTA_FICHAS) {
  const { mtimeMs } = fs.statSync(ruta);
  if (cache && cache.ruta === ruta && cache.mtimeMs === mtimeMs) return cache.buscador;
  const buscador = crearBuscador(leerArchivo(ruta));
  cache = { ruta, mtimeMs, buscador };
  return buscador;
}

function crearBuscador(fichasCrudas) {
  const fichas = (fichasCrudas || []).map((f) => normalizarFicha(f)).filter(Boolean);
  const N = fichas.length;

  const indice = fichas.map((f) => {
    // El id («no-puedo-entrar-plataforma») también es una frase del tema. Y si
    // la ficha no trae preguntas (la forma de la versión 1, donde el tema era
    // un título: «Qué es el CBM»), el tema hace de pregunta.
    const frases = [...f.preguntas, f.id.replace(/[-_]+/g, ' '), ...(f.preguntas.length ? [] : [f.tema])].map(
      (p) => new Set(raices(p)),
    );
    const cuerpo = new Set(
      raices([f.id.replace(/[-_]+/g, ' '), f.tema, ...f.preguntas, f.respuesta_base, ...f.pasos, f.pedir].join(' ')),
    );
    return { ficha: f, frases: frases.filter((s) => s.size), cuerpo };
  });

  const df = new Map();
  for (const { cuerpo } of indice) for (const t of cuerpo) df.set(t, (df.get(t) || 0) + 1);
  const vocabulario = [...df.keys()];
  const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
  const peso = (conjunto) => {
    let s = 0;
    for (const t of conjunto) s += idf(t);
    return s;
  };
  // «Rara» = está en muy pocas fichas (como mucho en 1 de cada 50).
  const esRara = (t) => (df.get(t) || 0) <= Math.max(1, Math.round(N / 50));

  const idfMax = Math.log(1 + (N + 0.5) / 0.5);

  /** Raíces del mensaje llevadas al vocabulario de las fichas (con tipeo).
      Las que no están en ninguna ficha se cuentan aparte: un mensaje lleno de
      palabras que la base no conoce no «se parece» a nada por una sola que sí. */
  function raicesDelMensaje(mensaje) {
    const conocidas = new Set();
    let desconocidas = 0;
    for (const r of new Set(raices(mensaje))) {
      if (df.has(r)) {
        conocidas.add(r);
        continue;
      }
      const cerca = vocabulario.find((v) => v[0] === r[0] && casiIgual(v, r));
      if (cerca) conocidas.add(cerca);
      else if (!/^\d+$/.test(r)) desconocidas += 1;
    }
    return { conocidas, desconocidas };
  }

  /**
   * @param {string} mensaje  lo que escribió el alumno
   * @param {object} [o]  { pais: 'ec' | 'mx' | null, n = 3, minimo }
   * @returns {{ficha:object, puntaje:number}[]}  de la más parecida a la menos
   */
  function buscar(mensaje, o = {}) {
    const n = o.n ?? MAX_FICHAS;
    const minimo = o.minimo ?? PUNTAJE_MINIMO;
    const pais = o.pais || null;
    const { conocidas: q, desconocidas } = raicesDelMensaje(mensaje);
    if (!q.size) return [];
    // Lo desconocido pesa algo menos que una palabra rara: suele ser un
    // nombre, un producto o relleno.
    const pesoQ = peso(q) + Math.min(desconocidas, 6) * idfMax * 0.5;

    const puntuadas = [];
    for (const { ficha, frases, cuerpo } of indice) {
      if (ficha.pais !== 'todos' && ficha.pais !== pais) continue;
      const enCuerpo = [...q].filter((t) => cuerpo.has(t));
      if (!enCuerpo.length) continue;

      let mejorFrase = 0;
      for (const frase of frases) {
        const comun = [...frase].filter((t) => q.has(t));
        if (!comun.length) continue;
        const cubreFrase = peso(comun) / peso(frase); // cuánto de la pregunta de la ficha está en el mensaje
        const cubreMensaje = peso(comun) / pesoQ; // cuánto del mensaje explica esa pregunta
        let parecido = cubreFrase * (0.55 + 0.45 * Math.sqrt(cubreMensaje));
        /* Una sola palabra en común, y de las que están en muchas fichas, no
           es parecerse: «quiero hablar…» no es «quiero cotizar…». */
        if (comun.length === 1 && frase.size > 1 && !esRara(comun[0])) parecido *= 0.4;
        mejorFrase = Math.max(mejorFrase, parecido);
      }
      const puntaje = 0.7 * mejorFrase + 0.3 * (peso(enCuerpo) / pesoQ);
      if (puntaje >= minimo) puntuadas.push({ ficha, puntaje: Math.round(puntaje * 1000) / 1000 });
    }
    puntuadas.sort((a, b) => b.puntaje - a.puntaje || a.ficha.id.localeCompare(b.ficha.id));
    return puntuadas.slice(0, n);
  }

  const version = `${N} fichas · ${crypto.createHash('sha1').update(JSON.stringify(fichas)).digest('hex').slice(0, 8)}`;
  return { buscar, fichas, version, total: N };
}

/**
 * Bloque de contexto con las fichas encontradas.
 * @param {{ficha:object}[]} resultados
 * @param {object} [o]  { hayCarga } true cuando en este turno también va el
 *        bloque con la carga REAL del cliente: ahí las fichas de carga ya no
 *        pueden decir «el bot no ve en qué paso está».
 */
function bloqueFichas(resultados, o = {}) {
  if (!resultados?.length) return '';
  const L = [
    '📚 FICHAS DE LA BASE más cercanas a lo que escribió (es lo ÚNICO que puedes afirmar sobre esos temas; el nombre de la ficha es para ti, no lo escribas):',
  ];
  /* Fichas escritas para un bot que NO veía la carga («no decir en qué paso
     está»). Cuando en este turno sí va la carga real del cliente, esa
     prohibición sobra, y la ficha que solo decía «lo revisa logística, pide la
     marca» cede ante el bloque 📦. */
  const dicePasoProhibido = (x) => /en que paso (esta|va)/.test(sinTildes(x));
  for (const { ficha: f } of resultados) {
    const ciega = Boolean(o.hayCarga) && f.no_decir.some(dicePasoProhibido);
    const area = areaParaCliente(f.pasar_a);
    L.push('');
    L.push(`FICHA «${f.id}»${f.tema ? ` · tema: ${f.tema}` : ''}`);
    if (ciega && area) {
      L.push('  Para ESTE cliente ya tienes su carga real en el bloque 📦: contesta con ese bloque y no le pidas la marca ni la cotización.');
    } else {
      if (f.respuesta_base) L.push(`  Respuesta: ${f.respuesta_base}`);
      if (f.pasos.length) {
        L.push('  Pasos (uno por línea, en este orden):');
        f.pasos.forEach((p) => L.push(`  - ${p}`));
      }
      if (f.enlace) L.push(`  Enlace: ${f.enlace}`);
      if (area) {
        // «Responde y pasa» (trae Respuesta) o «solo pasa» (no la trae).
        L.push(
          `  ${f.respuesta_base ? 'Y además lo' : 'Lo'} resuelve una persona: paso a asesor para ${area}` +
            `${f.pedir ? `. Dato que hace falta, si todavía no lo dio: ${f.pedir}` : ', sin pedirle datos'}.`,
        );
      } else if (f.pedir) {
        L.push(`  Dato que hace falta, si todavía no lo dio: ${f.pedir}.`);
      }
    }
    const noDecir = ciega ? f.no_decir.filter((x) => !dicePasoProhibido(x)) : f.no_decir;
    if (noDecir.length) L.push(`  No digas: ${noDecir.join(' · ')}`);
  }
  return L.join('\n');
}

module.exports = {
  RUTA_FICHAS,
  MAX_FICHAS,
  PUNTAJE_MINIMO,
  crearBuscador,
  buscadorDeArchivo,
  bloqueFichas,
  validarFichas,
  normalizarFicha,
  areaParaCliente,
};
