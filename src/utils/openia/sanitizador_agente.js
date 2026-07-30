// ─────────────────────────────────────────────────────────────
// sanitizarRespuestaAgente
// Convierte cualquier markdown/formato libre que GPT invente
// al formato esperado por el sistema: [producto_imagen_url]: URL
// ─────────────────────────────────────────────────────────────
function sanitizarRespuestaAgente(texto) {
  if (!texto || typeof texto !== 'string') return texto;

  // 1. Markdown imagen ![texto](url) → [producto_imagen_url]: url
  texto = texto.replace(
    /!\[([^\]]*?)\]\((https?:\/\/[^\s)]+)\)/gi,
    '\n[producto_imagen_url]: $2',
  );

  // 2. Markdown link con URL de video → [producto_video_url]: url
  texto = texto.replace(
    /\[([^\]]*?)\]\((https?:\/\/[^\s)]+\.(?:mp4|mov|webm|avi|mkv)(?:\?[^\s)]*)?)\)/gi,
    '\n[producto_video_url]: $2',
  );

  // 3. Markdown link con URL de imagen → [producto_imagen_url]: url
  texto = texto.replace(
    /\[([^\]]*?)\]\((https?:\/\/[^\s)]+\.(?:jpg|jpeg|png|webp|gif)(?:\?[^\s)]*)?)\)/gi,
    '\n[producto_imagen_url]: $2',
  );

  // 4. Markdown link cuyo texto contiene "imagen/foto/ver"
  texto = texto.replace(
    /\[(?:[^\]]*(?:imagen|foto|image|photo|picture|ver)[^\]]*)\]\((https?:\/\/[^\s)]+)\)/gi,
    '\n[producto_imagen_url]: $1',
  );

  // 5. Markdown link cuyo texto contiene "video"
  texto = texto.replace(
    /\[(?:[^\]]*video[^\]]*)\]\((https?:\/\/[^\s)]+)\)/gi,
    '\n[producto_video_url]: $1',
  );

  // 6. URLs sueltas precedidas por "Imagen:" / "Foto:" / "Video:"
  texto = texto.replace(
    /(?:imagen|foto)\s*:\s*(https?:\/\/\S+\.(?:jpg|jpeg|png|webp|gif))/gi,
    '\n[producto_imagen_url]: $1',
  );
  texto = texto.replace(
    /video\s*:\s*(https?:\/\/\S+\.(?:mp4|mov|webm))/gi,
    '\n[producto_video_url]: $1',
  );

  /* WhatsApp no entiende Markdown: **negrita** se ve literal con los asteriscos
     y ### queda como basura al inicio de la línea. Al modelo se le pide que no
     lo use, pero lo usa igual en cuanto enumera precios, así que se corrige
     aquí — es el único punto por el que pasan todas las respuestas.
     El negrita de WhatsApp es *un* asterisco, y el de Markdown son dos. */
  texto = texto.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '*$1*');
  texto = texto.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '*$1*');
  // Títulos Markdown al inicio de línea: se quedan solo con el texto.
  texto = texto.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  // Enlaces [texto](url) → la URL sola, que es lo único que WhatsApp abre.
  texto = texto.replace(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '$2');

  // Limpieza
  texto = texto.replace(/\n{3,}/g, '\n\n').trim();

  return texto;
}

module.exports = { sanitizarRespuestaAgente };
