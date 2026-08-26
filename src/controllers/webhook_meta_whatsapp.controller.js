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
const logger = require('../utils/logger');
const { filtrarMediaNueva, olvidarEnviado } = require('../utils/dedupeMedia');
const { reclamarWamid } = require('../utils/dedupeWamid');
const { extraerUrlsMedia } = require('../utils/urlsMedia');
const dashboardEmitter = require('./dashboardEmitter');

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
  buscarProductoPorReferral,
} = require('../utils/webhook_whatsapp/buscar_producto_referral');

// Wizard de producto (/productos2): primer mensaje FIJO desde el anuncio y
// respuestas rápidas sin IA. Solo actúa si el producto tiene wizard activo.
const {
  intentarMensajeFijoWizard,
  intentarRespuestaRapida,
} = require('../services/producto_wizard_runtime.service');

// Lectura de imágenes del cliente (equivalente visual de la transcripción)
const {
  describirImagenDesdeArchivo,
} = require('../utils/openia/describirImagen');

// Transcripción de notas de voz (compartida con Instagram y Messenger)
const {
  transcribirAudioDesdeArchivo,
  TEXTO_AUDIO_ILEGIBLE,
} = require('../utils/openia/transcribirAudio');

const {
  cancelarRemarketingEnNode,
  obtenerThreadId,
  enviarAsistenteGptVentas,
  enviarAsistenteGptEventos,
  separador_productos,
  enviarAsistenteGptImporfactory,
  enviarAsistenteGptImporshopProveedor,
  enviarAsistenteKanban,
  cancelarRemarketingKanbanWrapper,
  programarRemarketingKanbanWrapper,
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
  enviarEstadoMetaAPI,
} = require('../utils/webhook_whatsapp/enviar_consulta_socket');

const {
  estadoMensajeEspera,
} = require('../utils/webhook_whatsapp/estadoMensajeEspera');

const {
  crearClienteConRoundRobinUnDepto,
  asignarRoundRobinClienteExistente,
} = require('../utils/webhook_whatsapp/round_robin');

const {
  enviarEscribiendoWhatsapp,
  detenerEscribiendoWhatsapp,
} = require('../utils/webhook_whatsapp/funciones_typing');

const { ensureUnifiedClient } = require('../utils/unified/ensureUnifiedClient');

async function ensureDir(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (_) {}
}

/**
 * Avisa al chat abierto que un mensaje que ya estaba en pantalla cambió.
 *
 * Se emite igual que MESSAGE_STATUS_UPDATE (los ticks de Meta): a todos, con
 * el id_configuracion adentro para que cada pestaña descarte lo que no es
 * suyo. Sin esto el agente tendría que recargar el chat para enterarse de que
 * el cliente borró o corrigió algo.
 */
function emitirMensajeActualizado(id_configuracion, mensaje, esUltimo) {
  if (!global.io) return;

  global.io.emit('MESSAGE_UPDATED', {
    id_configuracion,
    id: mensaje.id,
    // `celular_recibe` guarda el id del chat, que es con lo que el sidebar
    // identifica su fila. `es_ultimo` decide si el preview debe cambiar: si el
    // cliente borró un mensaje viejo, la fila del sidebar no se toca.
    chat_id: mensaje.celular_recibe,
    es_ultimo: !!esUltimo,
    wamid: mensaje.id_wamid_mensaje,
    texto_mensaje: mensaje.texto_mensaje,
    texto_original: mensaje.texto_original,
    editado_at: mensaje.editado_at,
    eliminado_at: mensaje.eliminado_at,
  });
}

/**
 * Aplica sobre el mensaje original la edición o el borrado que el cliente hizo
 * desde su WhatsApp. Devuelve true si encontró el original y lo actualizó.
 *
 * Tanto el webhook `edit` como el `revoke` traen `original_message_id`, que es
 * el wamid del mensaje que ya tenemos guardado; el evento en sí no es un
 * mensaje nuevo. Las ventanas las hace cumplir WhatsApp del lado del cliente
 * (15 minutos para editar, 2 días para eliminar para todos), así que si el
 * evento llegó es porque estaba dentro de plazo: no hace falta revalidarlo.
 */
async function aplicarEdicionORevoke({
  tipo_mensaje,
  mensaje_recibido,
  id_configuracion,
  texto_nuevo,
}) {
  const originalWamid =
    tipo_mensaje === 'revoke'
      ? mensaje_recibido?.revoke?.original_message_id
      : mensaje_recibido?.edit?.original_message_id;

  if (!originalWamid) return false;

  const original = await MensajeCliente.findOne({
    where: { id_wamid_mensaje: originalWamid, id_configuracion },
  });

  // Puede no estar: mensajes anteriores a que guardáramos el wamid, o de otra
  // conexión. En ese caso el llamador sigue con el flujo viejo y deja al menos
  // el rastro de que el cliente tocó algo.
  if (!original) return false;

  const ahora = new Date();
  const cambios = {
    // Se guarda una sola vez: si el cliente edita dos veces, "el original"
    // sigue siendo el primer texto, no la edición intermedia.
    texto_original: original.texto_original ?? original.texto_mensaje,
    updated_at: ahora,
  };

  if (tipo_mensaje === 'revoke') {
    cambios.eliminado_at = ahora;
  } else {
    cambios.editado_at = ahora;
    cambios.texto_mensaje = texto_nuevo || '';
  }

  await original.update(cambios);

  // El preview del sidebar sólo cambia si lo que se tocó es el último mensaje
  // del chat: si el cliente borra algo de más arriba, la fila se queda igual.
  // `ultimo_msg_id` es la misma columna que `vista_chats` expone como
  // `mensaje_id`, así que la comparación es contra lo que el sidebar muestra.
  const [chat] = await db.query(
    `SELECT ultimo_msg_id FROM clientes_chat_center WHERE id = :id LIMIT 1`,
    {
      replacements: { id: original.celular_recibe },
      type: db.QueryTypes.SELECT,
    },
  );

  emitirMensajeActualizado(
    id_configuracion,
    original,
    String(chat?.ultimo_msg_id) === String(original.id),
  );

  return true;
}

// controllers/clientes_chat_centerController.js
exports.webhook_whatsapp = catchAsync(async (req, res, next) => {
  logger.info('entro en el webhook');

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
  logger.info('Es post y este es el data2: ' + JSON.stringify(data));

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
        rawBody + '\n',
      );

      // Log legible en consola
      /* console.log('Webhook recibido de Meta:\n', JSON.stringify(data, null, 2)); */

      await fsp.appendFile(
        path.join(logsDir, 'debug_log.txt'),
        'Inicio de mensaje\n',
      );

      // --- parseo mínimo recomendado ---
      const value = data?.entry?.[0]?.changes?.[0]?.value;
      if (!value) {
        await fsp.appendFile(
          path.join(logsDir, 'debug_log.txt'),
          'Estructura inválida: falta value en entry[0].changes[0]\n',
        );
        return;
      }
      // --- parseo mínimo recomendado ---

      const change = data?.entry?.[0]?.changes?.[0];
      const field = change?.field;

      /* detector para mensajes de sincronizacion */
      const isHistory = field === 'history';

      /* detector para lista de contactos sicronizador */
      const isStateSync =
        field === 'smb_app_state_sync' && Array.isArray(value?.state_sync);

      // ✅ Coexistence: mensajes enviados desde la app/linked device
      const isSMBEcho =
        field === 'smb_message_echoes' || Array.isArray(value?.message_echoes); // por si no viene field

      // normaliza a un arreglo de mensajes
      const inboundMessages = value?.messages ?? [];
      const echoMessages = value?.message_echoes ?? [];

      /* si recibo lista de contacto los crea y actualiza */
      if (isStateSync) {
        const business_phone_id = value?.metadata?.phone_number_id || '';
        const configuracion = await Configuraciones.findOne({
          where: { id_telefono: business_phone_id, suspendido: 0 },
        });

        if (!configuracion) return;

        const id_configuracion = configuracion.id;

        for (const ev of value.state_sync) {
          if (ev?.type !== 'contact') continue;

          const phone = (ev?.contact?.phone_number || '').trim();
          const fullName = (
            ev?.contact?.full_name ||
            ev?.contact?.first_name ||
            ''
          ).trim();

          if (!phone) continue;

          // timestamp viene en MILISEGUNDOS
          const tsMs = Number(ev?.metadata?.timestamp || 0);
          const fechaContacto = tsMs ? new Date(tsMs) : new Date();

          await ensureUnifiedClient({
            id_configuracion,
            id_usuario_dueno: configuracion.id_usuario,

            source: 'wa',
            business_phone_id,
            phone, // peer phone
            nombre_cliente: fullName || '',
            apellido_cliente: '',

            motivo: 'auto_round_robin_state_sync',
            metaClienteTimestamps: tsMs
              ? { created_at: fechaContacto, updated_at: fechaContacto }
              : {},
            permiso_round_robin: configuracion.permiso_round_robin,
          });
        }

        // ✅ IMPORTANTE: no continúe al flujo de mensajes
        return;
      }
      /* si recibo lista de contacto los crea y actualiza */

      const normalizedMessages = isSMBEcho ? echoMessages : inboundMessages;

      const business_phone_id = value?.metadata?.phone_number_id || ''; // Obtenemos el phone_number_id para buscar la configuracion

      /* buscar id_configuracion */
      const configuracion = await Configuraciones.findOne({
        where: { id_telefono: business_phone_id, suspendido: 0 },
      });

      if (!configuracion) {
        await fsp.appendFile(
          path.join(logsDir, 'debug_log.txt'),
          'Error: No se encontró configuración con id_telefono: ' +
            business_phone_id +
            '\n',
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
      const tipo_configuracion = configuracion.tipo_configuracion;
      /* buscar id_configuracion */

      /* Validar si existen errores */
      const statuses = value?.statuses || [];

      for (const status of statuses) {
        const wamid = status?.id || '';
        const messageStatus = status?.status || '';
        const error = status?.errors?.[0];

        // ✅ Entregado al teléfono del cliente
        if (messageStatus === 'delivered') {
          await MensajeCliente.update(
            { estado_meta: 1 },
            { where: { id_wamid_mensaje: wamid, id_configuracion } },
          );
          continue;
        }

        // ✅ Leído por el cliente
        if (messageStatus === 'read') {
          await MensajeCliente.update(
            { estado_meta: 2 },
            { where: { id_wamid_mensaje: wamid, id_configuracion } },
          );

          // ✅ mismo patrón que enviarConsultaAPI
          await enviarEstadoMetaAPI(id_configuracion, wamid, 2);

          continue;
        }

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
              { where: { id: id_configuracion } },
            );
            break;

          case 131026: {
            const details = error?.error_data?.details || '';
            debugLogMsg = `⚠️ El número no tiene WhatsApp'}`;
            break;
          }

          case 131047:
            debugLogMsg = '⚠️ Fuera de ventana de 24h. Requiere plantilla.';
            break;

          case 131031:
            debugLogMsg =
              '🔒 Cuenta de WhatsApp bloqueada o restringida por Meta. Verifica el Business Manager.';
            break;

          case 131048:
          case 131049:
            debugLogMsg = '⚠️ Límite alcanzado por spam o engagement.';
            break;

          case 131051:
            debugLogMsg = '⚠️ Tipo de mensaje no soportado.';
            break;

          case 131052: {
            // Media download error - Meta no pudo descargar el archivo entrante
            // Guardamos placeholder en MensajeCliente para que aparezca en el chat
            try {
              const peerPhoneFallback =
                value?.contacts?.[0]?.wa_id || status?.recipient_id || '';

              if (!peerPhoneFallback) {
                debugLogMsg = `⚠️ 131052 sin peer phone identificable para wamid ${wamid}`;
                break;
              }

              // Evitar duplicados si Meta reenvía el status
              const yaExiste = await MensajeCliente.findOne({
                where: { id_wamid_mensaje: wamid, id_configuracion },
              });

              if (yaExiste) {
                debugLogMsg = `⚠️ 131052 wamid ${wamid} ya registrado, no se duplica`;
                break;
              }

              // Crear/obtener cliente externo
              const clienteFallido = await ensureUnifiedClient({
                id_configuracion,
                id_usuario_dueno: configuracion.id_usuario,
                source: 'wa',
                business_phone_id,
                phone: peerPhoneFallback,
                nombre_cliente: '',
                apellido_cliente: '',
                motivo: 'auto_media_failed_131052',
                permiso_round_robin: configuracion.permiso_round_robin,
              });

              if (!clienteFallido) {
                debugLogMsg = `❌ 131052 no se pudo crear cliente unificado para ${peerPhoneFallback}`;
                break;
              }

              // Obtener/crear cliente de configuración (negocio)
              let clienteConfigFallback = await ClientesChatCenter.findOne({
                where: {
                  celular_cliente: telefono_configuracion,
                  id_configuracion,
                },
              });

              if (!clienteConfigFallback) {
                clienteConfigFallback = await ClientesChatCenter.create({
                  id_configuracion,
                  uid_cliente: business_phone_id,
                  nombre_cliente: nombre_configuracion,
                  apellido_cliente: '',
                  celular_cliente: telefono_configuracion,
                  propietario: 1,
                });
              }

              // Timestamp del status (viene en segundos)
              const tsSeconds = Number(status?.timestamp || 0);
              const fechaFallo = tsSeconds
                ? new Date(tsSeconds * 1000)
                : new Date();

              // Payload completo del error para reintento manual posterior
              const errorPayload = JSON.stringify({
                tipo: 'media_download_failed',
                codigo_error,
                title: statusTitle,
                message: statusMsg,
                details: error?.error_data?.details || '',
                timestamp: status?.timestamp,
                recipient_id: status?.recipient_id || null,
                recipient_user_id: status?.recipient_user_id || null,
                contacts: value?.contacts || null,
                raw_status: status,
              });

              await MensajeCliente.create({
                id_configuracion,
                id_cliente: clienteConfigFallback.id,
                mid_mensaje: business_phone_id,
                tipo_mensaje: 'media_failed',
                texto_mensaje:
                  '⚠️ El cliente envió un archivo (imagen/audio/video/documento) pero Meta no pudo descargarlo. Pídele que lo reenvíe.',
                ruta_archivo: errorPayload,
                rol_mensaje: 0, // entrante
                celular_recibe: clienteFallido.id,
                uid_whatsapp: peerPhoneFallback,
                visto: 0,
                estado_meta: 0,
                context_wamid: null,
                responsable: null,
                id_wamid_mensaje: wamid,
                created_at: fechaFallo,
                updated_at: fechaFallo,
              });

              // Reabrir chat si estaba cerrado
              if (clienteFallido.chat_cerrado === 1) {
                await asignarRoundRobinClienteExistente({
                  id_cliente: clienteFallido.id,
                  id_configuracion,
                  id_usuario_dueno: configuracion.id_usuario,
                  permiso_round_robin: configuracion.permiso_round_robin,
                  motivo: 'auto_round_robin_reopen_media_failed',
                });
              }

              // Notificar socket + dashboard para que aparezca como chat nuevo
              await enviarConsultaAPI(id_configuracion, clienteFallido.id);
              dashboardEmitter.emitByConfig(id_configuracion, 'new_chat', {
                chatsCreated: 1,
              });

              debugLogMsg = `⚠️ 131052 placeholder guardado wamid=${wamid} cliente=${peerPhoneFallback}`;
            } catch (errMedia) {
              debugLogMsg = `❌ Error procesando 131052: ${errMedia.message}`;
            }
            break;
          }

          case 131053:
            debugLogMsg = '⚠️ Error al enviar el audio.';
            break;

          case 130472:
            debugLogMsg = '⚠️ El usuario no acepta mensajes de este negocio';
            break;

          default:
            debugLogMsg = `Error Meta ${codigo_error}: ${statusTitle} - ${statusMsg}`;
            break;
        }

        // Si hay mensaje, lo logueamos
        if (debugLogMsg) {
          await fsp.appendFile(
            path.join(logsDir, 'debug_log.txt'),
            `[${new Date().toISOString()}] ${debugLogMsg}\n`,
          );
        }
      }
      /* Validar si existen errores */

      if (!normalizedMessages.length) return;

      // === Extraer datos del mensaje entrante ===
      /* const phone_whatsapp_from = value?.messages?.[0]?.from || ''; */ // Obtenemos el remitente
      /* obtenemos el remitente */
      const msg0 = normalizedMessages[0];
      const tipo_mensaje = msg0?.type || ''; // Tipo de mensaje

      // ✅ timestamp UNIX (segundos) -> Date (ms)
      let fechaMensaje = null;

      if (isHistory) {
        const tsSeconds = Number(msg0?.timestamp || 0);
        fechaMensaje = tsSeconds ? new Date(tsSeconds * 1000) : new Date();
      }

      // ✅ “peer” = el número del cliente (el remoto del chat)
      const peer_phone = isSMBEcho
        ? msg0?.to || '' // si es echo, "to" es el cliente
        : msg0?.from || ''; // si es inbound, "from" es el cliente

      // por si lo usas con tu mismo nombre de variable:
      const phone_whatsapp_from = peer_phone;

      /* obtenemos el remitente */

      const name_whatsapp_from = value?.contacts?.[0]?.profile?.name || ''; // Nombre del remitente

      // === Separar nombre y apellido ===
      const nombre_completo = name_whatsapp_from.trim().split(' ');
      const nombre_cliente = nombre_completo[0] || '';
      const apellido_cliente = nombre_completo[1] || ''; // Solo el segundo elemento

      // === Validar si los datos claves están presentes ===
      if (!phone_whatsapp_from || !business_phone_id) {
        await fsp.appendFile(
          path.join(logsDir, 'debug_log.txt'),
          `[${new Date().toISOString()}] ❌ Datos del mensaje incompletos\n`,
        );
        return;
      }

      // === Inicializar variables para el mensaje ===
      let texto_mensaje = '';
      let ruta_archivo = null;
      let tipo_button = '';

      // ✅ Capturar si el cliente respondió a un mensaje específico
      const context_wamid = msg0?.context?.id || null;

      // Obtener el objeto de mensaje completo (por si se necesita)
      const mensaje_recibido = msg0 || {};

      // ── Idempotencia: Meta entrega "al menos una vez" ────────────────────
      // El mismo mensaje puede llegar más de una vez (si nuestro 200 no llegó,
      // si el proceso se reinició a mitad del post-procesamiento, o si hay más
      // de una suscripción apuntando a este webhook). Sin esta guarda el
      // mensaje se insertaba de nuevo, el audio se volvía a descargar y
      // transcribir —se paga otra vez— y la IA le respondía dos veces al
      // cliente.
      //
      // Va ANTES del switch para ahorrarse también la descarga del multimedia.
      //
      // Sólo aplica a mensajes ENTRANTES: los echoes de WhatsApp Business
      // (isSMBEcho) comparten wamid con el mensaje que la plataforma ya guardó
      // al enviarlo, así que filtrarlos acá cambiaría cómo se registran los
      // envíos hechos desde el celular. Eso se evalúa aparte.
      //
      // La consulta se apoya en el índice `idx_wamid` (id_wamid_mensaje), que
      // ya existe en la tabla.
      //
      // ⚠️ SOLO EN PRODUCCIÓN, a propósito: en local se prueba el webhook
      // reenviando a mano el mismo payload que mandó WhatsApp, y con la guarda
      // activa ese reenvío se descartaría (no se descargaría el audio, no se
      // transcribiría, no respondería la IA) y no se podría probar nada.
      // Si NODE_ENV no es 'production', el comportamiento es el de siempre.
      const esProduccion = process.env.NODE_ENV === 'production';
      const wamid_entrante = msg0?.id || null;
      if (esProduccion && wamid_entrante && !isSMBEcho) {
        /* Primero el reclamo en memoria, que es síncrono, y después la consulta.
           La consulta sola no alcanza: es un SELECT seguido de un INSERT con
           varios `await` en medio, así que dos entregas simultáneas del mismo
           wamid —Meta reintenta— pasaban las dos y el mensaje disparaba la IA
           dos veces (respuesta doble, foto doble). Ver utils/dedupeWamid. */
        if (!reclamarWamid(`${id_configuracion}|${wamid_entrante}`)) {
          await fsp.appendFile(
            path.join(logsDir, 'debug_log.txt'),
            `[${new Date().toISOString()}] ♻️ Entrega simultánea descartada (wamid=${wamid_entrante}, otra entrega lo está procesando)\n`,
          );
          return;
        }

        const yaProcesado = await MensajeCliente.findOne({
          where: { id_wamid_mensaje: wamid_entrante, id_configuracion },
          attributes: ['id'],
        });

        if (yaProcesado) {
          await fsp.appendFile(
            path.join(logsDir, 'debug_log.txt'),
            `[${new Date().toISOString()}] ♻️ Mensaje duplicado ignorado (wamid=${wamid_entrante}, ya guardado como msg=${yaProcesado.id})\n`,
          );
          return;
        }
      }

      switch (tipo_mensaje) {
        case 'text':
          texto_mensaje = mensaje_recibido?.text?.body || '';
          break;

        case 'edit': {
          // WhatsApp "edit": el nuevo contenido viene dentro de edit.message
          const editedMsg = mensaje_recibido?.edit?.message;

          // Normaliza como "texto" si el edit es de tipo text
          if (editedMsg?.type === 'text') {
            texto_mensaje = editedMsg?.text?.body || '';
          } else if (editedMsg?.type === 'reaction') {
            texto_mensaje = editedMsg?.reaction?.emoji || '';
          } else if (editedMsg?.type === 'image') {
            texto_mensaje = editedMsg?.image?.caption || '';
            // Si algún día Meta manda id aquí y quieres bajar el archivo:
            // const imageId = editedMsg?.image?.id;
            // ruta_archivo = imageId ? await descargarImagenWhatsapp(imageId, accessToken) : null;
          } else if (editedMsg?.type === 'video') {
            texto_mensaje = editedMsg?.video?.caption || '';
            // const videoId = editedMsg?.video?.id;
            // ruta_archivo = videoId ? await descargarVideoWhatsapp(videoId, accessToken) : null;
          } else if (editedMsg?.type === 'document') {
            texto_mensaje =
              editedMsg?.document?.caption ||
              editedMsg?.document?.filename ||
              'Documento editado';
          } else {
            // fallback: guardas algo legible
            texto_mensaje =
              editedMsg?.text?.body ||
              JSON.stringify(editedMsg || {}) ||
              'Mensaje editado';
          }

          // (Opcional) guardar referencia del mensaje original editado
          // Si quieres guardarlo en ruta_archivo (como ya haces con revoke):
          const originalId =
            mensaje_recibido?.edit?.original_message_id || null;
          if (originalId) {
            ruta_archivo = JSON.stringify({ original_message_id: originalId });
          }

          break;
        }

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
          ruta_archivo = await descargarAudioWhatsapp(audioId, accessToken);
          // texto_mensaje queda vacío a propósito: el wamid y la ruta del
          // archivo ya viven en sus propias columnas (id_wamid_mensaje y
          // ruta_archivo), así que este campo queda libre para la
          // transcripción, que se escribe más abajo si la IA está activa.
          // Antes guardaba "Audio recibido con ID: X. Archivo guardado en: URL"
          // y ese texto terminaba llegándole a la IA como si el cliente lo
          // hubiera escrito. Los errores de descarga ya se loguean dentro de
          // descargarAudioWhatsapp.
          texto_mensaje = '';
          break;

        case 'document': {
          const docId = mensaje_recibido?.document?.id;
          const filename =
            mensaje_recibido?.document?.filename ||
            `documento_${docId || 'sin_id'}.pdf`;

          ruta_archivo = await descargarDocumentoWhatsapp(
            docId,
            accessToken,
            filename,
          );

          // En smb_message_echoes normalmente NO viene caption, entonces guardamos al menos el filename
          texto_mensaje = mensaje_recibido?.document?.caption || filename;

          if (!ruta_archivo)
            texto_mensaje += '\nError al descargar el documento.';
          break;
        }

        case 'location':
          const location = mensaje_recibido?.location;
          /* 
          console.log('location: ' + location);

          console.log('location?.latitude: ' + location?.latitude);

          console.log('location?.longitude: ' + location?.longitude); */

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
            id_configuracion,
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
              `[${new Date().toISOString()}] ❌ No se encontraron los datos necesarios para enviar el mensaje template.\n`,
            );
          }

          break;

        case 'sticker':
          const stickerId = mensaje_recibido?.sticker?.id;
          ruta_archivo = await descargarStickerWhatsapp(stickerId, accessToken);
          texto_mensaje = `Sticker recibido y guardado con ID: ${stickerId}`;
          break;

        case 'revoke': {
          const originalId =
            mensaje_recibido?.revoke?.original_message_id || '';
          // Texto “humano” opcional para logs
          texto_mensaje = '🚫 Mensaje eliminado por el usuario';
          // Si quieres guardar referencia (opcional)
          ruta_archivo = originalId
            ? JSON.stringify({ original_message_id: originalId })
            : null;
          break;
        }

        default:
          texto_mensaje = 'Tipo de mensaje no reconocido.';
      }

      // ── El cliente editó o eliminó SU propio mensaje ─────────────────────
      // Estos dos eventos no son mensajes nuevos: apuntan a uno que ya
      // tenemos guardado. Antes se insertaban como una fila más, así que el
      // chat mostraba el texto viejo intacto y, aparte, un globito suelto
      // ("🚫 Mensaje eliminado por el usuario") que no se veía relacionado con
      // él. Ahora el cambio se aplica sobre el mensaje original y el chat lo
      // pinta como lo pinta WhatsApp.
      //
      // Nota: hoy Meta entrega las ediciones como tipo `unsupported` en vez de
      // `edit` ("temporarily unsupported" en su documentación), así que la
      // rama de edición sólo se activará cuando lo reactiven.
      if (tipo_mensaje === 'revoke' || tipo_mensaje === 'edit') {
        const aplicado = await aplicarEdicionORevoke({
          tipo_mensaje,
          mensaje_recibido,
          id_configuracion,
          texto_nuevo: texto_mensaje,
        });

        if (aplicado) {
          await fsp.appendFile(
            path.join(logsDir, 'debug_log.txt'),
            `[${new Date().toISOString()}] ✏️ Evento ${tipo_mensaje} aplicado sobre el mensaje original\n`,
          );
          return;
        }
        // Si no se encontró el original se sigue de largo y se guarda como
        // antes, para no perder el rastro del evento.
      }

      // ── Detectar referral (click desde anuncio) ──────────────
      const referral = msg0?.referral || null;
      let mensaje_para_ia = texto_mensaje;
      let bloque_producto_referral = null;

      if (referral) {
        const headline = referral.headline || '';
        /* if (
          id_configuracion == 10 ||
          id_configuracion == 277 ||
          id_configuracion == 392 ||
          id_configuracion == 569 ||
          id_configuracion == 360 ||
          id_configuracion == 324 ||
          id_configuracion == 476
        ) { */
          // Buscar el producto exacto en la BD
          /* El source_id habilita el nivel 0 del resolver (el mapa
             anuncio→producto): es lo único que resuelve los títulos de puro
             marketing, que no contienen ningún nombre de producto. */
          const bloqueProducto = await buscarProductoPorReferral(
            id_configuracion,
            headline,
            referral.source_id || null,
          );

          if (bloqueProducto) {
            // El producto va como instrucción del run (NO contamina el thread)
            bloque_producto_referral = `[ORIGEN DEL CLIENTE: vino de un anuncio del producto "${headline}"]

          ${bloqueProducto}

          INSTRUCCIÓN: Estos son los datos EXACTOS del producto del anuncio. Usa SOLO estos precios y URLs para este producto. Si el cliente pregunta por CUALQUIER OTRO producto distinto, usa tu catálogo (file_search) normalmente.`;
          } else {
            // Fallback: no encontró el producto en BD, manda solo el nombre del ad
            bloque_producto_referral = `[ORIGEN DEL CLIENTE: vino de un anuncio del producto "${headline}"]
            No se encontró este producto exacto en el catálogo. Búscalo en tu catálogo (file_search) por ese nombre.`;
          }
        /* } */

        const body_ad = referral.body || '';
        const source_url = referral.source_url || '';

        mensaje_para_ia = `[CONTEXTO: El cliente viene de un anuncio publicitario]
          Nombre del producto anunciado: ${headline}
          Mensaje del cliente: ${texto_mensaje}`;

        await fsp.appendFile(
          path.join(logsDir, 'debug_log.txt'),
          `[${new Date().toISOString()}] 📢 Referral detectado: ${headline}\n`,
        );
      }

      /* registrar en el log el mensaje */
      await fsp.appendFile(
        path.join(logsDir, 'debug_log.txt'),
        `[${new Date().toISOString()}] Mensaje procesado:` +
          texto_mensaje +
          ` \n`,
      );
      /* console.log(
        `[${new Date().toISOString()}] Mensaje procesado:` +
          texto_mensaje +
          ` \n`,
      ); */

      let id_cliente = null;
      let bot_openia = 1;
      let estado_contacto = 'contacto_inicial';

      const metaClienteTimestamps =
        isHistory && fechaMensaje
          ? { created_at: fechaMensaje, updated_at: fechaMensaje }
          : {};

      const cliente = await ensureUnifiedClient({
        id_configuracion,
        id_usuario_dueno: configuracion.id_usuario,

        source: 'wa',
        business_phone_id,

        phone: phone_whatsapp_from,
        nombre_cliente,
        apellido_cliente,

        motivo: 'auto_round_robin',
        metaClienteTimestamps,
        permiso_round_robin: configuracion.permiso_round_robin,
      });

      if (!cliente) {
        await fsp.appendFile(
          path.join(logsDir, 'debug_log.txt'),
          `[${new Date().toISOString()}] ❌ No se pudo crear/obtener cliente unificado\n`,
        );
        return;
      }

      id_cliente = cliente.id;
      bot_openia = cliente.bot_openia ?? 1;
      estado_contacto = cliente.estado_contacto ?? 'contacto_inicial';

      // ── Guardar historial producto ad ──────────────────────────
      if (referral) {
        try {
          await db.query(
            `INSERT INTO cliente_productos_ad
       (id_cliente, id_configuracion, headline, body_ad, source_url, source_id, ctwa_clid, mensaje_cliente)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            {
              replacements: [
                id_cliente,
                id_configuracion,
                referral.headline || null,
                referral.body || null,
                referral.source_url || null,
                referral.source_id || null,
                referral.ctwa_clid || null,
                texto_mensaje,
              ],
              type: db.QueryTypes.INSERT,
            },
          );
        } catch (err) {
          await fsp.appendFile(
            path.join(logsDir, 'debug_log.txt'),
            `[${new Date().toISOString()}] ❌ Error guardando cliente_productos_ad: ${err.message}\n`,
          );
        }
      }

      // ✅ si el chat estaba cerrado, reabrir
      if (cliente.chat_cerrado === 1) {
        // Chat sin encargado → aplicar RR y reabrir
        await asignarRoundRobinClienteExistente({
          id_cliente,
          id_configuracion,
          id_usuario_dueno: configuracion.id_usuario,
          permiso_round_robin: configuracion.permiso_round_robin,
          motivo: 'auto_round_robin_reopen',
        });
      }

      await fsp.appendFile(
        path.join(logsDir, 'debug_log.txt'),
        `Después de mensaje procesado\n`,
      );
      /* console.log(`Después de mensaje procesado\n`) */

      /* obtener id_cliente_configuracion */
      let clienteExisteConfiguracion = await ClientesChatCenter.findOne({
        where: { celular_cliente: telefono_configuracion, id_configuracion },
      });

      /* console.log(
        'clienteExisteConfiguracion.id: ' + clienteExisteConfiguracion.id
      ); */

      /* Fin obtener id_cliente_configuracion */

      if (!clienteExisteConfiguracion || !clienteExisteConfiguracion.id) {
        await fsp.appendFile(
          path.join(logsDir, 'debug_log.txt'),
          `[${new Date().toISOString()}] Error numero de configuracion no existe en tabla clientes_chat_center` +
            texto_mensaje +
            ` \n`,
        );
        console.log(
          `[${new Date().toISOString()}] Error numero de configuracion no existe en tabla clientes_chat_center` +
            texto_mensaje +
            ` \n`,
        );

        clienteExisteConfiguracion = await ClientesChatCenter.create({
          id_configuracion,
          uid_cliente: business_phone_id,
          nombre_cliente: nombre_configuracion,
          apellido_cliente: '',
          celular_cliente: telefono_configuracion,
          propietario: 1,
        });
      }

      const metaTimestamps =
        isHistory && fechaMensaje
          ? { created_at: fechaMensaje, updated_at: fechaMensaje }
          : {};

      // ✅ Asegurar que ruta_archivo se guarde como STRING JSON (como ya lo tenía en la BD)
      if (ruta_archivo && typeof ruta_archivo === 'object') {
        ruta_archivo = JSON.stringify(ruta_archivo);
      }

      // ── Si viene de un anuncio, sobrescribimos tipo y metemos info en ruta_archivo
      let tipo_mensaje_final = tipo_mensaje;
      let ruta_archivo_final = ruta_archivo;

      if (referral) {
        ruta_archivo_final = JSON.stringify({
          headline: referral.headline || '',
          body_ad: referral.body || '',
          source_url: referral.source_url || '',
          source_id: referral.source_id || '',
          ctwa_clid: referral.ctwa_clid || '',
          source_type: referral.source_type || '',
          media_type: referral.media_type || '',
          thumbnail_url: referral.thumbnail_url || referral.image_url || '',
          video_url: referral.video_url || '',
          // Guardamos tipo y ruta original por si era audio/imagen
          original_type: tipo_mensaje,
          original_media: ruta_archivo,
        });
        tipo_mensaje_final = 'referral';
      }

      const creacion_mensaje = await MensajeCliente.create({
        id_configuracion,
        id_cliente: clienteExisteConfiguracion.id,
        mid_mensaje: business_phone_id,
        tipo_mensaje: tipo_mensaje_final,
        texto_mensaje,
        ruta_archivo: ruta_archivo_final,
        rol_mensaje: isSMBEcho ? 1 : 0,
        celular_recibe: id_cliente,
        uid_whatsapp: phone_whatsapp_from,
        visto: 0,
        estado_meta: 0, // ✅ arranca en "enviado"
        context_wamid, // ✅ null si no es reply, wamid si sí
        responsable: isSMBEcho ? 'Whatsapp Business' : null,
        id_wamid_mensaje: msg0?.id,

        // ✅ solo si field === 'history'
        ...metaTimestamps,
      });

      /* console.log('creacion_mensaje: ' + JSON.stringify(creacion_mensaje));
      console.log('creacion_mensaje.id: ' + creacion_mensaje.id); */

      if (creacion_mensaje && creacion_mensaje.id) {
        // ✅ si es echo: NO correr bots/IA
        if (isSMBEcho) {
          await fsp.appendFile(
            path.join(logsDir, 'debug_log.txt'),
            `[${new Date().toISOString()}] ✅ Mensaje guardado en DB como smb_message_echoes con ID ${
              creacion_mensaje.id
            }\n`,
          );
          return;
        }

        await fsp.appendFile(
          path.join(logsDir, 'debug_log.txt'),
          `[${new Date().toISOString()}] ✅ Mensaje guardado en DB con ID ${
            creacion_mensaje.id
          }\n`,
        );

        /* enviar notificacion al socket */

        const resultado_api = await enviarConsultaAPI(
          id_configuracion,
          id_cliente,
        );

        // Dashboard real-time: nuevo mensaje entrante
        dashboardEmitter.emitByConfig(id_configuracion, 'new_chat', {
          chatsCreated: 1,
        });

        cancelarRemarketingEnNode(phone_whatsapp_from, id_configuracion);
        if (tipo_button == 'template') {
          await enviarMensajeTextoWhatsApp(
            accessToken,
            business_phone_id,
            phone_whatsapp_from,
            id_configuracion,
            id_template,
            'webhook',
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
              `[${new Date().toISOString()}] ⚠️ No se encontró mensaje interno principal.\n`,
            );
          } else {
            mensaje_interno = templatePrincipal.id_template;
            // Puedes loguear
            await fsp.appendFile(
              path.join(logsDir, 'debug_log.txt'),
              `[${new Date().toISOString()}] ✅ mensaje_interno obtenido: ${mensaje_interno}\n`,
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
              `[${new Date().toISOString()}] count_mensajes_clientes: ${countMensajes}\n`,
            );

            if (countMensajes === 1) {
              // Si solo tiene un mensaje, enviar el mensaje interno principal
              await enviarMensajeTextoWhatsApp(
                accessToken,
                business_phone_id,
                phone_whatsapp_from,
                id_configuracion,
                mensaje_interno,
                'webhook', // responsable u otro parámetro según tu implementación
              );
            }
          }
        } catch (err) {
          await fsp.appendFile(
            path.join(logsDir, 'debug_log.txt'),
            `[${new Date().toISOString()}] ❌ Error en validar mensaje interno principal: ${
              err.message
            }\n`,
          );
        }

        /* validar si el chat ah sido cerrado */
        if (bot_openia === 1) {
          let total_tokens = 0;

          /* ── El thread SOLO lo necesitan las ramas viejas ──────────────
             `enviarAsistenteKanban` no recibe `id_thread` y no lo usa: por la
             Responses API la memoria es `openai_threads.response_id`, no el
             thread. Las únicas que lo consumen son las ramas por
             `tipo_configuracion` distintas de 'kanban', y hoy no hay ninguna
             cuenta de esos tipos.

             Pedirlo igual no era solo desperdicio (una llamada a OpenAI por
             cada uno de los ~16.500 mensajes diarios). Es una bomba de tiempo:
             `obtenerOCrearThreadId` valida el thread contra OpenAI y, si la
             validación falla, hace DELETE de la fila de `openai_threads` — la
             MISMA fila donde vive el `response_id`.

             Cuando OpenAI apague la Assistants API el 2026-08-26, esa
             validación va a fallar SIEMPRE: cada mensaje entrante borraría la
             memoria del cliente justo antes de que el motor la lea, y todos los
             bots empezarían a saludar de nuevo en cada turno sin un solo error
             a la vista.

             Con `null` para kanban, la rama viva deja de tocar esa fila. */
          const id_thread =
            tipo_configuracion === 'kanban'
              ? null
              : await obtenerThreadId(id_cliente, api_key_openai);

          // Si es audio y tienes ruta de archivo, intentar transcribir
          if (tipo_mensaje === 'audio' && ruta_archivo) {
            const texto_transcrito = await transcribirAudioDesdeArchivo(
              ruta_archivo,
              api_key_openai,
              msg0?.id, // wamid: si falla, queda en debug_log.txt qué audio fue
            );

            /* console.log('texto_transcrito: ' + texto_transcrito); */
            if (texto_transcrito) {
              texto_mensaje = texto_transcrito;

              // Persistimos la transcripción en el mensaje ya creado.
              // Es necesario porque construirRecapConversacion()
              // (kanban_ia.service.js) reconstruye el historial leyendo
              // texto_mensaje de la BD: sin esto, al resetearse el hilo por
              // context_length_exceeded la IA perdía todo lo que el cliente
              // dijo por audio. No cambia nada visualmente: para tipo_mensaje
              // 'audio' el front sólo renderiza el reproductor con ruta_archivo.
              try {
                await MensajeCliente.update(
                  { texto_mensaje },
                  { where: { id: creacion_mensaje.id } },
                );
              } catch (errUpd) {
                await fsp.appendFile(
                  path.join(logsDir, 'debug_log.txt'),
                  `[${new Date().toISOString()}] ⚠️ No se pudo guardar la transcripción en BD: ${errUpd.message}\n`,
                );
              }

              await fsp.appendFile(
                path.join(logsDir, 'debug_log.txt'),
                `[${new Date().toISOString()}] 📝 Transcripción exitosa: ${texto_mensaje}\n`,
              );
            } else {
              // Sin este aviso la IA recibía el texto crudo del audio (antes el
              // ID y la URL del archivo) y respondía cualquier cosa. Mismo
              // criterio que las imágenes: es mejor que sepa que llegó un audio
              // ilegible y le pida al cliente que escriba.
              texto_mensaje = TEXTO_AUDIO_ILEGIBLE;

              await fsp.appendFile(
                path.join(logsDir, 'debug_log.txt'),
                `[${new Date().toISOString()}] ⚠️ No se pudo transcribir el audio\n`,
              );
            }

            // En ambos casos la IA debe recibir el texto actualizado.
            if (referral) {
              mensaje_para_ia = `[CONTEXTO: El cliente viene de un anuncio publicitario]
              Nombre del producto anunciado: ${referral.headline || ''}
              Mensaje del cliente: ${texto_mensaje}`;
            } else {
              mensaje_para_ia = texto_mensaje;
            }
          }

          // Si es imagen, describirla para que la IA pueda "leerla".
          // Mismo criterio que el audio: sin flag, siempre que la IA esté activa.
          if (tipo_mensaje === 'image' && ruta_archivo) {
            const descripcion = await describirImagenDesdeArchivo(
              ruta_archivo,
              api_key_openai,
            );

            // El caption del cliente, si escribió algo junto a la foto
            const caption = (texto_mensaje || '').trim();

            // Si la visión falla se avisa igual: es mejor que la IA sepa que
            // llegó una imagen a que le entre un mensaje vacío y responda
            // cualquier cosa.
            const leido = descripcion || '[El cliente envió una imagen]';
            texto_mensaje = caption ? `${leido}\nCliente: ${caption}` : leido;

            // Persistir la descripción en el mensaje ya creado, igual que la
            // transcripción de audio de más arriba y por la misma razón:
            // construirRecapConversacion() rearma el historial leyendo
            // texto_mensaje de la BD, así que sin esto lo que decía la imagen
            // desaparecía del recap (caso 495, Iván: la foto de la agencia
            // Servientrega no dejaba rastro). De paso queda auditable qué leyó
            // la visión, y el panel la muestra como texto bajo la imagen.
            // Solo cuando la visión SÍ leyó algo: persistir el aviso genérico
            // "[El cliente envió una imagen]" bajo cada foto ilegible es ruido.
            if (descripcion) {
              try {
                await MensajeCliente.update(
                  { texto_mensaje },
                  { where: { id: creacion_mensaje.id } },
                );
              } catch (errUpd) {
                await fsp.appendFile(
                  path.join(logsDir, 'debug_log.txt'),
                  `[${new Date().toISOString()}] ⚠️ No se pudo guardar la descripción de la imagen en BD: ${errUpd.message}\n`,
                );
              }
            }

            if (referral) {
              mensaje_para_ia = `[CONTEXTO: El cliente viene de un anuncio publicitario]
              Nombre del producto anunciado: ${referral.headline || ''}
              Mensaje del cliente: ${texto_mensaje}`;
            } else {
              mensaje_para_ia = texto_mensaje;
            }

            await fsp.appendFile(
              path.join(logsDir, 'debug_log.txt'),
              `[${new Date().toISOString()}] ${
                descripcion ? '🖼️ Imagen descrita' : '⚠️ No se pudo leer la imagen'
              }: ${texto_mensaje}\n`,
            );
          }

          /* await enviarEscribiendoWhatsapp(phone_whatsapp_from,business_phone_id,accessToken); */

          let respuesta_asistente = '';

          if (tipo_configuracion == 'imporfactory') {
            respuesta_asistente = await enviarAsistenteGptImporfactory({
              mensaje: texto_mensaje,
              id_plataforma,
              id_configuracion,
              telefono: phone_whatsapp_from,
              api_key_openai,
              id_thread,
              business_phone_id,
              accessToken,
              estado_contacto,
            });

            if (respuesta_asistente?.status === 200) {
              total_tokens += Number(respuesta_asistente?.total_tokens ?? 0);

              if (estado_contacto == 'contacto_inicial') {
                // Mapeo de respuestas → estados en la DB
                const estadoMap = {
                  PLATAFORMAS_Y_CLASES: 'plataformas_clases',
                  PRODUCTOS_Y_PROVEEDORES: 'productos_proveedores',
                  COTIZACIONES: 'cotizaciones_imporfactory',
                  VENTAS: 'ventas_imporfactory',
                  ASESOR: 'asesor',
                };

                // Verifica si la respuesta está mapeada
                const respuesta = respuesta_asistente.respuesta;

                if (estadoMap[respuesta]) {
                  //aqui meter filtro para que si dice asesor se reaccion a asesor nuevamente
                  // si viene de cualquier otra IA
                  await ClientesChatCenter.update(
                    { estado_contacto: estadoMap[respuesta] },
                    { where: { id: id_cliente } },
                  );

                  switch (respuesta) {
                    case 'PLATAFORMAS_Y_CLASES':
                    case 'PRODUCTOS_Y_PROVEEDORES':
                    case 'COTIZACIONES':
                    case 'VENTAS':
                      // Reenviar al asistente GPT
                      nueva_respuesta_asistente =
                        await enviarAsistenteGptImporfactory({
                          mensaje: texto_mensaje,
                          id_plataforma,
                          id_configuracion,
                          telefono: phone_whatsapp_from,
                          api_key_openai,
                          id_thread,
                          business_phone_id,
                          accessToken,
                          estado_contacto: estadoMap[respuesta],
                        });

                      // 2) Detectar si la nueva respuesta menciona 'asesor'
                      const respuestaNueva =
                        nueva_respuesta_asistente.respuesta || '';
                      const mencionaAsesor = /asesor/i.test(respuestaNueva); // detecta asesor / Asesor / ASESOR

                      if (mencionaAsesor) {
                        // 3) Cambiar estado a asesor
                        await ClientesChatCenter.update(
                          { estado_contacto: 'asesor' },
                          { where: { id: id_cliente } },
                        );

                        // 4) Ejecutar acción especial
                        /*  await realizarAccionEspecialAsesor({
                          id_cliente,
                          phone_whatsapp_from,
                          business_phone_id,
                          accessToken,
                        }); */
                      }

                      total_tokens += Number(
                        nueva_respuesta_asistente?.total_tokens ?? 0,
                      );

                      await enviarMensajeWhatsapp({
                        phone_whatsapp_to: phone_whatsapp_from,
                        texto_mensaje: nueva_respuesta_asistente.respuesta,
                        business_phone_id,
                        accessToken,
                        id_configuracion,
                        responsable: nueva_respuesta_asistente.tipo_asistente,
                        total_tokens,
                      });
                      break;

                    case 'ASESOR':
                      // 🔥 Aquí metes tu acción especial
                      /* await realizarAccionEspecialAsesor({
                        id_cliente,
                        phone_whatsapp_from,
                        business_phone_id,
                        accessToken,
                      }); */
                      break;
                  }
                }
              } else if (estado_contacto != 'asesor') {
                await enviarMensajeWhatsapp({
                  phone_whatsapp_to: phone_whatsapp_from,
                  texto_mensaje: respuesta_asistente.respuesta,
                  business_phone_id,
                  accessToken,
                  id_configuracion,
                  responsable: respuesta_asistente.tipo_asistente,
                  total_tokens,
                });
              }
            }
          } else if (tipo_configuracion == 'imporshop_proveedor') {
            respuesta_asistente = await enviarAsistenteGptImporshopProveedor({
              mensaje: texto_mensaje,
              id_plataforma,
              id_configuracion,
              telefono: phone_whatsapp_from,
              api_key_openai,
              id_thread,
              business_phone_id,
              accessToken,
              estado_contacto,
            });

            if (respuesta_asistente?.status === 200) {
              total_tokens += Number(respuesta_asistente?.total_tokens ?? 0);

              if (estado_contacto == 'contacto_inicial') {
                // Mapeo de respuestas → estados en la DB
                const estadoMap = {
                  GARANTIAS: 'garantias',
                  SOPORTE_ENVIOS: 'soporte_envios',
                  INFO_PRODUCTO: 'info_producto',
                  SOPORTE_DROPI: 'soporte_dropi',
                  ONBOARDING: 'onboarding',
                  ASESOR: 'asesor',
                };

                // Verifica si la respuesta está mapeada
                const respuesta = respuesta_asistente.respuesta;

                if (estadoMap[respuesta]) {
                  //aqui meter filtro para que si dice asesor se reaccion a asesor nuevamente
                  // si viene de cualquier otra IA
                  await ClientesChatCenter.update(
                    { estado_contacto: estadoMap[respuesta] },
                    { where: { id: id_cliente } },
                  );

                  switch (respuesta) {
                    case 'GARANTIAS':
                    case 'SOPORTE_ENVIOS':
                    case 'INFO_PRODUCTO':
                    case 'SOPORTE_DROPI':
                    case 'ONBOARDING':
                      // Reenviar al asistente GPT
                      nueva_respuesta_asistente =
                        await enviarAsistenteGptImporshopProveedor({
                          mensaje: texto_mensaje,
                          id_plataforma,
                          id_configuracion,
                          telefono: phone_whatsapp_from,
                          api_key_openai,
                          id_thread,
                          business_phone_id,
                          accessToken,
                          estado_contacto: estadoMap[respuesta],
                        });

                      // 2) Detectar si la nueva respuesta menciona 'asesor'
                      const respuestaNueva =
                        nueva_respuesta_asistente.respuesta || '';
                      const mencionaAsesor = /asesor/i.test(respuestaNueva); // detecta asesor / Asesor / ASESOR

                      if (mencionaAsesor) {
                        // 3) Cambiar estado a asesor
                        await ClientesChatCenter.update(
                          { estado_contacto: 'asesor' },
                          { where: { id: id_cliente } },
                        );

                        // 4) Ejecutar acción especial
                        /*  await realizarAccionEspecialAsesor({
                          id_cliente,
                          phone_whatsapp_from,
                          business_phone_id,
                          accessToken,
                        }); */
                      }

                      total_tokens += Number(
                        nueva_respuesta_asistente?.total_tokens ?? 0,
                      );

                      await enviarMensajeWhatsapp({
                        phone_whatsapp_to: phone_whatsapp_from,
                        texto_mensaje: nueva_respuesta_asistente.respuesta,
                        business_phone_id,
                        accessToken,
                        id_configuracion,
                        responsable: nueva_respuesta_asistente.tipo_asistente,
                        total_tokens,
                      });
                      break;

                    case 'ASESOR':
                      // 🔥 Aquí metes tu acción especial
                      /* await realizarAccionEspecialAsesor({
                        id_cliente,
                        phone_whatsapp_from,
                        business_phone_id,
                        accessToken,
                      }); */
                      break;
                  }
                }
              } else if (estado_contacto != 'asesor') {
                await enviarMensajeWhatsapp({
                  phone_whatsapp_to: phone_whatsapp_from,
                  texto_mensaje: respuesta_asistente.respuesta,
                  business_phone_id,
                  accessToken,
                  id_configuracion,
                  responsable: respuesta_asistente.tipo_asistente,
                  total_tokens,
                });
              }
            }
          } else if (tipo_configuracion == 'eventos') {
            respuesta_asistente = await enviarAsistenteGptEventos({
              mensaje: texto_mensaje,
              id_plataforma,
              id_configuracion,
              telefono: phone_whatsapp_from,
              api_key_openai,
              id_thread,
              business_phone_id,
              accessToken,
              estado_contacto,
            });

            if (respuesta_asistente?.status === 200) {
              total_tokens += Number(respuesta_asistente?.total_tokens ?? 0);

              if (estado_contacto == 'contacto_inicial') {
                await ClientesChatCenter.update(
                  { estado_contacto: 'ia_ventas' },
                  { where: { id: id_cliente } },
                );
              }

              const mencionaAsesor = /asesor/i.test(
                respuesta_asistente.respuesta || '',
              ); // detecta asesor / Asesor / ASESOR

              if (mencionaAsesor) {
                // 3) Cambiar estado a asesor
                await ClientesChatCenter.update(
                  { estado_contacto: 'asesor' },
                  { where: { id: id_cliente } },
                );

                // 4) Ejecutar acción especial
                /*  await realizarAccionEspecialAsesor({
                          id_cliente,
                          phone_whatsapp_from,
                          business_phone_id,
                          accessToken,
                        }); */
              }

              await enviarMensajeWhatsapp({
                phone_whatsapp_to: phone_whatsapp_from,
                texto_mensaje: respuesta_asistente.respuesta,
                business_phone_id,
                accessToken,
                id_configuracion,
                responsable: respuesta_asistente.tipo_asistente,
                total_tokens,
              });
            }
          } else if (tipo_configuracion == 'ventas') {
            if (estado_contacto == 'seguimiento') {
              estado_contacto = 'ia_ventas';
              await ClientesChatCenter.update(
                { estado_contacto: 'ia_ventas' },
                { where: { id: id_cliente } },
              );
            }

            // Llamar a separador_productos antes de enviarAsistenteGptVentas
            const separadorRespuesta = await separador_productos({
              mensaje: texto_mensaje,
              id_plataforma,
              id_configuracion,
              telefono: phone_whatsapp_from,
              api_key_openai,
              id_thread,
              business_phone_id,
              accessToken,
              estado_contacto,
              id_cliente,
            });
            let lista_productos = '';

            if (separadorRespuesta.status === 200) {
              // Usar la respuesta del separador como prefijo antes de enviar el mensaje al asistente de ventas
              lista_productos = separadorRespuesta.respuesta;

              total_tokens += Number(separadorRespuesta?.total_tokens ?? 0);
            }

            respuesta_asistente = await enviarAsistenteGptVentas({
              mensaje: texto_mensaje,
              id_plataforma,
              id_configuracion,
              telefono: phone_whatsapp_from,
              api_key_openai,
              id_thread,
              business_phone_id,
              accessToken,
              estado_contacto,
              id_cliente,
              lista_productos,
            });

            if (respuesta_asistente?.status === 200) {
              total_tokens += Number(respuesta_asistente?.total_tokens ?? 0);

              if (estado_contacto == 'contacto_inicial') {
                await ClientesChatCenter.update(
                  { estado_contacto: 'ia_ventas' },
                  { where: { id: id_cliente } },
                );
              }

              const mensajeGPT = respuesta_asistente.respuesta;
              const tipoInfo = respuesta_asistente.tipoInfo;

              const pedidoConfirmado = /\[pedido_confirmado\]:\s*true/i.test(
                mensajeGPT,
              );

              const citaConfirmada = /\[cita_confirmada\]:\s*true/i.test(
                mensajeGPT,
              );

              if (pedidoConfirmado) {
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
                  mensajeGPT.match(/💰 Precio total:\s*(.+)/)?.[1]?.trim() ||
                  '';

                // Variables listas
                /* console.log('📦 Datos extraídos del pedido:');
                console.log({
                  nombre,
                  telefono,
                  provincia,
                  ciudad,
                  direccion,
                  producto,
                  precio,
                }); */

                await ClientesChatCenter.update(
                  { estado_contacto: 'generar_guia' },
                  { where: { id: id_cliente } },
                );
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
                  mensajeGPT.match(/💰 Precio total:\s*(.+)/)?.[1]?.trim() ||
                  '';

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
                /* console.log('📦 Datos extraídos de la cita:');
                console.log({
                  nombre,
                  telefono,
                  correo,
                  servicio,
                  fecha_hora_inicio_utc,
                  fecha_hora_fin_utc,
                  precio,
                }); */

                /* consultar id del calendarios */
                const calendars = await db.query(
                  `SELECT id
                  FROM calendars 
                  WHERE account_id  = ?`,
                  {
                    replacements: [id_configuracion],
                    type: db.QueryTypes.SELECT,
                  },
                );
                const id_calendars = calendars[0].id;
                /* consultar id del calendarios */

                /* consultar id del usuario y sub_usuario */
                const usuario = await db.query(
                  `SELECT sb.id_sub_usuario, sb.id_usuario
                  FROM configuraciones c
                  INNER JOIN sub_usuarios_chat_center sb ON sb.id_usuario = c.id_usuario
                  WHERE c.id  = ? AND c.suspendido = 0 AND sb.rol = "administrador" LIMIT 1`,
                  {
                    replacements: [id_configuracion],
                    type: db.QueryTypes.SELECT,
                  },
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

                /* console.log(JSON.stringify(payload)); */

                servicioAppointments.createAppointment(payload, id_usuarios);
              }

              /* Las urls salen ya normalizadas: el patrón anterior cortaba en
                 el primer espacio, y las de Dropi los traen, así que a Meta le
                 llegaba un link recortado que responde 200 pero no se entrega
                 nunca. Ver utils/urlsMedia. */
              const {
                imagenes: urls_imagenes,
                videos: urls_videos,
                texto: texto_sin_media,
              } = extraerUrlsMedia(mensajeGPT);

              /* Se descartan las que ya se le mandaron hace poco. Sin esto, cada
                 vez que el modelo repite la etiqueta en su respuesta —y la
                 repite turno a turno— al cliente le llegaba de nuevo la misma
                 foto. El asistente de kanban ya filtraba; estas ramas no, y por
                 eso las cuentas que no son kanban seguían viendo el problema. */
              const imagenes_a_enviar = await filtrarMediaNueva({
                id_cliente,
                id_configuracion,
                urls: urls_imagenes,
                etiqueta: 'imagen',
              });
              const videos_a_enviar = await filtrarMediaNueva({
                id_cliente,
                id_configuracion,
                urls: urls_videos,
                etiqueta: 'video',
              });

              /* Si el envío no salió, no queda fila en `mensajes_clientes`, así
                 que la marca en memoria estaría bloqueando una foto que el
                 cliente nunca recibió: se suelta para poder reintentar en el
                 próximo turno.

                 `enviarMedioWhatsapp` devuelve `{ ok, error }` en vez de lanzar
                 —antes se tragaba el fallo y este bloque no se ejecutaba jamás—.
                 Se comprueba el resultado y NO se corta: la respuesta de texto
                 va después, y una imagen que Meta rechaza no puede dejar al
                 cliente sin contestación. */
              // Enviar imágenes
              for (const url_img of imagenes_a_enviar) {
                const r = await enviarMedioWhatsapp({
                  tipo: 'image',
                  url_archivo: url_img,
                  phone_whatsapp_to: phone_whatsapp_from,
                  business_phone_id,
                  accessToken,
                  id_configuracion,
                  responsable: respuesta_asistente.tipo_asistente,
                }).catch((e) => ({ ok: false, error: e.message }));

                if (r && r.ok === false) {
                  olvidarEnviado(id_cliente, url_img);
                  console.log(
                    `⚠️ No se pudo enviar la imagen ${url_img}: ${r.error}`,
                  );
                }
              }

              // Enviar videos
              for (const url_video of videos_a_enviar) {
                const r = await enviarMedioWhatsapp({
                  tipo: 'video',
                  url_archivo: url_video,
                  phone_whatsapp_to: phone_whatsapp_from,
                  business_phone_id,
                  accessToken,
                  id_configuracion,
                  responsable: respuesta_asistente.tipo_asistente,
                }).catch((e) => ({ ok: false, error: e.message }));

                if (r && r.ok === false) {
                  olvidarEnviado(id_cliente, url_video);
                  console.log(
                    `⚠️ No se pudo enviar el video ${url_video}: ${r.error}`,
                  );
                }
              }

              // Eliminar las líneas con URLs del mensaje
              /* Parte del texto que `extraerUrlsMedia` ya dejó sin las etiquetas
                 de media: quitarlas acá con el patrón viejo dejaba colgando la
                 cola de las urls con espacios ("Image 2026-01-31 at 2.43.49 PM
                 (1).jpeg") a la vista del cliente. */
              let solo_texto = texto_sin_media
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
                  total_tokens,
                });
              }
            }
          } else if (tipo_configuracion == 'imporshop') {
            if (
              estado_contacto == 'contacto_inicial' ||
              estado_contacto == 'seguimiento'
            ) {
              estado_contacto = 'ia_ventas_imporshop';
            }

            // Llamar a separador_productos antes de enviarAsistenteGptVentas
            const separadorRespuesta = await separador_productos({
              mensaje: texto_mensaje,
              id_plataforma,
              id_configuracion,
              telefono: phone_whatsapp_from,
              api_key_openai,
              id_thread,
              business_phone_id,
              accessToken,
              estado_contacto,
              id_cliente,
            });
            let lista_productos = '';

            if (separadorRespuesta.status === 200) {
              // Usar la respuesta del separador como prefijo antes de enviar el mensaje al asistente de ventas
              lista_productos = separadorRespuesta.respuesta;

              total_tokens += Number(separadorRespuesta?.total_tokens ?? 0);
            }

            respuesta_asistente = await enviarAsistenteGptVentas({
              mensaje: texto_mensaje,
              id_plataforma,
              id_configuracion,
              telefono: phone_whatsapp_from,
              api_key_openai,
              id_thread,
              business_phone_id,
              accessToken,
              estado_contacto,
              id_cliente,
              lista_productos,
            });

            if (respuesta_asistente?.status === 200) {
              total_tokens += Number(respuesta_asistente?.total_tokens ?? 0);

              if (estado_contacto == 'contacto_inicial') {
                await ClientesChatCenter.update(
                  { estado_contacto: 'ia_ventas_imporshop' },
                  { where: { id: id_cliente } },
                );
              }

              const mensajeGPT = respuesta_asistente.respuesta;
              const tipoInfo = respuesta_asistente.tipoInfo;

              const pedidoConfirmado = /\[pedido_confirmado\]:\s*true/i.test(
                mensajeGPT,
              );

              const citaConfirmada = /\[cita_confirmada\]:\s*true/i.test(
                mensajeGPT,
              );

              const asesoronfirmado = /\[asesor_confirmado\]:\s*true/i.test(
                mensajeGPT,
              );

              const atencionUrgente = /\[atencion_urgente\]:\s*true/i.test(
                mensajeGPT,
              );

              if (pedidoConfirmado) {
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
                  mensajeGPT.match(/💰 Precio total:\s*(.+)/)?.[1]?.trim() ||
                  '';

                // Variables listas
                /* console.log('📦 Datos extraídos del pedido:');
                console.log({
                  nombre,
                  telefono,
                  provincia,
                  ciudad,
                  direccion,
                  producto,
                  precio,
                }); */

                await ClientesChatCenter.update(
                  { estado_contacto: 'generar_guia' },
                  { where: { id: id_cliente } },
                );
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
                  mensajeGPT.match(/💰 Precio total:\s*(.+)/)?.[1]?.trim() ||
                  '';

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
                /* console.log('📦 Datos extraídos de la cita:');
                console.log({
                  nombre,
                  telefono,
                  correo,
                  servicio,
                  fecha_hora_inicio_utc,
                  fecha_hora_fin_utc,
                  precio,
                }); */

                /* consultar id del calendarios */
                const calendars = await db.query(
                  `SELECT id
                  FROM calendars 
                  WHERE account_id  = ?`,
                  {
                    replacements: [id_configuracion],
                    type: db.QueryTypes.SELECT,
                  },
                );
                const id_calendars = calendars[0].id;
                /* consultar id del calendarios */

                /* consultar id del usuario y sub_usuario */
                const usuario = await db.query(
                  `SELECT sb.id_sub_usuario, sb.id_usuario
                  FROM configuraciones c
                  INNER JOIN sub_usuarios_chat_center sb ON sb.id_usuario = c.id_usuario
                  WHERE c.id  = ? AND c.suspendido = 0 AND sb.rol = "administrador" LIMIT 1`,
                  {
                    replacements: [id_configuracion],
                    type: db.QueryTypes.SELECT,
                  },
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

                /* console.log(JSON.stringify(payload)); */

                servicioAppointments.createAppointment(payload, id_usuarios);
              } else if (asesoronfirmado) {
                await ClientesChatCenter.update(
                  { estado_contacto: 'asesor' },
                  { where: { id: id_cliente } },
                );
              } else if (atencionUrgente) {
                await ClientesChatCenter.update(
                  { estado_contacto: 'atencion_urgente' },
                  { where: { id: id_cliente } },
                );
              }

              /* Las urls salen ya normalizadas: el patrón anterior cortaba en
                 el primer espacio, y las de Dropi los traen, así que a Meta le
                 llegaba un link recortado que responde 200 pero no se entrega
                 nunca. Ver utils/urlsMedia. */
              const {
                imagenes: urls_imagenes,
                videos: urls_videos,
                texto: texto_sin_media,
              } = extraerUrlsMedia(mensajeGPT);

              /* Se descartan las que ya se le mandaron hace poco. Sin esto, cada
                 vez que el modelo repite la etiqueta en su respuesta —y la
                 repite turno a turno— al cliente le llegaba de nuevo la misma
                 foto. El asistente de kanban ya filtraba; estas ramas no, y por
                 eso las cuentas que no son kanban seguían viendo el problema. */
              const imagenes_a_enviar = await filtrarMediaNueva({
                id_cliente,
                id_configuracion,
                urls: urls_imagenes,
                etiqueta: 'imagen',
              });
              const videos_a_enviar = await filtrarMediaNueva({
                id_cliente,
                id_configuracion,
                urls: urls_videos,
                etiqueta: 'video',
              });

              /* Si el envío no salió, no queda fila en `mensajes_clientes`, así
                 que la marca en memoria estaría bloqueando una foto que el
                 cliente nunca recibió: se suelta para poder reintentar en el
                 próximo turno.

                 `enviarMedioWhatsapp` devuelve `{ ok, error }` en vez de lanzar
                 —antes se tragaba el fallo y este bloque no se ejecutaba jamás—.
                 Se comprueba el resultado y NO se corta: la respuesta de texto
                 va después, y una imagen que Meta rechaza no puede dejar al
                 cliente sin contestación. */
              // Enviar imágenes
              for (const url_img of imagenes_a_enviar) {
                const r = await enviarMedioWhatsapp({
                  tipo: 'image',
                  url_archivo: url_img,
                  phone_whatsapp_to: phone_whatsapp_from,
                  business_phone_id,
                  accessToken,
                  id_configuracion,
                  responsable: respuesta_asistente.tipo_asistente,
                }).catch((e) => ({ ok: false, error: e.message }));

                if (r && r.ok === false) {
                  olvidarEnviado(id_cliente, url_img);
                  console.log(
                    `⚠️ No se pudo enviar la imagen ${url_img}: ${r.error}`,
                  );
                }
              }

              // Enviar videos
              for (const url_video of videos_a_enviar) {
                const r = await enviarMedioWhatsapp({
                  tipo: 'video',
                  url_archivo: url_video,
                  phone_whatsapp_to: phone_whatsapp_from,
                  business_phone_id,
                  accessToken,
                  id_configuracion,
                  responsable: respuesta_asistente.tipo_asistente,
                }).catch((e) => ({ ok: false, error: e.message }));

                if (r && r.ok === false) {
                  olvidarEnviado(id_cliente, url_video);
                  console.log(
                    `⚠️ No se pudo enviar el video ${url_video}: ${r.error}`,
                  );
                }
              }

              // Eliminar las líneas con URLs del mensaje
              /* Parte del texto que `extraerUrlsMedia` ya dejó sin las etiquetas
                 de media: quitarlas acá con el patrón viejo dejaba colgando la
                 cola de las urls con espacios ("Image 2026-01-31 at 2.43.49 PM
                 (1).jpeg") a la vista del cliente. */
              let solo_texto = texto_sin_media
                .replace(/\[pedido_confirmado\]:\s*true/gi, '') // Eliminar confirmación de pedido
                .replace(/\[cita_confirmada\]:\s*true/gi, '') // Eliminar confirmación de cita
                .replace(/\[asesor_confirmado\]:\s*true/gi, '') // Eliminar asesor_confirmado
                .replace(/\[atencion_urgente\]:\s*true/gi, ''); // Eliminar atencion_urgente

              solo_texto = solo_texto.trim();

              if (solo_texto !== '') {
                await enviarMensajeWhatsapp({
                  phone_whatsapp_to: phone_whatsapp_from,
                  texto_mensaje: solo_texto,
                  business_phone_id,
                  accessToken,
                  id_configuracion,
                  responsable: respuesta_asistente.tipo_asistente,
                  total_tokens,
                });
              }
            }
          } else if (tipo_configuracion == 'kanban') {
            // 1. Cliente respondió → cancelar remarketing pendiente SIEMPRE
            await cancelarRemarketingKanbanWrapper(
              id_cliente,
              id_configuracion,
            );

            // 1.5 Wizard de producto: si el cliente llega desde un anuncio de
            // un producto configurado, sale el paquete FIJO (fotos + video +
            // texto con precio y pregunta gancho) sin tocar la IA. Si el
            // mensaje fue un saludo o "quiero info", el turno termina ahí. En
            // los turnos siguientes, una pregunta que calce con una respuesta
            // rápida del producto también se contesta sin IA. Todo lo demás
            // sigue por enviarAsistenteKanban como siempre.
            let saltarIA = false;
            const logWizard = (m) =>
              fsp
                .appendFile(
                  path.join(logsDir, 'debug_log.txt'),
                  `[${new Date().toISOString()}] ${m}\n`,
                )
                .catch(() => {});
            try {
              const wiz = await intentarMensajeFijoWizard({
                id_configuracion,
                id_cliente,
                telefono: phone_whatsapp_from,
                business_phone_id,
                accessToken,
                estado_contacto,
                referral,
                texto_mensaje,
                log: logWizard,
              });
              // La ficha del wizard reemplaza al bloque genérico del referral:
              // trae descripción IA, combos válidos, FAQs y stock en vivo.
              if (wiz?.bloqueMotor) bloque_producto_referral = wiz.bloqueMotor;
              if (wiz?.saltarIA) saltarIA = true;

              if (!saltarIA && !wiz?.paqueteEnviado) {
                const rapida = await intentarRespuestaRapida({
                  id_configuracion,
                  id_cliente,
                  telefono: phone_whatsapp_from,
                  business_phone_id,
                  accessToken,
                  estado_contacto,
                  texto_mensaje,
                  log: logWizard,
                });
                if (rapida?.manejado) saltarIA = true;
              }
            } catch (eWiz) {
              await logWizard(`⚠️ wizard producto: ${eWiz.message}`);
            }

            // 2. Correr IA (solo si la columna tiene activa_ia=1)
            if (!saltarIA) {
              await enviarAsistenteKanban({
                mensaje: mensaje_para_ia,
                id_configuracion,
                id_cliente,
                telefono: phone_whatsapp_from,
                api_key_openai,
                business_phone_id,
                accessToken,
                estado_contacto,
                bloque_producto_referral,
              });
            }

            // 3. Re-leer estado actual (la IA pudo haberlo cambiado con un trigger)
            const clienteActualizado = await ClientesChatCenter.findByPk(
              id_cliente,
              {
                attributes: ['estado_contacto'],
              },
            );
            const estadoFinal =
              clienteActualizado?.estado_contacto || estado_contacto;

            // 4. Programar nuevo remarketing según estado final (con o sin IA)
            await programarRemarketingKanbanWrapper({
              id_configuracion,
              id_cliente,
              telefono: phone_whatsapp_from,
              estado_contacto: estadoFinal,
            });
          }
        }
        /* validar si el chat ah sido cerrado */

        if (resultado_api) {
          /* console.log({
            status: 'success',
            message: 'Datos enviados a la API correctamente.',
          }); */
        } else {
          console.log({
            status: 'error',
            message: 'No se pudo enviar los datos a la API.',
          });
        }
      } else {
        await fsp.appendFile(
          path.join(logsDir, 'debug_log.txt'),
          `[${new Date().toISOString()}] ❌ Error al guardar el mensaje en la base de datos.\n`,
        );
      }

      /* validar mensaje_espera */
      await estadoMensajeEspera(id_cliente);
      /* Fin validar mensaje_espera */

      await fsp.appendFile(
        path.join(logsDir, 'debug_log.txt'),
        'Fin Mensaje de mensaje\n',
      );
    } catch (err) {
      try {
        const logsDir = path.join(process.cwd(), './src/logs/logs_meta');
        await ensureDir(logsDir);

        const logPath = path.join(logsDir, 'debug_log.txt');

        const fullError = `
              ===== ERROR POS-RESPUESTA =====
              Fecha: ${new Date().toISOString()}
              Mensaje: ${err.message}
              Stack:
              ${err.stack || 'Sin stack disponible'}

              Tipo de error: ${err.name}
              Objeto recibido: ${JSON.stringify(err, null, 2)}

              ================================

              `;

        await fsp.appendFile(logPath, fullError);
      } catch (logErr) {
        console.error('Error registrando log:', logErr);
        console.error('Error original:', err);
      }
    }
  });
});

exports.emitirEstadoMeta = (id_configuracion, wamid, estado_meta) => {
  if (!io) return;

  io.emit('MESSAGE_STATUS_UPDATE', {
    id_configuracion,
    wamid,
    estado_meta,
  });
};
