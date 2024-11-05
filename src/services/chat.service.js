const { Op, Sequelize } = require('sequelize');
const AppError = require('../utils/appError');
const MensajesClientes = require('../models/mensaje_cliente.model');
const ClientesChatCenter = require('../models/clientes_chat_center.model');
const EtiquetasChatCenter = require('../models/etiquetas_chat_center.model');
const Configuraciones = require('../models/configuraciones.model');
const TemplatesChatCenter = require('../models/templates_chat_center.model');
const { db } = require('../database/config');
const FacturasCot = require('../models/facturas_cot.model');
const DetalleFactCot = require('../models/detalle_fact_cot.model');
const ProvinciaLaar = require('../models/provincia_laar.model');
const CiudadCotizacion = require('../models/ciudad_cotizacion.model');
class ChatService {
  async findChats(id_plataforma) {
    try {
      // Obtener número del dueño de la plataforma
      const configuraciones = await Configuraciones.findOne({
        where: {
          id_plataforma,
        },
        attributes: ['telefono'],
      });

      const numero = configuraciones ? configuraciones.telefono : null;

      // Asegúrate de que 'numero' no sea null o undefined
      if (!numero) {
        throw new AppError(
          'El número de teléfono para excluir no se encontró.',
          500
        );
      }

      // Realiza la consulta para obtener los chats excluyendo el número específico
      const chats = await db.query(
        `
        SELECT * FROM vista_chats
        WHERE id_plataforma = :id_plataforma
          AND celular_cliente != :numero
        ORDER BY mensaje_created_at DESC;
      `,
        {
          replacements: { id_plataforma: id_plataforma, numero: numero },
          type: Sequelize.QueryTypes.SELECT,
        }
      );

      return chats;
    } catch (error) {
      throw new AppError(error.message, 500);
    }
  }

  async getChatsByClient(id_cliente, id_plataforma) {
    try {
      const chats = await ClientesChatCenter.findAll({
        include: [
          {
            model: MensajesClientes,
            as: 'mensajes',
            where: {
              celular_recibe: id_cliente,
              id_plataforma: id_plataforma,
            },
            attributes: [
              'texto_mensaje',
              'created_at',
              'ruta_archivo',
              'visto',
              'tipo_mensaje',
              'id',
              'rol_mensaje',
            ],
            order: [['created_at', 'ASC']], // Ordenar los mensajes por fecha de creación ascendente
          },
        ],
      });

      return chats;
    } catch (error) {
      console.error('Error al obtener los chats:', error.message);
      throw error;
    }
  }

  async getTemplates(id_plataforma, palabraClave) {
    try {
      // Realiza la consulta para obtener los templates filtrados
      const templates = await TemplatesChatCenter.findAll({
        where: {
          id_plataforma,
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

  async getDataAdmin(id_plataforma) {
    try {
      const configuraciones = await Configuraciones.findOne({
        where: {
          id_plataforma,
        },
        attributes: ['id_telefono', 'token', 'id_plataforma', 'id_whatsapp'],
      });

      return configuraciones;
    } catch (error) {
      throw new AppError(error.message, 500);
    }
  }

  async sendMessage(data) {
    try {
      const { mensaje, to, dataAdmin } = data;
      const fromTelefono = dataAdmin.id_telefono; // Debe ser el ID del número de teléfono en WhatsApp
      const fromToken = dataAdmin.token;

      // Construcción de la URL de la API
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
      const responseData = await response.json();

      // Manejo de errores en la respuesta
      if (responseData.error) {
        console.error('Error al enviar el mensaje:', responseData.error);
        throw new Error(responseData.error.message);
      }

      const cliente = await ClientesChatCenter.findOne({
        where: {
          uid_cliente: fromTelefono,
        },
      });

      const receptor = await ClientesChatCenter.findOne({
        where: {
          celular_cliente: to,
        },
      });

      const id_cliente = cliente ? cliente.id : null;
      const id_recibe = receptor ? receptor.id : null;

      // Armar para guardar en la base de datos
      const mensajeCliente = {
        id_plataforma: dataAdmin.id_plataforma,
        mid_mensaje: fromTelefono,
        tipo_mensaje: 'text',
        rol_mensaje: 1,
        id_cliente,
        uid_whatsapp: to,
        texto_mensaje: mensaje,
        celular_recibe: id_recibe,
        informacion_suficiente: 1,
        visto: 0,
        created_at: new Date(),
        updated_at: new Date(),
      };

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

  async getCellphones(id_plataforma, texto) {
    try {
      const telefonos = await ClientesChatCenter.findAll({
        where: {
          id_plataforma,
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

  async getFacturas(id_plataforma, telefono) {
    try {
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
          [Op.or]: telefonoFormateado.map((formato) => ({
            telefono: {
              [Op.like]: `%${formato}%`,
            },
          })),
        },
        include: [
          {
            model: DetalleFactCot,
            as: 'detalles',
            attributes: ['id_inventario', 'cantidad', 'precio_venta'],
          },
        ],
      });

      return facturas;
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
}

module.exports = ChatService;
