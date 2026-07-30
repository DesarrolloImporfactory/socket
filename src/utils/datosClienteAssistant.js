// utils/datosClienteAssistant.js
const { db, db_2 } = require('../database/config');
const moment = require('moment-timezone');
const {
  obtenerTrackingGuia,
  obtenerUrlDescargaGuia,
  obtenerEstadoGuia,
} = require('./openai_helpers');

const obtenerDatosClienteParaAssistant = async (
  id_plataforma,
  telefono,
  id_thread
) => {
  // Consulta combinada para obtener datos con guía o pedido
  const sql = `
    SELECT 
      fc.numero_factura AS numero_factura,
      fc.monto_factura AS monto_factura,
      fc.nombre AS nombre_cliente,
      fc.telefono,
      fc.c_principal AS calle_principal,
      fc.c_secundaria AS calle_secundaria,
      fc.referencia,
      fc.numero_guia,
      fc.transporte AS transportadora,
      fc.costo_flete,
      fc.estado_guia_sistema,
      cc.ciudad, 
      cc.provincia, 
      b.nombre AS nombre_bodega, 
      b.direccion AS direccion_bodega,
      (
        SELECT GROUP_CONCAT(CONCAT(p.nombre_producto, ' x', dfc.cantidad, ' - $', dfc.precio_venta) SEPARATOR ', ')
        FROM detalle_fact_cot dfc
        INNER JOIN productos p ON p.id_producto = dfc.id_producto
        WHERE dfc.numero_factura = fc.numero_factura
      ) AS detalle_productos
    FROM facturas_cot fc
    LEFT JOIN ciudad_cotizacion cc ON cc.id_cotizacion = fc.ciudad_cot
    LEFT JOIN bodega b ON b.id = fc.id_bodega
    WHERE 
      fc.anulada = 0  
      AND (fc.id_plataforma = ? OR fc.id_propietario = ? OR b.id_plataforma = ?)
      AND (fc.telefono = ? OR fc.celular_cliente = ?)
      AND (TRIM(fc.numero_guia) <> '' AND fc.numero_guia IS NOT NULL AND fc.numero_guia <> '0'
           OR (TRIM(fc.numero_guia) = '' OR fc.numero_guia IS NULL OR fc.numero_guia = '0'))
    ORDER BY fc.fecha_guia DESC, fc.fecha_factura DESC
    LIMIT 1
  `;

  const [factura] = await db_2.query(sql, {
    replacements: [
      id_plataforma,
      id_plataforma,
      id_plataforma,
      telefono,
      telefono,
    ],
    type: db_2.QueryTypes.SELECT,
  });

  if (!factura) {
    return {
      bloque: null,
    };
  }

  let tipoDato = factura.numero_guia ? 'datos_guia' : 'datos_pedido';
  let datos = factura;

  let bloque = `🧾 ${tipoDato.toUpperCase()} DETECTADO:\n\n`;
  bloque += `Número factura: ${datos.numero_factura}\n`;
  bloque += `Monto factura: $${datos.monto_factura}\n`;
  bloque += `Nombre cliente: ${datos.nombre_cliente}\n`;
  bloque += `Teléfono: ${datos.telefono}\n`;
  bloque += `Dirección de entrega: ${datos.calle_principal} y ${datos.calle_secundaria}\n`;
  bloque += `Referencia: ${datos.referencia}\n`;

  if (datos.numero_guia) {
    bloque += `Número guía: ${datos.numero_guia || 'Sin asignar'}\n`;
    bloque += `Transporte: ${datos.transportadora || 'Sin asignar'}\n`;

    const estadoGuia = obtenerEstadoGuia(
      datos.transportadora,
      datos.estado_guia_sistema
    );
    const urlTracking = obtenerTrackingGuia(
      datos.transportadora,
      datos.numero_guia
    );
    const urlDescargaGuia = obtenerUrlDescargaGuia(
      datos.transportadora,
      datos.numero_guia
    );

    bloque += `Estado de la guía: ${estadoGuia}\n`;
    bloque += `Link de tracking guía: ${urlTracking}\n`;
    bloque += `Link de descarga guía: ${urlDescargaGuia}\n`;
  }

  bloque += `Costo flete: $${datos.costo_flete}\n`;
  bloque += `Ciudad: ${datos.ciudad}\n`;
  bloque += `Provincia: ${datos.provincia}\n`;
  bloque += `Bodega: ${datos.nombre_bodega}\n`;
  bloque += `Dirección bodega: ${datos.direccion_bodega}\n`;
  bloque += `Detalle productos: ${datos.detalle_productos}\n`;

  // Actualizar tabla openai_threads con numero_factura y numero_guia
  const updateSql = `
    UPDATE openai_threads
    SET numero_factura = ?, numero_guia = ?
    WHERE thread_id = ?
  `;
  await db.query(updateSql, {
    replacements: [datos.numero_factura, datos.numero_guia, id_thread],
    type: db.QueryTypes.UPDATE,
  });

  return {
    bloque,
    tipo: tipoDato,
  };
};

const obtenerDatosCalendarioParaAssistant = async (id_configuracion) => {
  /* La zona del calendario, no una fija: el bloque se lee en hora local del
     negocio y hay cuentas fuera de Ecuador. */
  const [cal] = await db.query(
    `SELECT time_zone FROM calendars
      WHERE account_id = ? AND is_active = 1 ORDER BY id ASC LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const tz = cal?.time_zone || 'America/Guayaquil';

  const sql = `
  SELECT
    ap.start_utc AS inicio_cita,
    ap.end_utc AS fin_cita,
    ap.id_establecimiento,
    est.nombre AS sede
  FROM calendars ca
  LEFT JOIN appointments ap ON ap.calendar_id = ca.id
  LEFT JOIN establecimientos_chat_center est ON est.id = ap.id_establecimiento
  WHERE
    ca.account_id = ?
    AND ap.start_utc > UTC_TIMESTAMP()
    AND ap.status NOT IN ('Completado', 'Cancelado', 'Bloqueado')
  ORDER BY ap.start_utc ASC
`;

  // Ejecutar la consulta SQL
  const calendario = await db.query(sql, {
    replacements: [id_configuracion],
    type: db.QueryTypes.SELECT,
  });

  /* Cuánta gente atiende en cada sede. Es lo que convierte "ese horario está
     ocupado" en "de tres esteticistas, dos están ocupadas": sin esto el bot
     descartaba una hora en la que todavía quedaban cupos. */
  const capacidad = new Map();
  const profs = await db.query(
    `SELECT id_establecimiento, COUNT(*) AS n
       FROM profesionales_chat_center
      WHERE id_configuracion = ? AND activo = 1 AND eliminado = 0
      GROUP BY id_establecimiento`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  profs.forEach((p) => capacidad.set(Number(p.id_establecimiento), Number(p.n)));

  /* Qué día es hoy. Va SIEMPRE, con citas o sin ellas.
     Antes solo se incluía cuando había citas agendadas, así que una agenda
     recién creada dejaba al asistente sin ninguna referencia temporal: al
     pedirle "el martes" resolvía con la fecha que le quedara del entrenamiento
     y agendaba en un año pasado, sin que nada fallara al crearse. */
  const ahora = moment().tz(tz);
  const DIAS = [
    'domingo',
    'lunes',
    'martes',
    'miércoles',
    'jueves',
    'viernes',
    'sábado',
  ];

  let bloque =
    `🗓️ HOY es ${DIAS[ahora.day()]} ${ahora.format('YYYY-MM-DD')} y son las ` +
    `${ahora.format('HH:mm')} (hora de ${tz}).\n` +
    `Cualquier fecha relativa que diga el cliente ("mañana", "el martes", ` +
    `"la próxima semana") la resuelves contra ESTA fecha, y siempre hacia ` +
    `adelante. Nunca propongas ni agendes una fecha ya pasada.\n\n`;

  if (!calendario || calendario.length === 0) {
    return {
      bloque: `${bloque}No hay ninguna cita agendada todavía: la agenda está libre.`,
      tipo: 'datos_servicio',
    };
  }

  /* Se agrupan las citas que caen en el mismo horario y la misma sede: lo que
     el bot necesita saber no es cuántas citas hay, sino si queda alguien libre. */
  const franjas = new Map();
  calendario.forEach((cita) => {
    // start_utc llega como texto UTC: hay que convertirlo, no leerlo como local.
    const ini = moment.utc(cita.inicio_cita).tz(tz);
    const fin = moment.utc(cita.fin_cita).tz(tz);
    const sedeId = Number(cita.id_establecimiento) || 0;
    const clave = `${ini.format('YYYY-MM-DD HH:mm')}|${fin.format('HH:mm')}|${sedeId}`;

    if (!franjas.has(clave)) {
      franjas.set(clave, {
        ini,
        fin,
        sedeId,
        sede: cita.sede || null,
        ocupadas: 0,
      });
    }
    franjas.get(clave).ocupadas += 1;
  });

  bloque += `Ocupación de la agenda (solo ofrece horarios donde quede cupo):\n`;

  for (const f of franjas.values()) {
    const total = capacidad.get(f.sedeId) || 1;
    const libres = Math.max(0, total - f.ocupadas);
    const cuando = `${DIAS[f.ini.day()]} ${f.ini.format('YYYY-MM-DD')} de ${f.ini.format('HH:mm')} a ${f.fin.format('HH:mm')}`;
    const donde = f.sede ? ` · ${f.sede}` : '';

    bloque +=
      libres > 0
        ? `- ${cuando}${donde}: ${f.ocupadas} de ${total} ocupadas, quedan ${libres} — SÍ puedes agendar\n`
        : `- ${cuando}${donde}: LLENO (${total} de ${total}) — no lo ofrezcas\n`;
  }

  if (capacidad.size) {
    bloque +=
      `\nVarias personas atienden a la vez, así que un horario con citas NO ` +
      `está necesariamente lleno: fíjate en cuántos cupos quedan.\n`;
  }

  return {
    bloque,
    tipo: 'datos_servicio',
  };
};

const obtenerCalendarioClasImporfactory = async () => {
  // Consulta combinada para obtener datos con guía o pedido
  const sql = `
    SELECT 
      title, description, event_date, target_url
    FROM banner_calendar_events 
    WHERE
    active = 1 AND
    event_date > NOW()
    ORDER BY event_date DESC 
  `;

  // Ejecutar la consulta SQL
  const calendario = await db_2.query(sql, {
    type: db_2.QueryTypes.SELECT,
  });

  // Verificar si no hay datos
  if (!calendario || calendario.length === 0) {
    return {
      bloque: 'No hay clases programadas.',
      tipo: 'datos_clases',
    };
  }

  // Crear un bloque organizado con las citas
  let tipoDato = 'datos_clases';
  let fechaActual = moment()
    .tz('America/Guayaquil')
    .format('YYYY-MM-DD HH:mm:ss');
  let bloque = `🧾 **Fecha actual es decir la fecha de hoy(${fechaActual}), Clases programadas datos_clases detectadas:**\n\n`;

  // Formatear y agregar cada cita al bloque
  calendario.forEach((cita, index) => {
    // Convertir las fechas a un formato legible
    const inicioCita = new Date(cita.event_date).toLocaleString();

    bloque += `Clase ${cita.title}:\n`;
    bloque += `- **Fecha:** ${inicioCita}\n`;
    bloque += `- **titulo:** ${cita.title}\n`;
    bloque += `- **Descripcion:** ${cita.description}\n`;
    bloque += `- **URL:** ${cita.target_url}\n`;
  });

  return {
    bloque,
    tipo: tipoDato,
  };
};

const informacionProductos = async (productos) => {
  let bloqueProductos =
    '📦 Información de todos los productos que ofrecemos pero que no necesariamente estan en el pedido:\n\n';

  for (const id of productos) {
    console.log('id: ' + id);
    /* const sqlProducto = `
      SELECT 
        p.nombre_producto AS nombre_producto,
        p.descripcion_producto AS descripcion_producto,
        ib.pvp AS precio_producto,
        p.image_path AS image_path
      FROM inventario_bodegas ib
      INNER JOIN productos p ON ib.id_producto = p.id_producto
      WHERE ib.id_inventario = ?
      LIMIT 1
    `; */

    const sqlProducto = `
      SELECT 
        pc.nombre AS nombre_producto,
        pc.descripcion AS descripcion_producto,
        pc.tipo AS tipo,
        pc.precio AS precio_producto,
        pc.imagen_url AS image_path,
        pc.video_url AS video_path,
        cc.nombre AS nombre_categoria
      FROM productos_chat_center pc
      INNER JOIN categorias_chat_center cc ON cc.id = pc.id_categoria
      WHERE pc.id = ?
      LIMIT 1
    `;

    const [infoProducto] = await db.query(sqlProducto, {
      replacements: [id],
      type: db.QueryTypes.SELECT,
    });

    if (infoProducto) {
      bloqueProductos += `🛒 Producto: ${infoProducto.nombre_producto}\n`;
      bloqueProductos += `📃 Descripción: ${infoProducto.descripcion_producto}\n`;
      bloqueProductos += ` Precio: ${infoProducto.precio_producto}\n`;
      /* bloqueProductos += `🖼️ Imagen: ${infoProducto.image_path}\n\n`; */ // esta forma la incluye la url de la imagen como texto solido
      bloqueProductos += `[producto_imagen_url]: ${infoProducto.image_path}\n\n`; //esta forma sirve como recurso para el asistente (no visible para el cliente en el bloque)
      bloqueProductos += `[producto_video_url]: ${infoProducto.video_path}\n\n`; //esta forma sirve como recurso para el asistente (no visible para el cliente en el bloque)
      bloqueProductos += ` tipo: ${infoProducto.tipo}\n`;
      bloqueProductos += ` Categoría: ${infoProducto.nombre_categoria}\n`;
      bloqueProductos += `\n`;
    }
  }

  return bloqueProductos;
};

const informacionProductosVinculado = async (productos) => {
  let bloqueProductos =
    '📦 Información de todos los productos que ofrecemos pero que no necesariamente estan en el pedido:\n\n';

  for (const id of productos) {
    console.log('id: ' + id);
    const sqlProducto = `
      SELECT 
        p.nombre_producto AS nombre_producto,
        p.descripcion_producto AS descripcion_producto,
        ib.pvp AS precio_producto,
        p.image_path AS image_path,
        l.nombre_linea AS nombre_categoria
      FROM inventario_bodegas ib
      INNER JOIN productos p ON ib.id_producto = p.id_producto 
      INNER JOIN lineas l ON l.id_linea = p.id_linea_producto
      WHERE ib.id_inventario = ?
      LIMIT 1
    `;

    const [infoProducto] = await db_2.query(sqlProducto, {
      replacements: [id],
      type: db_2.QueryTypes.SELECT,
    });

    if (infoProducto) {
      bloqueProductos += `🛒 Producto: ${infoProducto.nombre_producto}\n`;
      bloqueProductos += `📃 Descripción: ${infoProducto.descripcion_producto}\n`;
      bloqueProductos += ` Precio: ${infoProducto.precio_producto}\n`;
      /* bloqueProductos += `🖼️ Imagen: ${infoProducto.image_path}\n\n`; */ // esta forma la incluye la url de la imagen como texto solido
      bloqueProductos += `[producto_imagen_url]: ${infoProducto.image_path}\n\n`; //esta forma sirve como recurso para el asistente (no visible para el cliente en el bloque)
      bloqueProductos += ` Categoría: ${infoProducto.nombre_categoria}\n`;
      bloqueProductos += `\n`;
    }
  }

  return bloqueProductos;
};

const obtenerDatosClienteParaAssistant_viejo = async (
  id_plataforma,
  telefono
) => {
  // Consulta para obtener datos con guía
  const sqlGuia = `
    SELECT 
      fc.numero_factura AS numero_factura,
      fc.monto_factura AS monto_factura,
      fc.nombre AS nombre_cliente,
      fc.telefono,
      fc.c_principal AS calle_principal,
      fc.c_secundaria AS calle_secundaria,
      fc.referencia,
      fc.numero_guia,
      fc.transporte AS transportadora,
      fc.costo_flete,
      fc.estado_guia_sistema,
      cc.ciudad, 
      cc.provincia, 
      b.nombre AS nombre_bodega, 
      b.direccion AS direccion_bodega,
      (
        SELECT GROUP_CONCAT(CONCAT(p.nombre_producto, ' x', dfc.cantidad, ' - $', dfc.precio_venta) SEPARATOR ', ')
        FROM detalle_fact_cot dfc
        INNER JOIN productos p ON p.id_producto = dfc.id_producto
        WHERE dfc.numero_factura = fc.numero_factura
      ) AS detalle_productos
    FROM facturas_cot fc
    LEFT JOIN ciudad_cotizacion cc ON cc.id_cotizacion = fc.ciudad_cot
    LEFT JOIN bodega b ON b.id = fc.id_bodega
    WHERE 
      TRIM(fc.numero_guia) <> '' AND fc.numero_guia IS NOT NULL AND fc.numero_guia <> '0'
      AND fc.anulada = 0  
      AND (fc.id_plataforma = ? OR fc.id_propietario = ? OR b.id_plataforma = ?)
      AND fc.telefono = ?
    ORDER BY fc.fecha_guia DESC 
    LIMIT 1
  `;

  const [facturaGuia] = await db_2.query(sqlGuia, {
    replacements: [id_plataforma, id_plataforma, id_plataforma, telefono],
    type: db_2.QueryTypes.SELECT,
  });

  let tipoDato = 'datos_guia';
  let datos = facturaGuia;

  // Si no hay guía, consulta como pedido
  if (!datos) {
    tipoDato = 'datos_pedido';
    const sqlPedido = `
      SELECT 
        fc.numero_factura AS numero_factura,
        fc.monto_factura AS monto_factura,
        fc.nombre AS nombre_cliente,
        fc.telefono,
        fc.c_principal AS calle_principal,
        fc.c_secundaria AS calle_secundaria,
        fc.referencia,
        fc.numero_guia,
        fc.transporte,
        fc.costo_flete,
        cc.ciudad, 
        cc.provincia, 
        b.nombre AS nombre_bodega, 
        b.direccion AS direccion_bodega,
        (
          SELECT GROUP_CONCAT(CONCAT(p.nombre_producto, ' x', dfc.cantidad, ' - $', dfc.precio_venta) SEPARATOR ', ')
          FROM detalle_fact_cot dfc
          INNER JOIN productos p ON p.id_producto = dfc.id_producto
          WHERE dfc.numero_factura = fc.numero_factura
        ) AS detalle_productos
      FROM facturas_cot fc
      LEFT JOIN ciudad_cotizacion cc ON cc.id_cotizacion = fc.ciudad_cot
      LEFT JOIN bodega b ON b.id = fc.id_bodega
      WHERE 
        (TRIM(fc.numero_guia) = '' OR fc.numero_guia IS NULL OR fc.numero_guia = '0')
        AND fc.anulada = 0  
        AND fc.id_plataforma = ?
        AND fc.telefono = ?
      ORDER BY fc.fecha_factura DESC 
      LIMIT 1
    `;

    const [facturaPedido] = await db_2.query(sqlPedido, {
      replacements: [id_plataforma, telefono],
      type: db_2.QueryTypes.SELECT,
    });

    datos = facturaPedido;
  }

  if (datos) {
    let bloque = `🧾 ${tipoDato.toUpperCase()} DETECTADO:\n\n`;
    bloque += `Número factura: ${datos.numero_factura}\n`;
    bloque += `Monto factura: $${datos.monto_factura}\n`;
    bloque += `Nombre cliente: ${datos.nombre_cliente}\n`;
    bloque += `Teléfono: ${datos.telefono}\n`;
    bloque += `Dirección de entrega: ${datos.calle_principal} y ${datos.calle_secundaria}\n`;
    bloque += `Referencia: ${datos.referencia}\n`;

    if (datos.numero_guia) {
      bloque += `Número guía: ${datos.numero_guia || 'Sin asignar'}\n`;
      bloque += `Transporte: ${datos.transportadora || 'Sin asignar'}\n`;

      const estadoGuia = obtenerEstadoGuia(
        datos.transportadora,
        datos.estado_guia_sistema
      );
      const urlTracking = obtenerTrackingGuia(
        datos.transportadora,
        datos.numero_guia
      );
      const urlDescargaGuia = obtenerUrlDescargaGuia(
        datos.transportadora,
        datos.numero_guia
      );

      bloque += `Estado de la guía: ${estadoGuia}\n`;
      bloque += `Link de tracking guía: ${urlTracking}\n`;
      bloque += `Link de descarga guía: ${urlDescargaGuia}\n`;
    }

    bloque += `Costo flete: $${datos.costo_flete}\n`;
    bloque += `Ciudad: ${datos.ciudad}\n`;
    bloque += `Provincia: ${datos.provincia}\n`;
    bloque += `Bodega: ${datos.nombre_bodega}\n`;
    bloque += `Dirección bodega: ${datos.direccion_bodega}\n`;
    bloque += `Detalle productos: ${datos.detalle_productos}\n`;

    return {
      bloque,
      tipo: tipoDato,
    };
  }

  return {
    bloque: null,
  };
};

const procesarCombosParaIA = (combos_producto) => {
  let combos = [];

  // -------- 1. Normalizar el valor que viene desde la BD -------- //
  try {
    if (!combos_producto) {
      combos = [];
    } else if (typeof combos_producto === 'string') {
      combos = JSON.parse(combos_producto);
    } else if (Array.isArray(combos_producto)) {
      combos = combos_producto;
    } else {
      combos = [];
    }
  } catch (error) {
    combos = [];
  }

  // Asegurar que combos sea siempre un array
  if (!Array.isArray(combos)) combos = [];

  // -------- 2. Filtrar combos válidos (no vacíos) -------- //
  const combosValidos = combos.filter((c) => {
    return (
      c &&
      (String(c.cantidad || '').trim() !== '' ||
        String(c.precio || '').trim() !== '')
    );
  });

  // -------- 3. Crear bloque legible para IA -------- //
  let bloqueCombos = '';

  if (combosValidos.length > 0) {

    combosValidos.forEach((c, index) => {
      const cantidad = c.cantidad || '0';
      const precio = c.precio || '0.00';

      bloqueCombos += `   • Combo ${
        index + 1
      }: ${cantidad} unidades por $${precio}\n`;
    });

    bloqueCombos += '\n';
  }

  // -------- 4. Retornar resultado -------- //
  return {
    combosNormalizados: combos, // útil si lo quieres loguear, guardar o reutilizar
    bloqueCombos, // listo para insertar en tu prompt IA
  };
};

module.exports = {
  obtenerDatosClienteParaAssistant,
  obtenerDatosCalendarioParaAssistant,
  informacionProductos,
  informacionProductosVinculado,
  obtenerCalendarioClasImporfactory,
  procesarCombosParaIA,
};
