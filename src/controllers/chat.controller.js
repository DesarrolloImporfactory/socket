const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const MensajesClientes = require('../models/mensaje_cliente.model');
const ClientesChatCenter = require('../models/clientes_chat_center.model');

let io; // Variable global para almacenar el socket.io

exports.setSocketIo = (ioInstance) => {
  io = ioInstance;
};

exports.webhook = catchAsync(async (req, res, next) => {
  try {
    const { id_configuracion, celular_recibe } = req.body;

    // Obtener el último mensaje del cliente
    const ultimoMensaje = await MensajesClientes.findOne({
      where: {
        id_configuracion,
        celular_recibe,
      },
      include: [
        {
          model: ClientesChatCenter,
          as: 'clientePorCelular',
          attributes: ['celular_cliente', 'nombre_cliente', 'id_encargado'],
        },
      ],
      order: [['created_at', 'DESC']],
    });

    // Emitir el mensaje recibido a través del socket
    // if (io) {
    //   io.emit('RECEIVED_MESSAGE', {
    //     id_configuracion,
    //     celular_recibe,
    //     ultimoMensaje,
    //   });
    // }

    io.emit('UPDATE_CHAT', {
      id_configuracion,
      chatId: celular_recibe, // que en su caso es el id del chat (ccc.id)
      source: ultimoMensaje.source || 'wa',
      message: ultimoMensaje,
    });

    // Enviar una respuesta al Webhook
    return res.status(200).json({
      message: 'Mensaje recibido y emitido',
      ultimoMensaje: ultimoMensaje,
    });
  } catch (error) {
    console.error('Error completo:', error); // Muestra todo el stack
    return res.status(500).json({ message: 'Error al procesar el mensaje' });
  }
});
