const THROTTLED_WABAS = new Map(); // waba_id -> unlock_at_ms

function isWabaThrottled(wabaId) {
  if (!wabaId) return false;
  const id = String(wabaId);
  const unlockAt = THROTTLED_WABAS.get(id);
  if (!unlockAt) return false;
  if (Date.now() >= unlockAt) {
    THROTTLED_WABAS.delete(id);
    return false;
  }
  return true;
}

function markWabaThrottled(wabaId, minutes = 60) {
  if (!wabaId) return;
  const id = String(wabaId);
  const unlockAt = Date.now() + Math.max(1, Number(minutes)) * 60 * 1000;
  THROTTLED_WABAS.set(id, unlockAt);
  console.warn(
    `🛑 [WABA-THROTTLE] ${id} bloqueada ${minutes}min (hasta ${new Date(unlockAt).toISOString()})`,
  );
}

function processBucHeader(headers, context = '') {
  const raw = headers?.['x-business-use-case-usage'];
  if (!raw) return;
  let buc;
  try {
    buc = JSON.parse(raw);
  } catch {
    return;
  }
  for (const [objId, entries] of Object.entries(buc)) {
    const worst = entries.reduce(
      (acc, e) => (e.call_count > (acc?.call_count || 0) ? e : acc),
      null,
    );
    if (!worst) continue;
    if (worst.estimated_time_to_regain_access > 0) {
      markWabaThrottled(objId, worst.estimated_time_to_regain_access);
    } else if (worst.call_count >= 80) {
      console.warn(
        `⚠️ [BUC-NEAR-LIMIT]${context ? ' ' + context : ''} waba=${objId} call_count=${worst.call_count}%`,
      );
    }
  }
}

function getThrottledWabas() {
  const now = Date.now();
  const result = [];
  for (const [id, unlockAt] of THROTTLED_WABAS.entries()) {
    if (now < unlockAt) {
      result.push({
        waba_id: id,
        minutes_left: Math.ceil((unlockAt - now) / 60000),
        unlock_at: new Date(unlockAt).toISOString(),
      });
    } else {
      THROTTLED_WABAS.delete(id);
    }
  }
  return result;
}

module.exports = {
  isWabaThrottled,
  markWabaThrottled,
  processBucHeader,
  getThrottledWabas,
};
