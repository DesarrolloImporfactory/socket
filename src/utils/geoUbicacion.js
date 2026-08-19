'use strict';

/**
 * Ubicaciones compartidas por WhatsApp → dirección en palabras.
 *
 * Cuando el cliente toca "Enviar ubicación", el webhook guarda el JSON crudo
 * de Meta (`{"latitude":-0.3,"longitude":-78.4}`) porque el chat lo usa para
 * pintar el mapita. Ese JSON no le sirve a nadie más: ni al asistente (que
 * respondía pidiendo la dirección "en palabras"), ni al auto-orden de Dropi
 * (que necesita provincia/ciudad/dirección reales para crear la orden).
 *
 * Aquí vive la traducción única: parsear el JSON y geocodificarlo en reversa
 * con Nominatim (OpenStreetMap) — gratis, sin API key. La cuota pública es
 * 1 req/s, sobrada para este volumen (una consulta por ubicación compartida),
 * y el cache evita repetir la misma coordenada cuando varios pasos del flujo
 * la piden (asistente, extractor del auto-orden, candado de ciudad).
 */

const axios = require('axios');

/**
 * ¿El texto es el JSON de una ubicación de WhatsApp? Devuelve {lat, lng} o
 * null, para que el mensaje siga su camino sin tocarse.
 */
function parseUbicacionJson(texto) {
  const s = String(texto || '').trim();
  if (!s.startsWith('{') || !s.includes('latitude')) return null;

  try {
    const o = JSON.parse(s);
    const lat = Number(o?.latitude);
    const lng = Number(o?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

/* En Ecuador (el mercado principal) Nominatim NO manda la provincia en
   `state`: para Quito, por ejemplo, solo llega el código ISO ("EC-P"). Se
   traduce con esta tabla; en los demás países `state` sí viene con nombre
   (probado con CO y MX). */
const PROVINCIA_EC_POR_ISO = {
  'EC-A': 'Azuay',
  'EC-B': 'Bolívar',
  'EC-F': 'Cañar',
  'EC-C': 'Carchi',
  'EC-H': 'Chimborazo',
  'EC-X': 'Cotopaxi',
  'EC-O': 'El Oro',
  'EC-E': 'Esmeraldas',
  'EC-W': 'Galápagos',
  'EC-G': 'Guayas',
  'EC-I': 'Imbabura',
  'EC-L': 'Loja',
  'EC-R': 'Los Ríos',
  'EC-M': 'Manabí',
  'EC-S': 'Morona Santiago',
  'EC-N': 'Napo',
  'EC-D': 'Orellana',
  'EC-Y': 'Pastaza',
  'EC-P': 'Pichincha',
  'EC-SE': 'Santa Elena',
  'EC-SD': 'Santo Domingo de los Tsáchilas',
  'EC-U': 'Sucumbíos',
  'EC-T': 'Tungurahua',
  'EC-Z': 'Zamora Chinchipe',
};

/* Cache en memoria por coordenada redondeada (5 decimales ≈ 1 m): la misma
   ubicación se consulta varias veces en un mismo cierre (asistente → extractor
   → candado). Solo se cachean respuestas buenas: un timeout transitorio no
   debe quedar pegado. */
const cacheGeo = new Map();
const CACHE_MAX = 500;

/**
 * Geocodificación en reversa: coordenadas → { direccion, ciudad, provincia,
 * pais, referencia, mapa }. Devuelve null si el geocoder no responde o no
 * reconoce nada útil; el que llama decide su fallback.
 */
async function reverseGeocode(lat, lng) {
  const key = `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
  if (cacheGeo.has(key)) return cacheGeo.get(key);

  try {
    const { data } = await axios.get(
      'https://nominatim.openstreetmap.org/reverse',
      {
        params: {
          lat,
          lon: lng,
          format: 'jsonv2',
          'accept-language': 'es',
          addressdetails: 1,
          zoom: 18,
        },
        // Nominatim exige identificarse; sin User-Agent propio responde 403.
        headers: {
          'User-Agent': 'ChatCenter-Imporfactory/1.0 (imporfactory.app)',
        },
        timeout: 8000,
      },
    );

    const a = data?.address || {};
    /* Ciudad: en zonas urbanas viene en city/town; en rurales solo está el
       cantón/municipio en county ("Cantón Otavalo" → "Otavalo"), que es
       justamente el nivel que usan los catálogos de ciudades de Dropi. */
    const ciudad = String(
      a.city ||
        a.town ||
        (a.county
          ? String(a.county).replace(/^(cant[oó]n|municipio( de)?)\s+/i, '')
          : '') ||
        a.village ||
        a.municipality ||
        '',
    )
      // En Colombia el casco urbano llega como "Perímetro Urbano Medellín";
      // el catálogo de Dropi lo conoce como "Medellín" a secas.
      .replace(/^per[ií]metro urbano\s+/i, '')
      .trim();
    const provincia = String(
      a.state || PROVINCIA_EC_POR_ISO[a['ISO3166-2-lvl4']] || a.region || '',
    ).trim();
    const direccion = [
      [a.road, a.house_number].filter(Boolean).join(' '),
      a.neighbourhood || a.suburb,
    ]
      .filter(Boolean)
      .join(', ');

    let out = {
      lat: Number(lat),
      lng: Number(lng),
      direccion,
      ciudad,
      provincia,
      pais: String(a.country || '').trim(),
      // display_name completo: sirve como referencia legible ("Calle X,
      // Barrio Y, Otavalo, Imbabura, Ecuador") para logs y transcripts.
      referencia: String(data?.display_name || '').trim(),
      mapa: `https://www.google.com/maps?q=${lat},${lng}`,
    };
    // Sin ciudad ni provincia ni calle no hay nada que aportar (coordenada en
    // el mar, o respuesta vacía): mejor null que un objeto hueco.
    if (!out.ciudad && !out.provincia && !out.direccion) out = null;

    if (out) {
      if (cacheGeo.size >= CACHE_MAX) {
        cacheGeo.delete(cacheGeo.keys().next().value);
      }
      cacheGeo.set(key, out);
    }
    return out;
  } catch (err) {
    console.log('[geoUbicacion] reverse geocode falló:', err?.message);
    return null;
  }
}

/**
 * Atajo: texto del mensaje → geocodificación, o null si el texto no es una
 * ubicación o el geocoder no la resolvió.
 */
async function geocodificarMensaje(texto) {
  const coords = parseUbicacionJson(texto);
  if (!coords) return null;
  return reverseGeocode(coords.lat, coords.lng);
}

module.exports = { parseUbicacionJson, reverseGeocode, geocodificarMensaje };
