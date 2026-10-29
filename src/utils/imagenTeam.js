const axios = require('axios');
const FormData = require('form-data');

/*  Foto que un asesor manda desde Team. Team ya la achica a JPG en el
 *  navegador; aquí solo se comprueba que de verdad sea JPG o PNG (por sus
 *  primeros bytes, no por lo que diga el navegador) y que no pase el tope de
 *  WhatsApp, y se sube al mismo almacén que usa ImporChat. Meta la descarga
 *  de esa URL al mandarla. */

const MAX_BYTES = 5 * 1024 * 1024; // tope de WhatsApp para imágenes
const MAX_LEYENDA = 1024; // tope de WhatsApp para el texto de una imagen
const UPLOADER_URL = process.env.UPLOADER_URL || 'https://uploader.imporfactory.app/api/files/upload';

/** 'jpg' | 'png' | null según la firma del archivo. */
function tipoDeImagen(buffer) {
  if (!buffer || buffer.length < 8) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}

/*  Sube la foto y devuelve su URL pública. Nombre sin cifras: la URL pasa por
 *  taparTelefonos y no debe parecer un número. */
async function subirImagen(buffer, tipo) {
  const form = new FormData();
  form.append('file', buffer, {
    filename: `foto.${tipo}`,
    contentType: tipo === 'png' ? 'image/png' : 'image/jpeg',
  });
  const r = await axios.post(UPLOADER_URL, form, {
    headers: form.getHeaders(),
    timeout: 60000,
    maxContentLength: 20 * 1024 * 1024,
    maxBodyLength: 20 * 1024 * 1024,
  });
  const url = r.data?.data?.url;
  if (typeof url !== 'string' || !/^https:\/\/[^\s]+\.(jpe?g|png)$/i.test(url)) {
    throw new Error('el almacén no devolvió una URL de imagen');
  }
  return url;
}

module.exports = { tipoDeImagen, subirImagen, MAX_BYTES, MAX_LEYENDA };
