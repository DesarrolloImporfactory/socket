// utils/datosClienteAssistant.js
const { db } = require('../database/config');
const {
  obtenerTrackingGuia,
  obtenerUrlDescargaGuia,
  obtenerEstadoGuia,
} = require('./openai_helpers');

const obtenerDatosClienteParaAssistant = async (id_plataforma, telefono) => {
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

module.exports = obtenerDatosClienteParaAssistant;
