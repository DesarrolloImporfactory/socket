const fs = require('fs');
const path = require('path');

// Guarda TODA petición que llegue al router de Dropi Webhook (incluidas las
// rechazadas con 401) en logs/dropi_webhook/requests-YYYY-MM-DD.jsonl,
// una línea JSON por petición.
const LOG_DIR = path.join(__dirname, '..', '..', 'logs', 'dropi_webhook');
const MAX_BODY_CHARS = 100000;

fs.mkdirSync(LOG_DIR, { recursive: true });

function archivoDeHoy() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `requests-${y}-${m}-${day}.jsonl`);
}

function recortar(v) {
  if (typeof v !== 'string' || v.length <= MAX_BODY_CHARS) return v;
  return v.slice(0, MAX_BODY_CHARS) + '…[truncado]';
}

module.exports = function dropiWebhookLogger(req, res, next) {
  const inicio = Date.now();
  let registrado = false;

  const registrar = () => {
    if (registrado) return;
    registrado = true;

    const expected = process.env.DROPI_WEBHOOK_SECRET;
    const got = req.headers['x-dropi-webhook-secret'];
    const coincide =
      expected && String(expected).trim()
        ? String(got || '').trim() === String(expected).trim()
        : null;

    // No escribir el secreto real al archivo cuando sí coincide
    const headers = { ...req.headers };
    if (coincide && headers['x-dropi-webhook-secret']) {
      headers['x-dropi-webhook-secret'] = '[coincide]';
    }

    const entry = {
      ts: new Date().toISOString(),
      metodo: req.method,
      url: req.originalUrl,
      ip: req.ip,
      x_forwarded_for: req.headers['x-forwarded-for'] || null,
      user_agent: req.headers['user-agent'] || null,
      headers,
      raw_body: recortar(req.rawBody || null),
      body: req.body && Object.keys(req.body).length ? req.body : null,
      secreto_recibido: got !== undefined,
      secreto_coincide: coincide,
      respuesta_status: res.writableEnded ? res.statusCode : null,
      abortado: !res.writableEnded,
      duracion_ms: Date.now() - inicio,
    };

    fs.appendFile(archivoDeHoy(), JSON.stringify(entry) + '\n', (err) => {
      if (err) {
        console.error('❌ dropiWebhookLogger no pudo escribir:', err.message);
      }
    });
  };

  res.on('finish', registrar);
  res.on('close', registrar);

  next();
};
