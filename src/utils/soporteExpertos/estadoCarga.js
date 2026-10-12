/* En qué paso va la carga de una cotización y qué se le dice al cliente.

   Es la MISMA regla que `Class/EstadoCargaCliente.php` de Imporsuit (portal
   «Mi puesto» → «Buscar carga»), pasada a JavaScript línea por línea para que
   el bot y el asesor le digan lo mismo al mismo cliente. Si esa clase cambia,
   este archivo cambia con ella; `scripts/probar_soporte_expertos.js` compara
   las dos con casos fijos (ver ahí cómo se corre la comparación con el PHP).

   Lógica pura: sin base, sin red, sin reloj propio (`hoy` entra por
   parámetro).

   Regla de oro, igual que allá: NUNCA inventa una fecha. Solo nombra la fecha
   estimada si el contenedor la tiene registrada.

   Dos diferencias con el PHP, las dos opcionales y pensadas para el bot (el
   valor por defecto reproduce el PHP):
     - `conNombre: false`              el saludo va sin el nombre del cliente.
     - `descartarEstimadaVencida: true` una fecha estimada que ya pasó no se
                                        nombra: «llega el 1 de octubre» dicho
                                        el 12 de octubre es peor que no dar
                                        fecha. */

'use strict';

/** Los 7 pasos que ve el cliente, en orden. */
const PASOS = {
  1: 'Cotización registrada',
  2: 'Recibido en China',
  3: 'En contenedor',
  4: 'En tránsito',
  5: 'En aduana',
  6: 'Liberado',
  7: 'En bodega de destino',
};

/** Estado del contenedor (`cotizadorpro_cargas.estado`) → paso. */
const PASO_DE_CONTENEDOR = {
  borrador: 3,
  generado: 3,
  cerrado: 3,
  entransito: 4,
  aduana: 5,
  liberado: 6,
  bodega_destino: 7,
  finalizado: 7,
};

/** Cotizaciones que todavía no son (o ya no son) una carga. */
const SIN_CARGA = ['borrador', 'anulado', 'rechazado'];

/** Estados en los que la cotización todavía no subió entera a un contenedor. */
const ANTES_DE_CARGA = ['generado', 'aprobado', 'contactado', 'bodega'];

/** Días sin moverse tras los que un contenedor «asignado» merece duda. */
const DIAS_SIN_MOVIMIENTO = 30;

const MESES = [
  '', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

const minus = (v) => String(v ?? '').trim().toLowerCase();

/** Hoy en Ecuador (UTC-5, sin horario de verano), como AAAA-MM-DD. */
function hoyEcuador(ahora = new Date()) {
  return new Date(ahora.getTime() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Cualquier fecha de la base → AAAA-MM-DD, o null. Las consultas del bot ya
    piden las fechas como texto; los objetos Date se aceptan por si acaso. */
function fecha(valor) {
  if (valor instanceof Date) {
    return Number.isNaN(valor.getTime()) ? null : hoyEcuador(valor);
  }
  const v = String(valor ?? '').trim();
  if (v === '' || v.startsWith('0000')) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return null;
  const [mes, dia] = [Number(m[2]), Number(m[3])];
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

const aDias = (f) => Date.UTC(+f.slice(0, 4), +f.slice(5, 7) - 1, +f.slice(8, 10)) / 86400000;
/** Días de `desde` a `hasta` (los dos AAAA-MM-DD). */
const diasEntre = (desde, hasta) => Math.round(aDias(hasta) - aDias(desde));

/** «24 de octubre». */
function fechaTexto(f) {
  return `${Number(f.slice(8, 10))} de ${MESES[Number(f.slice(5, 7))]}`;
}

/** «a», «a y b», «a, b y c». */
function lista(items) {
  const xs = (items || []).map((s) => String(s)).filter((s) => s !== '');
  if (xs.length <= 1) return xs[0] || '';
  const ultimo = xs.pop();
  return `${xs.join(', ')} y ${ultimo}`;
}

function cajas(n, antes, despues) {
  return n > 0 ? `${antes}${n}${n === 1 ? ' caja' : ' cajas'}${despues}` : '';
}

function pais(destino) {
  const d = minus(destino);
  if (d === 'ec' || d.startsWith('ecu')) return 'Ecuador';
  if (d === 'mx' || d.startsWith('mex') || d.startsWith('méx')) return 'México';
  return '';
}

/* Hay nombres guardados con códigos HTML («Avi&ntilde;a»). */
const ENTIDADES = {
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ',
  ntilde: 'ñ', Ntilde: 'Ñ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó',
  uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  uuml: 'ü', Uuml: 'Ü',
};
function sinEntidades(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, k) => (k in ENTIDADES ? ENTIDADES[k] : m));
}

function primerNombre(nombre) {
  const primero = sinEntidades(nombre).trim().split(/\s+/)[0] || '';
  if (primero === '' || /\d|@/.test(primero)) return '';
  const p = primero.toLowerCase();
  return p.charAt(0).toUpperCase() + p.slice(1);
}

const pasoDeContenedor = (c) => PASO_DE_CONTENEDOR[minus(c?.estado)] ?? 3;

/** PHP: `!empty($x)`. */
const lleno = (x) => x !== null && x !== undefined && x !== '' && x !== '0' && x !== 0 && x !== false;

/**
 * @param {object} cot  cotización con `estado`, `destino`, `cliente.nombre`,
 *        `marcas[]` (codigo, subestado, cajas, fecha_recibida), `contenedores[]`
 *        (id_contenedor, nombre, estado, destino, fecha_asignada, fecha_cierre,
 *        fecha_estimada, fecha_puerto, fecha_bodega_destino), `parcial`,
 *        `entrega` y `pago` — la forma de `ConsultaCargasModel::buscar`.
 * @param {string} hoy  AAAA-MM-DD (hora de Ecuador)
 * @param {object} abiertoDesde  id_contenedor → fecha desde la que existe
 * @param {object} opciones  { conNombre = true, descartarEstimadaVencida = false }
 */
function estadoDeCarga(cot, hoy = hoyEcuador(), abiertoDesde = {}, opciones = {}) {
  const { conNombre = true, descartarEstimadaVencida = false } = opciones;
  const estado = minus(cot?.estado);
  const avisos = [];

  // ── Recepción en la bodega de China ───────────────────────────────
  const marcas = Array.isArray(cot?.marcas) ? cot.marcas : [];
  const recibidas = [];
  const pendientes = [];
  let nCajas = 0;
  for (const m of marcas) {
    const llego = lleno(m.fecha_recibida) || minus(m.subestado) === 'recibida';
    if (llego) {
      recibidas.push(String(m.codigo));
      nCajas += parseInt(m.cajas ?? 0, 10) || 0;
    } else {
      pendientes.push(String(m.codigo));
    }
  }
  const recepcion = {
    marcas: marcas.length,
    recibidas: recibidas.length,
    pendientes,
    cajas: nCajas,
  };

  // ── Contenedor: el más avanzado manda ─────────────────────────────
  const contenedores = [...(Array.isArray(cot?.contenedores) ? cot.contenedores : [])];
  contenedores.sort((a, b) => {
    const [pa, pb] = [pasoDeContenedor(a), pasoDeContenedor(b)];
    if (pa !== pb) return pb - pa;
    const [fa, fb] = [String(a.fecha_asignada ?? ''), String(b.fecha_asignada ?? '')];
    return fa === fb ? 0 : fb > fa ? 1 : -1;
  });
  const cont = contenedores[0] || null;
  const otros = contenedores.slice(1).map((c) => String(c.nombre));

  // ── Paso ──────────────────────────────────────────────────────────
  let paso;
  if (cont !== null) paso = pasoDeContenedor(cont);
  else if (SIN_CARGA.includes(estado)) paso = 0;
  else paso = recepcion.recibidas > 0 ? 2 : 1;

  // `parcial` del modelo es «tiene contenedor y su estado no es carga», y eso
  // también es cierto para una cotización ya en tránsito o entregada. Acá solo
  // cuenta como parcial mientras siga en un estado previo.
  const parcial = lleno(cot?.parcial) && ANTES_DE_CARGA.includes(estado);

  const entrega = cot?.entrega && typeof cot.entrega === 'object' ? cot.entrega : null;
  const entregada = Boolean(entrega) && (entrega.estado ?? '') === 'entregada';

  // ── Avisos para el asesor (no van al cliente) ─────────────────────
  if (paso === 0) {
    avisos.push(
      estado === 'borrador'
        ? 'La cotización está en borrador: todavía no es una compra. No informes estado de carga; pásalo a Pricing.'
        : `La cotización figura como ${estado}. No informes estado de carga; pásalo a Pricing.`,
    );
  }
  if (paso >= 1 && paso <= 2 && recepcion.marcas === 0) {
    avisos.push('La cotización no tiene marcas de envío registradas. Confírmalo con Pricing antes de informar.');
  }
  if (paso === 2 && recepcion.pendientes.length) {
    avisos.push(
      `Recepción incompleta: falta ${lista(recepcion.pendientes)}. Sugiérele al cliente que confirme el envío con su proveedor.`,
    );
  }
  if (paso >= 3 && parcial) {
    avisos.push('Solo una parte de esta cotización está en contenedor; el resto sigue en la bodega de China.');
  }
  if (otros.length) {
    avisos.push(
      `La cotización está repartida en ${otros.length + 1} contenedores (también ${lista(otros)}). Se muestra el más avanzado.`,
    );
  }
  // Un contenedor que lleva semanas «asignado» sin salir casi nunca está
  // quieto: lo que pasa es que nadie actualizó su estado. Ahí no se ofrece
  // texto, para que el dato viejo no llegue al cliente con cara de oficial.
  let viejo = false;
  if (paso === 3 && cont !== null) {
    const desde =
      fecha(abiertoDesde?.[parseInt(cont.id_contenedor ?? 0, 10) || 0]) ??
      fecha(cont.fecha_cierre) ??
      fecha(cont.fecha_asignada);
    if (desde !== null && desde < hoy && diasEntre(desde, hoy) > DIAS_SIN_MOVIMIENTO) {
      viejo = true;
      avisos.push(
        `Este contenedor figura sin salir desde el ${fechaTexto(desde)}: el estado del sistema puede estar desactualizado. No informes con este dato; pide el estado real a Logística y responde con eso.`,
      );
    }
  }
  let estimada = cont !== null ? fecha(cont.fecha_estimada) : null;
  let estimadaVencida = false;
  if (descartarEstimadaVencida && estimada !== null && estimada < hoy) {
    estimada = null;
    estimadaVencida = true;
  }
  if ([4, 5].includes(paso) && estimada === null) {
    avisos.push(
      'No hay fecha estimada en el sistema. No des una fecha de memoria: si el cliente insiste, abre un caso a Logística.',
    );
  }
  const pago = minus(cot?.pago?.estado);
  if (pago === 'vencida') {
    avisos.push('Tiene un saldo vencido registrado. Pásalo a Cobranza antes de coordinar la entrega.');
  } else if (pago === 'pendiente') {
    avisos.push('Tiene un saldo pendiente registrado. Si pregunta por pagos, va a Cobranza.');
  }

  return {
    paso,
    paso_nombre: PASOS[paso] ?? null,
    contenedor:
      cont === null
        ? null
        : {
            nombre: String(cont.nombre),
            estado: String(cont.estado),
            fecha_estimada: cont.fecha_estimada ?? null,
            fecha_puerto: cont.fecha_puerto ?? null,
            fecha_bodega_destino: cont.fecha_bodega_destino ?? null,
          },
    otros_contenedores: otros,
    recepcion,
    entregada,
    parcial,
    dato_dudoso: viejo,
    // Solo con `descartarEstimadaVencida`: había fecha, pero ya pasó.
    estimada_vencida: estimadaVencida,
    // La fecha estimada que SÍ se puede nombrar (solo se dice en tránsito).
    fecha_estimada_vigente: paso === 4 && !entregada ? estimada : null,
    texto_cliente:
      viejo && !entregada
        ? null
        : redactar(cot, paso, cont, recepcion, recibidas, entregada, estimada, parcial, conNombre),
    avisos,
  };
}

/**
 * El mensaje para el cliente. `null` cuando no hay nada que informar
 * (cotización en borrador o anulada). `estadoDeCarga` tampoco lo ofrece
 * cuando el dato del contenedor es dudoso.
 *
 * Estos textos salen a clientes y son los del portal: cambiarlos es una
 * decisión de gerencia, y se cambian en los dos lados.
 */
function redactar(cot, paso, cont, recepcion, recibidas, entregada, estimada, parcial, conNombre) {
  if (paso === 0) return null;

  const nombre = conNombre ? primerNombre(cot?.cliente?.nombre ?? '') : '';
  const hola = nombre !== '' ? `Hola ${nombre}, ` : 'Hola, ';
  const id = parseInt(cot?.id_cotizacion ?? 0, 10) || 0;
  const todas = (Array.isArray(cot?.marcas) ? cot.marcas : []).map((m) => String(m.codigo));
  const ref = todas.length === 1 ? todas[0] : `de la cotización N.º ${id}`;
  const carga = `${parcial ? 'una parte de tu carga ' : 'tu carga '}${ref}`;
  const p = pais(String(cot?.destino ?? cont?.destino ?? ''));
  const c = cont !== null ? String(cont.nombre) : '';

  if (entregada) {
    const cuando = fecha(cot.entrega.fecha_entrega);
    return `${hola}según nuestro registro ${carga} fue entregada${cuando ? ` el ${fechaTexto(cuando)}` : ''}. Si necesitas algo más, quedo pendiente.`;
  }

  switch (paso) {
    case 1:
      return (
        `${hola}tu cotización N.º ${id} está registrada. Todavía no tenemos registrada la llegada de tu mercadería a nuestra bodega en China.` +
        (todas.length
          ? ` Cuando tu proveedor la entregue rotulada con tu marca de envío (${lista(todas)}), te aviso por este chat.`
          : ' Cuando llegue, te aviso por este chat.')
      );
    case 2:
      if (recepcion.pendientes.length) {
        return (
          `${hola}en nuestra bodega de China ya recibimos ${recepcion.recibidas} de tus ${recepcion.marcas} marcas de envío` +
          `${cajas(recepcion.cajas, ' (', ')')}. Falta por llegar: ${lista(recepcion.pendientes)}` +
          '. Cuando esté completa pasa al siguiente contenedor y te aviso por aquí.'
        );
      }
      return (
        `${hola}ya recibimos tu mercadería en nuestra bodega de China${cajas(recepcion.cajas, ': ', '')}` +
        ` con la marca ${lista(recibidas)}` +
        '. Está a la espera de contenedor; apenas se le asigne uno, te lo confirmo por este chat.'
      );
    case 3:
      return `${hola}${carga} ya está asignada al contenedor ${c}. Te aviso por este chat cuando salga${p ? ` hacia ${p}` : ''}.`;
    case 4:
      return (
        `${hola}el contenedor ${c}, donde viaja ${carga}, ya está en tránsito${p ? ` hacia ${p}` : ''}.` +
        (estimada
          ? ` La fecha estimada de llegada que tenemos registrada es el ${fechaTexto(estimada)}; es una estimación y puede moverse.`
          : ' Todavía no tengo una fecha estimada confirmada; apenas el sistema la muestre, te escribo.')
      );
    case 5:
      return (
        `${hola}${carga} viaja en el contenedor ${c}, que hoy está en aduana.` +
        ' Todavía no tengo una fecha de entrega confirmada; apenas se libere, te escribo por este chat.'
      );
    case 6:
      return (
        `${hola}el contenedor ${c}, donde viaja ${carga}, ya fue liberado de aduana y va camino a nuestra bodega.` +
        ' Cuando esté lista para la entrega, te contactamos para coordinar.'
      );
    default: {
      const llego = fecha(cont?.fecha_bodega_destino);
      return `${hola}${carga} ya está en nuestra bodega${p ? ` de ${p}` : ''}${llego ? ` desde el ${fechaTexto(llego)}` : ''}. El siguiente paso es coordinar la entrega.`;
    }
  }
}

module.exports = {
  PASOS,
  PASO_DE_CONTENEDOR,
  SIN_CARGA,
  ANTES_DE_CARGA,
  DIAS_SIN_MOVIMIENTO,
  estadoDeCarga,
  hoyEcuador,
  fecha,
  fechaTexto,
  diasEntre,
  lista,
  primerNombre,
};
