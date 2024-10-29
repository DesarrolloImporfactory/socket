const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const MensajesClientes = require('../models/mensaje_cliente.model');

let io; // Variable global para almacenar el socket.io

exports.setSocketIo = (ioInstance) => {
  io = ioInstance;
};

exports.webhook = catchAsync(async (req, res, next) => {
  try {
    const { id_plataforma, celular_recibe } = req.body;

    // Obtener el último mensaje del cliente
    const ultimoMensaje = await MensajesClientes.findOne({
      where: {
        id_plataforma,
        celular_recibe,
      },
      order: [['created_at', 'DESC']],
    });

    // Emitir el mensaje recibido a través del socket
    if (io) {
      io.emit('RECEIVED_MESSAGE', {
        id_plataforma,
        celular_recibe,
        ultimoMensaje,
      });
    }
    // Enviar una respuesta al Webhook
    return res.status(200).json({ message: 'Mensaje recibido y emitido' });
  } catch (error) {
    console.error('Error al guardar el chat:', error.message);
    return res.status(500).json({ message: 'Error al procesar el mensaje' });
  }
});
