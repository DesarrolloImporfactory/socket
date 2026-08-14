'use strict';

/* Mandar la ubicación como ubicación de verdad.
   ─────────────────────────────────────────────────────────────
   Hasta ahora, "dónde queda" se resolvía pegando un enlace de Google Maps. En
   el computador funciona; en el celular —que es donde está el 100% de la
   gente— es bastante peor: hay que salir de WhatsApp, esperar que cargue el
   navegador y que abra la app. Un mensaje de tipo `location` sale con el mapita
   embebido, se toca una vez y arranca la navegación.

   Es la diferencia entre que alguien llegue a ver una casa y que se pierda en
   el camino. */

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const Configuraciones = require('../../models/configuraciones.model');
const { procesarMensajeTexto } = require('./procesarMensajeTexto');

const logsDir = path.join(process.cwd(), './src/logs/logs_meta');

async function logToFile(message) {
  try {
    await fs.mkdir(logsDir, { recursive: true });
    await fs.appendFile(path.join(logsDir, 'debug_log.txt'), message);
  } catch (_) {
    /* el log no puede tumbar un envío */
  }
}

/**
 * Devuelve `{ ok, wamid, error }` en vez de lanzar, igual que el envío de
 * medios: esto sale junto al mensaje de confirmación de una cita y un pin que
 * Meta rechace no puede llevarse por delante el aviso de que la visita quedó.
 *
 * @param {object} p
 * @param {number|string} p.latitud
 * @param {number|string} p.longitud
 * @param {string} [p.nombre]     título que se ve sobre el mapa
 * @param {string} [p.direccion]  línea de abajo
 */
async function enviarUbicacionWhatsapp({
  latitud,
  longitud,
  nombre = '',
  direccion = '',
  phone_whatsapp_to,
  business_phone_id,
  accessToken,
  id_configuracion = null,
  responsable = '',
}) {
  const lat = Number(latitud);
  const lng = Number(longitud);

  /* Sin coordenadas válidas no se manda nada. Un pin en (0,0) cae en el
     Atlántico y es peor que no mandar nada: la persona cree que tiene la
     ubicación. */
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180 ||
    (lat === 0 && lng === 0)
  ) {
    return { ok: false, error: 'coordenadas inválidas' };
  }

  const url = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${business_phone_id}/messages`;
  const data = {
    messaging_product: 'whatsapp',
    to: phone_whatsapp_to,
    type: 'location',
    location: {
      latitude: lat,
      longitude: lng,
      ...(nombre ? { name: String(nombre).slice(0, 100) } : {}),
      ...(direccion ? { address: String(direccion).slice(0, 200) } : {}),
    },
  };

  try {
    const response = await axios.post(url, data, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const mensajeId = response?.data?.messages?.[0]?.id;

    if (response.status >= 200 && response.status < 300 && mensajeId) {
      await logToFile(
        `[${new Date().toISOString()}] ✅ Ubicación enviada (${lat}, ${lng}). ID: ${mensajeId}\n`,
      );

      /* Se guarda en el hilo con el mismo formato que usa el webhook para las
         ubicaciones que ENTRAN, para que el chat las pinte igual venga de donde
         venga. */
      if (id_configuracion) {
        const config = await Configuraciones.findOne({
          where: { id: id_configuracion, suspendido: 0 },
        });
        if (config) {
          await procesarMensajeTexto({
            id_configuracion,
            business_phone_id,
            nombre_cliente: config.nombre_configuracion,
            apellido_cliente: '',
            telefono_configuracion: config.telefono,
            phone_whatsapp_to,
            tipo_mensaje: 'location',
            texto_mensaje: JSON.stringify({ latitude: lat, longitude: lng }),
            ruta_archivo: null,
            responsable,
            wamid: mensajeId,
          });
        }
      }

      return { ok: true, wamid: mensajeId };
    }

    const errorMsg = response?.data?.error
      ? JSON.stringify(response.data.error)
      : 'Respuesta inesperada';
    await logToFile(
      `[${new Date().toISOString()}] ❌ Error al enviar ubicación: ${errorMsg}\n`,
    );
    return { ok: false, error: errorMsg };
  } catch (err) {
    const detalle = err.response?.data?.error
      ? JSON.stringify(err.response.data.error)
      : err.message;
    await logToFile(
      `[${new Date().toISOString()}] ❌ Error axios al enviar ubicación: ${detalle}\n`,
    );
    return { ok: false, error: detalle };
  }
}

module.exports = { enviarUbicacionWhatsapp };
