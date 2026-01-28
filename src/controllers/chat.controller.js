const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const MensajesClientes = require('../models/mensaje_cliente.model');
const ClientesChatCenter = require('../models/clientes_chat_center.model');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');

let io;

exports.setSocketIo = (ioInstance) => {
  io = ioInstance;
};

exports.webhook = catchAsync(async (req, res, next) => {
  try {
    const { id_configuracion, celular_recibe } = req.body;

    const ultimoMensaje = await MensajesClientes.findOne({
      where: { id_configuracion, celular_recibe },
      include: [
        {
          model: ClientesChatCenter,
          as: 'clientePorCelular',
          attributes: ['celular_cliente', 'nombre_cliente', 'id_encargado'],
        },
      ],
      order: [['created_at', 'DESC']],
    });

    // Si existe el cliente relacionado y tiene id_encargado, buscamos el subusuario
    const idEncargado = ultimoMensaje?.clientePorCelular?.id_encargado;

    let nombreEncargado = null;

    if (idEncargado) {
      const subUsuarioDB = await Sub_usuarios_chat_center.findByPk(
        idEncargado,
        {
          attributes: ['nombre_encargado'],
        },
      );

      nombreEncargado = subUsuarioDB?.nombre_encargado ?? null; // ajusta el campo
    }

    // Adjuntarlo al mismo nivel dentro de clientePorCelular (junto a id_encargado)
    if (ultimoMensaje?.clientePorCelular) {
      // OJO: si es instancia Sequelize, usa setDataValue para que quede "bien"
      ultimoMensaje.clientePorCelular.setDataValue(
        'nombre_encargado',
        nombreEncargado,
      );
      // alternativa simple (también suele funcionar al enviar JSON):
      // ultimoMensaje.clientePorCelular.nombre_encargado = nombreEncargado;
    }

    io.emit('UPDATE_CHAT', {
      id_configuracion,
      chatId: celular_recibe,
      source: ultimoMensaje.source || 'wa',
      message: ultimoMensaje,
    });

    return res.status(200).json({
      message: 'Mensaje recibido y emitido',
      ultimoMensaje,
    });
  } catch (error) {
    console.error('Error completo:', error);
    return res.status(500).json({ message: 'Error al procesar el mensaje' });
  }
});
