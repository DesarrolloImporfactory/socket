'use strict';

/* ¿El vínculo de Google tiene permiso de calendario?

   Estar vinculado no alcanza: si al autorizar la persona destildó «ver y
   editar calendarios», el token solo trae correo y perfil, y el evento nunca
   se crea (Google responde 403 insufficient scopes). Pasó con Juan Garzón el
   2026-11-04: su agenda decía «conectado» y ninguna cita llegaba. Se consulta
   a Google qué permisos tiene el token (tokeninfo) y se recuerda 10 minutos
   por vínculo para no pegarle a Google en cada carga de pantalla.

   Devuelve true / false / null (sin dato: token vencido o Google no
   respondió; ni verde ni rojo). */

const { google } = require('googleapis');

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // link.id → { valor, hasta }

async function permisoCalendario(link) {
  if (!link?.refresh_token) return null;
  const c = cache.get(link.id);
  if (c && c.hasta > Date.now()) return c.valor;
  let valor = null;
  try {
    const client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI,
    );
    client.setCredentials({
      access_token: link.access_token || undefined,
      refresh_token: link.refresh_token,
      expiry_date: link.expiry_date || undefined,
    });
    const { token } = await client.getAccessToken();
    if (token) {
      const info = await client.getTokenInfo(token);
      const scopes = Array.isArray(info?.scopes) ? info.scopes : [];
      valor = scopes.some((sc) => /auth\/calendar(\.events)?$/.test(sc));
    }
  } catch (_) {
    valor = null;
  }
  if (link.id) cache.set(link.id, { valor, hasta: Date.now() + CACHE_MS });
  return valor;
}

function olvidarPermiso(linkId) {
  cache.delete(linkId);
}

module.exports = { permisoCalendario, olvidarPermiso };
