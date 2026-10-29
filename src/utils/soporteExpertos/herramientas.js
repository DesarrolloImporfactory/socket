/**
 * Herramientas del bot de soporte de Expertos (tramo 1): consultar la carga
 * del cliente y pasar el caso a una persona.
 *
 * El número del cliente y su mensaje llegan por cierre desde el motor, nunca
 * por lo que pida el modelo: los esquemas no tienen ningún campo de
 * identidad, así que «dame la carga del 0991234567» no puede consultar ese
 * número. Fuera de WhatsApp (chat de prueba del panel, Instagram, Messenger)
 * el número no es verificable y no se consulta nada, igual que en
 * `prepararTurno`. Si la cuenta tiene la carga apagada (`cargas: false`),
 * `ver_mi_carga` no se ofrece. Con `diagnostico: true` se ofrece además
 * `revisar_mi_imporchat`, que revisa la cuenta de IMPORCHAT de ese mismo
 * número (diagnosticoCuenta.js). Es la única con un dato: si ese número no
 * tiene cuenta, el alumno puede escribir el número o el correo con que se
 * registró, y solo vale si está en su mensaje de este turno. Con `pagos: true`
 * se ofrece `ver_mis_pagos`: cuotas, saldo, pagos registrados y facturas del
 * alumno de ese mismo número (pagosCliente.js), solo lectura. Con
 * `agenda: true`, `ver_mi_reunion`: su próxima reunión del calendario de la
 * cuenta y su sesión de implementación (reunionCliente.js), solo lectura; el
 * bot no agenda.
 */
const {
  cargasDelTelefono,
  cargasDelDueno,
  bloqueCarga,
  codigosEnMensaje,
  textoParaCliente,
  consultarImporsuit,
} = require('./cargaCliente');
const T = require('./textos');
const { hablaDeCarga, hablaDeImporchat } = require('./intencion');
const { diagnosticarCuenta } = require('./diagnosticoCuenta');
const {
  pagosDelTelefono,
  pagosDelDueno,
  bloquePagos,
  textoPagosParaCliente,
  variantesDeMontos,
  pidePagos,
} = require('./pagosCliente');
const { duenoPorDato, duenoRecordado, bloqueSinDueno } = require('./identidadPorDato');
const { novedadDelCaso, bloqueNovedad, pideNovedad } = require('./novedadCaso');
const {
  reunionesDelTelefono,
  bloqueReunion,
  variantesDeReuniones,
  textoReunionParaCliente,
  pideReunion,
} = require('./reunionCliente');
const { armarCotizacionMexico, notaBorrador, usd, m3 } = require('./cotizacionMexico');
const { paisDelTelefono } = require('./telefono');
const { pedidosDropi, bloquePedidosDropi } = require('./pedidosDropi');
const { membresiaDelAlumno, bloqueMembresia } = require('./membresiaAlumno');
const { buscarProveedores, bloqueProveedores } = require('./proveedoresYiwu');

/* Dato que el cliente escribió para buscar su carga o sus pagos cuando con
   su número no hay nada (tramo 4, identidadPorDato.js): número de
   cotización, marca de envío o correo. Solo se muestra lo de esa cuenta si
   se prueba que es suya; si no, no se dice ni si el dato existe. */
const DATO_DUENO = {
  type: 'string',
  description:
    'Solo si con su número no se encontró nada: el número de cotización (ej. 1867), la marca de envío (ej. MX-002026) o el correo con el que se registró, copiado tal cual de lo que escribió el cliente. Si no lo escribió, no lo pongas.',
};

const NO_VERIFICABLE_PEDIDOS =
  'No se pueden consultar los pedidos por este canal. Pide el número de guía y pasa el caso a una persona.';

const NO_VERIFICABLE =
  'No se puede consultar la carga por este canal. Pide la marca o el número de cotización y pasa el caso a logística.';

function crearHerramientas({
  telefono,
  mensaje = '',
  canalVerificable = false,
  cargas = true,
  diagnostico = false,
  pagos = false,
  agenda = false,
  cotizacionMx = false,
  novedad = false,
  proveedores = false,
  dropi = false,
  membresia = false,
  idConfiguracionPropia = null,
  idCliente = null,
  deps = {},
} = {}) {
  let ultimaCarga = null;
  let ultimoDiagnostico = null;
  let ultimosPagos = null;
  let ultimasReuniones = null;
  let ultimoPase = null; // motivo de pasar_a_humano (lo usa el escalado por área)
  let ultimoResumen = null; // datos que juntó el bot para el área de precios (van en la nota interna)
  let ultimoBorrador = null; // cotización de México en borrador (va en su propia nota interna)
  let ultimaCotizacion = null; // { cbm, flete, total } de esa cotización, para una objeción de precio
  let ultimaIdentidad = null; // resultado de buscar con el dato que escribió (identidadPorDato.js)
  let ultimaNovedad = null;
  let ultimosProveedores = null; // proveedores de Yiwu que encontró (sus tarjetas salen como foto)
  let ultimosPedidosDropi = null;
  let ultimaMembresia = null;

  /* Con su número no hay nada: se busca con el dato que escribió (o el dueño
     ya probado en esta conversación). Devuelve { idUsuario } si se probó que
     la cuenta es suya, { bloque } con lo que hay que responder si no, o null
     si no escribió ningún dato (se queda lo del teléfono). */
  const buscarDueno = async (input, area) => {
    const r = await duenoPorDato(telefono, {
      dato: typeof input?.dato === 'string' ? input.dato : '',
      mensaje: String(mensaje || ''),
      consultar: deps.consultar,
      ahora: deps.ahora,
    });
    if (r.estado === 'sin_dato') return null;
    ultimaIdentidad = { ...r, area };
    if (r.estado === 'verificado') return { idUsuario: r.idUsuario };
    return { bloque: bloqueSinDueno(r, { area, TX: T }) };
  };

  const verMiCarga = {
    definicion: {
      name: 'ver_mi_carga',
      description:
        'Lee del sistema de cargas el estado de la carga de ESTE cliente. Primero úsala SIN dato: busca por el número de WhatsApp desde el que escribe. ' +
        'Úsala cuando pregunte por su carga, su contenedor, su importación, cuándo llega o en qué va, o en qué va SU cotización (si ya está aprobada, si su mercadería ya llegó a la bodega de China), y no tengas ya el bloque 📦 con su carga. ' +
        'Úsala ANTES de pasar a una persona cualquier pregunta de «en qué va lo mío». ' +
        'Si con su número no encuentra nada y el cliente escribe su número de cotización, su marca de envío o su correo, vuelve a usarla con ese dato tal cual: solo muestra la carga si se confirma que es suya. ' +
        'Nunca pongas un dato que el cliente no escribió, ni el número de teléfono de otra persona. ' +
        'Si dice que no hay carga, que pide otro dato o que el número está en varios clientes, no inventes: sigue lo que diga el resultado.',
      input_schema: { type: 'object', properties: { dato: DATO_DUENO }, additionalProperties: false },
    },
    ejecutar: async (input = {}) => {
      if (!canalVerificable) return NO_VERIFICABLE;
      const opcionesBloque = {
        codigos: codigosEnMensaje(String(mensaje || '')),
        mensajeAsesor: T.MENSAJE_ASESOR,
        mensajeSinCargaPideDato: T.MENSAJE_SIN_CARGA_PIDE_DATO,
        mensajeSinCargaEnCuenta: T.MENSAJE_SIN_CARGA_EN_CUENTA,
      };
      let r = await cargasDelTelefono(telefono, { consultar: deps.consultar, hoy: deps.hoy });
      if (r.estado === 'sin_carga' || r.estado === 'solo_historicas') {
        const d = await buscarDueno(input, 'logística');
        if (d?.bloque) {
          ultimaCarga = null;
          return d.bloque;
        }
        if (d?.idUsuario) r = await cargasDelDueno(d.idUsuario, { consultar: deps.consultar, hoy: deps.hoy });
      }
      ultimaCarga = r;
      return bloqueCarga(r, opcionesBloque);
    },
  };

  const revisarMiImporchat = {
    definicion: {
      name: 'revisar_mi_imporchat',
      description:
        'Revisa la cuenta de IMPORCHAT de ESTE cliente y dice qué está fallando y qué tutorial lo resuelve: WhatsApp desconectado, bot apagado, llave de OpenAI sin saldo o inválida, plan suspendido, columnas sin IA. ' +
        'Úsala cuando diga que su IMPORCHAT, su bot o su asistente no responde, no funciona, se desconectó o da error. Primero úsala SIN dato: busca por el número desde el que escribe. ' +
        'Si responde que no encontró la cuenta y pide el número o el correo con que se registró, transmite eso; cuando el cliente lo escriba, vuelve a usarla con ese dato tal cual lo escribió. ' +
        'Nunca pongas un dato que el cliente no escribió en su último mensaje. Responde con lo que devuelve, con sus enlaces, sin agregar fallas que no estén ahí. ' +
        'Si dice que su cuenta está suspendida y el cliente pregunta cuánto debe o cómo pagar, usa ver_mis_pagos.',
      input_schema: {
        type: 'object',
        properties: {
          dato: {
            type: 'string',
            description: 'Solo si la revisión anterior no encontró su cuenta: el número de WhatsApp o el correo con el que el cliente dice que se registró, copiado de su último mensaje. Si no, no lo pongas.',
          },
        },
        additionalProperties: false,
      },
    },
    ejecutar: async (input = {}) => {
      if (!canalVerificable) return T.DIAGNOSTICO_FRASES.no_verificable;
      // Base de IMPORCHAT: clave aparte de deps.consultar, que es la de Imporsuit (ver_mi_carga).
      // Imporsuit sirve para hallar su cuenta si se registró con otro número.
      const r = await diagnosticarCuenta(telefono, {
        consultar: deps.consultarImporchat,
        consultarImporsuit: deps.consultar,
        verificarAcceso: deps.verificarAcceso,
        ahora: deps.ahora,
        estadosReconectar: deps.estadosReconectar,
        ajustesIA: deps.ajustesIA,
        propia: idConfiguracionPropia,
        dato: typeof input?.dato === 'string' ? input.dato : '',
        mensaje,
        // Cuenta suspendida por un cobro que rebotó: se suma su saldo de la
        // cartera (lo mismo que leería ver_mis_pagos), sin pedirle nada.
        ...(pagos ? { saldoPendiente } : {}),
      });
      ultimoDiagnostico = r;
      return r.texto;
    },
  };

  /* Saldo pendiente de la cartera, en una frase, para el diagnóstico de una
     cuenta suspendida. Por su número o por el dueño ya probado en esta
     conversación; null si no tiene cuotas pendientes o no se encontró. */
  const saldoPendiente = async () => {
    let r = await pagosDelTelefono(telefono, { consultar: deps.consultar });
    if (r.estado === 'sin_cartera') {
      const dueno = duenoRecordado(String(telefono), Number(deps.ahora) || Date.now());
      if (dueno) r = await pagosDelDueno(dueno, { consultar: deps.consultar });
    }
    if (r.estado !== 'encontrado' || !r.pendientes.length) return null;
    ultimosPagos = r;
    const t = textoPagosParaCliente(r);
    if (!t) return null;
    const sinSaludo = t.replace(/^Hola,\s*/, '');
    return sinSaludo.charAt(0).toLowerCase() + sinSaludo.slice(1);
  };

  const verMisPagos = {
    definicion: {
      name: 'ver_mis_pagos',
      description:
        'Lee de la cartera las cuotas, el saldo pendiente, los pagos registrados y las facturas (número y PDF) de ESTE cliente. Primero úsala SIN dato: busca por el número de WhatsApp desde el que escribe. ' +
        'Úsala cuando pregunte cuánto debe, su saldo, su próxima cuota o fecha de pago, si se registró un pago, o pida su factura. ' +
        'Si con su número no encuentra nada y el cliente escribe su número de cotización, su marca de envío o su correo, vuelve a usarla con ese dato tal cual: solo muestra los pagos si se confirma que la cuenta es suya. ' +
        'Nunca pongas un dato que el cliente no escribió, ni el número de teléfono de otra persona. ' +
        'Responde solo con lo que devuelve, con los montos escritos tal cual. Un comprobante que acaba de mandar no lo confirmas: lo registra cobranza.',
      input_schema: { type: 'object', properties: { dato: DATO_DUENO }, additionalProperties: false },
    },
    ejecutar: async (input = {}) => {
      if (!canalVerificable)
        return 'No se pueden consultar pagos por este canal. No digas montos: pasa el caso a cobranza con pasar_a_humano (motivo pago).';
      let r = await pagosDelTelefono(telefono, { consultar: deps.consultar });
      if (r.estado === 'sin_cartera') {
        const d = await buscarDueno(input, 'cobranza');
        if (d?.bloque) {
          ultimosPagos = null;
          return d.bloque;
        }
        if (d?.idUsuario) r = await pagosDelDueno(d.idUsuario, { consultar: deps.consultar });
      }
      ultimosPagos = r;
      return bloquePagos(r, { pideDato: true });
    },
  };

  const verMiReunion = {
    definicion: {
      name: 'ver_mi_reunion',
      description:
        'Lee la próxima reunión que el asesor le agendó a ESTE cliente (día, hora y enlace del Meet) y el estado de su sesión de implementación (si está habilitada, cuántas clases le faltan, su cita y el enlace para agendarla), buscando solo por el número de WhatsApp desde el que escribe. ' +
        'Úsala cuando pregunte cuándo es su reunión o llamada, a qué hora, el enlace, o cómo agendar su implementación o mentoría. ' +
        'No recibe datos ni agenda nada: nunca propongas ni cambies un día u hora.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    ejecutar: async () => {
      if (!canalVerificable)
        return 'No se pueden consultar reuniones por este canal. No digas días, horas ni enlaces: pasa el caso con pasar_a_humano (motivo otro).';
      const r = await reunionesDelTelefono(telefono, {
        cuenta: idConfiguracionPropia,
        consultarImporchat: deps.consultarImporchat,
        consultarImporsuit: deps.consultar,
        ahora: deps.ahora,
      });
      ultimasReuniones = r;
      return bloqueReunion(r);
    },
  };

  /* «¿Hay novedad de mi caso?»: lee las notas del equipo y el último mensaje
     que una persona le escribió en ESTE chat (novedadCaso.js). El chat llega
     por cierre desde el motor; el modelo no elige de quién leer. */
  const verNovedadDeMiCaso = {
    definicion: {
      name: 'ver_novedad_de_mi_caso',
      description:
        'Lee lo último que pasó con el caso de ESTE cliente: el estado del caso, las notas del equipo y el último mensaje que una persona del equipo le escribió en este chat. ' +
        'Úsala cuando pregunte si hay novedad, noticias o respuesta de su caso, su reclamo o su solicitud (también la de un reembolso o una baja que ya pidió), o si ya lo revisaron, ANTES de pasarlo a una persona. ' +
        'No recibe datos. Resume solo lo que devuelve, sin nombres del equipo, sin copiar notas internas y sin inventar avances, fechas ni montos.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    ejecutar: async () => {
      const r = await novedadDelCaso({
        idCliente,
        idConfiguracion: idConfiguracionPropia,
        consultar: deps.consultarImporchat,
      });
      ultimaNovedad = r;
      return bloqueNovedad(r);
    },
  };

  const pasarAHumano = {
    definicion: {
      name: 'pasar_a_humano',
      description:
        'Pasa el caso a una persona del equipo. Úsala SOLO cuando ya revisaste con tus otras herramientas y tu información y de verdad hace falta alguien: ' +
        'un pago que hay que verificar, un reclamo o reembolso, una llamada, o algo que no encuentras en ningún lado. ' +
        'Una cotización nueva va SOLO cuando ya juntaste los datos (país, producto, cantidad, precio EXW más envío a Yiwu, unidades por caja, CBM o medidas de la caja): ' +
        'entonces motivo «cotizacion» y en «resumen» esos datos en una línea, tal cual los dio el cliente. Mientras falte alguno, no la uses: pídeselo. ' +
        'Te devuelve el texto exacto que tienes que responder; no agregues nada más.',
      input_schema: {
        type: 'object',
        properties: {
          motivo: { type: 'string', enum: ['pago', 'reclamo', 'cotizacion', 'otro'] },
          resumen: {
            type: 'string',
            description:
              'Solo en una cotización nueva con los datos completos: país; producto; cantidad; precio EXW más envío a Yiwu; unidades por caja; CBM o medidas; peso si lo dio. Tal cual los escribió el cliente.',
          },
        },
        required: ['motivo'],
        additionalProperties: false,
      },
    },
    ejecutar: async (input = {}) => {
      ultimoPase = ['pago', 'reclamo', 'cotizacion', 'otro'].includes(input.motivo) ? input.motivo : 'otro';
      const resumen = typeof input.resumen === 'string' ? input.resumen.replace(/\s+/g, ' ').trim().slice(0, 600) : '';
      ultimoResumen = resumen || null;
      if (ultimoPase === 'cotizacion' && resumen) return `Responde exactamente: ${T.MENSAJE_COTIZACION_LISTA}`;
      return `Responde exactamente: ${input.motivo === 'reclamo' ? T.MENSAJE_RECLAMO : T.MENSAJE_ASESOR}`;
    },
  };

  /* Cotización de México en borrador (cotizacionMexico.js): el modelo copia
     los datos, el código hace la cuenta y el resultado va a una nota interna
     para que el asesor lo revise. Al cliente no le llega ningún precio. */
  const armarCotizacionMx = {
    definicion: {
      name: 'armar_cotizacion_mexico',
      description:
        'Solo para una cotización NUEVA con destino MÉXICO. Copia aquí los datos que dio el cliente de cada producto, tal cual, aunque falten algunos: ' +
        'te dice qué falta pedirle o, si está todo, deja la cotización en borrador para su asesor y te devuelve el texto exacto que tienes que responder. ' +
        'Nunca le digas al cliente un precio, flete o total: su asesor revisa el borrador y se lo manda. ' +
        'Para Ecuador u otro país no la uses: junta los datos y usa pasar_a_humano (motivo cotizacion) como siempre.',
      input_schema: {
        type: 'object',
        properties: {
          pais: { type: 'string', description: 'País de destino que dijo el cliente (México = mx).' },
          productos: {
            type: 'array',
            description: 'Un elemento por producto. No inventes ni calcules nada: deja vacío lo que no dio.',
            items: {
              type: 'object',
              properties: {
                nombre: { type: 'string' },
                cantidad: { type: 'number', description: 'Unidades que quiere importar.' },
                precio_unitario: { type: 'number', description: 'Precio EXW de UNA unidad, como lo dio el proveedor.' },
                moneda: { type: 'string', enum: ['USD', 'RMB'], description: 'USD si son dólares; RMB si son yuanes (¥, CNY, RMB).' },
                envio_yiwu: { type: 'number', description: 'Lo que cobra el proveedor por llevar TODO el pedido a la bodega de Yiwu, en la misma moneda.' },
                envio_incluido: { type: 'boolean', description: 'true si el cliente dijo que el envío a Yiwu ya está incluido en el precio.' },
                unidades_por_caja: { type: 'number' },
                cbm_por_caja: { type: 'number', description: 'CBM (m³) de UNA caja, si lo dio.' },
                medidas_caja_cm: {
                  type: 'object',
                  description: 'Medidas de UNA caja en centímetros, si las dio.',
                  properties: { largo: { type: 'number' }, ancho: { type: 'number' }, alto: { type: 'number' } },
                  additionalProperties: false,
                },
                cbm_total: { type: 'number', description: 'CBM de todo el pedido de este producto, solo si el cliente lo dio así.' },
              },
              additionalProperties: false,
            },
          },
        },
        required: ['pais', 'productos'],
        additionalProperties: false,
      },
    },
    ejecutar: async (input = {}) => {
      const productos = Array.isArray(input.productos) ? input.productos : [];
      let tasaYuan = null;
      if (productos.some((p) => /^(rmb|cny|yuan)/i.test(String(p?.moneda || '')))) {
        try {
          const filas = await (deps.consultar || consultarImporsuit)(
            "SELECT valor FROM cotizadorpro_parametros WHERE clave = 'tasa_yuan_usd' LIMIT 1",
          );
          tasaYuan = Number(filas?.[0]?.valor) || null;
        } catch {
          tasaYuan = null;
        }
      }
      const c = armarCotizacionMexico(input, { tasaYuan, paisTelefono: canalVerificable ? paisDelTelefono(telefono) : null });
      if (c.noEsMexico)
        return 'Esta herramienta es solo para México. Para otro país junta los datos y usa pasar_a_humano (motivo cotizacion) con el resumen.';
      if (!c.ok && c.faltan.length)
        return (
          `Todavía faltan estos datos: ${c.faltan.join('; ')}. ` +
          'Pídeselos al cliente, uno o dos por mensaje, sin repetir lo que ya dio. No pases el caso todavía y no le des ningún precio.'
        );
      ultimoPase = 'cotizacion';
      if (!c.ok) {
        // Más de 10 productos o precios en yuanes sin tasa: la arma el área de precios a mano.
        ultimoResumen = `México · ${productos.length} producto(s) · ${c.muchos ? 'más de 10 productos' : 'precios en yuanes y no se pudo leer la tasa'}: la arma el área de precios.`;
        return `Responde exactamente: ${T.MENSAJE_COTIZACION_LISTA}`;
      }
      ultimoBorrador = notaBorrador(c);
      // Para una objeción de precio en esta conversación (turno.anotarCotizacion).
      ultimaCotizacion = { cbm: c.cbm, flete: c.flete, total: c.total };
      ultimoResumen = `México · ${c.productos.length} producto(s) · ${m3(c.cbm)} CBM · borrador de ${usd(c.total)} USD en la nota de abajo.`;
      return `Responde exactamente: ${T.MENSAJE_COTIZACION_LISTA}`;
    },
  };

  /* Proveedores de Yiwu con tarjeta (proveedoresYiwu.js): el modelo solo
     copia el producto; la búsqueda y el texto salen de la base. */
  const buscarProveedor = {
    definicion: {
      name: 'buscar_proveedor',
      description:
        'Busca en el Directorio de Proveedores de Yiwu (China) hasta 3 proveedores del producto que el cliente quiere importar, con su contacto y su tarjeta. ' +
        'Úsala cuando pida un proveedor, un contacto o una fábrica para un producto, o diga que todavía no tiene proveedor y ya dijo qué producto. ' +
        'Te devuelve el texto exacto que tienes que responder: no agregues proveedores, nombres, teléfonos ni enlaces que no vengan ahí. ' +
        'Las tarjetas se mandan solas como foto: no escribas sus enlaces.',
      input_schema: {
        type: 'object',
        properties: {
          producto: {
            type: 'string',
            description: 'El producto tal cual lo escribió el cliente (ej. «mochilas para niños», «paraguas»). Sin marca ni cantidad.',
          },
        },
        required: ['producto'],
        additionalProperties: false,
      },
    },
    ejecutar: async (input = {}) => {
      const r = await buscarProveedores(typeof input.producto === 'string' ? input.producto : '', {
        consultar: deps.consultar,
        telefono,
        membresias: deps.membresias,
      });
      ultimosProveedores = r;
      return bloqueProveedores(r);
    },
  };

  /* Pedidos de Dropi de la tienda del alumno (pedidosDropi.js): lee el caché
     de IMPORCHAT de SU cuenta, nunca Dropi en vivo. El modelo solo copia lo que
     el cliente escribió para buscar; de quién leer lo decide el código. */
  const verMisPedidosDropi = {
    definicion: {
      name: 'ver_mis_pedidos_dropi',
      description:
        'Lee los pedidos de Dropi de la tienda de ESTE cliente (la que tiene conectada a su IMPORCHAT): cuántos hay por estado en los últimos 30 días, los que tienen novedad o llevan más tiempo, con su guía, su último movimiento y el enlace de rastreo. ' +
        'Úsala cuando pregunte por los pedidos, las guías o los envíos de SU tienda o de SUS clientes (un pedido que no se entrega, una guía que no se mueve, una novedad, si ya está en la agencia), ANTES de pasarlo a una persona. ' +
        'No es para su carga de importación desde China: eso es ver_mi_carga. ' +
        'Si escribió un número de guía, de pedido, el teléfono o el nombre de su cliente, ponlo en «buscar» tal cual. ' +
        'Si con su número no se encuentra la cuenta y el cliente escribe el número o el correo con que se registró en IMPORCHAT, vuelve a usarla con ese dato. ' +
        'Responde solo con lo que devuelve: no inventes estados, fechas ni entregas.',
      input_schema: {
        type: 'object',
        properties: {
          buscar: {
            type: 'string',
            description: 'Solo si lo escribió: el número de guía, el número de pedido de Dropi, el teléfono o el nombre de su cliente, tal cual.',
          },
          dato: {
            type: 'string',
            description: 'Solo si con su número no se encontró la cuenta: el número o el correo con que se registró en IMPORCHAT, tal cual lo escribió.',
          },
        },
        additionalProperties: false,
      },
    },
    ejecutar: async (input = {}) => {
      if (!canalVerificable) return NO_VERIFICABLE_PEDIDOS;
      const r = await pedidosDropi(telefono, {
        dato: typeof input.dato === 'string' ? input.dato : '',
        buscar: typeof input.buscar === 'string' ? input.buscar : '',
        mensaje: String(mensaje || ''),
        propia: idConfiguracionPropia,
        consultar: deps.consultarImporchat,
        consultarImporsuit: deps.consultar,
        ahora: deps.ahora,
      });
      ultimosPedidosDropi = r;
      return bloquePedidosDropi(r);
    },
  };

  /* Membresía de Imporsuit (membresiaAlumno.js): solo la del número que
     escribe; no recibe ningún dato del modelo, así nadie consulta la de otro. */
  const verMiMembresia = {
    definicion: {
      name: 'ver_mi_membresia',
      description:
        'Lee la membresía de la plataforma (Imporsuit) del número que escribe: si está activa o vencida, desde cuándo, hasta cuándo y qué incluye. ' +
        'Úsala cuando pregunte hasta cuándo tiene acceso, si su membresía o suscripción sigue activa, o cuando diga que no puede entrar a la plataforma, ANTES de pasarlo a una persona. ' +
        'Solo consulta la del número desde el que escribe. Responde solo con lo que devuelve: no inventes fechas, precios ni descuentos.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    ejecutar: async () => {
      if (!canalVerificable) return T.MEMBRESIA.error;
      const r = await membresiaDelAlumno(telefono, {
        resolver: deps.membresias,
        porCorreo: deps.membresiaPorCorreo,
        correoDelDueno: deps.correoDelDueno,
        propia: idConfiguracionPropia,
        consultarImporchat: deps.consultarImporchat,
      });
      ultimaMembresia = r;
      return bloqueMembresia(r);
    },
  };

  return {
    lista: [
      ...(cargas ? [verMiCarga] : []),
      ...(diagnostico ? [revisarMiImporchat] : []),
      ...(pagos ? [verMisPagos] : []),
      ...(agenda ? [verMiReunion] : []),
      ...(cotizacionMx ? [armarCotizacionMx] : []),
      ...(novedad && idCliente ? [verNovedadDeMiCaso] : []),
      ...(proveedores ? [buscarProveedor] : []),
      ...(dropi ? [verMisPedidosDropi] : []),
      ...(membresia ? [verMiMembresia] : []),
      pasarAHumano,
    ],
    cargaConsultada: () => ultimaCarga,
    diagnosticoConsultado: () => ultimoDiagnostico,
    pagosConsultados: () => ultimosPagos,
    reunionesConsultadas: () => ultimasReuniones,
    paseConsultado: () => ultimoPase,
    resumenPase: () => ultimoResumen,
    borradorCotizacion: () => ultimoBorrador,
    cotizacionArmada: () => ultimaCotizacion,
    identidadConsultada: () => ultimaIdentidad,
    novedadConsultada: () => ultimaNovedad,
    proveedoresConsultados: () => ultimosProveedores,
    pedidosDropiConsultados: () => ultimosPedidosDropi,
    membresiaConsultada: () => ultimaMembresia,
  };
}

/**
 * Suma a los hechos del turno lo que trajeron las herramientas, antes de la
 * guardia. Fechas y cifras se comparan contra `firme`. Las frases de estado
 * («en tránsito», «en aduana») contra `estado`: si la herramienta trajo la
 * carga, de su estado solo habla lo que trajo (igual que en `prepararTurno`),
 * para que una ficha que explica los pasos no respalde «la tuya está en aduana».
 *
 * Si la guardia rechaza y el texto seguro era «un asesor te escribe», pasa a
 * ser el estado real de la carga, pero solo si el cliente o la respuesta del
 * modelo hablaban de la carga (una pregunta de cobranza sigue yendo al asesor).
 *
 * Lo mismo con el diagnóstico de IMPORCHAT: si la cuenta se revisó y se
 * encontró algo concreto, el texto seguro es ese diagnóstico (sale del
 * catálogo fijo y ya trae sus enlaces) en vez de «un asesor te escribe». Con
 * `sin_causa` o un error se queda el asesor.
 *
 * Con los pagos: cada monto leído entra al respaldo también en las formas en
 * que lo puede escribir el modelo («$1.250», «1250 USD»). Si la guardia
 * rechaza y el cliente preguntaba su saldo o su factura (no «ya pagué»), el
 * texto seguro es el armado en código con la cartera. Igual con las
 * reuniones: el día y la hora entran al respaldo en sus formas («mañana a las
 * 10 am»), y si la guardia rechaza y preguntaba por su reunión o su sesión de
 * implementación, el texto seguro es el armado en código.
 * Lo usan el motor (paso 9.5), el simulador y las pruebas.
 */
/* ¿Pregunta por los pedidos o guías de SU tienda (no por su carga de China)? */
const RE_PEDIDOS_DROPI = /\b(dropi|pedidos?|[oó]rden(es)?|gu[ií]as?|transportadora|servientrega|gintracom|laar|veloces|urbano|courier|retir[oa]r? en (la )?agencia|mis clientes?|mi client[ae])\b/i;
const hablaDePedidosDropi = (t) => RE_PEDIDOS_DROPI.test(String(t || ''));
/* ¿Pregunta por su acceso o su membresía? (sin tildes: se normaliza antes) */
const RE_MEMBRESIA = /\b(membresia|suscripcion|hasta cuando|vence|vencio|caduca|acceso|no puedo (entrar|ingresar)|plataforma)\b/;
const hablaDeMembresia = (t) =>
  RE_MEMBRESIA.test(
    String(t || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, ''),
  );

function sumarHechosHerramientas(
  hechos,
  extraHerramientas = [],
  cargaConsultada = null,
  { mensaje = '', respuesta = '', diagnostico = null, pagos = null, reuniones = null, identidad = null, novedad = null, pedidosDropi: dropi = null, membresia = null } = {},
) {
  if (!extraHerramientas.length || !hechos?.respaldo) return hechos;
  const r = hechos.respaldo;
  const extra = extraHerramientas.join('\n');
  r.firme = `${String(r.firme || '')}\n${extra}`;
  if (pagos?.estado === 'encontrado') r.firme += `\n${variantesDeMontos(pagos)}`;
  if (reuniones?.estado === 'leido') r.firme += `\n${variantesDeReuniones(reuniones)}`;
  r.estado = cargaConsultada && !hechos.carga
    ? `${Object.values(T.TEXTOS_FIJOS).join('\n')}\n${extra}`
    : `${String(r.estado || '')}\n${extra}`;
  /* El estado de la carga como texto seguro solo si lo pidió el CLIENTE (que
     el modelo la nombre no alcanza) y nunca si se le dijo hace poco (E2,
     Daniel 27-oct). */
  const deCarga = hablaDeCarga(String(mensaje || ''));
  if (cargaConsultada && deCarga && !hechos.cargaDichaReciente && hechos.textoSeguro === T.MENSAJE_ASESOR) {
    const t = textoParaCliente(cargaConsultada, T.MENSAJE_ASESOR);
    if (t) hechos.textoSeguro = t;
  }
  // Si se buscó con el número o el correo que escribió, ese mensaje es un dato
  // suelto («ana@gmail.com») y no habla de IMPORCHAT, pero la pregunta sí lo era.
  const deImporchat =
    diagnostico?.por === 'dato' ||
    hablaDeImporchat(String(mensaje || '')) ||
    hablaDeImporchat(String(respuesta || ''));
  if (
    diagnostico?.estado === 'revisada' &&
    diagnostico.resultado !== 'sin_causa' &&
    deImporchat &&
    hechos.textoSeguro === T.MENSAJE_ASESOR &&
    String(diagnostico.texto || '').length <= 1400
  ) {
    hechos.textoSeguro = diagnostico.texto;
  }
  // Si no encontró la cuenta, el texto fijo pide el número o el correo: si la
  // guardia rechaza cómo lo dijo el modelo, se manda ese y no el «un asesor».
  if (
    ['sin_cuenta', 'pide_dato', 'limite', 'ambiguo'].includes(diagnostico?.estado) &&
    hechos.textoSeguro === T.MENSAJE_ASESOR &&
    String(diagnostico.texto || '').length <= 1400
  ) {
    hechos.textoSeguro = diagnostico.texto;
  }
  const pide = pidePagos(String(mensaje || ''));
  if (pide && hechos.textoSeguro === T.MENSAJE_ASESOR) {
    const t = textoPagosParaCliente(pagos, { pideFactura: pide === 'factura' });
    if (t) hechos.textoSeguro = t;
  }
  const pideR = pideReunion(String(mensaje || ''));
  if (pideR && hechos.textoSeguro === T.MENSAJE_ASESOR) {
    const t = textoReunionParaCliente(reuniones, { pide: pideR });
    if (t) hechos.textoSeguro = t;
  }
  /* Buscó con el dato que escribió y no se pudo confirmar que es suyo: el
     texto fijo que pide el otro dato (o el que lo pasa al área) en vez del
     «un asesor», para no cortar la búsqueda. Nunca trae datos de nadie. */
  if (hechos.textoSeguro === T.MENSAJE_ASESOR && identidad) {
    const nc = identidad.area === 'cobranza' ? T.MENSAJE_DATO_NO_COINCIDE_PAGOS : T.MENSAJE_DATO_NO_COINCIDE;
    const t =
      identidad.estado === 'pide_otro'
        ? identidad.falta === 'correo'
          ? T.MENSAJE_DATO_PIDE_CORREO
          : T.MENSAJE_DATO_PIDE_CODIGO
        : ['no_coincide', 'limite'].includes(identidad.estado)
          ? nc
          : null;
    if (t) hechos.textoSeguro = t;
  }
  if (hechos.textoSeguro === T.MENSAJE_ASESOR && novedad?.texto && pideNovedad(String(mensaje || ''))) {
    hechos.textoSeguro = novedad.texto;
  }
  /* Pedidos de Dropi: si el cliente preguntaba por sus pedidos o guías y la
     guardia rechazó, el texto seguro es lo leído (o el que dice que no hay
     tienda conectada / pide la guía) en vez del «un asesor». */
  if (hechos.textoSeguro === T.MENSAJE_ASESOR && dropi?.texto && hablaDePedidosDropi(String(mensaje || ''))) {
    hechos.textoSeguro = dropi.texto;
  }
  // Membresía: lo mismo si preguntaba por su acceso o su membresía.
  if (hechos.textoSeguro === T.MENSAJE_ASESOR && membresia?.texto && hablaDeMembresia(String(mensaje || ''))) {
    hechos.textoSeguro = membresia.texto;
  }
  return hechos;
}

module.exports = { crearHerramientas, sumarHechosHerramientas, hablaDePedidosDropi, hablaDeMembresia, NO_VERIFICABLE };
