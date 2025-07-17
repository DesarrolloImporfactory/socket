const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const axios = require('axios');

const { db } = require('../database/config');
const FacturasCot = require('../models/facturas_cot.model');

// controllers/detalle_fact_cotController.js
exports.validarDevolucion = catchAsync(async (req, res, next) => {
  const { telefono } = req.body;

  try {
    const sql = `SELECT * FROM facturas_cot 
    WHERE telefono = '${telefono}'
    AND (
      (estado_guia_sistema BETWEEN 500 AND 502 AND id_transporte = 2)
      OR (estado_guia_sistema IN (9) AND id_transporte = 2)
      OR (estado_guia_sistema IN (9) AND id_transporte = 4)
      OR (estado_guia_sistema IN (8, 9, 13) AND id_transporte = 3)
    )
    LIMIT 1`;

    const rows = await db.query(sql, { type: db.QueryTypes.SELECT });

    const existe = rows.length > 0;

    res.status(200).json({
      status: '200',
      success: existe,
    });
  } catch (error) {
    console.error('Error en validarDevolucion:', error);
    return next(new AppError('Error al consultar devoluciones', 500));
  }
});

// Mapa de URLs de transporte
const mapaURLs = {
  1: 'https://new.imporsuitpro.com/Guias/generarLaar',
  2: 'https://new.imporsuitpro.com/Guias/generarServientrega',
  3: 'https://new.imporsuitpro.com/Guias/generarGintracom',
  4: 'https://new.imporsuitpro.com/Guias/generarSpeed',
};

// Controlador para generar la guía
exports.generarGuia = catchAsync(async (req, res, next) => {
  const data = req.body;

  console.log('Generando guía para factura:', data.numero_factura);

  const idTransporte = data.id_transporte;

  // Verificar que el id_transporte esté en el mapa
  if (!mapaURLs[idTransporte]) {
    console.error('ID de transporte no soportado:', idTransporte);
    return next(new AppError('ID de transporte no soportado', 400));
  }

  const url = mapaURLs[idTransporte];

  // Asegurarse de que los productos estén en formato JSON
  if (Array.isArray(data.productos)) {
    data.productos = JSON.stringify(data.productos);
  }

  // Formulario con los datos a enviar
  const formularioGuia = {
    total_venta: data.monto_factura,
    nombre: data.nombre_cliente,
    recaudo: data.recaudo,
    telefono: data.telefono_cliente,
    calle_principal: data.c_principal,
    calle_secundaria: data.c_secundaria,
    referencia: data.referencia,
    ciudad: data.ciudad_cot,
    provincia: data.provincia,
    identificacion: data.identificacion,
    observacion: data.observacion,
    nombre_responsable: data.nombre_responsable,
    transporte: data.transporte,
    celular: data.celular,
    id_producto_venta: data.id_producto_venta,
    dropshipping: data.dropshipping,
    importado: data.importado,
    id_propietario: data.id_bodega,
    identificacionO: data.identificacionO,
    celularO: data.celularO,
    nombreO: data.nombreO,
    ciudadO: data.ciudadO,
    provinciaO: data.provinciaO,
    direccionO: data.direccionO,
    referenciaO: data.referenciaO,
    numeroCasaO: data.numeroCasaO,
    valor_seguro: data.valor_segura,
    no_piezas: data.no_piezas,
    contiene: data.contiene,
    productos: data.productos,
    costo_flete: data.costo_flete,
    costo_producto: data.costo_producto,
    comentario: data.comentario,
    id_transporte: data.id_transporte,
    url_google_speed_pedido: data.url_google_speed_pedido || '',
    numero_factura: data.numero_factura,
    flete: data.flete || '',
    seguro: data.seguro || '',
    comision: data.comision || '',
    otros: data.otros || '',
    impuestos: data.impuestos || '',
    id: data.id_usuario,
    id_plataforma: data.id_plataforma,
  };

  try {
    // Realizar la solicitud POST al servicio de generación de guía
    const response = await axios.post(
      url,
      new URLSearchParams(formularioGuia),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'WorkerPedidoGuia/1.0',
        },
      }
    );

    // Enviar la respuesta recibida al cliente
    res.status(200).json({
      status: 'success',
      data: response.data,
    });
  } catch (error) {
    console.error('Error al generar la guía:', error.message);
    return next(new AppError('Error al generar la guía', 500));
  }
});

const ESTADOS_ENTREGAS = '7,400,401,402,403';
const ESTADOS_DEVOL = '8,9,13,500,501,502';

exports.infoCliente = catchAsync(async (req, res, next) => {
  const { telefono, id_plataforma } = req.body;
  if (!telefono || !id_plataforma) {
    return next(new AppError('Faltan teléfono o id_plataforma', 400));
  }

  const soloDigitos = telefono.replace(/\D/g, '');

  const telLike = `%${soloDigitos.slice(-9)}`; // «…987654321»

  /* ────────── consulta ────────── */
  const sql = `
    SELECT
      COALESCE(SUM(CASE WHEN id_plataforma = :plat THEN 1 END),0)                       AS ordenes_tienda,
      COUNT(*)                                                                          AS ordenes_imporsuit,
      COALESCE(SUM(CASE WHEN estado_guia_sistema IN (${ESTADOS_ENTREGAS}) THEN 1 END),0) AS entregas,
      COALESCE(SUM(CASE WHEN estado_guia_sistema IN (${ESTADOS_DEVOL})   THEN 1 END),0) AS devoluciones
    FROM facturas_cot
    /*  quitamos "+" y comparamos con LIKE */
    WHERE REPLACE(telefono_limpio, '+', '') LIKE :tel
  `;

  const [stats] = await db.query(sql, {
    replacements: { plat: id_plataforma, tel: telLike },
    type: db.QueryTypes.SELECT,
  });

  /* ────────── semáforo ────────── */
  const ratio =
    stats.ordenes_imporsuit > 0
      ? stats.devoluciones / stats.ordenes_imporsuit
      : 0;

  const nivel =
    ratio >= 0.4
      ? { color: 'danger', texto: 'Probabilidad baja de entrega.' }
      : ratio >= 0.2
      ? { color: 'warning', texto: 'Buena probabilidad, vigile factores.' }
      : { color: 'success', texto: 'Excelente historial de entrega.' };

  /* ────────── respuesta ───────── */
  res.status(200).json({
    status: 200,
    stats,
    nivel,
  });
});

exports.marcarChatCenter = catchAsync(async (req, res, next) => {
  const { numero_factura } = req.body;

  if (!numero_factura)
    return next(new AppError('numero_factura es obligatorio', 400));

  const [filasAfectadas] = await FacturasCot.update(
    { chat_center: 1 },
    { where: { numero_factura } }
  );

  if (!filasAfectadas) return next(new AppError('Factura no encontrada', 404));
  res.status(200).json({ status: 200, message: 'Factura actualizada' });
});
