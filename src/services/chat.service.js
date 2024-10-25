const { Op, Sequelize } = require('sequelize');
const AppError = require('../utils/appError');
const MensajesClientes = require('../models/mensaje_cliente.model');
const ClientesChatCenter = require('../models/clientes_chat_center.model');
const EtiquetasChatCenter = require('../models/etiquetas_chat_center.model');
const Configuraciones = require('../models/configuraciones.model');

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
      const chats = await ClientesChatCenter.findAll({
        where: {
          id_plataforma,
          celular_cliente: {
            [Op.ne]: numero, // Filtra clientes cuyo número no sea el del dueño
          },
        },
        attributes: [
          'nombre_cliente',
          'apellido_cliente',
          'celular_cliente',
          'id',
          [
            Sequelize.literal(`(
              SELECT MAX(mc1.created_at) 
              FROM mensajes_clientes AS mc1 
              WHERE mc1.celular_recibe = clientes_chat_center.id 
              AND (mc1.rol_mensaje = 0 OR mc1.rol_mensaje = 1) 
              AND mc1.created_at IS NOT NULL
            )`),
            'mensaje_created_at',
          ],
          [
            Sequelize.literal(`(
              SELECT COUNT(*)
              FROM mensajes_clientes AS mc1
              WHERE mc1.celular_recibe = clientes_chat_center.id 
              AND mc1.rol_mensaje = 0 
              AND mc1.visto = 0
            )`),
            'mensajes_pendientes',
          ],
          [
            Sequelize.literal(`(
              SELECT mc1.texto_mensaje 
              FROM mensajes_clientes AS mc1 
              WHERE mc1.celular_recibe = clientes_chat_center.id 
              AND (mc1.rol_mensaje = 0 OR mc1.rol_mensaje = 1)
              ORDER BY mc1.created_at DESC
              LIMIT 1
            )`),
            'texto_mensaje',
          ],
          [Sequelize.col('etiqueta.color_etiqueta'), 'color_etiqueta'],
        ],
        include: [
          {
            model: EtiquetasChatCenter,
            as: 'etiqueta',
            required: false,
            attributes: [],
          },
        ],
        group: ['clientes_chat_center.id'],
        order: [[Sequelize.literal('mensaje_created_at'), 'DESC']],
      });
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
}

module.exports = ChatService;
