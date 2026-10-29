/* Qué contesta el bot de Expertos cuando al cliente le parece CARO el precio,
   el flete o la cotización («me sale muy caro», «está caro el flete», «en otro
   lado me cobran menos»). La señal es `objetaPrecio` (senales.js).

   Lo que pasó del 29-sep al 27-oct en la 265 (22 chats con objeción contra
   nuestro precio): de 13 con cotización ya enviada, unas 8 aprobaron o
   pagaron, 3 cambiaron cantidad o producto y 2 se fueron. En 5 o 6 el equipo
   ofreció o aplicó una rebaja sin regla (una de −31 %). Por eso el bot NUNCA
   baja el precio: explica, muestra el espacio y las alternativas, y si insiste
   pasa a la persona que decide (Johan, líder comercial).

   En pasos, dentro de la misma conversación (memoria de 20 min de turno.js):
     1.ª objeción  → desglose (flete por CBM; en México con los impuestos
                     dentro) + espacio o paso de CBM + alternativas.
     2.ª objeción  → pasa al líder comercial con nota «objeción de precio» y
                     el resumen de la cotización (escalado.js).
   Un reclamo con enojo que además objeta el precio pasa directo.

   Se enciende con ia_ajustes → soporte_expertos.objecion_precio (los textos
   de textos.OBJECION los aprobó Daniel el 27-oct: OBJECION_APROBADO = true).
   Puro: no lee ni escribe nada. Ecuador sigue con cotización manual: aquí
   solo se explica, no se calcula su flete. */

'use strict';

const T = require('./textos');
const { fleteMexico, usd, m3 } = require('./cotizacionMexico');

// Fichas que hoy contestan la objeción y pasan a pricing: con el flujo
// encendido no se muestran (el flujo las reemplaza y la guardia no les agrega
// el paso a asesor en la 1.ª objeción).
const FICHAS_OBJECION = Object.freeze(['envio-caro-descuento', 'cotizacion-mas-barata', 'objecion-de-precio']);

// La 2.ª objeción en la conversación ya va al líder comercial.
const OBJECIONES_PARA_PASAR = 2;

/* Bajo 1 CBM en México NO hay mínimo (Daniel, 27-oct): «lo ideal es que
   complete uno, pero si no, prorratéale». El bot sugiere completar 1 CBM y
   aclara que si no, paga solo lo que ocupa. Si algún día se fija un mínimo,
   con ponerlo aquí el bot dice cuánto le queda pagado sin usar. */
const MINIMO_CBM_MX = null;

const entero = (n) => usd(Math.round(n)).replace(/,00$/, '');
const llenar = (plantilla, datos) => String(plantilla).replace(/\{(\w+)\}/g, (_, k) => (datos[k] == null ? `{${k}}` : String(datos[k])));

/**
 * ¿Le queda espacio pagado o le conviene sumar volumen? Escala A de México:
 * de 1 a 4 CBM cada CBM extra cuesta menos (750 / 550 / 200 / 100), así que
 * completar el siguiente CBM entero baja el precio por CBM.
 * Bajo 1 CBM sin mínimo: se le sugiere completar 1 CBM (si no, se prorratea).
 * @returns {null | {tipo:'libre', cbm, minimo, libre} | {tipo:'completar', cbm, libre} | {tipo:'paso', cbm, hasta, flete, fleteHasta, extra}}
 */
function espacioYPaso(cbm, { minimo = MINIMO_CBM_MX } = {}) {
  const c = Number(cbm);
  if (!Number.isFinite(c) || c <= 0) return null;
  if (minimo && c < minimo) return { tipo: 'libre', cbm: c, minimo, libre: Math.round((minimo - c) * 100) / 100 };
  if (c < 1) return { tipo: 'completar', cbm: c, libre: Math.round((1 - c) * 100) / 100 };
  if (c >= 4) return null; // desde 4 CBM, 400 USD por CBM parejo
  const hasta = Math.floor(c) + 1;
  const flete = fleteMexico(c);
  const fleteHasta = fleteMexico(hasta);
  // Solo si de verdad baja el precio por CBM.
  if (!(fleteHasta / hasta < flete / c - 1)) return null;
  return { tipo: 'paso', cbm: c, hasta, flete, fleteHasta, extra: fleteHasta - flete };
}

/** Texto del espacio o del paso (vacío si no hay nada que mostrar). */
function textoEspacio(e) {
  if (!e) return '';
  if (e.tipo === 'libre') return llenar(T.OBJECION.espacio_libre, { cbm: m3(e.cbm), minimo: m3(e.minimo), libre: m3(e.libre) });
  if (e.tipo === 'completar') return llenar(T.OBJECION.completar_uno, { cbm: m3(e.cbm), libre: m3(e.libre) });
  return llenar(T.OBJECION.paso_siguiente, {
    hasta: m3(e.hasta),
    extra: entero(e.extra),
    flete: entero(e.flete),
    flete_hasta: entero(e.fleteHasta),
  });
}

/**
 * La respuesta a la 1.ª objeción.
 * @param {object} p
 *   pais        'mx' | 'ec' | otro (del teléfono)
 *   cotizacion  { cbm, flete, total } de una cotización de México que el bot
 *               armó en esta conversación (turno.anotarCotizacion), o null
 */
function respuestaExplicar({ pais = null, cotizacion = null } = {}) {
  const partes = [];
  const cbm = Number(cotizacion?.cbm);
  const conCifras = pais === 'mx' && Number.isFinite(cbm) && cbm > 0;
  if (conCifras) partes.push(llenar(T.OBJECION.desglose_mx_cifras, { cbm: m3(cbm), flete: entero(fleteMexico(cbm)) }));
  else if (pais === 'mx') partes.push(T.OBJECION.desglose_mx);
  else if (pais === 'ec') partes.push(T.OBJECION.desglose_ec);
  else partes.push(T.OBJECION.desglose_otro);
  if (conCifras) {
    const espacio = textoEspacio(espacioYPaso(cbm));
    if (espacio) partes.push(espacio);
  }
  partes.push(T.OBJECION.alternativas);
  return partes.join('\n\n');
}

/**
 * En qué paso va: 'explicar' (1.ª) o 'pasar' (2.ª, o la 1.ª si viene con
 * enojo). `previas` = objeciones anteriores en esta conversación.
 */
function pasoDeObjecion({ previas = 0, reclamo = false } = {}) {
  if (reclamo) return 'pasar';
  return previas + 1 >= OBJECIONES_PARA_PASAR ? 'pasar' : 'explicar';
}

/** Resumen de la cotización para la nota de Johan (nunca vacío). */
function resumenObjecion({ pais = null, cotizacion = null, veces = 1 } = {}) {
  const donde = pais === 'mx' ? 'México' : pais === 'ec' ? 'Ecuador' : 'país sin identificar';
  const cbm = Number(cotizacion?.cbm);
  const cifras =
    Number.isFinite(cbm) && cbm > 0
      ? `${m3(cbm)} CBM · flete ${usd(cotizacion.flete ?? fleteMexico(cbm))} USD` +
        (cotizacion.total ? ` · total ${usd(cotizacion.total)} USD (borrador del bot)` : '')
      : 'el bot no tiene la cotización a la mano (revísala en el cotizador)';
  return (
    `Objeción de precio (${veces}.ª vez en esta conversación) · ${donde} · ${cifras}. ` +
    'El bot ya le explicó el desglose y las alternativas (cantidad o carga grupal) y NO ofreció descuento. ' +
    'Regla de Daniel: no se rebaja; ofrécele alternativas. Un descuento solo lo autoriza Daniel.'
  );
}

module.exports = {
  FICHAS_OBJECION,
  OBJECIONES_PARA_PASAR,
  MINIMO_CBM_MX,
  espacioYPaso,
  textoEspacio,
  respuestaExplicar,
  pasoDeObjecion,
  resumenObjecion,
};
