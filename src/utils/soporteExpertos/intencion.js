/* De qué habla el mensaje, sin inteligencia artificial: lo justo para decidir
   si en este turno se consulta la carga del cliente y si está pidiendo datos
   que no son suyos.

   Equivocarse hacia el «sí» sale barato (una consulta de lectura y un bloque
   más de contexto); equivocarse hacia el «no» deja al bot sin el dato. Por eso
   `hablaDeCarga` es generoso, salvo con lo que es claramente de ecommerce
   («mi pedido de Dropi»), que no es una carga de importación. */

'use strict';

const { sinTildes } = require('./texto');
const { soloDigitos, mismoTelefono, colaCandidatos } = require('./telefono');

const COSA =
  /\b(carga|cargas|mercaderia|mercancia|contenedor|contenedores|importacion|importaciones|embarque|bultos?|cajas|marca de envio|tracking|rastreo)\b/;
const COSA_PROPIA =
  /\bmis? (carga|cargas|mercaderia|mercancia|contenedor|importacion|importaciones|embarque|cajas|bultos)\b/;
const ESTADO =
  /\b(donde (esta|estan|anda|va|se encuentra)|por donde (va|anda|viene)|como va|como van|en que (va|estado|paso|parte|etapa)|que paso con|que ha pasado con|novedad|novedades|ya (llego|llegaron|llegaria|llegarian|llega|salio|sale|zarpo|esta|estan|estaria|arribo)|cuando (llega|llegan|llegaria|llegara|sale|saldra|arriba|me llega|estaria|estara|puedo retirar)|para cuando|fecha de (llegada|entrega|arribo|salida)|estado de (mi|la|el|mis)|seguimiento|rastrear|rastreo|en aduana|aduana|en transito|liberad[oa]|retirar|retiro|ya puedo|sigue en|todavia no llega|aun no llega|no llega|no ha llegado|demorad[oa]|atrasad[oa]|retras)/;
const PEDIDO = /\b(pedido|pedidos|compra|productos?|paquete|paquetes|envio)\b/;
const ECOMMERCE =
  /\b(dropi|shopify|tienda|guia|guias|transportadora|servientrega|laar|gintracom|cliente final|contra entrega|contraentrega|campana|anuncio|landing|novedad de entrega|wallet)\b/;
const MARCA = /\b(?:ec|mx)[- ]?\d{5,9}\b/;

/** ¿El cliente pregunta por el estado de SU carga de importación? */
function hablaDeCarga(texto) {
  const t = sinTildes(texto);
  if (!t.trim()) return false;
  if (MARCA.test(t)) return true;
  if (COSA_PROPIA.test(t)) return true;
  const estado = ESTADO.test(t);
  if (estado && COSA.test(t)) return true;
  if (estado && PEDIDO.test(t) && !ECOMMERCE.test(t)) return true;
  return false;
}

const TERCERO =
  /\b(?:de|del|a nombre de|para|por)\s+(?:mi|un|una|el|la|mis)?\s*(soci[oa]|amig[oa]|espos[oa]|marido|mujer|herman[oa]|prim[oa]|cunad[oa]|jef[ea]|companer[oa]|clientes?|papa|mama|padre|madre|hij[oa]|novi[oa]|pareja|familiar|conocid[oa]|vecin[oa]|ti[oa]|suegr[oa]|otra persona|otro cliente|otro numero|otro usuario|otro alumno|otra cuenta|otro telefono|un tercero|terceros)\b/;
const HABLA_DE_NUMERO = /\b(numero|telefono|celular|cel|whatsapp|wsp)\b/;
// Diez dígitos seguidos también son una cuenta bancaria, una cédula o una referencia.
const NO_ES_TELEFONO = /\b(cuenta|banco|transferencia|transferi|deposito|deposite|comprobante|referencia|cedula|ruc|factura)\b/;
const SOY_DEL_EQUIPO = /\bsoy (asesor|asesora|del equipo|de logistica|de soporte|administrador|admin|el dueno|daniel|supervisor)/;

/**
 * ¿Pide datos de una carga que no es la del número que escribe?
 * @returns {{pide:boolean, motivo:string|null}}
 */
function pideDatosDeOtro(texto, telefonoRemitente) {
  const t = sinTildes(texto);
  const deCarga = COSA.test(t) || PEDIDO.test(t) || /cotizacion|estado|llega|donde/.test(t);
  if (!deCarga) return { pide: false, motivo: null };

  if (TERCERO.test(t)) return { pide: true, motivo: 'la carga de otra persona' };
  if (SOY_DEL_EQUIPO.test(t)) return { pide: true, motivo: 'dice ser del equipo' };

  // Un teléfono escrito en el mensaje que no es el del remitente.
  const escritos = (String(texto).match(/\+?\d[\d\s().-]{7,16}\d/g) || [])
    .map(soloDigitos)
    .filter((d) => d.length >= 9 && d.length <= 13 && colaCandidatos(d));
  const ajeno = escritos.find(
    (d) => !mismoTelefono(telefonoRemitente, d) && soloDigitos(telefonoRemitente).slice(-9) !== d.slice(-9),
  );
  const loSenala = HABLA_DE_NUMERO.test(t) || /\b(del|al|con el|para el)\s+\+?\d/.test(t);
  if (ajeno && loSenala && !NO_ES_TELEFONO.test(t)) {
    return { pide: true, motivo: 'otro número de teléfono' };
  }
  return { pide: false, motivo: null };
}

module.exports = { hablaDeCarga, pideDatosDeOtro };
