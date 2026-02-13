function onlyDigits(s = '') {
  return String(s).replace(/\D/g, '');
}

function normPhone(s = '') {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/^\+/, '');
}

/**
 * Acepta formatos típicos del front:
 * - payload.attachment: { kind, url, mime_type, file_name, size }
 * - payload.attachments: [ { kind, url, ... } ]
 * - payload.ruta_archivo + payload.tipo_mensaje (legacy)
 */
function pickAttachmentFromPayload(payload = {}) {
  // 1) attachment directo
  if (payload?.attachment?.url) return payload.attachment;

  // 2) attachments array
  if (Array.isArray(payload?.attachments) && payload.attachments.length) {
    const first = payload.attachments.find((a) => a?.url);
    if (first?.url) return first;
  }

  // 3) legacy: ruta_archivo + tipo_mensaje
  if (
    payload?.ruta_archivo &&
    payload?.tipo_mensaje &&
    payload.tipo_mensaje !== 'text'
  ) {
    const tipo = String(payload.tipo_mensaje).toLowerCase();
    const kind =
      tipo === 'image'
        ? 'image'
        : tipo === 'video'
          ? 'video'
          : tipo === 'audio'
            ? 'audio'
            : 'file';

    return {
      kind,
      url: String(payload.ruta_archivo),
      mime_type: payload?.mime_type || null,
      file_name: payload?.file_name || null,
      size: payload?.size || null,
    };
  }

  return null;
}

function isValidPublicUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

/**
 * Normaliza tipos para MS/IG:
 * kind: image | video | file
 * (si llega audio lo pasamos a file, porque su fb/ig helper hoy maneja image/video/file)
 */
function normalizeAttachment(att) {
  if (!att || !att.url) return null;

  const kindRaw = String(att.kind || '').toLowerCase();
  const kind =
    kindRaw === 'image' ? 'image' : kindRaw === 'video' ? 'video' : 'file'; // default

  return {
    kind,
    url: String(att.url),
    mime_type: att.mime_type || null,
    file_name: att.file_name || null,
    size: att.size || null,
  };
}

module.exports = {
  onlyDigits,
  normPhone,
  pickAttachmentFromPayload,
  normalizeAttachment,
  isValidPublicUrl,
};
