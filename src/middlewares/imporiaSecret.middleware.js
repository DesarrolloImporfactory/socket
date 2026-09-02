// ═══════════════════════════════════════════════════════════════
// imporiaSecret.middleware.js
//
// Secreto compartido entre el PHP de imporsuit-pro y este servicio.
//
// POR QUÉ
//
// `enviar_mensaje_gpt` estuvo abierto a internet: sin auth, recibiendo el id de
// la conversación por body y corriendo contra la API key de Imporfactory
// —no la del cliente—. Cualquiera con la URL podía gastarle saldo en un bucle
// e insertar filas en mensajes_gpt_imporsuit.
//
// POR QUÉ UN SECRETO Y NO `protect`
//
// Quien llama no es un navegador con sesión: es el PHP de imporsuit-pro, que
// ya validó el JWT del usuario y saca el id_plataforma del token. Meterle el
// JWT de ChatCenter (otro dominio, otra tabla de usuarios, otras claves) sería
// atar dos sistemas de auth que no se conocen. Un secreto de servidor a
// servidor es lo que corresponde.
//
// CONFIGURACIÓN — SE CAE SI FALTA, A PROPÓSITO
//
// Hay que poner la MISMA cadena en los dos lados antes de desplegar:
//   socket        .env  IMPORIA_SHARED_SECRET=…
//   imporsuit-pro .env  IMPORIA_SHARED_SECRET=…
//
// Si la variable no está, el endpoint responde 503 en vez de quedar abierto:
// un secreto mal configurado que "funciona igual" es exactamente como se
// pierden estos arreglos con el tiempo. Generar uno con:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');

/** Comparación en tiempo constante, tolerante a longitudes distintas. */
function coincide(recibido, esperado) {
  const a = Buffer.from(String(recibido || ''), 'utf8');
  const b = Buffer.from(String(esperado || ''), 'utf8');

  // timingSafeEqual explota si los buffers miden distinto, y la longitud sola
  // no es un secreto que valga la pena proteger: se hashean los dos para
  // igualar el tamaño y recién ahí se comparan.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireImporiaSecret(req, res, next) {
  const esperado = process.env.IMPORIA_SHARED_SECRET;

  if (!esperado) {
    console.error(
      '[imporia] IMPORIA_SHARED_SECRET no está configurado: el endpoint queda cerrado',
    );
    return res.status(503).json({
      status: 503,
      message: 'ImporIA no está configurado en el servidor',
    });
  }

  const recibido = req.get('x-imporia-secret');

  if (!recibido || !coincide(recibido, esperado)) {
    console.warn(
      `[imporia] intento rechazado desde ${req.ip} (secreto ${recibido ? 'incorrecto' : 'ausente'})`,
    );
    return res.status(401).json({
      status: 401,
      message: 'No autorizado',
    });
  }

  return next();
}

module.exports = { requireImporiaSecret };
