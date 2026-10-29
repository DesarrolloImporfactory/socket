/* Cotización de México armada por el bot de Expertos, EN BORRADOR (27-oct).

   Decisión de Daniel (27-oct-2026): México se automatiza; Ecuador sigue a mano
   porque lleva impuestos. El bot junta los datos, este archivo hace la cuenta
   y el resultado va a la NOTA INTERNA del chat: el asesor la revisa y, si está
   bien, se la manda al cliente. El cliente no ve ningún precio hasta entonces
   («Borrador primero»).

   La cuenta es de código, nunca del modelo: el modelo solo copia los datos que
   dio el cliente en el esquema de `armar_cotizacion_mexico`.

   ESCALA DE FLETE (Pricing, 27-oct), todo incluido hasta la bodega de México:
     1 CBM = 750 · 2 = 1.300 · 3 = 1.500 · 4 = 1.600 USD; entre dos puntos se
     interpola; bajo 1 CBM es proporcional a 750; sobre 4 CBM, 1.600 + 400 por
     cada CBM extra («cargas de más de 4 CBM, escala»: variante A).
   En México no se suman arancel, IVA ni FODINFA: van dentro del flete
   (FleteCotizador::mexico de Imporsuit). El flete se reparte entre los
   productos por su CBM, como hace el cotizador.

   Sin red ni base: todo lo que necesita llega por parámetro. */

'use strict';

const PUNTOS = [
  [0, 0],
  [1, 750],
  [2, 1300],
  [3, 1500],
  [4, 1600],
];
const POR_CBM_SOBRE_4 = 400;

const CBM_CARGA_GRANDE = 15; // desde aquí Pricing confirma la tarifa
const VALOR_ALTO_POR_M3 = 3000; // USD de mercadería por m³: más impuesto dentro del flete
const CBM_CAJA_MIN = 0.001;
const CBM_CAJA_MAX = 2;
const LADO_MIN_CM = 2;
const LADO_MAX_CM = 250;
const MAX_PRODUCTOS = 10;

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const r3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s/g, '');
  if (!t) return null;
  // «1.234,5» o «1,234.5» o «12,5»
  const limpio = /,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
};
const usd = (n) => Number(n).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const m3 = (n) => Number(n).toLocaleString('es-EC', { maximumFractionDigits: 3 });
const positivo = (v) => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};

/** Flete todo incluido a México para `cbm` metros cúbicos (escala de Pricing). */
function fleteMexico(cbm) {
  const c = Number(cbm);
  if (!Number.isFinite(c) || c <= 0) return 0;
  if (c >= 4) return r2(1600 + POR_CBM_SOBRE_4 * (c - 4));
  for (let i = 1; i < PUNTOS.length; i++) {
    const [c0, f0] = PUNTOS[i - 1];
    const [c1, f1] = PUNTOS[i];
    if (c <= c1) return r2(f0 + ((f1 - f0) * (c - c0)) / (c1 - c0));
  }
  return 0;
}

const MONEDAS = { USD: 'USD', DOLARES: 'USD', 'DÓLARES': 'USD', RMB: 'RMB', CNY: 'RMB', YUAN: 'RMB', YUANES: 'RMB' };
const moneda = (v) => MONEDAS[String(v || 'USD').trim().toUpperCase()] || null;

/* Volumen de un producto. Vale el CBM total si lo dio; si no, cajas × CBM de la
   caja (dado o sacado de las medidas en centímetros). */
function volumenDe(p, faltan, avisos, nombre) {
  const total = positivo(p.cbm_total);
  if (total) return { cbm: total, cajas: null, como: 'CBM total que dio el cliente' };

  const upc = positivo(p.unidades_por_caja);
  let cbmCaja = positivo(p.cbm_por_caja);
  let como = 'CBM por caja que dio el cliente';
  if (!cbmCaja && p.medidas_caja_cm && typeof p.medidas_caja_cm === 'object') {
    const lados = ['largo', 'ancho', 'alto'].map((k) => positivo(p.medidas_caja_cm[k]));
    if (lados.every(Boolean)) {
      if (lados.some((l) => l < LADO_MIN_CM || l > LADO_MAX_CM)) {
        faltan.push(`${nombre}: medidas de la caja en centímetros (las que dio no cuadran: ${lados.join(' × ')})`);
        return null;
      }
      cbmCaja = (lados[0] * lados[1] * lados[2]) / 1e6;
      como = `medidas de la caja ${lados.map(m3).join(' × ')} cm`;
    }
  }
  if (!cbmCaja) {
    faltan.push(`${nombre}: CBM o medidas de la caja (largo, ancho y alto en cm)`);
    if (!upc) faltan.push(`${nombre}: unidades por caja`);
    return null;
  }
  if (cbmCaja < CBM_CAJA_MIN || cbmCaja > CBM_CAJA_MAX) {
    faltan.push(`${nombre}: CBM de la caja (${r3(cbmCaja)} m³ no cuadra con una caja)`);
    return null;
  }
  if (!upc) {
    faltan.push(`${nombre}: unidades por caja`);
    return null;
  }
  const cant = positivo(p.cantidad);
  const cajas = Math.ceil(cant / upc);
  if (cant % upc) avisos.push(`${nombre}: ${cant} u no llenan cajas de ${upc}; se cuentan ${cajas} cajas (la última incompleta).`);
  return { cbm: cajas * cbmCaja, cajas, como: `${cajas} cajas × ${m3(r3(cbmCaja))} m³ (${como})` };
}

/**
 * Arma la cotización de México o dice qué falta.
 * @param {object} datos  lo que copió el modelo: { pais, productos: [...] }
 * @param {object} o      { tasaYuan } yuanes por dólar (la vigente de Imporsuit)
 * @returns {{ ok: true, ... } | { ok: false, faltan: string[], noEsMexico?: true }}
 */
function armarCotizacionMexico(datos = {}, { tasaYuan = null, paisTelefono = null } = {}) {
  const pais = String(datos.pais || '').trim().toLowerCase();
  if (!/^(mx|mexico|méxico)$/.test(pais)) return { ok: false, noEsMexico: true, faltan: [] };

  const lista = Array.isArray(datos.productos) ? datos.productos.slice(0, MAX_PRODUCTOS + 1) : [];
  if (!lista.length) return { ok: false, faltan: ['qué producto es (nombre o foto con la proforma)'] };
  if (lista.length > MAX_PRODUCTOS) return { ok: false, faltan: [], muchos: true };

  const faltan = [];
  const avisos = [];
  const filas = [];
  lista.forEach((p, i) => {
    const nombre = String(p?.nombre || '').replace(/\s+/g, ' ').trim().slice(0, 80) || `Producto ${i + 1}`;
    if (!String(p?.nombre || '').trim()) faltan.push(`producto ${i + 1}: qué producto es`);
    const cant = positivo(p?.cantidad);
    if (!cant) faltan.push(`${nombre}: cantidad`);
    const precio = positivo(p?.precio_unitario);
    if (!precio) faltan.push(`${nombre}: precio EXW por unidad`);
    const mon = moneda(p?.moneda);
    if (!mon) faltan.push(`${nombre}: si el precio está en dólares o en yuanes`);
    const envio = num(p?.envio_yiwu);
    const envioIncluido = p?.envio_incluido === true;
    if (!envioIncluido && (envio === null || envio < 0)) faltan.push(`${nombre}: cuánto cobra el proveedor por enviar a nuestra bodega de Yiwu (o si ya está incluido)`);
    const vol = cant ? volumenDe(p || {}, faltan, avisos, nombre) : null;
    filas.push({ nombre, cant, precio, mon, envio: envioIncluido ? 0 : envio, envioIncluido, vol });
  });
  if (faltan.length) return { ok: false, faltan };

  const enYuanes = filas.some((f) => f.mon === 'RMB');
  const tasa = positivo(tasaYuan);
  if (enYuanes && !tasa) return { ok: false, faltan: [], sinTasa: true };
  const aUsd = (v, mon) => (mon === 'RMB' ? v / tasa : v);

  const cbmTotal = filas.reduce((s, f) => s + f.vol.cbm, 0);
  const flete = fleteMexico(cbmTotal);
  let mercaderia = 0;
  let envios = 0;
  const productos = filas.map((f) => {
    const precioUsd = aUsd(f.precio, f.mon);
    const envioUsd = aUsd(f.envio, f.mon);
    const fleteProd = cbmTotal > 0 ? (flete * f.vol.cbm) / cbmTotal : 0;
    const subtotal = precioUsd * f.cant;
    mercaderia += subtotal;
    envios += envioUsd;
    const total = subtotal + envioUsd + fleteProd;
    return {
      nombre: f.nombre,
      cantidad: f.cant,
      precio_usd: r2(precioUsd),
      precio_original: f.mon === 'RMB' ? `${r2(f.precio)} RMB` : null,
      envio_yiwu_usd: r2(envioUsd),
      envio_incluido: f.envioIncluido,
      cbm: r3(f.vol.cbm),
      como_cbm: f.vol.como,
      flete: r2(fleteProd),
      total: r2(total),
      por_unidad: r2(total / f.cant),
    };
  });

  if (cbmTotal > CBM_CARGA_GRANDE) avisos.push(`Carga grande (${m3(r2(cbmTotal))} CBM): confirma la tarifa con Pricing antes de enviarla.`);
  const valorM3 = mercaderia / cbmTotal;
  if (valorM3 > VALOR_ALTO_POR_M3) avisos.push(`Mercadería de alto valor (${usd(Math.round(valorM3)).replace(/,00$/, '')} USD por m³): los impuestos van dentro del flete; revisa que la tarifa alcance.`);
  if (enYuanes) avisos.push(`Precios en yuanes pasados a dólares con la tasa de Imporsuit (${m3(tasa)} RMB por USD).`);
  if (cbmTotal < 1) avisos.push(`Menos de 1 CBM: flete proporcional a 750 USD el CBM, sin mínimo (Daniel, 27-oct). Lo ideal es que complete 1 CBM: le quedan ${m3(r3(1 - cbmTotal))} CBM para sumar productos.`);
  if (paisTelefono && paisTelefono !== 'mx') avisos.push(`Ojo: el WhatsApp del cliente es de ${paisTelefono.toUpperCase()}, no de México. Confirma el destino.`);

  return {
    ok: true,
    productos,
    cbm: r3(cbmTotal),
    flete: r2(flete),
    mercaderia: r2(mercaderia),
    envios_yiwu: r2(envios),
    total: r2(mercaderia + envios + flete),
    avisos,
  };
}

/** Texto que el asesor le manda al cliente si aprueba el borrador. */
function textoParaCliente(c) {
  const L = ['Tu cotización a México, todo incluido (flete, impuestos y entrega en nuestra bodega de México):'];
  c.productos.forEach((p) => L.push(`- ${p.nombre}: ${p.cantidad} u → ${usd(p.por_unidad)} USD c/u`));
  L.push(`Volumen: ${m3(c.cbm)} CBM → flete ${usd(c.flete)} USD`);
  L.push(`Total puesto en México: ${usd(c.total)} USD`);
  L.push('Es un valor de referencia: tu asesor la confirma con el volumen que mida la bodega de China.');
  return L.join('\n');
}

/** Nota interna con el borrador: el detalle para revisar y el texto listo para enviar. */
function notaBorrador(c) {
  const L = ['🧮 BORRADOR de cotización a México (lo armó el bot; el cliente todavía NO lo ve).'];
  L.push('Revísalo. Si está bien, copia el texto de abajo y envíaselo. Si algo no cuadra, corrígelo o pide el dato.');
  L.push('');
  c.productos.forEach((p) => {
    L.push(
      `• ${p.nombre}: ${p.cantidad} u × ${usd(p.precio_usd)} USD${p.precio_original ? ` (${p.precio_original})` : ''}` +
        ` + envío a Yiwu ${p.envio_incluido ? 'incluido' : `${usd(p.envio_yiwu_usd)} USD`}` +
        ` · ${m3(p.cbm)} CBM (${p.como_cbm}) · flete ${usd(p.flete)} USD → ${usd(p.total)} USD (${usd(p.por_unidad)} c/u)`,
    );
  });
  L.push(`Mercadería ${usd(c.mercaderia)} + envío a Yiwu ${usd(c.envios_yiwu)} + flete ${usd(c.flete)} (${m3(c.cbm)} CBM, escala de Pricing) = ${usd(c.total)} USD`);
  if (c.avisos.length) {
    L.push('');
    L.push('⚠️ Revisa:');
    c.avisos.forEach((a) => L.push(`- ${a}`));
  }
  L.push('');
  L.push('Texto para el cliente:');
  L.push(textoParaCliente(c));
  return L.join('\n');
}

module.exports = {
  fleteMexico,
  armarCotizacionMexico,
  textoParaCliente,
  notaBorrador,
  usd,
  m3,
  CBM_CARGA_GRANDE,
};
