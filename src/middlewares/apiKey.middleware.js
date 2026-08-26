const crypto = require('crypto');
const { literal } = require('sequelize');
const ApiKeys = require('../models/api_keys.model');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const hashKey = (raw) =>
  crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');

/* Lee la key de `Authorization: Bearer <key>` o `X-Api-Key`. */
function leerKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const h = req.headers['x-api-key'];
  return h ? String(h).trim() : null;
}

/* La columna `scopes` llega con api_public_scopes_migration.sql. Hasta que
   corra, toda llave se trata como solo-lectura ('read') — así el deploy del
   código y la migración no tienen que ir amarrados. El latch evita
   preguntarle a la BD por una columna que ya sabemos que no existe. */
let scopesDisponibles = true;

/* Autentica al tercero y fija req.apiKey + req.id_configuracion. La key
   manda: el consumidor nunca elige de qué conexión lee. */
exports.apiKeyAuth = catchAsync(async (req, res, next) => {
  const raw = leerKey(req);
  if (!raw)
    return next(
      new AppError(
        'Falta la API key. Envíala en el header Authorization: Bearer <key>.',
        401,
      ),
    );

  const attrs = ['id', 'id_configuracion', 'nombre'];
  if (scopesDisponibles) attrs.push('scopes');

  let row;
  try {
    row = await ApiKeys.findOne({
      where: { key_hash: hashKey(raw), activo: 1, revoked_at: null },
      attributes: attrs,
      raw: true,
    });
  } catch (e) {
    if (scopesDisponibles && /Unknown column/i.test(e?.message || '')) {
      scopesDisponibles = false;
      row = await ApiKeys.findOne({
        where: { key_hash: hashKey(raw), activo: 1, revoked_at: null },
        attributes: ['id', 'id_configuracion', 'nombre'],
        raw: true,
      });
    } else {
      throw e;
    }
  }
  if (!row) return next(new AppError('API key inválida o revocada.', 401));

  req.apiKey = row;
  req.apiKey.scopesLista = String(row.scopes || 'read')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  req.id_configuracion = Number(row.id_configuracion);

  // Telemetría de uso: no bloquea la respuesta
  ApiKeys.update(
    { last_used_at: new Date(), usos: literal('usos + 1') },
    { where: { id: row.id }, silent: true },
  ).catch(() => {});

  next();
});

exports.hashKey = hashKey;

/* Autorización por scope. Los GET históricos usan 'read' (toda llave lo
   tiene por defecto); los endpoints de escritura exigen su scope explícito
   ('bot:write', 'flujos:write', 'plantillas:write'). '*' concede todo. */
exports.requireScope = (scope) => (req, res, next) => {
  const lista = req.apiKey?.scopesLista || ['read'];
  if (lista.includes('*') || lista.includes(String(scope).toLowerCase())) {
    return next();
  }
  return next(
    new AppError(
      `Esta API key no tiene el permiso "${scope}". Pide una llave con ese scope al dueño de la conexión.`,
      403,
    ),
  );
};

/* Genera una key nueva: se devuelve en claro UNA sola vez. */
exports.generarKey = () => {
  const raw = `ick_live_${crypto.randomBytes(24).toString('hex')}`;
  return { raw, hash: hashKey(raw), prefix: raw.slice(0, 16) };
};
