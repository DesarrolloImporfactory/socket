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
     · contra las `preguntas` de cada ficha, y devuelve una CERCANÍA de 0 a 1.
       Solo entrega las que pasan `UMBRAL_CERCANIA` (ver más abajo): mejor
       ninguna ficha que una floja.

   Lo que entrega son fichas «posiblemente relacionadas», no la respuesta: el
   prompt manda usarlas solo si contestan EXACTAMENTE lo que se preguntó, y una
   ficha con `pasar_a` nunca cierra sola (bloque, prompt y guardia).

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
const { sinTildes, raiz, palabras, casiIgual, VACIAS } = require('./texto');

const RUTA_FICHAS = path.join(__dirname, 'fichas_bot.json');
const MAX_FICHAS = 3;

/* ── CERCANÍA: qué tan igual es lo que escribió a una pregunta de la ficha ──
   La versión anterior entregaba «la más parecida» con un mínimo de 0,4, y con
   eso alcanzaba UNA palabra del tema: en la prueba en papel (365
   conversaciones) 8 de las 19 respuestas hechas con una ficha no contestaban
   lo que se preguntó («ya instalé WeChat» recibía «cómo se instala WeChat»;
   quien mandaba su proforma, «qué es una proforma»).

   La cercanía se mide contra cada PREGUNTA de la ficha, tramo por tramo del
   mensaje, y se queda con la mejor:

       cubreFrase × √cubreMensaje × forma

     cubreFrase    cuánto de la pregunta de la ficha está en lo que escribió
     cubreMensaje  cuánto de lo que escribió (en ese tramo) es algo que la
                   ficha pregunta; lo que sobra es otra cosa
     forma         1 si pregunta lo mismo; se castiga cuando el tema es el
                   mismo y la pregunta no:
                   · la ficha contesta «¿qué es…?», «¿cómo…?», «¿dónde…?» o
                     «¿cuánto…?» y el mensaje no pregunta eso;
                   · el mensaje pregunta CUÁNDO o CUÁNTO y la pregunta de la
                     ficha no (una ficha que no habla de fechas ni de montos
                     no contesta esa pregunta);
                   · el mensaje AVISA o MANDA algo ya hecho («listo, ya lo
                     instalé», «ahí te mando la proforma»): no pregunta;
                   · es una sola palabra suelta («la cotización»): nombra un
                     tema, no pregunta nada.

   Las dos coberturas van con peso por rareza. Con `forma` = 1:
     · la pregunta de la ficha ENTERA en el mensaje (cubreFrase = 1) pasa si es
       al menos la mitad de lo que dice ese tramo (√0,49 = 0,70);
     · el tramo ENTERO dentro de la ficha (cubreMensaje = 1) pasa si trae al
       menos el 70 % de la pregunta;
     · con cualquier castigo de forma (0,6 o 0,5) NO pasa, ni calzando exacto.

   POR QUÉ 0,70. Medido con `scripts/probar_soporte_expertos_fichas.js` sobre
   las 228 fichas: lo que pregunta lo mismo que una ficha queda en 0,75 o más
   (casi todo en 1); el mismo tema con otra pregunta y lo que no tiene que ver
   quedan en 0,66 o menos. El umbral va en el medio de ese hueco. Con 0,65
   volvían a entrar fichas «de al lado» («quiero cambiar el producto de mi
   cotización» → los datos para cotizar); con 0,80 se perdían preguntas bien
   hechas que traen una palabra de más.

   LO QUE NO VE. Compara palabras, no sentido: si el alumno usa un sinónimo
   que ninguna pregunta de la ficha trae («descargar» por «instalar»), la ficha
   no sale y el caso va a un asesor. Se arregla sumando esa forma de preguntar
   a `preguntas` en la base, no bajando el umbral. Y no ve la conversación: una
   pregunta suelta que en realidad sigue un trámite con el asesor («¿cuál es el
   siguiente paso?») calza igual; eso lo decide el prompt. */
const UMBRAL_CERCANIA = 0.7;
const PUNTAJE_MINIMO = UMBRAL_CERCANIA; // nombre anterior, por si alguien lo importa

const CASTIGO_FORMA = 0.6; // la ficha contesta otra clase de pregunta
const CASTIGO_AVISO = 0.5; // el mensaje avisa o manda algo; no pregunta

/* Qué CLASE de pregunta es. Sobre el texto sin tildes. */
const FORMAS = {
  def: /\bque (?:es|son|significa\w*|quiere decir)\b|\bpara que (?:sirven?|es|son)\b|\ba que se refiere\w*\b/,
  como: /\bcomo\b|\bde que (?:manera|forma)\b|\bque (?:hago|debo|tengo que)\b/,
  donde: /\b(?:a|de|por)?donde\b|\ben que (?:parte|lugar|seccion|pagina)\b/,
  cuando: /\bcuando\b|\b(?:que|cual|cuales) (?:es |son |seria |serian )?(?:el |la |las |los )?(?:dia|fecha|hora|horario)s?\b|\ba que horas?\b|\bfechas?\b/,
  cuanto: /\bcuant[oa]s?\b|\b(?:cuesta|cuestan|vale|valen)\b|\bque (?:precio|costo|valor)\b/,
};
/* Pide ayuda o cuenta un problema: vale como «¿cómo…?» y «¿dónde…?». */
const RE_PIDE =
  /\?|\b(?:me ayudan?|me (?:puede|pueden|puedes|podria|podrian|podrias)\b|ayudenme|ayudame|ayudeme|ayuda (?:con|para)|necesito|quiero|quisiera|deseo|me gustaria|no se\b|no puedo|no pude|no logro|no encuentro|no veo|no hallo|no me (?:deja|permite|sale|aparece|funciona|carga|abre|llega)|explic\w+|indic\w+|ensen\w+)/;
/* Pregunta algo, aunque no sea ninguna de las clases de arriba («¿quién es mi asesor?»). */
const RE_PREGUNTA = /[¿?]|\b(?:quien|quienes|cual|cuales)\b|^\s*que\b/;
const RE_NO_ENTIENDO = /\bno (?:entiendo|entendi|comprendo|me queda claro)\b|\bexplic\w+/;
/* Avisa o manda algo ya hecho. Los verbos van escritos (no «ya» + cualquier
   palabra): «ya llegaría», «ya sale» y «ya tiene» son preguntas. */
const RE_AVISO =
  /^\s*list[oa]s?\b|\bya (?:lo |la |los |las |le |les |te |me |se )*(?:instale|descargue|pague|cancele|deposite|transferi|envie|mande|pase|deje|adjunte|subi|llene|complete|registre|cree|hice|realice|compre|pedi|recibi|revise|vi|termine|agregue|escribi|hable|contacte|actualice|cambie|entre|ingrese)\b|\b(?:ahi|aqui|aca) (?:te |le |les )?(?:va|van|esta|estan|mando|envio|paso|dejo|adjunto)\b|\b(?:te|le|les) (?:mando|envio|paso|dejo|adjunto|comparto|reenvio)\b|\b(?:mi|la) (?:clave|contrasena|password) es\b/;
/* Un código (SGTE-58, EC-2609112, IMP016) identifica algo; no es parte de la
   pregunta ni «una palabra que la base no conoce». */
const RE_CODIGO = /\b[a-z]{1,6}-?\d+(?:-\d+)*\b/g;

/* Raíces que no dicen de qué se pregunta («¿qué SIGNIFICA…?», «no ENTIENDO…»,
   «me DICE…», «QUERÍA saber…»). `texto.js` ya quita las palabras vacías; estas
   son las que, además, inflaban «lo que sobra» de un mensaje bien preguntado. */
const RELLENO = new Set(
  // «entiendo» queda en «ent» (pierde «-iendo» como si fuera un gerundio)
  'signific ent entiend entend comprend explic quer qui ten dic dij disculp noch salud amabl gentil'.split(' '),
);
/* Como `raices` de texto.js, con dos diferencias: se va el relleno, y una
   palabra en «-ador/-adora» (cotizador, calculadora, importador, ganador) no
   se reduce al verbo: «¿dónde está el cotizador?» no es «una cotización». */
function raicesUtiles(t) {
  const out = [];
  for (const p of palabras(t)) {
    if (VACIAS.has(p) || p.length < 2) continue;
    const herramienta = p.match(/^(.{3,}ador)(?:a|es|as)?$/);
    const r = herramienta ? herramienta[1] : raiz(p);
    if (r.length < 2 || VACIAS.has(r) || RELLENO.has(r)) continue;
    out.push(r);
  }
  return out;
}

/* Para saber si un tramo es solo el NOMBRE de un tema («la cotización», «y mi
   proforma», «gracias por el curso»): lo que queda al quitar estas palabras.
   «Tienen financiamiento» o «eres un bot» son preguntas aunque no lleven
   signo: les queda un verbo además del tema. */
const SIN_PESO = new Set(
  ('el la los las lo un una unos unas mi mis tu tus su sus y e o u de del al a por para con en ' +
    'favor porfa porfavor gracias hola buenas buenos buen dia dias tardes noches ok okey listo si ya pues ' +
    'entonces este esta esto ese esa eso estos estas esos esas').split(' '),
);
const soloNombraUnTema = (textoSinTildes) => palabras(textoSinTildes).filter((w) => !SIN_PESO.has(w)).length <= 1;

function formasDe(textoSinTildes) {
  const f = new Set();
  for (const [k, re] of Object.entries(FORMAS)) if (re.test(textoSinTildes)) f.add(k);
  return f;
}

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
    /* El id también es una frase del tema cuando dice algo («no-puedo-entrar-
       plataforma»). Un id de una sola palabra («wechat», «proforma») es el
       NOMBRE del tema: como frase, cualquier mensaje que lo nombrara la
       cubría entera. Y si la ficha no trae preguntas (la forma de la versión
       1, donde el tema era un título: «Qué es el CBM»), el tema hace de
       pregunta. */
    const idComoFrase = f.id.replace(/[-_]+/g, ' ');
    const frases = [
      ...f.preguntas,
      ...(new Set(raicesUtiles(idComoFrase)).size > 1 || !f.preguntas.length ? [idComoFrase] : []),
      ...(f.preguntas.length ? [] : [f.tema]),
    ]
      .map((p) => {
        const plano = sinTildes(p);
        return { raices: new Set(raicesUtiles(p)), formas: formasDe(plano), aviso: RE_AVISO.test(plano) };
      })
      .filter((x) => x.raices.size);
    // Todo lo que preguntan sus preguntas: lo que el mensaje traiga de aquí no es «otra cosa».
    const preguntado = new Set();
    for (const fr of frases) for (const r of fr.raices) preguntado.add(r);
    // Todas sus palabras: solo para saber qué tan rara es cada una en la base.
    const cuerpo = new Set(
      raicesUtiles([f.id.replace(/[-_]+/g, ' '), f.tema, ...f.preguntas, f.respuesta_base, ...f.pasos, f.pedir].join(' ')),
    );
    return { ficha: f, frases, preguntado, cuerpo };
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

  /** Raíces de un texto llevadas al vocabulario de las fichas (con tipeo).
      Las que no están en ninguna ficha se cuentan aparte: un mensaje lleno de
      palabras que la base no conoce no «se parece» a nada por una sola que sí. */
  function raicesDelMensaje(mensaje) {
    const conocidas = new Set();
    let desconocidas = 0;
    for (const r of new Set(raicesUtiles(mensaje))) {
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

  /** Un tramo del mensaje, listo para comparar. */
  function tramo(textoPlano) {
    const { conocidas: q, desconocidas } = raicesDelMensaje(textoPlano.replace(RE_CODIGO, ' '));
    const formas = formasDe(textoPlano);
    return {
      q,
      // Lo desconocido pesa algo menos que una palabra rara: suele ser un
      // nombre, un producto o relleno.
      pesoQ: peso(q) + Math.min(desconocidas, 6) * idfMax * 0.5,
      formas,
      unaSolaPalabra: soloNombraUnTema(textoPlano),
      // Avisa o manda algo ya hecho, y en ese tramo no pregunta ni pide nada.
      avisa: RE_AVISO.test(textoPlano) && !formas.size && !RE_PIDE.test(textoPlano),
    };
  }

  /** En qué tramos se compara el mensaje. Cada ORACIÓN (lo que va entre signos
      de puntuación; lo de un paréntesis, aparte) y, si trae «y», «pero»,
      «que»…, también cada una de sus partes. Así «olvidé mi clave, ¿cómo la
      recupero?» calza con «olvidé mi clave», y un saludo o un «que encontré
      en Alibaba» no tapan la pregunta. A propósito NO se compara el mensaje
      entero cuando tiene varias oraciones: juntar una palabra de cada una
      («¿qué marca es?, ¿de dónde se importa?») armaba una pregunta que nadie
      hizo. */
  function tramosDe(mensaje) {
    const plano = sinTildes(mensaje).replace(/https?:\/\/\S+/g, ' ');
    const entreParentesis = [...plano.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
    const oraciones = [...plano.replace(/\([^)]*\)/g, ' ').split(/[.?!;,:\n[\]"«»]+/), ...entreParentesis];
    const tramos = [];
    for (const o of oraciones) {
      if (!o.trim()) continue;
      tramos.push(tramo(o));
      const partes = o.split(/\s+(?:y|e|pero|entonces|ademas|tambien|porque|aunque|que)\s+/).filter((x) => x.trim());
      if (partes.length > 1) for (const x of partes) tramos.push(tramo(x));
    }
    return tramos.filter((t) => t.q.size);
  }

  /**
   * @param {string} mensaje  lo que escribió el alumno
   * @param {object} [o]  { pais: 'ec' | 'mx' | null, n = 3, minimo = UMBRAL_CERCANIA }
   * @returns {{ficha:object, cercania:number, puntaje:number, cierraSola:boolean}[]}
   *          de la más cercana a la menos. `cercania` va de 0 a 1 (`puntaje` es
   *          el mismo número, con el nombre anterior). `cierraSola` = la ficha
   *          no tiene `pasar_a`: el bot puede contestar con ella y terminar.
   */
  function buscar(mensaje, o = {}) {
    const n = o.n ?? MAX_FICHAS;
    const minimo = o.minimo ?? UMBRAL_CERCANIA;
    const pais = o.pais || null;
    const tramos = tramosDe(mensaje);
    if (!tramos.length) return [];
    const plano = sinTildes(mensaje);
    const formasMensaje = formasDe(plano);
    const pide = RE_PIDE.test(plano);
    const noEntiende = RE_NO_ENTIENDO.test(plano);
    /* Solo nombra un tema («la cotización», «wechat»): una palabra no es una pregunta. */
    const soloNombra = !formasMensaje.size && !pide && !RE_PREGUNTA.test(plano);

    const r3 = (x) => Math.round(x * 1000) / 1000;
    const puntuadas = [];
    for (const { ficha, frases, preguntado } of indice) {
      if (ficha.pais !== 'todos' && ficha.pais !== pais) continue;
      /* Cuánto de cada tramo es algo que esta ficha PREGUNTA. Lo que solo está
         en su respuesta no cuenta: con eso entraba la ficha «de al lado» (a
         «WeChat me pide una tarjeta», la de cómo instalar WeChat). */
      const cubre = tramos.map((t) => peso([...t.q].filter((x) => preguntado.has(x))) / t.pesoQ);
      if (!cubre.some((c) => c > 0)) continue;

      let mejor = 0;
      let detalle = null;
      for (const frase of frases) {
        // ¿El mensaje pregunta lo que esta pregunta de la ficha pregunta?
        let mismaPregunta = true;
        for (const f of frase.formas) {
          if (formasMensaje.has(f)) continue;
          if ((f === 'como' || f === 'donde') && pide) continue;
          if (f === 'def' && noEntiende) continue;
          // «¿ya llegó?» y «¿cuándo llega?» preguntan por lo mismo; al revés no (ver abajo).
          if (f === 'cuando') continue;
          mismaPregunta = false;
          break;
        }
        tramos.forEach((t, i) => {
          const comun = [...frase.raices].filter((x) => t.q.has(x));
          if (!comun.length) return;
          const cubreFrase = peso(comun) / peso(frase.raices); // cuánto de la pregunta de la ficha está en el tramo
          const cubreMensaje = cubre[i]; // cuánto del tramo es de esta ficha

          let forma = mismaPregunta ? 1 : CASTIGO_FORMA;
          // Pregunta CUÁNDO o CUÁNTO y la pregunta de la ficha no: no es lo mismo.
          if ((t.formas.has('cuando') && !frase.formas.has('cuando')) || (t.formas.has('cuanto') && !frase.formas.has('cuanto'))) {
            forma = CASTIGO_FORMA;
          }
          // Una sola palabra, sin preguntar ni pedir nada: nombra un tema.
          if (t.unaSolaPalabra && soloNombra) forma = CASTIGO_FORMA;
          // Avisa de algo ya hecho y la pregunta de la ficha no es un aviso.
          if (t.avisa && !frase.aviso) forma = CASTIGO_AVISO;

          let c = cubreFrase * Math.sqrt(cubreMensaje) * forma;
          /* Una sola palabra en común, y de las que están en muchas fichas, no
             es parecerse: «quiero hablar…» no es «quiero cotizar…». */
          if (comun.length === 1 && frase.raices.size > 1 && !esRara(comun[0])) c *= 0.4;
          if (c > mejor) {
            mejor = c;
            detalle = { cubreFrase: r3(cubreFrase), cubreMensaje: r3(cubreMensaje), forma };
          }
        });
      }
      if (mejor < minimo) continue;
      const cercania = r3(Math.min(1, mejor));
      puntuadas.push({
        ficha,
        cercania,
        puntaje: cercania,
        cierraSola: !ficha.pasar_a,
        ...(o.detalle ? { detalle } : {}),
      });
    }
    // Empate: primero la que pasa a una persona (ante la duda, no se cierra solo).
    puntuadas.sort(
      (a, b) =>
        b.cercania - a.cercania || Number(a.cierraSola) - Number(b.cierraSola) || a.ficha.id.localeCompare(b.ficha.id),
    );
    return puntuadas.slice(0, n);
  }

  const version = `${N} fichas · ${crypto.createHash('sha1').update(JSON.stringify(fichas)).digest('hex').slice(0, 8)}`;
  return { buscar, fichas, version, total: N };
}

const MAX_PREGUNTAS_EN_BLOQUE = 4;

/**
 * Bloque de contexto con las fichas encontradas. Van como «posiblemente
 * relacionadas»: cada una lleva las preguntas que contesta, para que el modelo
 * compare con lo que de verdad preguntó el cliente antes de usarla.
 * @param {{ficha:object}[]} resultados
 * @param {object} [o]  { hayCarga } true cuando en este turno también va el
 *        bloque con la carga REAL del cliente: ahí las fichas de carga ya no
 *        pueden decir «el bot no ve en qué paso está».
 */
function bloqueFichas(resultados, o = {}) {
  if (!resultados?.length) return '';
  const L = [
    '📚 FICHAS DE LA BASE posiblemente relacionadas con lo que escribió. Las eligió un buscador por las palabras: todavía NO son la respuesta. ' +
      'Cada una contesta SOLO las preguntas de su línea «Contesta a». Usa una únicamente si el cliente preguntó EXACTAMENTE eso; ' +
      'si habla del mismo tema pero pregunta otra cosa, o si ninguna calza, no la uses ni la menciones: es paso a asesor. ' +
      '(Sobre esos temas es lo ÚNICO que puedes afirmar; el nombre de la ficha es para ti, no lo escribas.)',
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
      if (f.preguntas.length) {
        L.push(`  Contesta a: ${f.preguntas.slice(0, MAX_PREGUNTAS_EN_BLOQUE).map((p) => `«${p}»`).join(' · ')}`);
      }
      if (f.respuesta_base) L.push(`  Respuesta: ${f.respuesta_base}`);
      if (f.pasos.length) {
        L.push('  Pasos (uno por línea, en este orden):');
        f.pasos.forEach((p) => L.push(`  - ${p}`));
      }
      if (f.enlace) L.push(`  Enlace: ${f.enlace}`);
      if (area) {
        // «Responde y pasa» (trae Respuesta) o «solo pasa» (no la trae).
        L.push(
          `  ${f.respuesta_base ? 'Y además lo' : 'Lo'} resuelve una persona: paso a asesor${area === 'un asesor' ? '' : ` para ${area}`}` +
            `${f.pedir ? `. Dato que hace falta, si todavía no lo dio: ${f.pedir}` : ', sin pedirle datos'}.`,
        );
        // Una ficha con `pasar_a` nunca cierra el caso: la guardia lo exige también.
        if (f.respuesta_base) {
          L.push('  NO CIERRA SOLA: si usas su Respuesta, el mismo mensaje lleva el MENSAJE DE PASO A ASESOR. Sin eso está incompleto.');
        }
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
  UMBRAL_CERCANIA,
  PUNTAJE_MINIMO,
  crearBuscador,
  buscadorDeArchivo,
  bloqueFichas,
  validarFichas,
  normalizarFicha,
  areaParaCliente,
};
