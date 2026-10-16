// ════════════════════════════════════════════════════════════
// apiKeyClaude.js
// Única puerta de entrada y salida de configuraciones.api_key_claude.
//
// Misma regla que utils/openia/apiKeyOpenAI.js: la llave se guarda cifrada
// (AES-256-GCM de utils/cryptoToken) y al navegador solo le llega
// enmascarada. La lectura es tolerante (acepta la llave plana «sk-ant-…» o el
// cifrado «iv.tag.datos») para que una fila vieja o escrita a mano no deje al
// bot mudo. TODA lectura de la columna pasa por leerApiKeyClaude.
// ════════════════════════════════════════════════════════════
const { encryptToken, decryptToken } = require('../cryptoToken');

// Las llaves de Anthropic empiezan con «sk-ant-». El texto cifrado es base64
// con dos puntos, nunca puede empezar así.
function esTextoPlano(valor) {
  return String(valor || '').trim().startsWith('sk-ant-');
}

function estaCifrada(valor) {
  const v = String(valor || '').trim();
  return Boolean(v) && !esTextoPlano(v) && v.split('.').length === 3;
}

/** La llave lista para usar, venga como venga. null si no hay o no se pudo descifrar. */
function leerApiKeyClaude(valor) {
  const v = String(valor || '').trim();
  if (!v) return null;
  if (!estaCifrada(v)) return v;
  try {
    return decryptToken(v).trim() || null;
  } catch (err) {
    console.error('[apiKeyClaude] no se pudo descifrar la key guardada:', err?.message);
    return null;
  }
}

/** Valor a escribir en la columna: recibe la llave plana y la devuelve cifrada. */
function prepararApiKeyClaudeParaGuardar(plana) {
  const key = String(plana || '').trim();
  if (!key) return null;
  return encryptToken(key);
}

/** Lo único que puede salir hacia el front: «sk-ant-••••AbCd». */
function enmascararApiKeyClaude(valor) {
  const key = leerApiKeyClaude(valor);
  if (!key) return null;
  if (key.length <= 12) return '••••';
  const prefijo = key.startsWith('sk-ant-') ? 'sk-ant-' : key.slice(0, 3);
  return `${prefijo}••••${key.slice(-4)}`;
}

module.exports = {
  leerApiKeyClaude,
  prepararApiKeyClaudeParaGuardar,
  enmascararApiKeyClaude,
  estaCifrada,
};
