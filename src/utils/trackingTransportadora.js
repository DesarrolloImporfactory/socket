/* Link de rastreo por transportadora (Ecuador y México). Solo links
   verificados que abren el rastreo con la guía ya puesta. Sin link → '' y
   el que llama decide (el redirect muestra el estado según Dropi). */

const URL_REDIRECT_TRACKING =
  'https://chat.imporfactory.app/api/v1/kanban_plantillas/t/';

const POR_TRANSPORTADORA = [
  // ── Ecuador ──
  {
    test: (c) => c.includes('LAAR'),
    url: (g) =>
      `https://fenixoper.laarcourier.com/Tracking/Guiacompleta.aspx?guia=${g}`,
  },
  {
    // Gintracom cambió su rastreo: /web/site/tracking?guia= pasó a responder
    // 401 "Credenciales inválidas" (visto el 11-11-2026). La página nueva
    // recibe la guía igual y abre con la búsqueda ya hecha.
    test: (c) => c.includes('GINTRACOM'),
    url: (g) => `https://ec.gintracom.site/tracking?guia=${g}`,
  },
  {
    test: (c) => c.includes('VELOCES'),
    url: (g) => `https://tracking.veloces.app/tracking-client/${g}`,
  },
  {
    test: (c) => c.includes('SERVIENTREGA'),
    url: (g) => `https://www.servientrega.com.ec/Tracking/?guia=${g}&tipo=GUIA`,
  },
  // ── México ──
  {
    test: (c) => c.includes('AMPM'),
    url: (g) => `https://grupoampm.com/rastreador/?tracking-id=${g}`,
  },
  {
    // Abre su portal con la guía escrita; el cliente solo da "Buscar".
    test: (c) => c.includes('QUALITY'),
    url: (g) =>
      `https://wstracking.qualitypost.com.mx/portal_seguimiento?info=${g}`,
  },
  {
    test: (c) => c.includes('COORDI'),
    url: (g) =>
      `https://coordi.com/rastreo/rastreo-de-guia/detalle-de-rastreo-de-guia/?guia=${g}`,
  },
  {
    test: (c) => c.includes('TIUI'),
    url: (g) => `https://tiuiamigo.tiui.mx/rastreo/${g}`,
  },
];

/* Transportadoras cuyo rastreo no acepta la guía por link (Afimex solo
   recibe POST con token). Se muestra como botón en nuestra página. */
const RASTREADOR_SIN_GUIA = [
  {
    test: (c) => c.includes('AFIMEX'),
    url: 'https://afimex.net/rastrea-envio',
  },
  {
    // Urbano dejó de aceptar ?guia= (visto el 12-11-2026: "No se encontraron
    // resultados" con 19 guías reales en todos los estados). Su página ahora
    // exige ?tkn=, un token cifrado que arma su propia web y caduca a los
    // 5 minutos, así que no hay enlace que lleve la guía puesta.
    test: (c) => c.includes('URBANO'),
    url: 'https://www.urbano.com.ec/',
  },
];

// Adivinar por prefijo solo sirve cuando no sabemos la transportadora.
const POR_PREFIJO = [
  { re: /^(LC|IMP|MKP)/i, comp: 'LAAR' },
  { re: /^(D0|I0)/i, comp: 'GINTRACOM' },
  { re: /^V/i, comp: 'VELOCES' },
  { re: /^WYB/i, comp: 'URBANO' },
];

function urlTrackingTransportadora(shippingCompany, guide) {
  const g = String(guide || '').trim();
  if (!g) return '';
  let comp = String(shippingCompany || '').toUpperCase();
  if (!comp) comp = POR_PREFIJO.find((p) => p.re.test(g))?.comp || '';
  const t = POR_TRANSPORTADORA.find((x) => x.test(comp));
  return t ? t.url(encodeURIComponent(g)) : '';
}

// `guide` solo sirve para adivinar la transportadora cuando no se conoce.
function urlRastreadorSinGuia(shippingCompany, guide = '') {
  let comp = String(shippingCompany || '').toUpperCase();
  if (!comp) {
    const g = String(guide || '').trim();
    comp = POR_PREFIJO.find((p) => p.re.test(g))?.comp || '';
  }
  return RASTREADOR_SIN_GUIA.find((x) => x.test(comp))?.url || '';
}

/* Para el cuerpo de una plantilla: si la transportadora no tiene link
   directo, mandamos a nuestro redirect, que muestra el estado según Dropi. */
function urlTrackingParaCliente(shippingCompany, guide) {
  const g = String(guide || '').trim();
  if (!g) return '';
  return (
    urlTrackingTransportadora(shippingCompany, g) ||
    URL_REDIRECT_TRACKING + encodeURIComponent(g)
  );
}

/* El botón "Rastrear" de las plantillas es .../kanban_plantillas/t/{{1}} y
   espera el número de guía. Si una cuenta configura ese botón con la variable
   `tracking` (el enlace completo), al cliente le llega
   .../t/https://www.servientrega.com.ec/Tracking/?guia=1800131048&tipo=GUIA
   y la ruta respondía 404 (cfg 862, 12-11-2026). Acá se saca la guía de
   cualquiera de nuestros enlaces para que el redirect siga el camino normal.
   Nunca se redirige al enlace recibido: solo se usa para leer la guía. */
function guiaDesdeEnlace(valor) {
  let s = String(valor || '').trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    /* se queda como vino */
  }
  if (!/^https?:/i.test(s)) return s;
  // Dentro de una ruta el navegador deja "https://" como "https:/".
  s = s.replace(/^(https?:)\/+/i, '$1//');
  let u;
  try {
    u = new URL(s);
  } catch {
    return '';
  }
  for (const k of ['guia', 'tracking-id', 'info']) {
    const v = (u.searchParams.get(k) || '').trim();
    if (v) return v;
  }
  // Veloces, TIUI y nuestro propio redirect llevan la guía al final de la ruta.
  return u.pathname.split('/').filter(Boolean).pop() || '';
}

module.exports = {
  guiaDesdeEnlace,
  urlTrackingTransportadora,
  urlRastreadorSinGuia,
  urlTrackingParaCliente,
};
