const ChatService = require('../services/chat.service');
const {
  listOrdersForClient,
  createOrderForClient,
  updateOrderForClient,
} = require('../services/dropiOrders.service');
const AppError = require('../utils/appError');
const dropiService = require('../services/dropi.service');
const DropiIntegrations = require('../models/dropi_integrations.model');
const { decryptToken } = require('../utils/cryptoToken');

const onlineUsers = [];

async function getActiveIntegration(id_configuracion) {
  return DropiIntegrations.findOne({
    where: { id_configuracion, deleted_at: null, is_active: 1 },
    order: [['id', 'DESC']],
  });
}

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function strOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.trim().length ? s.trim() : null;
}

class Sockets {
  constructor(io) {
    this.io = io;
    global.io = io;
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

  getProgramadosRoom(id_configuracion, id_cliente_chat_center) {
    const idCfg = Number(id_configuracion);
    const idCli = Number(id_cliente_chat_center);

    if (!idCfg || !idCli) return null;
    return `chat_programados:${idCfg}:${idCli}`;
  }

  emitProgramadoEstadoToRoom(payload = {}) {
    try {
      const room = this.getProgramadosRoom(
        payload.id_configuracion,
        payload.id_cliente_chat_center,
      );

      if (!room) return;

      this.io.to(room).emit('PROGRAMADO_ESTADO', payload);
    } catch (e) {
      console.warn('emitProgramadoEstadoToRoom error:', e.message);
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

      socket.on(
        'JOIN_PROGRAMADOS_CHAT',
        ({ id_configuracion, id_cliente_chat_center }) => {
          try {
            const room = this.getProgramadosRoom(
              id_configuracion,
              id_cliente_chat_center,
            );

            if (!room) {
              return socket.emit('ERROR_RESPONSE', {
                message: 'JOIN_PROGRAMADOS_CHAT: parámetros inválidos',
              });
            }

            socket.join(room);

            socket.emit('JOIN_PROGRAMADOS_CHAT_OK', {
              ok: true,
              room,
              id_configuracion: Number(id_configuracion),
              id_cliente_chat_center: Number(id_cliente_chat_center),
            });
          } catch (e) {
            socket.emit('ERROR_RESPONSE', {
              message: `Error al unirse al room de programados: ${e.message}`,
            });
          }
        },
      );

      socket.on(
        'LEAVE_PROGRAMADOS_CHAT',
        ({ id_configuracion, id_cliente_chat_center }) => {
          try {
            const room = this.getProgramadosRoom(
              id_configuracion,
              id_cliente_chat_center,
            );

            if (!room) return;

            socket.leave(room);

            socket.emit('LEAVE_PROGRAMADOS_CHAT_OK', {
              ok: true,
              room,
            });
          } catch (e) {
            socket.emit('ERROR_RESPONSE', {
              message: `Error al salir del room de programados: ${e.message}`,
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

      socket.on('GET_DROPI_PRODUCTS', async (payload) => {
        try {
          const id_configuracion = toInt(payload?.id_configuracion);
          if (!id_configuracion)
            throw new AppError('id_configuracion es requerido', 400);

          const integration = await getActiveIntegration(id_configuracion);
          if (!integration)
            throw new AppError('No existe una integración Dropi activa', 404);

          const integrationKey = decryptToken(integration.integration_key_enc);
          if (!integrationKey) throw new AppError('Dropi key inválida', 400);

          const body = payload || {};

          const dropiPayload = {
            pageSize: toInt(body.pageSize) || 50,
            startData: toInt(body.startData) ?? 0,
            no_count: body.no_count === false ? false : true,
            order_by: strOrNull(body.order_by) || 'id',
            order_type: strOrNull(body.order_type) || 'asc',
            keywords: String(body.keywords || ''),
          };

          if (Array.isArray(body.category) && body.category.length)
            dropiPayload.category = body.category;
          if (typeof body.favorite === 'boolean')
            dropiPayload.favorite = body.favorite;
          if (typeof body.privated_product === 'boolean')
            dropiPayload.privated_product = body.privated_product;

          const data = await dropiService.listProductsIndex({
            integrationKey,
            payload: dropiPayload,
          });

          socket.emit('DROPI_PRODUCTS_OK', { isSuccess: true, data });
        } catch (e) {
          socket.emit('DROPI_PRODUCTS_ERROR', {
            isSuccess: false,
            message: e?.message || 'Error obteniendo productos',
          });
        }
      });

      socket.on('GET_DROPI_STATES', async (payload) => {
        try {
          const id_configuracion = toInt(payload?.id_configuracion);
          const country_id = toInt(payload?.country_id) ?? 1;

          if (!id_configuracion)
            throw new AppError('id_configuracion es requerido', 400);

          const integration = await getActiveIntegration(id_configuracion);
          if (!integration)
            throw new AppError('No existe una integración Dropi activa', 404);

          const integrationKey = decryptToken(integration.integration_key_enc);
          if (!integrationKey) throw new AppError('Dropi key inválida', 400);

          const data = await dropiService.listStates({
            integrationKey,
            country_id,
          });

          socket.emit('DROPI_STATES_OK', { isSuccess: true, data });
        } catch (e) {
          socket.emit('DROPI_STATES_ERROR', {
            isSuccess: false,
            message: e?.message || 'Error cargando departamentos',
          });
        }
      });

      socket.on('GET_DROPI_CITIES', async (payload) => {
        try {
          const id_configuracion = toInt(payload?.id_configuracion);
          const department_id = toInt(payload?.department_id);
          const rate_type = strOrNull(payload?.rate_type);

          if (!id_configuracion)
            throw new AppError('id_configuracion es requerido', 400);
          if (!department_id)
            throw new AppError('department_id es requerido', 400);
          if (!rate_type) throw new AppError('rate_type es requerido', 400);

          const integration = await getActiveIntegration(id_configuracion);
          if (!integration)
            throw new AppError('No existe una integración Dropi activa', 404);

          const integrationKey = decryptToken(integration.integration_key_enc);
          if (!integrationKey) throw new AppError('Dropi key inválida', 400);

          const data = await dropiService.listCities({
            integrationKey,
            payload: { department_id, rate_type },
          });

          socket.emit('DROPI_CITIES_OK', { isSuccess: true, data });
        } catch (e) {
          socket.emit('DROPI_CITIES_ERROR', {
            isSuccess: false,
            message: e?.message || 'Error cargando ciudades',
          });
        }
      });

      socket.on('GET_DROPI_COTIZA_ENVIO_V2', async (payload) => {
        try {
          const id_configuracion = toInt(payload?.id_configuracion);
          const EnvioConCobroRaw = payload?.EnvioConCobro; // bool o string

          const ciudad_destino_cod_dane = strOrNull(
            payload?.ciudad_destino_cod_dane,
          );
          const ciudad_remitente_cod_dane = strOrNull(
            payload?.ciudad_remitente_cod_dane,
          );

          if (!id_configuracion)
            throw new AppError('id_configuracion es requerido', 400);
          if (!ciudad_destino_cod_dane)
            throw new AppError('ciudad_destino_cod_dane es requerido', 400);
          if (!ciudad_remitente_cod_dane)
            throw new AppError('ciudad_remitente_cod_dane es requerido', 400);

          const integration = await getActiveIntegration(id_configuracion);
          if (!integration)
            throw new AppError('No existe una integración Dropi activa', 404);

          const integrationKey = decryptToken(integration.integration_key_enc);
          if (!integrationKey) throw new AppError('Dropi key inválida', 400);

          // Dropi lo quiere como string "true"/"false"
          const EnvioConCobro =
            String(EnvioConCobroRaw).toLowerCase() === 'true'
              ? 'true'
              : 'false';

          const dropiPayload = {
            EnvioConCobro,
            ciudad_destino: { cod_dane: ciudad_destino_cod_dane },
            ciudad_remitente: { cod_dane: ciudad_remitente_cod_dane },
          };

          const data = await dropiService.cotizaEnvioTransportadora({
            integrationKey,
            payload: dropiPayload,
          });

          socket.emit('DROPI_COTIZA_ENVIO_V2_OK', { isSuccess: true, data });
        } catch (e) {
          socket.emit('DROPI_COTIZA_ENVIO_V2_ERROR', {
            isSuccess: false,
            message: e?.message || 'Error cotizando transportadoras',
          });
        }
      });

      socket.on('DROPI_CREATE_ORDER', async (payload) => {
        try {
          const id_configuracion = toInt(payload?.id_configuracion);
          if (!id_configuracion)
            throw new AppError('id_configuracion es requerido', 400);

          const data = await createOrderForClient({
            id_configuracion,
            body: payload,
          });

          socket.emit('DROPI_CREATE_ORDER_OK', { isSuccess: true, data });
        } catch (e) {
          socket.emit('DROPI_CREATE_ORDER_ERROR', {
            isSuccess: false,
            message: e?.message || 'Error creando orden en Dropi',
          });
        }
      });

      socket.on('DROPI_UPDATE_ORDER', async (payload) => {
        try {
          const id_configuracion = toInt(payload?.id_configuracion);
          const orderId = toInt(payload?.orderId);
          const body = payload?.body || {};

          if (!id_configuracion)
            throw new AppError('id_configuracion es requerido', 400);
          if (!orderId) throw new AppError('orderId es requerido', 400);

          const data = await updateOrderForClient({
            id_configuracion,
            orderId,
            body,
          });

          socket.emit('DROPI_UPDATE_ORDER_OK', {
            isSuccess: true,
            data,
            orderId,
          });
        } catch (e) {
          socket.emit('DROPI_UPDATE_ORDER_ERROR', {
            isSuccess: false,
            message: e?.message || 'Error actualizando orden',
          });
        }
      });

      // Confirmar / Cancelar (atajo)
      socket.on('DROPI_SET_ORDER_STATUS', async (payload) => {
        try {
          const id_configuracion = toInt(payload?.id_configuracion);
          const orderId = toInt(payload?.orderId);
          const status = String(payload?.status || '')
            .trim()
            .toUpperCase();

          if (!id_configuracion)
            throw new AppError('id_configuracion es requerido', 400);
          if (!orderId) throw new AppError('orderId es requerido', 400);
          if (!status) throw new AppError('status es requerido', 400);

          // ✅ solo los que usted quiere permitir desde UI
          const allowedStatuses = new Set(['PENDIENTE', 'CANCELADO']);
          if (!allowedStatuses.has(status)) {
            throw new AppError(`status no permitido: ${status}`, 400);
          }

          const data = await updateOrderForClient({
            id_configuracion,
            orderId,
            body: { status },
          });

          socket.emit('DROPI_SET_ORDER_STATUS_OK', {
            isSuccess: true,
            data,
            orderId,
            status,
          });
        } catch (e) {
          socket.emit('DROPI_SET_ORDER_STATUS_ERROR', {
            isSuccess: false,
            message: e?.message || 'Error cambiando estado de orden',
          });
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
