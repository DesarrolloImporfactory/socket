// utils/datosClienteAssistant.js
const { db } = require('../database/config');
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
      AND (fc.telefono = ? OR fc.telefono_limpio = ?)
      AND (TRIM(fc.numero_guia) <> '' AND fc.numero_guia IS NOT NULL AND fc.numero_guia <> '0'
           OR (TRIM(fc.numero_guia) = '' OR fc.numero_guia IS NULL OR fc.numero_guia = '0'))
    ORDER BY fc.fecha_guia DESC, fc.fecha_factura DESC
    LIMIT 1
  `;

  const [factura] = await db.query(sql, {
    replacements: [id_plataforma, id_plataforma, id_plataforma, telefono, telefono],
    type: db.QueryTypes.SELECT,
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
  // Consulta combinada para obtener datos con guía o pedido
  const sql = `
  SELECT 
    ap.start_utc AS inicio_cita,
    ap.end_utc AS fin_cita
  FROM calendars ca
  LEFT JOIN appointments ap ON ap.calendar_id = ca.id
  WHERE 
    ca.account_id = ? 
    AND ap.start_utc > NOW()
    AND ap.status NOT IN ('Completado', 'Cancelado', 'Bloqueado')
  ORDER BY ap.start_utc DESC 
`;

  // Ejecutar la consulta SQL
  const calendario = await db.query(sql, {
    replacements: [id_configuracion],
    type: db.QueryTypes.SELECT,
  });

  // Verificar si no hay datos
  if (!calendario || calendario.length === 0) {
    return {
      bloque: 'No hay citas programadas.',
      tipo: 'datos_servicio',
    };
  }

  // Crear un bloque organizado con las citas
  let tipoDato = 'datos_servicio';
  let bloque = `🧾 **Citas ocupadas datos_servicio detectadas:**\n\n`;

  // Formatear y agregar cada cita al bloque
  calendario.forEach((cita, index) => {
    // Convertir las fechas a un formato legible
    const inicioCita = new Date(cita.inicio_cita).toLocaleString();
    const finCita = new Date(cita.fin_cita).toLocaleString();

    bloque += `Cita ${index + 1}:\n`;
    bloque += `- **Inicio:** ${inicioCita}\n`;
    bloque += `- **Fin:** ${finCita}\n\n`;
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

  const [facturaGuia] = await db.query(sqlGuia, {
    replacements: [id_plataforma, id_plataforma, id_plataforma, telefono],
    type: db.QueryTypes.SELECT,
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

    const [facturaPedido] = await db.query(sqlPedido, {
      replacements: [id_plataforma, telefono],
      type: db.QueryTypes.SELECT,
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

module.exports = {
  obtenerDatosClienteParaAssistant,
  obtenerDatosCalendarioParaAssistant,
  informacionProductos,
  informacionProductosVinculado,
};
