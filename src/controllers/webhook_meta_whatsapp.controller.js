const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { db } = require('../database/config');
const ClientesChatCenter = require('../models/clientes_chat_center.model');
const MensajeCliente = require('../models/mensaje_cliente.model');
const Templates_chat_center = require('../models/templates_chat_center.model');
const Configuraciones = require('../models/configuraciones.model');
const Errores_chat_meta = require('../models/errores_chat_meta.model');

const servicioAppointments = require('../services/appointments.service');
const {
  descargarAudioWhatsapp,
  descargarImagenWhatsapp,
  descargarDocumentoWhatsapp,
  descargarVideoWhatsapp,
  descargarStickerWhatsapp,
} = require('../utils/webhook_whatsapp/descargarMultimedia');

const {
  validarAutomatizador,
} = require('../utils/webhook_whatsapp/validar_automatizador');

const {
  cancelarRemarketingEnNode,
  obtenerThreadId,
  transcribirAudioConWhisperDesdeArchivo,
  enviarAsistenteGpt,
} = require('../utils/webhook_whatsapp/funcciones_asistente');

const {
  enviarMedioWhatsapp,
} = require('../utils/webhook_whatsapp/enviarMultimedia');

const {
  enviarMensajeTextoWhatsApp,
  enviarMensajeWhatsapp,
} = require('../utils/webhook_whatsapp/enviarMensajes');

const {
  asignarEtiquetas,
} = require('../utils/webhook_whatsapp/asignar_etiquetas');

const {
  enviarConsultaAPI,
} = require('../utils/webhook_whatsapp/enviar_consulta_socket');

const {
  estadoMensajeEspera,
} = require('../utils/webhook_whatsapp/estadoMensajeEspera');

const {
  enviarEscribiendoWhatsapp,
  detenerEscribiendoWhatsapp,
} = require('../utils/webhook_whatsapp/funciones_typing');

async function ensureDir(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (_) {}
}

// controllers/clientes_chat_centerController.js
exports.webhook_whatsapp = catchAsync(async (req, res, next) => {
  /* Recepción de eventos (GET) */
  /* Verificar del webhook para el desafío de validación */
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const verifyTokenFromMeta = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const webhookTokenFromUrl = req.query['webhook'];

    if (
      mode === 'subscribe' &&
      webhookTokenFromUrl &&
      verifyTokenFromMeta &&
      webhookTokenFromUrl === verifyTokenFromMeta
    ) {
      return res.status(200).send(challenge);
    } else {
      return res
        .status(403)
        .json({ message: 'Token de verificación incorrecto.' });
    }
  }
  /* Verificar del webhook para el desafío de validación */

  /* Recepción de eventos (POST) */
  // Aquí recibes el JSON enviado por Meta
  const data = req.body;

  // Si vino vacío, 400 y cortamos
  if (!data || Object.keys(data).length === 0) {
    return res.status(400).json({
      status: 'error',
      message: 'Datos inválidos o vacíos.',
    });
  }

  // ✅ Responder de una vez a Meta para que NO reintente
  res.status(200).json({
    status: '200',
    title: 'Webhook recibido',
    message: 'Datos procesados correctamente',
  });

  // === A partir de aquí, continúa el “post-procesamiento” ===
  // Hazlo fuera del turno actual para no competir con el envío de la respuesta
  setImmediate(async () => {
    try {
      const logsDir = path.join(process.cwd(), './src/logs/logs_meta');
      await ensureDir(logsDir);

      const rawBody = JSON.stringify(data);
      /*  console.log('whatsapp_debug_raw: ' + rawBody);
      console.log('fin'); */
      await fsp.appendFile(
        path.join(logsDir, 'whatsapp_debug_raw.txt'),
        rawBody + '\n'
      );

      // Log legible en consola
      /* console.log('Webhook recibido de Meta:\n', JSON.stringify(data, null, 2)); */

      await fsp.appendFile(
        path.join(logsDir, 'debug_log.txt'),
        'Inicio de mensaje\n'
      );

      // --- parseo mínimo recomendado ---
      const value = data?.entry?.[0]?.changes?.[0]?.value;
      if (!value) {
        await fsp.appendFile(
          path.join(logsDir, 'debug_log.txt'),
          'Estructura inválida: falta value en entry[0].changes[0]\n'
        );
        return;
      }
      // --- parseo mínimo recomendado ---

      const business_phone_id = value?.metadata?.phone_number_id || ''; // Obtenemos el phone_number_id para buscar la configuracion

      /* buscar id_configuracion */
      const configuracion = await Configuraciones.findOne({
        where: { id_telefono: business_phone_id },
      });

      if (!configuracion) {
        await fsp.appendFile(
          path.join(logsDir, 'debug_log.txt'),
          'Error: No se encontró configuración con id_telefono: ' +
            business_phone_id +
            '\n'
        );
        return;
      }

      const id_plataforma = configuracion.id_plataforma;
      const accessToken = configuracion.token;
      const waba_id = configuracion.id_whatsapp;
      const id_configuracion = configuracion.id;
      const telefono_configuracion = configuracion.telefono;
      const nombre_configuracion = configuracion.nombre_configuracion;
      const api_key_openai = configuracion.api_key_openai;
      /* buscar id_configuracion */

      /* Validar si existen errores */
      const statuses = value?.statuses || [];

      for (const status of statuses) {
        const wamid = status?.id || '';
        const error = status?.errors?.[0];

        if (!error) continue; // No hay error, pasamos

        const codigo_error = error.code || '';
        const statusMsg = error.message || '';
        const statusTitle = error.title || '';

        // Insertar en tabla de errores
        await Errores_chat_meta.create({
          id_wamid_mensaje: wamid,
          codigo_error,
          mensaje_error: statusMsg,
        });

        // Inicializa log local opcional
        let debugLogMsg = '';

        switch (codigo_error) {
          case 131042:
            // Método de pago
            await Configuraciones.update(
              { metodo_pago: 0 },
              { where: { id: id_configuracion } }
            );
            break;

          case 131026:
            debugLogMsg = '⚠️ Mensaje no entregado (code 131026).';
            break;

          case 131047:
            debugLogMsg = '⚠️ Fuera de ventana de 24h. Requiere plantilla.';
            break;

          case 131048:
          case 131049:
            debugLogMsg = '⚠️ Límite alcanzado por spam o engagement.';
            break;

          case 131051:
            debugLogMsg = '⚠️ Tipo de mensaje no soportado.';
            break;

          default:
            debugLogMsg = `Error Meta ${codigo_error}: ${statusTitle} - ${statusMsg}`;
            break;
        }

        // Si hay mensaje, lo logueamos
        if (debugLogMsg) {
          await fsp.appendFile(
            path.join(logsDir, 'debug_log.txt'),
            `[${new Date().toISOString()}] ${debugLogMsg}\n`
          );
        }
      }
      /* Validar si existen errores */

      // === Extraer datos del mensaje entrante ===
      const phone_whatsapp_from = value?.messages?.[0]?.from || ''; // Obtenemos el remitente
      const name_whatsapp_from = value?.contacts?.[0]?.profile?.name || ''; // Nombre del remitente
      const tipo_mensaje = value?.messages?.[0]?.type || ''; // Tipo de mensaje

      // === Separar nombre y apellido ===
      const nombre_completo = name_whatsapp_from.trim().split(' ');
      const nombre_cliente = nombre_completo[0] || '';
      const apellido_cliente = nombre_completo[1] || ''; // Solo el segundo elemento

      // === Validar si los datos claves están presentes ===
      if (!phone_whatsapp_from || !business_phone_id) {
        await fsp.appendFile(
          path.join(logsDir, 'debug_log.txt'),
          `[${new Date().toISOString()}] ❌ Datos del mensaje incompletos\n`
        );
        return;
      }

      // === Inicializar variables para el mensaje ===
      let texto_mensaje = '';
      let ruta_archivo = null;
      let tipo_button = '';

      // Obtener el objeto de mensaje completo (por si se necesita)
      const mensaje_recibido = value?.messages?.[0] || {};

      switch (tipo_mensaje) {
        case 'text':
          texto_mensaje = mensaje_recibido?.text?.body || '';
          break;

        case 'reaction':
          texto_mensaje = mensaje_recibido?.reaction?.emoji || '';
          break;

        case 'image':
          const imageId = mensaje_recibido?.image?.id;
          ruta_archivo = await descargarImagenWhatsapp(imageId, accessToken);
          texto_mensaje = mensaje_recibido?.image?.caption || '';
          break;

        case 'video':
          const videoId = mensaje_recibido?.video?.id;
          ruta_archivo = await descargarVideoWhatsapp(videoId, accessToken);
          texto_mensaje = mensaje_recibido?.video?.caption || '';
          break;

        case 'audio':
          const audioId = mensaje_recibido?.audio?.id;
          texto_mensaje = `Audio recibido con ID: ${audioId}`;
          ruta_archivo = await descargarAudioWhatsapp(audioId, accessToken);
          /* console.log('ruta_archivo: ' + ruta_archivo); */
          texto_mensaje += ruta_archivo
            ? `. Archivo guardado en: ${ruta_archivo}`
            : `. Error al descargar el archivo.`;
          break;

        case 'document':
          const docId = mensaje_recibido?.document?.id;
          const filename = mensaje_recibido?.document?.filename;
          ruta_archivo = await descargarDocumentoWhatsapp(
            docId,
            accessToken,
            filename
          );
          texto_mensaje = mensaje_recibido?.document?.caption || '';
          if (!ruta_archivo)
            texto_mensaje += '\nError al descargar el documento.';
          break;

        case 'location':
          const location = mensaje_recibido?.location;

          console.log("location: "+location);

          console.log("location?.latitude: "+location?.latitude);

          console.log("location?.longitude: "+location?.longitude);

          texto_mensaje = JSON.stringify({
            latitude: location?.latitude,
            longitude: location?.longitude,
          });
          break;

        case 'contacts':
          const contactos = mensaje_recibido?.contacts || [];
          texto_mensaje = contactos
            .map((c) => {
              const nombre = c.name?.formatted_name || '';
              const telefono = c.phones?.[0]?.wa_id || '';
              return `Nombre: ${nombre}, Teléfono: ${telefono}`;
            })
            .join(', ');
          break;

        case 'interactive':
          const interactive = mensaje_recibido?.interactive || {};
          if (interactive.type === 'button_reply') {
            texto_mensaje = `Respuesta de botón: ${interactive.button_reply?.title}`;
          } else if (interactive.type === 'list_reply') {
            texto_mensaje = `Respuesta de lista: ${interactive.list_reply?.title}`;
          }
          break;

        case 'button':
          const payload = mensaje_recibido?.button?.payload || '';
          texto_mensaje = payload;

          const resultado_automatizador = await validarAutomatizador(
            payload,
            id_configuracion
          );
          const id_template = resultado_automatizador?.id_template ?? null;
          const id_etiquetas = resultado_automatizador?.id_etiquetas ?? null;

          if (id_template) {
            tipo_button = 'template';
          } else if (id_etiquetas?.length) {
            tipo_button = 'etiquetas';
          } else {
            await fsp.appendFile(
              path.join(logsDir, 'debug_log.txt'),
              `[${new Date().toISOString()}] ❌ No se encontraron los datos necesarios para enviar el mensaje template.\n`
            );
          }

          break;

        case 'sticker':
          const stickerId = mensaje_recibido?.sticker?.id;
          ruta_archivo = await descargarStickerWhatsapp(stickerId, accessToken);
          texto_mensaje = `Sticker recibido y guardado con ID: ${stickerId}`;
          break;

        default:
          texto_mensaje = 'Tipo de mensaje no reconocido.';
      }

      /* registrar en el log el mensaje */
      await fsp.appendFile(
        path.join(logsDir, 'debug_log.txt'),
        `[${new Date().toISOString()}] Mensaje procesado:` +
          texto_mensaje +
          ` \n`
      );
      console.log(
        `[${new Date().toISOString()}] Mensaje procesado:` +
          texto_mensaje +
          ` \n`
      );

      const clienteExiste = await ClientesChatCenter.findOne({
        where: { celular_cliente: phone_whatsapp_from, id_configuracion },
      });

      let id_cliente = null;
      let bot_openia = 1;

      if (!clienteExiste) {
        cliente = await ClientesChatCenter.create({
          id_configuracion,
          uid_cliente: business_phone_id,
          nombre_cliente,
          apellido_cliente,
          celular_cliente: phone_whatsapp_from,
        });

        id_cliente = cliente.id;
      } else {
        //cliente ya existe
        id_cliente = clienteExiste.id;
        bot_openia = clienteExiste.bot_openia;

        if (clienteExiste.chat_cerrado === 1) {
          await ClientesChatCenter.update(
            { chat_cerrado: 0 },
            { where: { id: id_cliente } }
          );
        }
      }

      await fsp.appendFile(
        path.join(logsDir, 'debug_log.txt'),
        `Después de mensaje procesado\n`
      );
      /* console.log(`Después de mensaje procesado\n`) */

      /* obtener id_cliente_configuracion */
      const clienteExisteConfiguracion = await ClientesChatCenter.findOne({
        where: { celular_cliente: telefono_configuracion, id_configuracion },
      });

      /* console.log(
        'clienteExisteConfiguracion.id: ' + clienteExisteConfiguracion.id
      ); */

      /* Fin obtener id_cliente_configuracion */

      const creacion_mensaje = await MensajeCliente.create({
        id_configuracion,
        id_cliente: clienteExisteConfiguracion.id,
        mid_mensaje: business_phone_id,
        tipo_mensaje,
        texto_mensaje,
        ruta_archivo,
        rol_mensaje: 0,
        celular_recibe: id_cliente,
        uid_whatsapp: phone_whatsapp_from,
      });

      /* console.log('creacion_mensaje: ' + JSON.stringify(creacion_mensaje));
      console.log('creacion_mensaje.id: ' + creacion_mensaje.id); */

      if (creacion_mensaje && creacion_mensaje.id) {
        await fsp.appendFile(
          path.join(logsDir, 'debug_log.txt'),
          `[${new Date().toISOString()}] ✅ Mensaje guardado en DB con ID ${
            creacion_mensaje.id
          }\n`
        );
        console.log(
          `[${new Date().toISOString()}] ✅ Mensaje guardado en DB con ID ${
            creacion_mensaje.id
          }`
        );

        /* enviar notificacion al socket */

        const resultado_api = await enviarConsultaAPI(
          id_configuracion,
          id_cliente
        );

        cancelarRemarketingEnNode(phone_whatsapp_from, id_configuracion);
        if (tipo_button == 'template') {
          await enviarMensajeTextoWhatsApp(
            accessToken,
            business_phone_id,
            phone_whatsapp_from,
            id_configuracion,
            id_template,
            'webhook'
          );
        } else if (tipo_button == 'etiquetas') {
          await asignarEtiquetas(id_etiquetas, id_configuracion, id_cliente);
        }
        /* validador para enviar mensaje tipo buttom */

        /* validar si tiene mensaje interno principal */
        let mensaje_interno = null;

        try {
          // Buscar template interno principal
          const templatePrincipal = await Templates_chat_center.findOne({
            where: {
              id_configuracion,
              principal: 1,
            },
            attributes: ['id_template'],
          });

          if (!templatePrincipal) {
            await fsp.appendFile(
              path.join(logsDir, 'debug_log.txt'),
              `[${new Date().toISOString()}] ⚠️ No se encontró mensaje interno principal.\n`
            );
          } else {
            mensaje_interno = templatePrincipal.id_template;
            // Puedes loguear
            await fsp.appendFile(
              path.join(logsDir, 'debug_log.txt'),
              `[${new Date().toISOString()}] ✅ mensaje_interno obtenido: ${mensaje_interno}\n`
            );

            // Contar cuántos mensajes tiene ese cliente con esa configuración
            const countMensajes = await MensajeCliente.count({
              where: {
                id_configuracion,
                celular_recibe: phone_whatsapp_from,
              },
            });

            await fsp.appendFile(
              path.join(logsDir, 'debug_log.txt'),
              `[${new Date().toISOString()}] count_mensajes_clientes: ${countMensajes}\n`
            );

            if (countMensajes === 1) {
              // Si solo tiene un mensaje, enviar el mensaje interno principal
              await enviarMensajeTextoWhatsApp(
                accessToken,
                business_phone_id,
                phone_whatsapp_from,
                id_configuracion,
                mensaje_interno,
                'webhook' // responsable u otro parámetro según tu implementación
              );
            }
          }
        } catch (err) {
          await fsp.appendFile(
            path.join(logsDir, 'debug_log.txt'),
            `[${new Date().toISOString()}] ❌ Error en validar mensaje interno principal: ${
              err.message
            }\n`
          );
        }

        /* validar si el chat ah sido cerrado */
        if (bot_openia === 1) {
          // Obtener thread
          const id_thread = await obtenerThreadId(id_cliente, api_key_openai);

          // Si es audio y tienes ruta de archivo, intentar transcribir
          if (tipo_mensaje === 'audio' && ruta_archivo) {
            const ruta_absoluta = ruta_archivo;
            /* console.log('tipo audio para conversion');
            console.log('ruta audio: ' + ruta_absoluta); */

            const texto_transcrito =
              await transcribirAudioConWhisperDesdeArchivo(
                ruta_absoluta,
                api_key_openai
              );

            console.log('texto_transcrito: ' + texto_transcrito);
            if (texto_transcrito) {
              texto_mensaje = texto_transcrito;
              await fsp.appendFile(
                path.join(logsDir, 'debug_log.txt'),
                `[${new Date().toISOString()}] 📝 Transcripción exitosa: ${texto_mensaje}\n`
              );
            } else {
              await fsp.appendFile(
                path.join(logsDir, 'debug_log.txt'),
                `[${new Date().toISOString()}] ⚠️ No se pudo transcribir el audio\n`
              );
            }
          }

          /* await enviarEscribiendoWhatsapp(phone_whatsapp_from,business_phone_id,accessToken); */

          // Enviar mensaje al asistente GPT
          const respuesta_asistente = await enviarAsistenteGpt({
            mensaje: texto_mensaje,
            id_plataforma,
            id_configuracion,
            telefono: phone_whatsapp_from,
            api_key_openai,
            id_thread,
            business_phone_id,
            accessToken,
          });

          if (respuesta_asistente?.status === 200) {
            const mensajeGPT = respuesta_asistente.respuesta;
            const tipoInfo = respuesta_asistente.tipoInfo;

            const pedidoConfirmado = /\[pedido_confirmado\]:\s*true/i.test(
              mensajeGPT
            );

            const citaConfirmada = /\[cita_confirmada\]:\s*true/i.test(
              mensajeGPT
            );

            if (pedidoConfirmado) {
              // Extraer valores usando regex
              const nombre =
                mensajeGPT.match(/🧑 Nombre:\s*(.+)/)?.[1]?.trim() || '';
              const telefono =
                mensajeGPT.match(/📞 Teléfono:\s*(.+)/)?.[1]?.trim() || '';
              const provincia =
                mensajeGPT.match(/📍 Provincia:\s*(.+)/)?.[1]?.trim() || '';
              const ciudad =
                mensajeGPT.match(/📍 Ciudad:\s*(.+)/)?.[1]?.trim() || '';
              const direccion =
                mensajeGPT.match(/🏡 Dirección:\s*(.+)/)?.[1]?.trim() || '';
              const producto =
                mensajeGPT.match(/📦 Producto:\s*(.+)/)?.[1]?.trim() || '';
              const precio =
                mensajeGPT.match(/💰 Precio total:\s*(.+)/)?.[1]?.trim() || '';

              // Variables listas
              console.log('📦 Datos extraídos del pedido:');
              console.log({
                nombre,
                telefono,
                provincia,
                ciudad,
                direccion,
                producto,
                precio,
              });

              await ClientesChatCenter.update(
                { pedido_confirmado: 1 },
                { where: { id: id_cliente } }
              );

              if (tipoInfo == 'datos_pedido') {
                /* console.log('entro en condicion datos pedidos'); */
              }
            } else if (citaConfirmada) {
              // Extraer valores usando regex
              const nombre =
                mensajeGPT.match(/🧑 Nombre:\s*(.+)/)?.[1]?.trim() || '';
              const telefono =
                mensajeGPT.match(/📞 Teléfono:\s*(.+)/)?.[1]?.trim() || '';
              const correo =
                mensajeGPT.match(/📍 Correo:\s*(.+)/)?.[1]?.trim() || '';
              const servicio =
                mensajeGPT
                  .match(/📍 Servicio que desea:\s*(.+)/)?.[1]
                  ?.trim() || '';
              const fecha_hora_inicio =
                mensajeGPT
                  .match(/🕒 Fecha y hora de inicio:\s*(.+)/)?.[1]
                  ?.trim() || '';
              const fecha_hora_fin =
                mensajeGPT
                  .match(/🕒 Fecha y hora de fin:\s*(.+)/)?.[1]
                  ?.trim() || '';
              const precio =
                mensajeGPT.match(/💰 Precio total:\s*(.+)/)?.[1]?.trim() || '';

              // Convierte las fechas locales a UTC usando la zona horaria 'America/Guayaquil'
              const moment = require('moment-timezone');

              const fecha_hora_inicio_utc = moment
                .tz(fecha_hora_inicio, 'America/Guayaquil')
                .utc()
                .format();
              const fecha_hora_fin_utc = moment
                .tz(fecha_hora_fin, 'America/Guayaquil')
                .utc()
                .format();
              // Variables listas
              console.log('📦 Datos extraídos de la cita:');
              console.log({
                nombre,
                telefono,
                correo,
                servicio,
                fecha_hora_inicio_utc,
                fecha_hora_fin_utc,
                precio,
              });

              /* consultar id del calendarios */
              const calendars = await db.query(
                `SELECT id
                  FROM calendars 
                  WHERE account_id  = ?`,
                {
                  replacements: [id_configuracion],
                  type: db.QueryTypes.SELECT,
                }
              );
              const id_calendars = calendars[0].id;
              /* consultar id del calendarios */

              /* consultar id del usuario y sub_usuario */
              const usuario = await db.query(
                `SELECT sb.id_sub_usuario, sb.id_usuario
                  FROM configuraciones c
                  INNER JOIN sub_usuarios_chat_center sb ON sb.id_usuario = c.id_usuario
                  WHERE c.id  = ? AND sb.rol = "administrador" LIMIT 1`,
                {
                  replacements: [id_configuracion],
                  type: db.QueryTypes.SELECT,
                }
              );
              const id_usuarios = usuario[0].id_usuario;
              const id_sub_usuario = usuario[0].id_sub_usuario;
              /* consultar id del usuario y sub_usuario */

              const payload = {
                assigned_user_id: id_sub_usuario,
                booked_tz: 'America/Guayaquil',
                calendar_id: id_calendars,
                create_meet: true,
                created_by_user_id: id_usuarios,
                description: '',
                end: fecha_hora_fin_utc,
                invitees: [
                  {
                    name: nombre,
                    email: correo,
                    phone: telefono,
                  },
                ],
                location_text: 'online',
                meeting_url: null,
                start: fecha_hora_inicio_utc,
                status: 'Agendado',
                title: nombre + ' - ' + servicio,
              };

              console.log(JSON.stringify(payload));

              servicioAppointments.createAppointment(payload, id_usuarios);
            }

            // Buscar URLs de imágenes y videos usando regex
            const urls_imagenes = (
              mensajeGPT.match(
                /\[producto_imagen_url\]:\s*(https?:\/\/[^\s]+)|\[servicio_imagen_url\]:\s*(https?:\/\/[^\s]+)/gi
              ) || []
            )
              .map((s) => {
                const m = s.match(
                  /\[producto_imagen_url\]:\s*(https?:\/\/[^\s]+)|\[servicio_imagen_url\]:\s*(https?:\/\/[^\s]+)/i
                );
                return m ? m[1] || m[2] : null;
              })
              .filter(Boolean);

            const urls_videos = (
              mensajeGPT.match(
                /\[producto_video_url\]:\s*(https?:\/\/[^\s]+)|\[servicio_video_url\]:\s*(https?:\/\/[^\s]+)/gi
              ) || []
            )
              .map((s) => {
                const m = s.match(
                  /\[producto_video_url\]:\s*(https?:\/\/[^\s]+)|\[servicio_video_url\]:\s*(https?:\/\/[^\s]+)/i
                );
                return m ? m[1] || m[2] : null;
              })
              .filter(Boolean);

            // Enviar imágenes
            for (const url_img of urls_imagenes) {
              if (url_img) {
                await enviarMedioWhatsapp({
                  tipo: 'image',
                  url_archivo: url_img,
                  phone_whatsapp_to: phone_whatsapp_from,
                  business_phone_id,
                  accessToken,
                  id_configuracion,
                  responsable: respuesta_asistente.tipo_asistente,
                });
              }
            }

            // Enviar videos
            for (const url_video of urls_videos) {
              if (url_video) {
                await enviarMedioWhatsapp({
                  tipo: 'video',
                  url_archivo: url_video,
                  phone_whatsapp_to: phone_whatsapp_from,
                  business_phone_id,
                  accessToken,
                  id_configuracion,
                  responsable: respuesta_asistente.tipo_asistente,
                });
              }
            }

            // Eliminar las líneas con URLs del mensaje
            let solo_texto = mensajeGPT
              .replace(/\[producto_imagen_url\]:\s*https?:\/\/[^\s]+/gi, '') // Eliminar imágenes de producto
              .replace(/\[servicio_imagen_url\]:\s*https?:\/\/[^\s]+/gi, '') // Eliminar imágenes de servicio
              .replace(/\[producto_video_url\]:\s*https?:\/\/[^\s]+/gi, '') // Eliminar videos de producto
              .replace(/\[servicio_video_url\]:\s*https?:\/\/[^\s]+/gi, '') // Eliminar videos de servicio
              .replace(/\[pedido_confirmado\]:\s*true/gi, '') // Eliminar confirmación de pedido
              .replace(/\[cita_confirmada\]:\s*true/gi, ''); // Eliminar confirmación de cita

            solo_texto = solo_texto.trim();

            if (solo_texto !== '') {
              await enviarMensajeWhatsapp({
                phone_whatsapp_to: phone_whatsapp_from,
                texto_mensaje: solo_texto,
                business_phone_id,
                accessToken,
                id_configuracion,
                responsable: respuesta_asistente.tipo_asistente,
              });
            }
          }
        }
        /* validar si el chat ah sido cerrado */

        if (resultado_api) {
          console.log({
            status: 'success',
            message: 'Datos enviados a la API correctamente.',
          });
        } else {
          console.log({
            status: 'error',
            message: 'No se pudo enviar los datos a la API.',
          });
        }
      } else {
        await fsp.appendFile(
          path.join(logsDir, 'debug_log.txt'),
          `[${new Date().toISOString()}] ❌ Error al guardar el mensaje en la base de datos.\n`
        );
      }

      /* validar mensaje_espera */
      await estadoMensajeEspera(id_cliente);
      /* Fin validar mensaje_espera */

      await fsp.appendFile(
        path.join(logsDir, 'debug_log.txt'),
        'Fin Mensaje de mensaje\n'
      );
    } catch (err) {
      try {
        const logsDir = path.join(process.cwd(), './src/logs/logs_meta');
        await ensureDir(logsDir);
        await fsp.appendFile(
          path.join(logsDir, 'debug_log.txt'),
          `[ERROR pos-respuesta] ${new Date().toISOString()} - ${err.message}\n`
        );
      } catch (_) {
        // último recurso: consola
        console.error('Error registrando log:', err);
      }
    }
  });
});
