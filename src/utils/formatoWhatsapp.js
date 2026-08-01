'use strict';

/* WhatsApp no entiende Markdown. Los `**negritas**` llegan con los asteriscos a
   la vista y los `### títulos` con los numerales, así que un mensaje que en
   pantalla del modelo se ve prolijo, al cliente le llega roto.

   Está prohibido en el prompt y el modelo lo escribe igual —sobre todo cuando
   lista datos de una sede—, así que se corrige acá antes de enviar.

   WhatsApp sí entiende *un asterisco a cada lado* para negrita, que es a lo que
   se traduce, en vez de borrar el énfasis. */

const limpiarMarkdown = (texto) => {
  if (!texto || typeof texto !== 'string') return texto;

  return (
    texto
      // **negrita** o __negrita__ → *negrita* (lo que WhatsApp sí muestra)
      .replace(/\*\*(.+?)\*\*/gs, '*$1*')
      .replace(/__(.+?)__/gs, '*$1*')
      // ### Título al principio de línea → se queda el texto solo
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      // [texto](url) → el enlace pelado, que es lo único clicable en WhatsApp
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$2')
      // Viñetas con guion largo al inicio de línea: WhatsApp las respeta mejor
      // como guion simple.
      .replace(/^\s*[–—]\s+/gm, '- ')
  );
};

module.exports = { limpiarMarkdown };
