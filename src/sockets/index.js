const ChatService = require('../services/chat.service');
const fb = require('../utils/facebookGraph');
const ig = require('../utils/instagramGraph');
const { listOrdersForClient } = require('../services/dropiOrders.service');

const onlineUsers = [];

class Sockets {
  constructor(io) {
    this.io = io;
    this.socketEvents();
  }

  addUser(user, socketId) {
    const exists = onlineUsers.find((u) => u.id === user.id);
    if (!exists) {
      onlineUsers.push({ ...user, socketId });
    }
  }

  removeUser(socketId) {
    const index = onlineUsers.findIndex((user) => user.socketId === socketId);
    if (index !== -1) {
      onlineUsers.splice(index, 1); // Eliminar usuario desconectado
    }
  }

  socketEvents() {
    this.io.on('connection', (socket) => {
      socket.on('ADD_USER', (data) => {
        this.addUser(data, socket.id);
        this.io.emit('USER_ADDED', onlineUsers);
      });

      socket.on(
        'GET_CHATS',
        async (
          id_configuracion,
          id_sub_usuario,
          rol,
          { cursorFecha, cursorId, limit = 10, filtros = {}, scopeChats },
        ) => {
          try {
            const chatService = new ChatService();

            const chats = await chatService.findChats(
              id_configuracion,
              id_sub_usuario,
              rol,
              {
                cursorFecha,
                cursorId,
                limit,
                filtros,
                scopeChats,
              },
            );

            socket.emit('CHATS', chats);
          } catch (error) {
            console.error('Error al obtener los chats 2:', error);
            socket.emit('ERROR', { message: 'Error al obtener los chats' });
          }
        },
      );

      socket.on('GET_CHATS_BOX', async ({ chatId, id_configuracion }) => {
        try {
          const chatService = new ChatService();
          const chat = await chatService.getChatsByClient(
            chatId,
            id_configuracion,
          );
          // Enviar el chat al cliente que hizo la solicitud
          socket.emit('CHATS_BOX_RESPONSE', chat);
        } catch (error) {
          console.error('Error al obtener los chats 3:', error.message);

          // Enviar mensaje de error al cliente en caso de fallo
          socket.emit('ERROR_RESPONSE', {
            message: 'Error al obtener los chats. Intenta de nuevo más tarde.',
          });
        }
      });

      socket.on('GET_TEMPLATES', async ({ id_configuracion, palabraClave }) => {
        try {
          const chatService = new ChatService();
          const templates = await chatService.getTemplates(
            id_configuracion,
            palabraClave,
          );

          // Enviar los templates al cliente que hizo la solicitud
          socket.emit('TEMPLATES_RESPONSE', templates);
        } catch (error) {
          console.error('Error al obtener los templates:', error.message);

          // Enviar mensaje de error al cliente en caso de fallo
          socket.emit('ERROR_RESPONSE', {
            message:
              'Error al obtener los templates. Intenta de nuevo más tarde.',
          });
        }
      });

      socket.on('GET_DATA_ADMIN', async (id_configuracion) => {
        try {
          const chatService = new ChatService();
          const data = await chatService.getDataAdmin(id_configuracion);

          // Enviar los datos al cliente que hizo la solicitud
          socket.emit('DATA_ADMIN_RESPONSE', data);
        } catch (error) {
          console.error(
            'Error al obtener los datos del admin GET_DATA_ADMIN:',
            error.message,
          );

          // Enviar mensaje de error al cliente en caso de fallo
          socket.emit('ERROR_RESPONSE', {
            message:
              'Error al obtener los datos del admin. Intenta de nuevo más tarde.',
          });
        }
      });

      socket.on('GET_CELLPHONES', async ({ id_configuracion, texto }) => {
        try {
          const chatService = new ChatService();

          const data = await chatService.getCellphones(id_configuracion, texto);

          // Enviar los datos al cliente que hizo la solicitud
          socket.emit('DATA_CELLPHONE_RESPONSE', data);
        } catch (error) {
          console.error(
            'Error al obtener los datos del admin GET_CELLPHONES:',
            error.message,
          );

          // Enviar mensaje de error al cliente en caso de fallo
          socket.emit('ERROR_RESPONSE', {
            message:
              'Error al obtener los datos del admin. Intenta de nuevo más tarde.',
          });
        }
      });

      socket.on(
        'GET_SERVIENTREGA',
        async ({ ciudadO, ciudadD, provinciaD, monto_factura }) => {
          try {
            const chatService = new ChatService();

            ciudadD = await chatService.getNombre(ciudadD, 'ciudad');
            ciudadO = await chatService.getNombre(ciudadO, 'ciudad');
            provinciaD = await chatService.getNombre(provinciaD, 'provincia');
            const data = await chatService.getServientrega(
              ciudadO.ciudad,
              ciudadD.ciudad,
              provinciaD.provincia,
              monto_factura,
            );

            // Enviar los datos al cliente que hizo la solicitud
            socket.emit('DATA_SERVIENTREGA_RESPONSE', data);
          } catch (error) {
            console.log('Error al solicitar la petición servi: ' + error);
          }
        },
      );

      socket.on(
        'GET_TARIFAS',
        async ({
          ciudad,
          provincia,
          id_plataforma,
          monto_factura,
          recaudo,
        }) => {
          try {
            const chatService = new ChatService();
            const data = await chatService.getTarifas(
              ciudad,
              monto_factura,
              recaudo,
              id_plataforma,
            );
            // Enviar los datos al cliente que hizo la solicitud
            socket.emit('DATA_TARIFAS_RESPONSE', data);
          } catch (error) {
            console.error(
              'Error al obtener los datos DATA_TARIFAS_RESPONSE:',
              error.message,
            );

            // Enviar mensaje de error al cliente en caso de fallo
            socket.emit('ERROR_RESPONSE', {
              message: 'Error al obtener los datos del admin. ' + error.message,
            });
          }
        },
      );

      socket.on('GET_DROPI_ORDERS_BY_CLIENT', async (payload) => {
        try {
          const { id_configuracion, phone, ...rest } = payload || {};

          if (!id_configuracion)
            throw new AppError('id_configuracion es requerido', 400);
          if (!phone) throw new AppError('phone es requerido', 400);

          const data = await listOrdersForClient({
            id_configuracion: Number(id_configuracion),
            phone,
            body: rest, // { result_number, filter_date_by, from, until, status... }
          });

          socket.emit('DROPI_ORDERS_BY_CLIENT', { isSuccess: true, data });
        } catch (e) {
          socket.emit('DROPI_ORDERS_BY_CLIENT_ERROR', {
            isSuccess: false,
            message: e?.message || 'Error consultando órdenes',
          });
        }
      });

      socket.on('GET_PROVINCIAS', async () => {
        try {
          const chatService = new ChatService();
          const data = await chatService.getProvincias();

          // Enviar los datos al cliente que hizo la solicitud
          socket.emit('DATA_PROVINCIAS_RESPONSE', data);
        } catch (error) {
          console.error(
            'Error al obtener los datos del admin DATA_PROVINCIAS_RESPONSE:',
            error.message,
          );

          // Enviar mensaje de error al cliente en caso de fallo
          socket.emit('ERROR_RESPONSE', {
            message:
              'Error al obtener los datos del admin. Intenta de nuevo más tarde.',
          });
        }
      });

      socket.on('GET_CIUDADES', async (id_provincia) => {
        try {
          const chatService = new ChatService();
          const data = await chatService.getCiudades(id_provincia);

          // Enviar los datos al cliente que hizo la solicitud
          socket.emit('DATA_CIUDADES_RESPONSE', data);
        } catch (error) {
          console.error(
            'Error al obtener los datos del admin DATA_CIUDADES_RESPONSE:',
            error.message,
          );
        }
      });

      socket.on('connect_error', (err) => {
        // the reason of the error, for example "xhr poll error"
        console.log(err.message);

        // some additional description, for example the status code of the initial HTTP response
        console.log(err.description);

        // some additional context, for example the XMLHttpRequest object
        console.log(err.context);
      });

      socket.on('SEEN_MESSAGE', async ({ celular_recibe, plataforma }) => {
        try {
          const chatService = new ChatService();
          const message = await chatService.seenMessage(
            celular_recibe,
            plataforma,
          );

          // Emitir evento para actualizar el chat en tiempo real
          // cuando se recibe un mensaje o se marca visto o se inserta en BD:
          this.io.emit('UPDATE_CHAT', {
            id_configuracion,
            chatId, // <= el id real del chat (clientes_chat_center.id o conversation_id)
            source, // 'wa'|'ig'|'ms'
            message: {
              id: lastMessage.id,
              created_at: lastMessage.created_at,
              texto_mensaje: lastMessage.texto_mensaje,
              tipo_mensaje: lastMessage.tipo_mensaje,
              ruta_archivo: lastMessage.ruta_archivo,
              rol_mensaje: lastMessage.rol_mensaje,
              direction: lastMessage.direction,
              status_unificado: lastMessage.status_unificado,
            },
          });
        } catch (error) {
          console.error(
            'Error al marcar el mensaje como visto:',
            error.message,
          );

          // Enviar mensaje de error al cliente en caso de fallo
          socket.emit('ERROR_RESPONSE', {
            message:
              'Error al marcar el mensaje como visto. Intenta de nuevo más tarde.',
          });
        }
      });

      socket.on('SAVE_AUDIO', async (data) => {
        try {
          const chatService = new ChatService();
          const audio = await chatService.saveAudio(data);

          // Enviar el audio al cliente que hizo la solicitud
          socket.emit('AUDIO_RESPONSE', audio);
        } catch (error) {
          console.error('Error al guardar el audio:', error.message);

          // Enviar mensaje de error al cliente en caso de fallo
          socket.emit('ERROR_RESPONSE', {
            message: 'Error al guardar el audio. Intenta de nuevo más tarde.',
          });
        }
      });

      socket.on('SEND_IMAGE', async (data) => {});

      socket.on(
        'QUITAR_MENSAJE',
        async ({ id_configuracion, celular_recibe }) => {
          const chatService = new ChatService();

          const data = await chatService.getDataAsignar(
            id_configuracion,
            celular_recibe,
          );

          this.io.emit('QUITAR_MENSAJE_RESPONSE', data);
        },
      );

      socket.on(
        'ASIGNAR_ENCARGADO',
        async ({ id_encargado, id_cliente_chat_center, id_configuracion }) => {
          try {
            const chatService = new ChatService();

            const result = await chatService.setDataAsignar(
              id_encargado,
              id_cliente_chat_center,
              id_configuracion,
            );

            // respuesta al que lo pidió
            socket.emit('ASIGNAR_ENCARGADO_RESPONSE', result);

            if (result.status !== 'success') return;

            const payload = result.data; // ultimoMensaje + clientePorCelular + nombre_encargado

            // opción simple:
            this.io.emit('ENCARGADO_CHAT_ACTUALIZADO', payload);
          } catch (err) {
            socket.emit('ASIGNAR_ENCARGADO_RESPONSE', {
              status: 'error',
              message: err.message ?? 'Error inesperado al asignar',
            });
          }
        },
      );

      socket.on('disconnect', () => {
        this.removeUser(socket.id);
        this.io.emit('USER_ADDED', onlineUsers); // Actualizar lista
      });
    });
  }
}

module.exports = Sockets;
