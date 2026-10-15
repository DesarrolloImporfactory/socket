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
    test: (c) => c.includes('GINTRACOM'),
    url: (g) => `https://ec.gintracom.site/web/site/tracking?guia=${g}`,
  },
  {
    test: (c) => c.includes('VELOCES'),
    url: (g) => `https://tracking.veloces.app/tracking-client/${g}`,
  },
  {
    test: (c) => c.includes('URBANO'),
    url: (g) =>
      `https://app.urbano.com.ec/plugin/etracking/etracking/?guia=${g}`,
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

function urlRastreadorSinGuia(shippingCompany) {
  const comp = String(shippingCompany || '').toUpperCase();
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

module.exports = {
  urlTrackingTransportadora,
  urlRastreadorSinGuia,
  urlTrackingParaCliente,
};
