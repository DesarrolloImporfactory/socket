const { Op, Sequelize, where } = require('sequelize');
const AppError = require('../utils/appError');
const MensajesClientes = require('../models/mensaje_cliente.model');
const ErroresChatMeta = require('../models/errores_chat_meta.model');
const ClientesChatCenter = require('../models/clientes_chat_center.model');
const EtiquetasChatCenter = require('../models/etiquetas_chat_center.model');
const Configuraciones = require('../models/configuraciones.model');
const TemplatesChatCenter = require('../models/templates_chat_center.model');
const { db } = require('../database/config');
const FacturasCot = require('../models/facturas_cot.model');
const DetalleFactCot = require('../models/detalle_fact_cot.model');
const ProvinciaLaar = require('../models/provincia_laar.model');
const CiudadCotizacion = require('../models/ciudad_cotizacion.model');
const Plataforma = require('../models/plataforma.model');
const CoberturaLaar = require('../models/cobertura_laar.model');
const CoberturaServientrega = require('../models/cobertura_servientrega.model');
const CoberturaGintracom = require('../models/cobertura_gintracom.model');
const InventarioBodegas = require('../models/inventario_bodegas.model');
const Productos = require('../models/productos.model');
const axios = require('axios');
const xml2js = require('xml2js');
const { decode } = require('html-entities');
class ChatService {
  async findChats(
    id_configuracion,
    id_sub_usuario,
    rol,
    { cursorFecha = null, cursorId = null, limit = 10, filtros = {} }
  ) {
    try {
      console.log('Filtros:', filtros);

      const configuraciones = await Configuraciones.findOne({
        where: { id: id_configuracion },
        attributes: ['telefono'],
      });

      const numero = configuraciones ? configuraciones.telefono : null;

      if (!numero) {
        throw new AppError(
          'El número de teléfono para excluir no se encontró.',
          500
        );
      }
      let whereClause = '';

      if (rol == 'administrador') {
        whereClause = `WHERE id_configuracion = :id_configuracion AND celular_cliente != :numero`;
      } else {
        whereClause = `WHERE id_configuracion = :id_configuracion AND celular_cliente != :numero AND (id_encargado = :id_sub_usuario OR id_encargado IS NULL)`;
      }

      if (filtros.searchTerm && filtros.searchTerm.trim() !== '') {
        whereClause += ` AND (LOWER(nombre_cliente) LIKE :searchTerm OR LOWER(celular_cliente) LIKE :searchTerm)`;
      }

      if (filtros.selectedEtiquetas && filtros.selectedEtiquetas.length > 0) {
        whereClause += ` AND (${filtros.selectedEtiquetas
          .map(
            (etiqueta) =>
              `JSON_CONTAINS(etiquetas, '{"id": ${etiqueta.value}}', '$')`
          )
          .join(' AND ')})`;
      }

      if (
        filtros.selectedTransportadora &&
        filtros.selectedTransportadora.value
      ) {
        whereClause += ` AND transporte = :selectedTransportadora`;
      }

      if (filtros.selectedNovedad) {
        if (filtros.selectedNovedad.value === 'gestionadas') {
          whereClause += ` AND novedad_info IS NOT NULL AND (novedad_info->'$.terminado' = 1 OR novedad_info->'$.solucionada' = 1)`;
        } else if (filtros.selectedNovedad.value === 'no_gestionadas') {
          whereClause += ` AND (novedad_info IS NULL OR (novedad_info->'$.terminado' = 0 AND novedad_info->'$.solucionada' = 0))`;
        }
      }

      if (filtros.selectedPedidos_confirmados) {
        if (filtros.selectedPedidos_confirmados.value === '1') {
          whereClause += ` AND pedido_confirmado = 1`;
        } else if (filtros.selectedPedidos_confirmados.value === '0') {
          whereClause += ` AND pedido_confirmado = 0`;
        }
      } else {
        console.log('filtros.selectedPedidos_confirmados es null o undefined');
      }

      if (filtros.selectedTab) {
        if (filtros.selectedTab === 'abierto') {
          whereClause += ` AND chat_cerrado = 0`;
        } else if (filtros.selectedTab === 'resueltos') {
          whereClause += ` AND chat_cerrado = 1`;
        }
      }

      if (filtros.selectedTransportadora && filtros.selectedEstado) {
        const estadoTransportadoraMap = {
          LAAR: {
            Generada: [1, 2],
            'En transito': [5, 11, 12, 6],
            Entregada: [7],
            Novedad: [14],
            Devolucion: [9],
          },
          SERVIENTREGA: {
            Generada: [100, 102, 103],
            'En transito': (estadoFactura) =>
              estadoFactura >= 300 && estadoFactura <= 317,
            Entregada: (estadoFactura) =>
              estadoFactura >= 400 && estadoFactura <= 403,
            Novedad: (estadoFactura) =>
              estadoFactura >= 320 && estadoFactura <= 351,
            Devolucion: (estadoFactura) =>
              estadoFactura >= 500 && estadoFactura <= 502,
          },
          GINTRACOM: {
            Generada: [1, 2, 3],
            'En transito': [5, 4],
            Entregada: [7],
            Novedad: [6],
            Devolucion: [8, 9, 13],
          },
          SPEED: {
            Generada: [2],
            'En transito': [3],
            Devolucion: [9],
          },
        };

        const estadosPermitidos =
          estadoTransportadoraMap[filtros.selectedTransportadora.value]?.[
            filtros.selectedEstado.value
          ];

        if (Array.isArray(estadosPermitidos)) {
          whereClause += ` AND estado_factura IN (${estadosPermitidos.join(
            ', '
          )})`;
        } else if (typeof estadosPermitidos === 'function') {
          const estado = filtros.selectedEstado.value;
          let condicionFuncion = '';

          if (filtros.selectedTransportadora.value === 'SERVIENTREGA') {
            switch (estado) {
              case 'Generada':
                condicionFuncion = `estado_factura IN (100, 102, 103)`;
                break;
              case 'En transito':
                condicionFuncion = `estado_factura BETWEEN 300 AND 317`;
                break;
              case 'Entregada':
                condicionFuncion = `estado_factura BETWEEN 400 AND 403`;
                break;
              case 'Novedad':
                condicionFuncion = `estado_factura BETWEEN 320 AND 351`;
                break;
              case 'Devolucion':
                condicionFuncion = `estado_factura BETWEEN 500 AND 502`;
                break;
            }
          }

          if (condicionFuncion) {
            whereClause += ` AND ${condicionFuncion}`;
          }
        }
      }

      if (cursorFecha && cursorId) {
        whereClause += ` AND (mensaje_created_at < :cursorFecha OR (mensaje_created_at = :cursorFecha AND id < :cursorId))`;
      }

      const sqlQuery = `
      SELECT * FROM chats_4
      ${whereClause}
      ORDER BY mensaje_created_at DESC, id DESC
      LIMIT :limit;
    `;

      if (cursorFecha) {
        const fechaUtc = new Date(cursorFecha);
        fechaUtc.setHours(fechaUtc.getHours() - 5); // Ajustar según zona horaria del servidor
        cursorFecha = fechaUtc.toISOString().slice(0, 19).replace('T', ' ');
        console.log('Cursor ajustado (fecha local):', cursorFecha);
      }

      // Armar los replacements
      const replacements = {
        id_configuracion,
        numero,
        searchTerm: filtros.searchTerm
          ? `%${filtros.searchTerm.toLowerCase()}%`
          : null,
        selectedEstado: filtros.selectedEstado
          ? filtros.selectedEstado.value
          : null,
        selectedTransportadora: filtros.selectedTransportadora
          ? filtros.selectedTransportadora.value
          : null,
        cursorFecha,
        cursorId,
        limit,
      };

      // Solo agregar id_sub_usuario si el rol no es 'administrador'
      if (rol !== 'administrador') {
        replacements.id_sub_usuario = id_sub_usuario;
      }

      // Construir e imprimir la SQL final con valores reales (solo para debug)
      let sqlFinal = sqlQuery;
      Object.keys(replacements).forEach((key) => {
        const value = replacements[key];
        const replacedValue =
          typeof value === 'string'
            ? `'${value}'`
            : value === null
            ? 'NULL'
            : value;
        sqlFinal = sqlFinal.replace(new RegExp(`:${key}`, 'g'), replacedValue);
      });

      console.log('🚀 SQL Final ejecutada:\n', sqlFinal);

      // Ejecutar la query
      const chats = await db.query(sqlQuery, {
        replacements,
        type: Sequelize.QueryTypes.SELECT,
      });

      return chats;
    } catch (error) {
      console.error('Error en la consulta:', error);
      throw new AppError('Error al obtener los chats', 500);
    }
  }

  async getNombre(codigo, nombre) {
    let sql = '';
    if (nombre === 'ciudad') {
      sql = `SELECT ${nombre} FROM ciudad_cotizacion WHERE id_cotizacion = '${codigo}';`;
    } else {
      sql = `SELECT ${nombre} FROM ciudad_cotizacion WHERE codigo_provincia_laar = '${codigo}' LIMIT 1`;
    }

    try {
      const [results, metadata] = await db.query(sql); // El resultado está en `results`
      console.log('Resultado:', results); // Imprime el resultado de forma legible

      // Devuelve el primer elemento si esperas solo un resultado
      return results.length > 0 ? results[0] : null;
    } catch (error) {
      console.error('Error ejecutando la consulta:', error.message);
      throw error; // Opcional: Lanza el error para manejarlo en niveles superiores
    }
  }

  async getChatsByClient(id_cliente, id_configuracion) {
    try {
      const chats = await ClientesChatCenter.findAll({
        include: [
          {
            model: MensajesClientes,
            as: 'mensajes',
            where: {
              celular_recibe: id_cliente,
              id_configuracion: id_configuracion,
            },
            attributes: [
              'texto_mensaje',
              'created_at',
              'ruta_archivo',
              'visto',
              'tipo_mensaje',
              'id',
              'rol_mensaje',
              'celular_recibe',
              'mid_mensaje',
              'responsable',
              'id_wamid_mensaje',
              'template_name',
              'language_code',
            ],
            include: [
              {
                model: ErroresChatMeta,
                as: 'error_meta',
                attributes: ['codigo_error', 'mensaje_error'],
                required: false, // LEFT JOIN para que, si no existe, devuelva null
              },
            ],
            order: [['created_at', 'ASC']],
          },
        ],
      });

      // marcar vistos
      await MensajesClientes.update(
        { visto: 1 },
        {
          where: {
            celular_recibe: id_cliente,
            id_configuracion: id_configuracion,
            visto: 0,
            rol_mensaje: 0,
          },
        }
      );

      return chats;
    } catch (error) {
      console.error('Error al obtener los chats:', error.message);
      throw error;
    }
  }

  async getTemplates(id_configuracion, palabraClave) {
    try {
      // Realiza la consulta para obtener los templates filtrados
      const templates = await TemplatesChatCenter.findAll({
        where: {
          id_configuracion,
          [Op.or]: [
            { atajo: { [Op.like]: `%${palabraClave}%` } },
            { mensaje: { [Op.like]: `%${palabraClave}%` } },
          ],
        },
      });

      return templates;
    } catch (error) {
      throw new AppError(error.message, 500);
    }
  }

  async getDataAdmin(id_configuracion) {
    try {
      const configuraciones = await Configuraciones.findOne({
        where: {
          id: id_configuracion,
        },
        attributes: [
          'id',
          'id_telefono',
          'token',
          'id_plataforma',
          'id_whatsapp',
          'telefono',
          'metodo_pago',
        ],
      });

      return configuraciones;
    } catch (error) {
      throw new AppError(error.message, 500);
    }
  }

  async sendMessage(data) {
    try {
      const {
        mensaje,
        to,
        dataAdmin,
        tipo_mensaje,
        id_configuracion,
        ruta_archivo = null,
        nombre_encargado,
      } = data;
      const fromTelefono = dataAdmin.id_telefono; // Debe ser el ID del número de teléfono en WhatsApp
      const fromToken = dataAdmin.token;

      console.log(tipo_mensaje);
      let responseData = {};
      if (tipo_mensaje !== 'image') {
        // Construcción de la URL de la API
        console.log('entre');
        const url = `https://graph.facebook.com/v19.0/${fromTelefono}/messages`;

        // Datos de la petición
        const requestData = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: to,
          type: 'text',
          text: {
            preview_url: true,
            body: mensaje, // Mensaje a enviar
          },
        };

        // Encabezados de la petición
        const headers = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fromToken}`,
        };

        // Realiza la petición para enviar el mensaje
        const response = await fetch(url, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(requestData),
        });

        // Parsear la respuesta de la API
        responseData = await response.json();

        // Manejo de errores en la respuestas
        if (responseData.error) {
          console.error('Error al enviar el mensaje:', responseData.error);
          throw new Error(responseData.error.message);
        }
      }

      const wamid = responseData?.messages?.[0]?.id || null;

      const cliente = await ClientesChatCenter.findOne({
        where: {
          uid_cliente: fromTelefono,
          id_configuracion: id_configuracion,
        },
      });

      const receptor = await ClientesChatCenter.findOne({
        where: {
          celular_cliente: to,
          id_configuracion: id_configuracion,
        },
      });

      const id_cliente = cliente ? cliente.id : null;
      const id_recibe = receptor ? receptor.id : null;

      // Armar para guardar en la base de datos
      const mensajeCliente = {
        id_configuracion: dataAdmin.id,
        mid_mensaje: fromTelefono,
        tipo_mensaje: tipo_mensaje,
        rol_mensaje: 1,
        id_cliente,
        uid_whatsapp: to,
        id_wamid_mensaje: wamid,
        responsable: nombre_encargado,
        texto_mensaje: mensaje,
        celular_recibe: id_recibe,
        informacion_suficiente: 1,
        visto: 0,
        created_at: new Date(),
        updated_at: new Date(),
      };

      if (ruta_archivo !== null) {
        mensajeCliente.ruta_archivo = ruta_archivo;
      }

      // Guardar el mensaje en la base de datos
      const mensajeAgregado = await MensajesClientes.create(mensajeCliente);

      if (!mensajeAgregado) {
        throw new Error('Error al guardar el mensaje en la base de datos');
      }
      responseData.mensajeNuevo = mensajeAgregado;
      // Retorna la respuesta exitosa
      return responseData;
    } catch (error) {
      console.error('Error en la solicitud:', error);
      throw new Error('Ocurrió un error al enviar el mensaje.');
    }
  }

  async getCellphones(id_configuracion, texto) {
    try {
      const telefonos = await ClientesChatCenter.findAll({
        where: {
          id_configuracion,
          celular_cliente: {
            [Op.like]: `%${texto}%`,
          },
        },
        attributes: ['celular_cliente', 'nombre_cliente'],
      });

      return telefonos;
    } catch (error) {
      throw new AppError(error.message, 500);
    }
  }

  async getServientrega(ciudadO, ciudadD, provinciaD, monto_factura) {
    let destino;

    try {
      if (ciudadD.includes('/')) {
        destino = `${ciudadD} (${provinciaD})-${provinciaD}`;
      } else {
        destino = `${ciudadD}-${provinciaD}`;
      }

      const url =
        'https://servientrega-ecuador.appsiscore.com/app/ws/cotizador_ser_recaudo.php?wsdl';

      const xml = `
              <soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ws="https://servientrega-ecuador.appsiscore.com/app/ws/">
                  <soapenv:Header/>
                  <soapenv:Body>
                      <ws:Consultar soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
                          <producto xsi:type="xsd:string">MERCANCIA PREMIER</producto>
                          <origen xsi:type="xsd:string">${ciudadO}</origen>
                          <destino xsi:type="xsd:string">${destino}</destino>
                          <valor_mercaderia xsi:type="xsd:string">${monto_factura}</valor_mercaderia>
                          <piezas xsi:type="xsd:string">1</piezas>
                          <peso xsi:type="xsd:string">2</peso>
                          <alto xsi:type="xsd:string">10</alto>
                          <ancho xsi:type="xsd:string">50</ancho>
                          <largo xsi:type="xsd:string">50</largo>
                          <tokn xsi:type="xsd:string">1593aaeeb60a560c156387989856db6be7edc8dc220f9feae3aea237da6a951d</tokn>
                          <usu xsi:type="xsd:string">IMPCOMEX</usu>
                          <pwd xsi:type="xsd:string">Rtcom-ex9912</pwd>
                      </ws:Consultar>
                  </soapenv:Body>
              </soapenv:Envelope>
          `;

      const response = await axios.post(url, xml, {
        headers: { 'Content-Type': 'text/xml' },
      });

      console.log('Respuesta RAW:', response.data);

      const parser = new xml2js.Parser({ explicitArray: false });
      const parsed = await parser.parseStringPromise(response.data);

      // Detectar dinámicamente los prefijos
      const envelopeKey = Object.keys(parsed).find((key) =>
        key.includes('Envelope')
      );
      const bodyKey = envelopeKey
        ? Object.keys(parsed[envelopeKey]).find((key) => key.includes('Body'))
        : null;

      if (!bodyKey) {
        console.error('No se encontró el nodo Body en la respuesta SOAP');
        return {
          mensaje: 'No se pudo procesar la solicitud',
          flete: 0,
          seguro: 0,
          comision: 0,
          otros: 0,
          impuestos: 0,
        };
      }

      const resultNode =
        parsed[envelopeKey][bodyKey]['ns1:ConsultarResponse']?.Result;

      if (!resultNode) {
        console.error('No se encontró el nodo <Result>');
        return {
          mensaje: 'No se pudo procesar la solicitud',
          flete: 0,
          seguro: 0,
          comision: 0,
          otros: 0,
          impuestos: 0,
        };
      }

      // Extraer y decodificar el contenido de <Result>
      const rawResult = resultNode._; // Contenido del nodo
      const decodedResult = decode(rawResult); // Decodificar entidades HTML

      console.log('Resultado decodificado:', decodedResult);

      // Parsear el XML anidado en <Result>
      const resultParser = new xml2js.Parser({ explicitArray: false });
      const resultData = await resultParser.parseStringPromise(decodedResult);

      const data = {
        flete: parseFloat(resultData.ConsultarResult.flete || 0).toFixed(2),
        seguro: parseFloat(resultData.ConsultarResult.seguro || 0).toFixed(2),
        comision: parseFloat(
          resultData.ConsultarResult.valor_comision || 0
        ).toFixed(2),
        otros: parseFloat(resultData.ConsultarResult.otros || 0).toFixed(2),
        impuestos: parseFloat(resultData.ConsultarResult.impuesto || 0).toFixed(
          2
        ),
      };

      console.log('La data es:', data);

      return {
        mensaje: 'Procesado correctamente',
        ...data,
      };
    } catch (error) {
      console.error('Error en la solicitud SOAP:', error.message);
      return {
        mensaje: 'Error en la solicitud',
        flete: 0,
        seguro: 0,
        comision: 0,
        otros: 0,
        impuestos: 0,
      };
    }
  }

  async getFacturas(id_plataforma, telefono) {
    try {
      if (
        telefono == 'undefined' ||
        telefono == 'null' ||
        telefono == null ||
        telefono == undefined ||
        telefono == ''
      ) {
        return [];
      }

      // Normalizamos el teléfono de entrada quitando caracteres no numéricos
      const telefonoNormalizado = telefono.replace(/[^\d]/g, '');

      // Creamos las posibles variantes de formato
      const telefonoFormateado = [
        `593${telefonoNormalizado.replace(/^0+/, '')}`, // Formato con prefijo 593 y sin cero inicial
        telefonoNormalizado.replace(/^593/, ''), // Sin prefijo internacional
        telefonoNormalizado.replace(/^0+/, ''), // Solo el número sin cero inicial ni prefijo
        `0${telefonoNormalizado.replace(/^593/, '')}`, // Con cero inicial, sin prefijo internacional
      ];

      // Consultamos utilizando `Op.or` para buscar en cualquiera de los formatos generados
      const facturas = await FacturasCot.findAll({
        where: {
          id_plataforma,
          guia_enviada: 0,
          anulada: 0,
          id_plataforma: id_plataforma,
          [Op.or]: telefonoFormateado.map((formato) => ({
            telefono: {
              [Op.like]: `%${formato}%`,
            },
          })),
        },
      });

      const guias = await FacturasCot.findAll({
        where: {
          id_plataforma,
          guia_enviada: 1,

          id_plataforma: id_plataforma,
          [Op.or]: telefonoFormateado.map((formato) => ({
            telefono: {
              [Op.like]: `%${formato}%`,
            },
          })),
        },
      });

      // Iteramos sobre cada factura para agregar sus productos
      for (const factura of facturas) {
        const productos = await db.query(
          `SELECT * FROM vista_productos_2 WHERE numero_factura = :numero_factura`,
          {
            replacements: { numero_factura: factura.numero_factura },
            type: Sequelize.QueryTypes.SELECT,
          }
        );

        // Añadimos los productos al objeto de la factura
        factura.dataValues.productos = productos;
      }

      for (const guia of guias) {
        const productos = await db.query(
          `SELECT * FROM vista_productos_2 WHERE numero_factura = :numero_factura`,
          {
            replacements: { numero_factura: guia.numero_factura },
            type: Sequelize.QueryTypes.SELECT,
          }
        );

        // Añadimos los productos al objeto de la factura
        guia.dataValues.productos = productos;
      }

      return { facturas, guias };
    } catch (error) {
      throw new AppError(error.message, 500);
    }
  }

  async getNovedades(id_plataforma, telefono) {
    try {
      if (
        telefono == 'undefined' ||
        telefono == 'null' ||
        telefono == null ||
        telefono == undefined ||
        telefono == ''
      ) {
        return { gestionadas: [], no_gestionadas: [] };
      }

      const telefonoNormalizado = telefono.replace(/[^\d]/g, '');

      const baseSQL = `
      SELECT 
        nvd.guia_novedad as guia_novedad,
        nvd.solucionada as solucionada,
        nvd.estado_novedad as estado_novedad,
        nvd.terminado as terminado,
        nvd.cliente_novedad as cliente_novedad,
        nvd.tracking as tracking,
        nvd.novedad as novedad,
        nvd.id_novedad as id_novedad
      FROM novedades nvd 
      INNER JOIN facturas_cot fc ON fc.numero_guia = nvd.guia_novedad
      WHERE nvd.id_plataforma = :id_plataforma
      AND fc.telefono_limpio = :telefono
      AND NOT (
        (nvd.guia_novedad LIKE 'IMP%' OR nvd.guia_novedad LIKE 'MKP%') 
        AND nvd.estado_novedad IN (
          97, 108, 118, 57, 44, 56, 53, 52, 123, 121, 51, 10,
          54, 119, 109, 55, 99, 120, 104, 122, 93, 111, 3, 8,
          98, 15, 113
        )
      )
      AND NOT (
        nvd.guia_novedad LIKE 'I00%' AND nvd.estado_novedad = 6
      )
    `;
      const no_gestionadasSQL = `${baseSQL} AND (nvd.solucionada = 0 AND nvd.terminado = 0)`;

      // No gestionadas (sin condición adicional)
      const no_gestionadas = await db.query(no_gestionadasSQL, {
        replacements: {
          id_plataforma,
          telefono: telefonoNormalizado,
        },
        type: Sequelize.QueryTypes.SELECT,
      });

      // Gestionadas (con condición adicional)
      const gestionadasSQL = `${baseSQL} AND (nvd.solucionada = 1 OR nvd.terminado = 1)`;

      const gestionadas = await db.query(gestionadasSQL, {
        replacements: {
          id_plataforma,
          telefono: telefonoNormalizado,
        },
        type: Sequelize.QueryTypes.SELECT,
      });

      return { gestionadas, no_gestionadas };
    } catch (error) {
      throw new AppError(error.message, 500);
    }
  }

  async getProvincias() {
    try {
      const provincias = await ProvinciaLaar.findAll({
        distinct: true,
        where: {
          id_pais: 1,
        },
        attributes: ['id_prov', 'codigo_provincia', 'provincia'],
      });
      return provincias;
    } catch (error) {
      throw new AppError(error.message, 500);
    }
  }

  async getCiudades(codigo_provincia) {
    try {
      const ciudades = await CiudadCotizacion.findAll({
        where: {
          codigo_provincia_laar: codigo_provincia,
        },
        attributes: ['id_cotizacion', 'ciudad'],
      });

      return ciudades;
    } catch (error) {
      throw new AppError(error.message, 500);
    }
  }

  async seenMessage(chatId, id_plataforma) {
    try {
      const mensajes = await MensajesClientes.update(
        { visto: 1 },
        {
          where: {
            celular_recibe: chatId,
            id_plataforma,
            visto: 0,
          },
        }
      );

      return mensajes;
    } catch (error) {
      throw new AppError(error.message, 500);
    }
  }

  async sendAudio(data) {}

  async getTarifas(ciudadId, montoFactura, recuado, id_plataforma) {
    try {
      // Consulta para obtener los datos de la ciudad
      const ciudadData = await CiudadCotizacion.findOne({
        where: { id_cotizacion: ciudadId },
        attributes: [
          'trayecto_laar',
          'trayecto_servientrega',
          'trayecto_gintracom',
          'ciudad',
          'cobertura_servientrega',
          'cobertura_gintracom',
          'cobertura_laar',
        ],
      });

      if (!ciudadData) throw new Error('Datos de ciudad no encontrados.');

      const {
        trayecto_laar,
        trayecto_servientrega,
        trayecto_gintracom,
        ciudad,
      } = ciudadData;

      // Consultas para obtener los precios de cobertura según los trayectos
      const precioLaarResult = await CoberturaLaar.findOne({
        where: { tipo_cobertura: trayecto_laar },
      });

      const precioServientregaResult = await CoberturaServientrega.findOne({
        where: { tipo_cobertura: trayecto_servientrega },
      });

      const precioGintracomResult = await CoberturaGintracom.findOne({
        where: { trayecto: trayecto_gintracom },
      });

      // Asignar precios o 0 si no se encontraron resultados
      let precioLaar = precioLaarResult ? precioLaarResult.precio : 0;
      let precioServientrega = precioServientregaResult
        ? precioServientregaResult.precio
        : 0;
      let precioGintracom = precioGintracomResult
        ? precioGintracomResult.precio
        : 0;

      // Revisar coberturas y asignar 0 si no están disponibles
      if (ciudadData.cobertura_servientrega === 0) {
        precioServientrega = 0;
      }
      if (ciudadData.cobertura_gintracom === 0) {
        precioGintracom = 0;
      }
      if (ciudadData.cobertura_laar === 0) {
        precioLaar = 0;
      }

      let tarifas = {
        laar: precioLaar,
        servientrega: precioServientrega,
        gintracom: precioGintracom,
      };

      // Obtener el valor de la matriz
      const matrizData = await this.obtenerMatriz(id_plataforma);
      const matriz = matrizData[0] ? matrizData[0].idmatriz : null;

      // Cálculo de "previo" con monto de factura
      let previo = montoFactura * 0.03;
      let previoServientrega = montoFactura * 0.03;
      if (previoServientrega < 1.35) previoServientrega = 1.35;

      console.log(previoServientrega);
      console.log(tarifas.servientrega);

      // Aplicación de lógica condicional para cada tarifa según el trayecto y el recuado
      if (trayecto_laar && trayecto_laar !== '0') {
        tarifas.laar += recuado === '1' ? previo : 0;
        if (matriz === 2) tarifas.laar = 5.99;
      } else {
        tarifas.laar = 0;
      }

      if (trayecto_gintracom && trayecto_gintracom !== '0') {
        tarifas.gintracom += recuado === '1' ? previo : 0;
        if (id_plataforma === 1206) tarifas.gintracom -= 0.5;
      } else {
        tarifas.gintracom = 0;
      }

      if (trayecto_servientrega && trayecto_servientrega !== '0') {
        tarifas.servientrega += recuado === '1' ? previoServientrega : 0;
        if (ciudad === 'QUITO' && recuado !== '1') tarifas.servientrega = 4.97;
      } else {
        tarifas.servientrega = 0;
      }

      console.log(tarifas.servientrega);

      // Aplicación de tarifas "speed" según la ciudad y plataforma
      const speedTarifas = {
        QUITO: 5.5,
        'VALLE DE LOS CHILLOS': 6.5,
        CUMBAYA: 6.5,
        TUMBACO: 6.5,
        SANGOLQUI: 6.5,
        PIFO: 6.5,
        'SAN RAFAEL': 6.5,
        CONOCOTO: 6.5,
        GUAYAQUIL: id_plataforma === 1206 ? 5.5 : 0,
        DAULE: id_plataforma === 1206 ? 6.5 : 0,
        SAMBORONDON: id_plataforma === 1206 ? 6.5 : 0,
        'LA PUNTILLA/GUAYAS': id_plataforma === 1206 ? 6.5 : 0,
      };

      tarifas.speed = speedTarifas[ciudad] || 0;

      if (ciudadData.cobertura_servientrega === 0) {
        tarifas.servientrega = 0;
      }
      if (ciudadData.cobertura_gintracom === 0) {
        tarifas.gintracom = 0;
      }
      if (ciudadData.cobertura_laar === 0) {
        tarifas.laar = 0;
      }

      // Formato de los valores de tarifas a 2 decimales
      tarifas.laar = parseFloat(tarifas.laar.toFixed(2));
      tarifas.servientrega = parseFloat(tarifas.servientrega.toFixed(2));
      tarifas.gintracom = parseFloat(tarifas.gintracom.toFixed(2));

      return tarifas;
    } catch (error) {
      throw new AppError(error.message, 500);
    }
  }

  /**
   * Obtiene la ciudad y la provincia según el id_cotizacion
   * @param {number|string} id - id_cotizacion de ciudad_cotizacion
   * @returns {Promise<{ciudad:string, provincia:string}|null>}
   */
  static async obtenerCiudadProvincia(id) {
    try {
      const data = await CiudadCotizacion.findOne({
        where: { id_cotizacion: id },
        attributes: ['ciudad', 'provincia'],
      });
      return data;
    } catch (err) {
      throw new AppError(err.message, 500);
    }
  }

  async obtenerMatriz(id_plataforma) {
    try {
      const matriz = await db.query(
        `SELECT id_matriz FROM plataformas WHERE id_plataforma = :id_plataforma`,
        {
          replacements: { id_plataforma },
          type: Sequelize.QueryTypes.SELECT,
        }
      );

      return matriz;
    } catch (error) {
      throw new AppError(error.message, 500);
    }
  }

  async findChatByPhone(id_plataforma, phone) {
    try {
      const sql = `
        SELECT *
        FROM vista_chats_materializada
        WHERE id_plataforma   = :id_plataforma
          AND celular_cliente = :phone
        ORDER BY mensaje_created_at DESC, id DESC
        LIMIT 1
      `;

      const [chat] = await db.query(sql, {
        replacements: { id_plataforma, phone },
        type: Sequelize.QueryTypes.SELECT,
      });

      return chat || null; // null si no existe
    } catch (err) {
      throw new AppError(err.message, 500);
    }
  }

  async findChatByPhone_desconect(id_configuracion, phone) {
    try {
      const sql = `
        SELECT *
        FROM chats_4
        WHERE id_configuracion   = :id_configuracion
          AND celular_cliente = :phone
        ORDER BY mensaje_created_at DESC, id DESC
        LIMIT 1
      `;

      const [chat] = await db.query(sql, {
        replacements: { id_configuracion, phone },
        type: Sequelize.QueryTypes.SELECT,
      });

      return chat || null; // null si no existe
    } catch (err) {
      throw new AppError(err.message, 500);
    }
  }
}

module.exports = ChatService;
