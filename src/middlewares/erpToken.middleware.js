const crypto = require('crypto');
const AppError = require('../utils/appError');

/**
 * Puerta para las llamadas servidor-a-servidor que llegan desde el ERP
 * (imporsuitpro, PHP). No hay un sub-usuario detrás: es un proceso hablándole
 * a otro, así que el `protect` de siempre —que exige un JWT de sesión— no
 * aplica. Lo que se valida es un secreto compartido en `.env`, presente en los
 * dos lados.
 *
 * La comparación es de tiempo constante a propósito: `===` sobre strings corta
 * en el primer byte distinto y filtra, byte a byte, cuánto del token es
 * correcto. Con un endpoint que crea citas en el Google Calendar del equipo
 * eso no es un detalle académico.
 */
function comparar(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  // timingSafeEqual exige longitudes iguales; el hash las iguala sin filtrar
  // la longitud real del secreto.
  const hashA = crypto.createHash('sha256').update(bufA).digest();
  const hashB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function leerToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const h = req.headers['x-erp-token'];
  return h ? String(h).trim() : null;
}

exports.erpToken = (req, res, next) => {
  const esperado = String(process.env.ERP_MENTORIAS_TOKEN || '').trim();

  // Sin secreto configurado el endpoint queda cerrado, no abierto: un `.env`
  // incompleto en un despliegue nuevo no debe dejar la agenda del equipo
  // expuesta a cualquiera que adivine la ruta.
  if (!esperado) {
    return next(
      new AppError('La integración con el ERP no está configurada.', 503),
    );
  }

  const recibido = leerToken(req);
  if (!recibido || !comparar(recibido, esperado)) {
    return next(new AppError('Token de integración inválido.', 401));
  }

  next();
};
