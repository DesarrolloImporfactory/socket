'use strict';

const axios = require('axios');
const FormData = require('form-data');

/**
 * Sube un comprobante (captura o PDF del banco) al uploader compartido —el
 * mismo de los adjuntos del chat— y devuelve su URL.
 *
 * Devuelve null si falla, y el caller decide: perder el archivo es molesto,
 * pero bloquear el registro de un pago porque el uploader está caído sería
 * peor. El dinero ya salió del banco para cuando alguien pulsa el botón.
 *
 * Lo usan los cobros de referidos (referidos/comprobantes) y los pagos
 * manuales de planes (pagos_manuales/comprobantes).
 */
const UPLOADER_URL = 'https://uploader.imporfactory.app/api/files/upload';

async function subirComprobante(file, carpeta = 'comprobantes') {
  if (!file?.buffer?.length) return null;
  try {
    const nombre = String(file.originalname || 'comprobante').replace(
      /[^\w.\-() ]+/g,
      '_',
    );
    const form = new FormData();
    form.append('file', file.buffer, {
      filename: `${carpeta}/${Date.now()}-${nombre}`,
      contentType: file.mimetype || 'application/octet-stream',
    });

    const resp = await axios.post(UPLOADER_URL, form, {
      headers: form.getHeaders(),
      timeout: 30000,
      validateStatus: () => true,
    });

    if (resp.status >= 200 && resp.status < 300 && resp.data?.data?.url) {
      return resp.data.data.url;
    }
    console.log(`[comprobante] uploader rechazó el archivo (${carpeta}):`, resp.status);
    return null;
  } catch (e) {
    console.log(`[comprobante] subida falló (${carpeta}):`, e?.message);
    return null;
  }
}

module.exports = { subirComprobante };
