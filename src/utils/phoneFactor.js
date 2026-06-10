'use strict';

const {
  parsePhoneNumberFromString,
  isSupportedCountry,
} = require('libphonenumber-js');

/**
 * Mapa calling code (lo que guarda tu columna country_code, ej "593")
 * → región ISO-2 que entiende libphonenumber (ej "EC").
 * Si tu country_code ya guardara ISO ("EC", "CO"...), igual funciona (ver resolveRegion).
 */
const CALLING_TO_ISO = {
  593: 'EC', // Ecuador
  57: 'CO', // Colombia
  52: 'MX', // México
  51: 'PE', // Perú
  56: 'CL', // Chile
  54: 'AR', // Argentina
  58: 'VE', // Venezuela
  55: 'BR', // Brasil
  502: 'GT', // Guatemala
  503: 'SV', // El Salvador
  504: 'HN', // Honduras
  505: 'NI', // Nicaragua
  506: 'CR', // Costa Rica
  507: 'PA', // Panamá
  591: 'BO', // Bolivia
  595: 'PY', // Paraguay
  598: 'UY', // Uruguay
  1: 'US', // USA/Canadá
  34: 'ES', // España
};

/**
 * Resuelve tu country_code a una región ISO-2.
 * Acepta tanto ISO ("EC") como calling code ("593").
 */
function resolveRegion(countryCode, fallback = 'EC') {
  const raw = String(countryCode || '')
    .trim()
    .toUpperCase();
  if (isSupportedCountry(raw)) return raw; // ya es ISO: "EC", "CO", "MX"...
  const digits = raw.replace(/\D/g, '');
  if (CALLING_TO_ISO[digits]) return CALLING_TO_ISO[digits]; // era "593" → "EC"
  return fallback;
}

/**
 * Parsea un teléfono en cualquier formato a un objeto libphonenumber.
 * Maneja: local ("962803007"), local con 0 ("0962803007"),
 * internacional con + ("+593962803007") e internacional sin + ("593962803007").
 * Devuelve null si no logra parsear (el caller hace fallback a solo-dígitos).
 */
function parseAny(raw, countryCode) {
  const region = resolveRegion(countryCode);
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;

  // 1) como número local de esa región (cubre "962803007" y "0962803007")
  let p = parsePhoneNumberFromString(String(raw || ''), region);
  if (p && p.isValid()) return p;

  // 2) como internacional, anteponiendo "+" (cubre "593962803007" sin el +)
  p = parsePhoneNumberFromString('+' + digits);
  if (p && p.isValid()) return p;

  return null;
}

/**
 * Para Dropi: número NACIONAL, sin código de país ni 0 de marcación.
 *   EC "962803007" · CO "3001234567" · MX "5512345678" · GT "55551234"
 */
function toDropiLocal(raw, countryCode = 'EC') {
  const p = parseAny(raw, countryCode);
  if (p) return p.nationalNumber;
  return String(raw || '').replace(/\D/g, ''); // fallback: no rompemos el flujo
}

/**
 * Para WhatsApp: internacional en dígitos, SIN el "+".
 *   "593962803007", "573001234567", ...
 */
function toWhatsapp(raw, countryCode = 'EC') {
  const p = parseAny(raw, countryCode);
  if (p) return p.number.replace('+', '');
  return String(raw || '').replace(/\D/g, '');
}

module.exports = {
  resolveRegion,
  toDropiLocal,
  toWhatsapp,
};
