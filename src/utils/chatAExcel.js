/* Traduce una fila de mensajes_clientes a lo que se lee en la hoja de Excel
   de «Exportar conversación» (menú de tres puntos del chat).

   La tabla guarda cada tipo a su manera: las plantillas traen el texto con
   {{1}} y los valores aparte en ruta_archivo, la ubicación es un JSON dentro
   de texto_mensaje, los documentos guardan {ruta, nombre}, y Messenger /
   Instagram dejan el adjunto en attachments_unificado. Volcar las columnas
   tal cual dejaba un Excel que solo entiende quien conoce la base; aquí queda
   como se ve en el chat. Es el espejo de lo que pinta ChatPrincipal.jsx en el
   front: si allá cambia cómo se muestra un tipo, se cambia aquí también. */

const BASE_ARCHIVOS = 'https://new.imporsuitpro.com/';

const TIPOS = {
  text: 'Texto',
  edit: 'Texto',
  image: 'Imagen',
  video: 'Video',
  audio: 'Audio',
  document: 'Documento',
  sticker: 'Sticker',
  template: 'Plantilla',
  location: 'Ubicación',
  referral: 'Anuncio',
  button: 'Botón',
  interactive: 'Respuesta interactiva',
  postback: 'Botón',
  reaction: 'Reacción',
  attachment: 'Adjunto',
  notificacion: 'Notificación',
  revoke: 'Mensaje eliminado',
  unsupported: 'No compatible',
  media_failed: 'Archivo no disponible',
};

const CANALES = { wa: 'WhatsApp', ms: 'Messenger', ig: 'Instagram' };

const ESTADOS_META = { 0: 'Enviado', 1: 'Entregado', 2: 'Leído' };

const parseJSON = (raw) => {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const urlArchivo = (ruta) => {
  const limpia = String(ruta ?? '').trim();
  if (!limpia || limpia === 'null' || limpia === 'undefined') return '';
  if (/^https?:\/\//i.test(limpia)) return limpia;
  return BASE_ARCHIVOS + limpia.replace(/^\//, '');
};

// Mismo criterio que prettyAgentName del front.
const nombreResponsable = (raw) => {
  if (!raw) return '';
  if (raw === 'IA_logistica') return 'IA Logística';
  if (raw === 'IA_ventas') return 'IA Ventas';
  if (raw === 'IA_mensaje_fijo' || raw === 'IA_wizard') return 'Mensaje fijo';
  if (raw === 'IA_respuesta_rapida') return 'Respuesta rápida';
  if (raw === 'cron_template_programado') return 'Programación de Template';
  if (['webook', 'automatizador', 'automatizador_wait'].includes(raw)) {
    return 'Automatizador';
  }
  return String(raw)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-záéíóúñ])([A-ZÁÉÍÓÚÑ])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
};

// Valores de una plantilla: los tres formatos con que se han guardado.
const valoresPlantilla = (info) => {
  if (!info || typeof info !== 'object') return {};
  if (info.placeholders && typeof info.placeholders === 'object') {
    return info.placeholders;
  }
  if (Array.isArray(info.body_parameters)) {
    const out = {};
    info.body_parameters.forEach((it, idx) => {
      if (typeof it === 'string' || typeof it === 'number') {
        out[String(idx + 1)] = String(it);
      } else if (it && typeof it === 'object') {
        const k = String(it.key ?? it.n ?? idx + 1).trim();
        out[k] = String(it.value ?? it.text ?? '').trim();
      }
    });
    if (Object.keys(out).length) return out;
  }
  const out = {};
  const META = ['header', 'source', 'template_name', 'language', 'body_parameters'];
  Object.entries(info).forEach(([k, v]) => {
    if (META.includes(k)) return;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      out[String(k)] = String(v ?? '');
    }
  });
  return out;
};

const filaPlantilla = (m) => {
  const info = parseJSON(m.ruta_archivo) || {};
  const valores = valoresPlantilla(info);
  let texto = String(m.texto_mensaje || '').replace(
    /\{\{(.*?)\}\}/g,
    (match, key) => valores[String(key).trim()] ?? match,
  );

  let archivo = '';
  const header = info.header;
  if (header && typeof header === 'object') {
    const formato = String(header.format || '').toUpperCase();
    if (formato === 'TEXT') {
      const titulo = String(header.text ?? header.value ?? '').trim();
      if (titulo && titulo.toUpperCase() !== 'TEXT_FIXED') {
        texto = `${titulo}\n${texto}`;
      }
    } else if (formato) {
      archivo = urlArchivo(
        header.media_url || header.fileUrl || header.url || header.link || header.value,
      );
    }
  }

  const nombre = m.template_name || info.template_name;
  return { texto, archivo, nota: nombre ? `Plantilla: ${nombre}` : '' };
};

const filaUbicacion = (m) => {
  const loc = parseJSON(m.texto_mensaje);
  const lat = loc?.latitude ?? loc?.latitud;
  const lng = loc?.longitude ?? loc?.longitud;
  if (lat == null || lng == null) {
    return { texto: m.texto_mensaje || '', archivo: '', nota: '' };
  }
  const detalle = [loc.name, loc.address].filter(Boolean).join(' — ');
  return {
    texto: detalle ? `${detalle} (${lat}, ${lng})` : `${lat}, ${lng}`,
    archivo: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
    nota: '',
  };
};

// Adjuntos de Messenger / Instagram: viven en el JSON unificado.
const adjuntosUnificados = (m) => {
  const meta = parseJSON(m.meta_unificado);
  const raw1 = meta?.raw || meta || null;
  const raw = raw1?.raw || raw1;
  let adjuntos = Array.isArray(raw?.attachments) ? raw.attachments : [];
  if (!adjuntos.length) {
    const au = parseJSON(m.attachments_unificado);
    if (Array.isArray(au)) adjuntos = au;
  }
  return adjuntos
    .map((a) => a?.payload?.url || a?.url || '')
    .filter(Boolean);
};

const contenido = (m) => {
  const texto = m.texto_mensaje || '';

  switch (m.tipo_mensaje) {
    case 'template':
      return filaPlantilla(m);

    case 'location':
      return filaUbicacion(m);

    case 'document': {
      const doc = parseJSON(m.ruta_archivo);
      const ruta =
        doc && typeof doc === 'object' ? doc.ruta || doc.path : m.ruta_archivo;
      const nombre = doc && typeof doc === 'object' ? doc.nombre || doc.name : '';
      return { texto: texto || nombre || '', archivo: urlArchivo(ruta), nota: '' };
    }

    case 'image':
    case 'video':
    case 'sticker':
      return { texto, archivo: urlArchivo(m.ruta_archivo), nota: '' };

    // En los audios texto_mensaje ES la transcripción (solo existe si el bot
    // estaba activo en el chat cuando llegó).
    case 'audio':
      return {
        texto,
        archivo: urlArchivo(m.ruta_archivo),
        nota: texto ? 'El texto es la transcripción del audio' : '',
      };

    case 'referral': {
      const ad = parseJSON(m.ruta_archivo) || {};
      return {
        texto,
        archivo: ad.source_url || '',
        nota: ad.headline ? `Llegó desde el anuncio: ${ad.headline}` : '',
      };
    }

    case 'attachment': {
      const urls = adjuntosUnificados(m);
      return { texto, archivo: urls.join('\n'), nota: '' };
    }

    case 'unsupported':
      return {
        texto,
        archivo: '',
        nota: 'Contenido que la plataforma no entrega; se ve desde la app nativa',
      };

    case 'media_failed':
      return { texto, archivo: '', nota: 'El archivo no se pudo descargar' };

    default:
      return { texto, archivo: '', nota: '' };
  }
};

/**
 * @param {object} m  fila de mensajes_clientes (más `fecha`/`hora` ya
 *                    formateadas y `error_envio` si Meta rechazó el envío)
 * @param {object} ctx { nombreContacto }
 */
const mensajeAFila = (m, { nombreContacto = 'Cliente' } = {}) => {
  const rol = Number(m.rol_mensaje);
  const esSistema = m.tipo_mensaje === 'notificacion' || rol === 3;
  const esCliente = !esSistema && rol === 0;

  const { texto, archivo, nota } = contenido(m);
  const notas = [];
  let mensaje = texto;

  // Eliminado / editado por quien lo envió: en el chat se conserva el
  // original, así que en el Excel también.
  if (m.eliminado_at) {
    mensaje = m.texto_original || texto;
    notas.push(
      esCliente ? 'El cliente eliminó este mensaje' : 'Mensaje eliminado',
    );
  } else if (m.editado_at && m.texto_original) {
    notas.push(`Editado. Antes decía: ${m.texto_original}`);
  }
  if (nota) notas.push(nota);
  if (m.error_envio) notas.push(`No se entregó: ${m.error_envio}`);

  let estado = '';
  if (!esSistema && !esCliente && m.source === 'wa') {
    estado = m.error_envio
      ? 'Falló'
      : ESTADOS_META[Number(m.estado_meta ?? 0)] || '';
  }

  return {
    fecha: m.fecha,
    hora: m.hora,
    de: esSistema ? 'Sistema' : esCliente ? 'Cliente' : 'Negocio',
    enviado_por: esSistema
      ? ''
      : esCliente
        ? nombreContacto
        : nombreResponsable(m.responsable),
    tipo: TIPOS[m.tipo_mensaje] || m.tipo_mensaje || '',
    mensaje,
    archivo,
    estado,
    nota: notas.join(' · '),
  };
};

module.exports = { mensajeAFila, CANALES };
