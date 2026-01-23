/**
 * Códigos de país para países latinoamericanos y otros comunes
 */
const COUNTRY_CODES = {
    '593': { country: 'Ecuador', code: '593', length: 9 },
    '52': { country: 'México', code: '52', length: 10 },
    '57': { country: 'Colombia', code: '57', length: 10 },
    '51': { country: 'Perú', code: '51', length: 9 },
    '56': { country: 'Chile', code: '56', length: 9 },
    '54': { country: 'Argentina', code: '54', length: 10 },
    '58': { country: 'Venezuela', code: '58', length: 10 },
    '55': { country: 'Brasil', code: '55', length: 11 },
    '507': { country: 'Panamá', code: '507', length: 8 },
    '506': { country: 'Costa Rica', code: '506', length: 8 },
    '503': { country: 'El Salvador', code: '503', length: 8 },
    '502': { country: 'Guatemala', code: '502', length: 8 },
    '504': { country: 'Honduras', code: '504', length: 8 },
    '505': { country: 'Nicaragua', code: '505', length: 8 },
    '591': { country: 'Bolivia', code: '591', length: 8 },
    '595': { country: 'Paraguay', code: '595', length: 9 },
    '598': { country: 'Uruguay', code: '598', length: 9 },
    '1': { country: 'USA/Canadá', code: '1', length: 10 },
    '34': { country: 'España', code: '34', length: 9 },
};

/**
 * Limpia un número de teléfono eliminando caracteres no numéricos
 * @param {string} phone - Número de teléfono
 * @returns {string} - Número limpio solo con dígitos
 */
function cleanPhoneNumber(phone) {
    if (!phone) return '';
    return phone.toString().replace(/\D/g, '');
}

/**
 * Detecta el código de país de un número de teléfono
 * @param {string} phone - Número de teléfono
 * @returns {object|null} - Información del país o null si no se encuentra
 */
function detectCountryCode(phone) {
    const cleaned = cleanPhoneNumber(phone);

    // Intentar con códigos de 3 dígitos primero (ej: 593, 507)
    const threeDigitCode = cleaned.substring(0, 3);
    if (COUNTRY_CODES[threeDigitCode]) {
        return COUNTRY_CODES[threeDigitCode];
    }
    
    // Intentar con códigos de 2 dígitos (ej: 52, 57)
    const twoDigitCode = cleaned.substring(0, 2);
    if (COUNTRY_CODES[twoDigitCode]) {
        return COUNTRY_CODES[twoDigitCode];
    }
    
    // Intentar con códigos de 1 dígito (ej: 1 para USA)
    const oneDigitCode = cleaned.substring(0, 1);
    if (COUNTRY_CODES[oneDigitCode]) {
        return COUNTRY_CODES[oneDigitCode];
    }
    
    return null;
}

/**
 * Normaliza un número de teléfono eliminando el código de país
 * @param {string} phone - Número de teléfono
 * @param {string} defaultCountryCode - Código de país por defecto si no se detecta (ej: '593')
 * @returns {object} - { normalizedPhone, countryCode, country, originalPhone }
 */
function normalizePhoneNumber(phone, defaultCountryCode = '593') {
    const cleaned = cleanPhoneNumber(phone);
    
    if (!cleaned) {
        return {
            normalizedPhone: '',
            countryCode: null,
            country: null,
            originalPhone: phone,
            hasCountryCode: false
        };
    }
    
    // Intentar detectar código de país
    const detectedCountry = detectCountryCode(cleaned);
    
    if (detectedCountry) {
        // Eliminar el código de país detectado
        const normalizedPhone = cleaned.substring(detectedCountry.code.length);
        return {
            normalizedPhone,
            countryCode: detectedCountry.code,
            country: detectedCountry.country,
            originalPhone: phone,
            hasCountryCode: true
        };
    }
    
    // Si no se detectó código de país, usar el código por defecto
    const defaultCountry = COUNTRY_CODES[defaultCountryCode];
    return {
        normalizedPhone: cleaned,
        countryCode: defaultCountryCode,
        country: defaultCountry ? defaultCountry.country : 'Desconocido',
        originalPhone: phone,
        hasCountryCode: false
    };
}

/**
 * Genera variaciones de un número de teléfono para búsquedas flexibles
 * @param {string} phone - Número de teléfono
 * @param {string} defaultCountryCode - Código de país por defecto
 * @returns {array} - Array con variaciones del número
 */
function generatePhoneVariations(phone, defaultCountryCode = '593') {
    const normalized = normalizePhoneNumber(phone, defaultCountryCode);
    const variations = new Set();
    
    // Agregar el número normalizado
    variations.add(normalized.normalizedPhone);
    
    // Agregar con código de país
    variations.add(normalized.countryCode + normalized.normalizedPhone);
    
    // Agregar número original limpio
    variations.add(cleanPhoneNumber(phone));
    
    return Array.from(variations).filter(v => v.length > 0);
}

/**
 * Formatea un número de teléfono para WhatsApp (con código de país)
 * Si el número ya tiene código, lo retorna limpio
 * Si NO tiene código, le agrega el código de país por defecto
 * @param {string} phone - Número de teléfono
 * @param {string} defaultCountryCode - Código de país por defecto (ej: '593' para Ecuador)
 * @returns {string} - Número con código de país listo para WhatsApp
 */
function formatPhoneForWhatsApp(phone, defaultCountryCode = '593') {
    const cleaned = cleanPhoneNumber(phone);
    
    if (!cleaned) {
        return '';
    }
    
    // Detectar si ya tiene código de país
    const detectedCountry = detectCountryCode(cleaned);
    
    if (detectedCountry) {
        // Ya tiene código de país, retornar el número limpio
        return cleaned;
    }
    
    // NO tiene código de país, procesarlo
    let localNumber = cleaned;
    
    // Para Ecuador: eliminar el 0 inicial si existe
    if (defaultCountryCode === '593' && localNumber.startsWith('0')) {
        localNumber = localNumber.substring(1);
    }
    
    // Agregar código de país
    return defaultCountryCode + localNumber;
}
module.exports = {
    COUNTRY_CODES,
    cleanPhoneNumber,
    detectCountryCode,
    normalizePhoneNumber,
    generatePhoneVariations,
    formatPhoneForWhatsApp
};
