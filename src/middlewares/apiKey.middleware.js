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

  const row = await ApiKeys.findOne({
    where: { key_hash: hashKey(raw), activo: 1, revoked_at: null },
    attributes: ['id', 'id_configuracion', 'nombre'],
    raw: true,
  });
  if (!row) return next(new AppError('API key inválida o revocada.', 401));

  req.apiKey = row;
  req.id_configuracion = Number(row.id_configuracion);

  // Telemetría de uso: no bloquea la respuesta
  ApiKeys.update(
    { last_used_at: new Date(), usos: literal('usos + 1') },
    { where: { id: row.id }, silent: true },
  ).catch(() => {});

  next();
});

exports.hashKey = hashKey;

/* Genera una key nueva: se devuelve en claro UNA sola vez. */
exports.generarKey = () => {
  const raw = `ick_live_${crypto.randomBytes(24).toString('hex')}`;
  return { raw, hash: hashKey(raw), prefix: raw.slice(0, 16) };
};
