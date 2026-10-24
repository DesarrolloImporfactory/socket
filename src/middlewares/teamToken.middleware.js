const crypto = require('crypto');
const AppError = require('../utils/appError');

/**
 * Puerta para el servidor de Team (team.imporchina.com, PHP). Team pide la
 * sesión de un usuario «equipo» con un secreto compartido en `.env`
 * (TEAM_EQUIPO_TOKEN), igual que el ERP con erpToken. Sin secreto la puerta
 * queda cerrada (503), nunca abierta.
 */
function comparar(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function leerToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const h = req.headers['x-team-token'];
  return h ? String(h).trim() : null;
}

exports.teamToken = (req, res, next) => {
  const esperado = String(process.env.TEAM_EQUIPO_TOKEN || '').trim();
  if (!esperado) {
    return next(new AppError('La integración con Team no está configurada.', 503));
  }
  const recibido = leerToken(req);
  if (!recibido || !comparar(recibido, esperado)) {
    return next(new AppError('Token de integración inválido.', 401));
  }
  next();
};
