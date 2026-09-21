// ════════════════════════════════════════════════════════════
// apiKeyOpenAI.js
// Única puerta de entrada y salida de configuraciones.api_key_openai.
//
// POR QUÉ EXISTE ESTE ARCHIVO
//
// La API key de OpenAI de cada cliente se guardaba en texto plano y además
// viajaba completa al navegador (info_asistentes). Quien viera la BD, un dump o
// la pestaña de red se llevaba una llave con saldo. Ahora se guarda cifrada con
// el mismo AES-256-GCM de Dropi (utils/cryptoToken) y al front solo le llega
// enmascarada.
//
// No es bcrypt a propósito: bcrypt es un hash de una vía y la key hay que
// RECUPERARLA para llamar a OpenAI. Tiene que ser cifrado reversible.
//
// LA LECTURA ES TOLERANTE, Y TIENE QUE SEGUIR SIÉNDOLO
//
// Desarrollo y producción comparten la misma base. Si se cifra una fila y algún
// proceso con código viejo la lee, manda el texto cifrado como Bearer y ese bot
// se queda mudo. Por eso:
//   1) leerApiKeyOpenAI acepta los DOS formatos (sk-… plano o iv.tag.datos).
//   2) Las keys nuevas se guardan siempre cifradas. Mientras producción no
//      tenga este lector, NO guardar keys desde dev ni desde local: esa fila
//      quedaría cifrada para un proceso que todavía no sabe leerla.
//   3) Las filas viejas se cifran con scripts/cifrarApiKeysOpenAI.js, recién
//      cuando TODOS los entornos ya corren este lector.
//
// TODA lectura de la columna debe pasar por leerApiKeyOpenAI. Un SELECT nuevo
// que use el valor crudo funciona hoy y se rompe el día que se cifre esa fila.
// ════════════════════════════════════════════════════════════
const { encryptToken, decryptToken } = require('../cryptoToken');

// Las keys de OpenAI siempre empiezan así (sk-…, sk-proj-…, sk-svcacct-…).
// El texto cifrado es base64 con puntos, nunca puede empezar con "sk-".
function esTextoPlano(valor) {
  return String(valor || '').trim().startsWith('sk-');
}

function estaCifrada(valor) {
  const v = String(valor || '').trim();
  return Boolean(v) && !esTextoPlano(v) && v.split('.').length === 3;
}

// Devuelve la key lista para usar como Bearer, venga como venga. null si no
// hay key o si no se pudo descifrar (mejor "sin key" que mandar basura a OpenAI).
function leerApiKeyOpenAI(valor) {
  const v = String(valor || '').trim();
  if (!v) return null;
  if (!estaCifrada(v)) return v;

  try {
    return decryptToken(v).trim() || null;
  } catch (err) {
    console.error(
      '[apiKeyOpenAI] no se pudo descifrar la key guardada:',
      err?.message,
    );
    return null;
  }
}

// Valor a escribir en la columna. Recibe SIEMPRE la key en texto plano y la
// devuelve cifrada.
function prepararApiKeyParaGuardar(plana) {
  const key = String(plana || '').trim();
  if (!key) return null;
  return encryptToken(key);
}

// Lo único que puede salir hacia el front: "sk-proj-…UVYA".
function enmascararApiKeyOpenAI(valor) {
  const key = leerApiKeyOpenAI(valor);
  if (!key) return null;
  if (key.length <= 12) return '••••';
  const prefijo = key.startsWith('sk-proj-') ? 'sk-proj-' : key.slice(0, 3);
  return `${prefijo}••••${key.slice(-4)}`;
}

module.exports = {
  leerApiKeyOpenAI,
  prepararApiKeyParaGuardar,
  enmascararApiKeyOpenAI,
  estaCifrada,
};
