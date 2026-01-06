const crypto = require('crypto');

/**
 * Obtiene y valida la llave de cifrado desde variables de entorno.
 * - Se espera que `DROPI_TOKEN_ENC_KEY` venga en base64.
 * - Al decodificarla, DEBE ser exactamente 32 bytes (256 bits) para AES-256.
 */
function getKey() {
  const raw = process.env.DROPI_TOKEN_ENC_KEY;

  if (!raw) throw new Error('DROPI_TOKEN_ENC_KEY is missing');

  // Convierte base64 → bytes reales
  const key = Buffer.from(raw, 'base64');

  // AES-256 requiere 32 bytes exactos
  if (key.length !== 32)
    throw new Error('DROPI_TOKEN_ENC_KEY must be 32 bytes (base64)');

  return key;
}

/**
 * Cifra un token (texto) usando AES-256-GCM.
 * GCM = cifrado autenticado:
 * - Protege confidencialidad (nadie lee el token)
 * - Protege integridad (si lo alteran, falla al descifrar)
 *
 * Retorna un string con formato:
 *   ivBase64.tagBase64.ciphertextBase64
 */
function encryptToken(plain) {
  // - Debe ser ÚNICO por cada cifrado (por eso se genera random)
  const iv = crypto.randomBytes(12);

  // Llave AES-256 (32 bytes)
  const key = getKey();

  // Crea el cifrador AES-256-GCM con llave + IV
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  // Encripta el texto plano:
  // - update() procesa la data
  // - final() termina el cifrado
  const ciphertext = Buffer.concat([
    cipher.update(String(plain), 'utf8'),
    cipher.final(),
  ]);

  // Obtiene el "auth tag" (etiqueta de autenticación):
  // - Es lo que permite validar que nadie modificó el ciphertext/iv
  // - Sin este tag, NO se puede descifrar correctamente en GCM
  const tag = cipher.getAuthTag();

  // Empaqueta todo en base64 y lo une con puntos
  return [
    iv.toString('base64'), // IV
    tag.toString('base64'), // Auth tag
    ciphertext.toString('base64'), // Datos cifrados
  ].join('.');
}

/**
 * Descifra un string previamente cifrado por encryptToken().
 * Espera formato:
 *   ivBase64.tagBase64.ciphertextBase64
 *
 * Si el contenido fue alterado (o la llave no coincide),
 * `decipher.final()` lanzará error.
 */
function decryptToken(enc) {
  // Separa las 3 partes
  const [ivB64, tagB64, dataB64] = String(enc).split('.');

  // Valida formato mínimo
  if (!ivB64 || !tagB64 || !dataB64)
    throw new Error('Invalid encrypted token format');

  // Llave AES-256 (debe ser la misma que se usó al cifrar)
  const key = getKey();

  // Reconstruye IV, tag y ciphertext desde base64 a bytes
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');

  // Crea el descifrador con la misma config (aes-256-gcm + key + iv)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);

  // Carga el auth tag para que GCM pueda verificar integridad
  decipher.setAuthTag(tag);

  // Descifra:
  // - update() procesa los bytes cifrados
  // - final() valida integridad y termina (aquí explota si fue manipulado)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    'utf8'
  );
}

/**
 * Devuelve los últimos 4 caracteres del token.
 * Útil para logs sin exponer el valor completo (ej: ****1234).
 */
function last4(token) {
  const t = String(token || '');
  return t.length >= 4 ? t.slice(-4) : t;
}

module.exports = { encryptToken, decryptToken, last4 };
