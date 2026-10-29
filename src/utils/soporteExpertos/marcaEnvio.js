/* El shipping mark que le pide su proveedor (FAQ de Daniel, 27-oct).

   Clientes escriben «mi proveedor me pide el shipping mark» o «cuál es mi
   webmarker» y el bot contestaba con la ficha genérica («la ves en la
   plataforma») o lo pasaba sin decir nada. La marca ya está en la lectura de
   su carga (cargaCliente.js → propias.detalle, solo las cotizaciones de SU
   número), así que se le dice cuál es:

     · marca        una cotización aprobada, todavía sin cargar, con UNA marca
     · varias       más de una marca vigente (un código por proveedor)
     · sin_aprobar  ninguna aprobada y una cotización que aún no lo está
     · sin_marca    nada que darle

   Una carga ya embarcada (carga, próximo, tránsito, entregado) no cuenta: su
   marca no sirve para una compra nueva. Sin lectura de carga (error, el número
   está en cotizaciones de dos clientes, datos de otra persona) no se decide:
   sale lo de siempre. Puro: lo usa proactivo.js. */

'use strict';

const { pideShippingMark } = require('./intencion');

// Aprobada y todavía recibiendo en China: su marca es la que va en las cajas.
const VIGENTES = ['aprobado', 'contactado', 'bodega'];
const CON_LECTURA = ['encontradas', 'sin_carga', 'solo_historicas'];
const MAX_MARCAS = 4;

/**
 * @param {{ mensaje: string, carga: object|null }} p  carga = hechos.carga del turno
 * @returns null | { caso: 'marca', marca, n } | { caso: 'varias', marcas: [{marca, n}] }
 *        | { caso: 'sin_aprobar', n } | { caso: 'sin_marca' }
 */
function shippingMark({ mensaje = '', carga = null } = {}) {
  if (!pideShippingMark(mensaje)) return null;
  if (!carga || !CON_LECTURA.includes(carga.estado)) return null;
  const detalle = (carga.propias && carga.propias.detalle) || [];

  const marcas = [];
  for (const d of detalle) {
    if (!d.aprobada || !VIGENTES.includes(d.estado)) continue;
    for (const m of d.marcas || []) if (!marcas.some((x) => x.marca === m)) marcas.push({ marca: m, n: d.id_cotizacion });
  }
  if (marcas.length === 1) return { caso: 'marca', marca: marcas[0].marca, n: marcas[0].n };
  if (marcas.length > 1) return { caso: 'varias', marcas: marcas.slice(0, MAX_MARCAS) };

  const sinAprobar = detalle.find((d) => !d.aprobada);
  if (sinAprobar) return { caso: 'sin_aprobar', n: sinAprobar.id_cotizacion };
  return { caso: 'sin_marca' };
}

// «EC-1234 (cotización N.º 5678) y EC-1240 (cotización N.º 5679)»
function listaDeMarcas(marcas) {
  const partes = marcas.map((m) => `${m.marca} (cotización N.º ${m.n})`);
  return partes.length > 1 ? `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]}` : partes[0] || '';
}

module.exports = { shippingMark, listaDeMarcas, VIGENTES };
