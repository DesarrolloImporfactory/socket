// utils/webhook_whatsapp/erroresEnvio.js
// Registro en memoria del ÚLTIMO error de envío por número de destino. Meta
// rechaza, por ejemplo, un texto libre cuando el cliente no escribió en las
// últimas 24 h (código 131047): hasta ahora eso quedaba solo en el log y el
// panel de pruebas se quedaba "esperando la respuesta" sin saber por qué. Es
// por proceso (no BD) a propósito: lo consulta el mismo servidor que envió.

const ULTIMOS = new Map(); // telefono -> { codigo, mensaje, ts }
const TTL_MS = 10 * 60 * 1000;

function soloDigitos(v) {
  return String(v || '').replace(/\D+/g, '');
}

/** Extrae código y texto del error de Meta (objeto, JSON en string o texto). */
function normalizarError(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = { message: raw };
    }
  }
  const codigo = Number(obj?.code ?? obj?.codigo) || null;
  const mensaje = String(
    obj?.error_data?.details || obj?.message || obj?.mensaje || raw || '',
  ).slice(0, 300);
  return { codigo, mensaje };
}

function registrarErrorEnvio(telefono, raw) {
  const tel = soloDigitos(telefono);
  if (!tel) return;
  const { codigo, mensaje } = normalizarError(raw);
  ULTIMOS.set(tel, { codigo, mensaje, ts: Date.now() });
  if (ULTIMOS.size > 5000) {
    const limite = Date.now() - TTL_MS;
    for (const [k, v] of ULTIMOS) if (v.ts < limite) ULTIMOS.delete(k);
  }
}

function ultimoErrorEnvio(telefono, maxEdadMs = 3 * 60 * 1000) {
  const tel = soloDigitos(telefono);
  const e = ULTIMOS.get(tel);
  if (!e || Date.now() - e.ts > maxEdadMs) return null;
  return {
    ...e,
    // 131047: fuera de la ventana de 24 h (el cliente tiene que escribir primero).
    ventana_24h: e.codigo === 131047 || /re-engagement|24 hours|24 horas/i.test(e.mensaje),
  };
}

function limpiarErrorEnvio(telefono) {
  ULTIMOS.delete(soloDigitos(telefono));
}

module.exports = { registrarErrorEnvio, ultimoErrorEnvio, limpiarErrorEnvio };
