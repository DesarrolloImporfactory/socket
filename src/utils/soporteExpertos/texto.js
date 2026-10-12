/* Texto en español para comparar lo que escribe un alumno con lo que hay en la
   base: sin tildes, sin palabras vacías y por RAÍZ de palabra («llegó»,
   «llegaría» y «llegar» son la misma). Sin dependencias: lo usan el buscador de
   fichas, el detector de temas y la guardia de respuestas, y también las
   pruebas locales, que corren con `node` a secas.

   La raíz no es lingüística fina: recorta el sufijo más largo de una lista
   corta y arregla las tres alternancias que más rompen la coincidencia
   (cotice/cotizar, busque/buscar, llegue/llegar). Para un buscador sobre unas
   decenas de fichas alcanza de sobra, y es predecible. */

'use strict';

/** minúsculas y sin tildes ni diéresis; la ñ queda como n. */
function sinTildes(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/* Palabras que no distinguen una pregunta de otra. Ya sin tildes. */
const VACIAS = new Set(
  (
    'a al algo algun alguna algunas alguno algunos ante antes aqui asi aun aunque ' +
    'cada como con contra cual cuales de del desde donde dos e el ella ellas ellos en ' +
    'entre era eran eres es esa esas ese eso esos esta estaba estan estar estas este ' +
    'esto estos estoy fue fueron ha han has hasta hay he la las le les lo los mas me ' +
    'mi mis mucho muy nada ni no nos o os otra otras otro otros para pero poco por ' +
    'porque pues que se sea ser si sin sobre son soy su sus tambien te tengo ti tiene ' +
    'tienen todo todos tu tus un una unas uno unos usted ustedes va van y ya yo ' +
    'favor porfa porfavor gracias buenas buenos buen dia dias tardes noches hola ' +
    'ahi alla aca ok okey ' +
    // preguntas y muletillas: «quiero», «necesito», «me ayudan» están en
    // cualquier mensaje y no dicen de qué tema es
    'cuando cuanto cuanta cuantos cuantas quien quienes cual cuales ' +
    'quiero quisiera quier necesito necesita necesitamos necesit puedo puede pueden podria podrian pued ' +
    'ayuda ayudan ayudar ayudenme ayudeme ayudame ayud tener hacer hago hac saber sab ' +
    'dime digame diganme decir duda dudas consulta consultas consult pregunta preguntas pregunt ' +
    'informacion info estimado estimados amigo amiga senor senora senorita ' +
    'alguien ahora tambien solo entonces bueno bien mal asi cosa cosas tema'
  ).split(/\s+/),
);

/* Del más largo al más corto: gana el primero que calce y deje raíz de 3+. */
const SUFIJOS = [
  'amientos', 'imientos', 'amiento', 'imiento', 'aciones', 'uciones', 'iciones',
  'adores', 'adoras', 'acion', 'ucion', 'icion', 'ancias', 'encias', 'ancia', 'encia',
  'adora', 'ador', 'mente', 'idades', 'idad', 'ables', 'ibles', 'able', 'ible',
  'ariamos', 'eriamos', 'iriamos', 'aremos', 'eremos', 'iremos', 'asteis', 'isteis',
  'abamos', 'aramos', 'ieramos', 'arian', 'erian', 'irian', 'arias', 'erias', 'irias',
  'aran', 'eran', 'iran', 'aron', 'ieron', 'ando', 'iendo', 'yendo', 'aban', 'abas',
  'adas', 'ados', 'idas', 'idos', 'aria', 'eria', 'iria', 'aste', 'iste', 'amos',
  'emos', 'imos', 'iera', 'iese', 'are', 'ere', 'ire', 'ara', 'ase', 'aba', 'ada',
  'ado', 'ida', 'ido', 'ian', 'ias', 'an', 'en', 'ar', 'er', 'ir', 'as', 'es', 'os',
  'ia', 'io', 'a', 'e', 'o', 's',
];

/** Raíz de una palabra YA sin tildes y en minúsculas. */
function raiz(palabra) {
  const p = String(palabra || '');
  if (p.length <= 3 || /\d/.test(p)) return p; // códigos y números van enteros
  for (const suf of SUFIJOS) {
    if (p.length - suf.length < 3 || !p.endsWith(suf)) continue;
    let r = p.slice(0, -suf.length);
    // «cotice» → cotiz · «busque» → busc · «llegue» / «pague» → lleg / pag
    if (/^[ei]/.test(suf)) {
      if (r.endsWith('qu')) r = `${r.slice(0, -2)}c`;
      else if (r.endsWith('gu')) r = r.slice(0, -1);
      else if (r.endsWith('c') && r.length > 3) r = `${r.slice(0, -1)}z`;
    }
    return r;
  }
  return p;
}

/** Palabras de un texto: sin tildes, sin signos; los códigos (EC-2609112) enteros. */
function palabras(texto) {
  return sinTildes(texto)
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Raíces útiles de un texto (sin palabras vacías ni letras sueltas). */
function raices(texto) {
  const out = [];
  for (const p of palabras(texto)) {
    if (VACIAS.has(p)) continue;
    if (p.length < 2) continue;
    const r = raiz(p);
    if (r.length < 2 || VACIAS.has(r)) continue;
    out.push(r);
  }
  return out;
}

/** ¿Dos raíces son la misma con un error de tipeo? (una letra de más, de menos,
    cambiada o dos vecinas invertidas). Solo para raíces de 5+ letras: en las
    cortas un cambio de letra es otra palabra. */
function casiIgual(a, b) {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5) return false;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    // cambiada, o dos vecinas invertidas
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  const [corta, larga] = la < lb ? [a, b] : [b, a];
  return corta.slice(i) === larga.slice(i + 1);
}

module.exports = { sinTildes, raiz, palabras, raices, casiIgual, VACIAS };
