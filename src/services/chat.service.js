const { Op, Sequelize, where } = require('sequelize');
const AppError = require('../utils/appError');
const MensajesClientes = require('../models/mensaje_cliente.model');
const ErroresChatMeta = require('../models/errores_chat_meta.model');
const ClientesChatCenter = require('../models/clientes_chat_center.model');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const DepartamentosChatCenter = require('../models/departamentos_chat_center.model');
const Clientes_chat_center = require('../models/clientes_chat_center.model');
const Historial_encargados = require('../models/historial_encargados.model');
const Configuraciones = require('../models/configuraciones.model');
const TemplatesChatCenter = require('../models/templates_chat_center.model');
const { db, db_2 } = require('../database/config');
const { marcarClientesImporchat } = require('./leads_imporchat.service');
const Plataforma = require('../models/plataforma.model');
const axios = require('axios');
const { buildSearchClause } = require('../utils/buscarContactosClause');
const {
  canalesDeUsuarioEnConfig,
  sqlFiltroCanales,
} = require('../utils/canalesDepartamento');

const {
  normalizePhoneNumber,
  generatePhoneVariations,
} = require('../utils/phoneUtils');
const { reactivarMetodoPagoSiCorresponde } = require('../utils/metaPagoStatus');
const UsuarioPlataforma = require('../models/usuario_plataforma.model');
const { logging } = require('googleapis/build/src/apis/logging');
class ChatService {
  async findChats(
    id_configuracion,
    id_sub_usuario,
    rol,
    {
      cursorFecha = null,
      cursorId = null,
      limit = 10,
      filtros = {},
      scopeChats = 'mine',
    },
  ) {
    try {
      /* console.log('Filtros:', filtros); */

      const configuraciones = await Configuraciones.findOne({
        where: { id: id_configuracion, suspendido: 0 },
        attributes: ['telefono'],
      });

      const numero = configuraciones ? configuraciones.telefono : null;

      if (!numero) {
        throw new AppError(
          'El número de teléfono para excluir no se encontró.',
          500,
        );
      }
      /* Filtro «sin responder»: chats donde el último mensaje es del
         cliente y ya pasaron X minutos. Se resuelve acá arriba porque no
         agrega solo una condición: también cambia el alcance y el orden. */
      const minutosSinRespuesta = Number(filtros.selectedSinRespuesta?.value);
      const filtrandoSinRespuesta =
        Number.isFinite(minutosSinRespuesta) && minutosSinRespuesta > 0;

      const esAdmin = rol == 'administrador' || rol == 'admin_limitado';
      let usaSubUsuario = false;

      /* Canales del asesor en esta conexión (departamentos → canales). Un
         asesor que solo atiende Messenger/Instagram NO ve en «En espera»
         los chats de WhatsApp: esos quedan para quienes sí atienden ese
         canal y para los administradores, que siempre ven todo. «Mis chats»
         no se filtra: lo que se le asignó o transfirió a mano es suyo. */
      const filtroCanalEspera = esAdmin
        ? null
        : sqlFiltroCanales(
            await canalesDeUsuarioEnConfig(id_sub_usuario, id_configuracion),
          );
      const soloSinEncargado = filtroCanalEspera
        ? `(id_encargado IS NULL AND ${filtroCanalEspera})`
        : `id_encargado IS NULL`;

      let whereClause = `WHERE id_configuracion = :id_configuracion AND propietario != 1`;

      if (filtrandoSinRespuesta) {
        /* La cola de espera no se parte por pestaña: se ve completa. Si
           respetara el scope, un chat sin asignar no saldría en «Mis
           chats» aunque el aviso lo esté contando, y el filtro parecería
           roto justo cuando más se lo necesita. */
        if (!esAdmin) {
          whereClause += ` AND (id_encargado = :id_sub_usuario OR ${soloSinEncargado})`;
          usaSubUsuario = true;
        }
      } else if (esAdmin) {
        whereClause +=
          scopeChats != 'mine'
            ? ` AND id_encargado IS NULL`
            : ` AND id_encargado IS NOT NULL `;
      } else if (scopeChats == 'mine') {
        whereClause += ` AND id_encargado = :id_sub_usuario `;
        usaSubUsuario = true;
      } else {
        whereClause += ` AND ${soloSinEncargado}`;
      }

      if (filtros.searchTerm && filtros.searchTerm.trim() !== '') {
        whereClause += ` AND (LOWER(nombre_cliente) LIKE :searchTerm OR LOWER(celular_cliente) LIKE :searchTerm)`;
      }

      if (filtros.source && filtros.source !== 'all') {
        const allowed = new Set(['wa', 'ig', 'ms']);
        if (allowed.has(String(filtros.source))) {
          whereClause += ` AND source = :source`;
        }
      }

      if (filtros.selectedEtiquetas && filtros.selectedEtiquetas.length > 0) {
        whereClause += ` AND (${filtros.selectedEtiquetas
          .map(
            (etiqueta) =>
              `JSON_CONTAINS(etiquetas, '{"id": ${etiqueta.value}}', '$')`,
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

      if (filtros.selectedEstado_contacto?.value) {
        whereClause += ` AND estado_db = '${filtros.selectedEstado_contacto.value}'`;
      }

      // Filtro lectura
      if (filtros.selectedLectura?.value === 'no_leidos') {
        whereClause += ` AND mensajes_pendientes > 0`;
      } else if (filtros.selectedLectura?.value === 'leidos') {
        whereClause += ` AND mensajes_pendientes = 0`;
      }

      // Filtro asesor
      if (filtros.selectedAsesor?.value) {
        whereClause += ` AND id_encargado = :selectedAsesor`;
      }

      // Filtro producto del anuncio  ← NUEVO
      if (filtros.selectedProductoAd?.value) {
        if (filtros.selectedProductoAd.value === '__sin_producto__') {
          whereClause += ` AND (ultimo_producto_ad IS NULL OR ultimo_producto_ad = '')`;
        } else {
          whereClause += ` AND ultimo_producto_ad = :selectedProductoAd`;
        }
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
            ', ',
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

      /* Al filtrar por espera se invierte el orden: la gracia es ver
         primero al que lleva más tiempo esperando, que con el orden
         normal queda al final de todo el scroll. */
      if (filtrandoSinRespuesta) {
        whereClause += ` AND mensaje_rol = 0 AND chat_cerrado = 0`;
        whereClause += ` AND mensaje_created_at <= NOW() - INTERVAL :minutosSinRespuesta MINUTE`;
      }

      // El cursor tiene que seguir la misma dirección que el ORDER BY o la
      // paginación devuelve siempre la primera página.
      const orden = filtrandoSinRespuesta ? 'ASC' : 'DESC';
      const comparador = filtrandoSinRespuesta ? '>' : '<';

      if (cursorFecha && cursorId) {
        whereClause += ` AND (mensaje_created_at ${comparador} :cursorFecha OR (mensaje_created_at = :cursorFecha AND id ${comparador} :cursorId))`;
      }

      const sqlQuery = `
      SELECT c.*
      FROM vista_chats c
      ${whereClause}
      ORDER BY mensaje_created_at ${orden}, id ${orden}
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
        ...(filtrandoSinRespuesta && {
          minutosSinRespuesta: Math.floor(minutosSinRespuesta),
        }),
        source:
          filtros.source && filtros.source !== 'all'
            ? String(filtros.source)
            : null,
        ...(filtros.selectedAsesor?.value && {
          selectedAsesor: filtros.selectedAsesor.value,
        }),
        ...(filtros.selectedProductoAd?.value &&
          filtros.selectedProductoAd.value !== '__sin_producto__' && {
            selectedProductoAd: filtros.selectedProductoAd.value,
          }),
      };

      // Se manda solo si el WHERE realmente lo referencia: que sobre no
      // rompe nada, que falte hace fallar la consulta entera.
      if (usaSubUsuario) {
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

      /* console.log('🚀 SQL Final ejecutada:\n', sqlFinal); */

      // Ejecutar la query
      const chats = await db.query(sqlQuery, {
        replacements,
        type: Sequelize.QueryTypes.SELECT,
      });

      // Solo en la configuración de lanzamientos: marca qué contactos ya son
      // clientes de ImporChat. Una consulta por página, no por chat.
      await marcarClientesImporchat(chats, id_configuracion);

      // Si el último mensaje de un chat quedó editado o eliminado, el preview
      // del sidebar tiene que decirlo en vez de mostrar el texto viejo.
      await this.marcarUltimoMensajeEditado(chats);

      return chats;
    } catch (error) {
      console.error('Error en la consulta:', error);
      throw new AppError('Error al obtener los chats', 500);
    }
  }

  /**
   * Marca en cada chat de la página si su último mensaje quedó editado o
   * eliminado por el cliente, para que el preview del sidebar no siga
   * mostrando el texto de algo que el cliente ya borró.
   *
   * Va como consulta aparte y no dentro de `vista_chats` a propósito: la vista
   * la comparten varias pantallas y recrearla en caliente es bastante más
   * riesgoso que esto, que es un lookup por clave primaria de a lo sumo una
   * página de ids (igual que `marcarClientesImporchat`). El WHERE final deja
   * pasar sólo lo que está marcado, que en la práctica es casi nada.
   *
   * También pisa `texto_mensaje`: la vista no lee `mensajes_clientes`, lee
   * `clientes_chat_center.ultimo_texto`, que es una copia escrita cuando el
   * mensaje llegó. Si después se editó, esa copia quedó vieja y el preview
   * mostraría el texto anterior a la edición.
   */
  async marcarUltimoMensajeEditado(chats) {
    if (!Array.isArray(chats) || chats.length === 0) return;

    // `mensaje_id` lo expone la propia vista (clientes_chat_center.ultimo_msg_id),
    // así que es exactamente el mismo mensaje que el preview está mostrando.
    const ids = [...new Set(chats.map((c) => c?.mensaje_id).filter(Boolean))];
    if (ids.length === 0) return;

    const filas = await db.query(
      `
      SELECT id, texto_mensaje, editado_at, eliminado_at
      FROM mensajes_clientes
      WHERE id IN (:ids)
        AND (editado_at IS NOT NULL OR eliminado_at IS NOT NULL)
      `,
      {
        replacements: { ids },
        type: Sequelize.QueryTypes.SELECT,
      },
    );

    if (filas.length === 0) return;

    const porMensaje = new Map(filas.map((f) => [String(f.id), f]));
    for (const chat of chats) {
      const marca = porMensaje.get(String(chat?.mensaje_id));
      if (!marca) continue;

      chat.mensaje_editado_at = marca.editado_at;
      chat.mensaje_eliminado_at = marca.eliminado_at;
      chat.texto_mensaje = marca.texto_mensaje;
    }
  }

  async getChatsByClient(id_cliente, id_configuracion) {
    try {
      // Validaciones
      if (!id_cliente || !id_configuracion) {
        throw new Error('id_cliente e id_configuracion son obligatorios');
      }
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
              'attachments_unificado',
              'meta_unificado',
              'json_mensaje',
              'context_wamid',
              'estado_meta',
              // Edición / borrado hecho por el cliente: el chat necesita
              // pintar el mensaje como eliminado o como editado, y poder
              // mostrar el texto que tenía antes.
              'texto_original',
              'editado_at',
              'eliminado_at',
              // Precio que Meta confirmó en el webhook: el chat marca los
              // mensajes que salieron gratis por la ventana de 72 h.
              'precio_meta_tipo',
              'precio_meta_facturable',
              'fep_expira_at',
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

      const celular_cliente =
        chats.length > 0 ? chats[0].celular_cliente : null;
      //  console.log("Chats: ", chats);

      const phoneVariants = celular_cliente;
      const plataforma = await Plataforma.findAll({
        where: {
          whatsapp: { [Op.like]: `%${phoneVariants}%` },
        },

        order: [['id_plataforma', 'ASC']],
      });

      const plataformaIds = plataforma.map((p) => p.id_plataforma);

      // Obtener paquetes solo si hay plataformas asociadas
      let paquetes = null;

      if (plataformaIds.length > 0) {
        const usuarioIds = await UsuarioPlataforma.findAll({
          where: {
            id_plataforma: {
              [Op.in]: plataformaIds,
            },
          },
          attributes: ['id_usuario'],
        }).then((results) => results.map((up) => up.id_usuario));

        console.log(
          'IDs de usuarios asociados a las plataformas:',
          plataformaIds,
          usuarioIds,
        );
        if (usuarioIds.length > 0) {
          // Priorizar estado 1 en cada paquete si tiene 1 en cualquiera de sus usuarios
          const paquetesConEstado = await db_2.query(
            `
            SELECT importacion, membresia_ecommerce, ecommerce, productos, fecha_suscripcion 
            FROM users 
            WHERE id_users IN (${usuarioIds.join(',')})
          `,
            {
              type: db_2.QueryTypes.SELECT,
            },
          );

          console.log('Paquetes con estado:', paquetesConEstado);

          // OR por campo (si existe un 1 en cualquiera -> queda 1)
          if ([265, 237, 242, 251, 261].includes(Number(id_configuracion))) {
            paquetes = paquetesConEstado.reduce(
              (acc, row) => {
                acc.importacion =
                  acc.importacion || Number(row.importacion) === 1 ? 1 : 0;
                acc.productos =
                  acc.productos || Number(row.productos) === 1 ? 1 : 0;
                acc.ecommerce =
                  acc.ecommerce || Number(row.ecommerce) === 1 ? 1 : 0;
                // Un mismo WhatsApp puede colgar de varios usuarios Imporsuit
                // (tiendas/plataformas distintas). La membresía vigente es la
                // de la suscripción más reciente, no la de la última fila.
                if (
                  row.fecha_suscripcion &&
                  (!acc.fecha_suscripcion ||
                    new Date(row.fecha_suscripcion) >
                      new Date(acc.fecha_suscripcion))
                ) {
                  acc.fecha_suscripcion = row.fecha_suscripcion;
                }
                return acc;
              },
              {
                importacion: 0,
                productos: 0,
                ecommerce: 0,
                fecha_suscripcion: null,
              },
            );
          } else {
            paquetes = null;
          }
        }
      }

      // Convertir chats a JSON y agregar paquetes
      const chatsPlain = chats.map((c) => c.toJSON());
      chatsPlain.forEach((c) => {
        c.paquetes = paquetes;
      });

      // Marcar mensajes como vistos
      await MensajesClientes.update(
        { visto: 1 },
        {
          where: {
            celular_recibe: '' + id_cliente,
            id_configuracion: id_configuracion,
            visto: 0,
            rol_mensaje: 0,
          },
        },
      );

      return chatsPlain;
    } catch (error) {
      console.error('Error al obtener los chats 1:', error.message);
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
          suspendido: 0,
        },
        attributes: [
          'id',
          'id_telefono',
          'token',
          'id_plataforma',
          'id_whatsapp',
          'telefono',
          'metodo_pago',
          'meta_business_id',
        ],
      });

      /* Antes de que el front muestre "Acción requerida en Meta": si el
         cliente ya arregló la facturación, Meta lo confirma acá y el aviso no
         sale (candado de 10 min por cuenta, ver utils/metaPagoStatus). Muta
         configuraciones.metodo_pago a 1 cuando reactiva. */
      if (configuraciones && Number(configuraciones.metodo_pago) === 0) {
        await reactivarMetodoPagoSiCorresponde(
          configuraciones,
          'GET_DATA_ADMIN',
        );
      }

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
        tipo_mensaje = 'text',
        id_configuracion,
        ruta_archivo = null,
        nombre_encargado,
        jwt_token = null, // ← NUEVO
      } = data;

      const fromTelefono = dataAdmin.id_telefono;
      const fromToken = dataAdmin.token;

      const url = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${fromTelefono}/messages`;

      let requestData;
      const tipo = String(tipo_mensaje || 'text').toLowerCase();

      if (tipo === 'text') {
        // ← SIN CAMBIOS
        requestData = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: true, body: mensaje || '' },
        };
      } else if (tipo === 'image') {
        // ← SIN CAMBIOS
        if (!ruta_archivo) throw new Error('Falta ruta_archivo para image');
        requestData = {
          messaging_product: 'whatsapp',
          to,
          type: 'image',
          image: {
            link: ruta_archivo,
            caption: mensaje || '',
          },
        };
      } else if (tipo === 'video') {
        // ═══════════════════════════════════════════
        //  VIDEO: mismo flujo que enviarVideoWhatsappFile
        //    Descargar buffer → subir a Meta → media_id
        // ═══════════════════════════════════════════
        if (!ruta_archivo) throw new Error('Falta ruta_archivo para video');

        const axios = require('axios');
        const FormData = require('form-data');

        // 1) Descargar video como buffer
        //    Si es Video API → usa el jwt_token del frontend
        //    Si es URL pública → descarga sin auth
        const downloadHeaders = {};
        const isVideoApi = String(ruta_archivo).includes('/Videos/stream');
        if (isVideoApi && jwt_token) {
          downloadHeaders.Authorization = `Bearer ${jwt_token}`;
        }

        console.log('[VIDEO_SEND] Descargando desde:', ruta_archivo);

        const dlResp = await axios.get(ruta_archivo, {
          headers: downloadHeaders,
          responseType: 'arraybuffer',
          timeout: 60000,
        });

        const videoBuffer = Buffer.from(dlResp.data);
        console.log(
          `[VIDEO_SEND] Descargado: ${(videoBuffer.length / (1024 * 1024)).toFixed(2)} MB`,
        );

        // 2) Subir buffer a Meta → media_id (igual que enviarVideoWhatsappFile)
        const uploadForm = new FormData();
        uploadForm.append('file', videoBuffer, {
          filename: 'video.mp4',
          contentType: 'video/mp4',
        });
        uploadForm.append('type', 'video/mp4');
        uploadForm.append('messaging_product', 'whatsapp');

        const uploadResp = await axios.post(
          `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${fromTelefono}/media`,
          uploadForm,
          {
            headers: {
              Authorization: `Bearer ${fromToken}`,
              ...uploadForm.getHeaders(),
            },
            timeout: 120000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
          },
        );

        const mediaId = uploadResp.data?.id;
        if (!mediaId) throw new Error('Meta no retornó media_id');

        console.log(`[VIDEO_SEND] ✅ media_id: ${mediaId}`);

        // 3) Enviar con media_id (NO con link)
        requestData = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'video',
          video: {
            id: mediaId, // ← media_id, NO link
            caption: mensaje || '',
          },
        };
      } else if (tipo === 'document' || tipo === 'file') {
        if (!ruta_archivo) throw new Error('Falta ruta_archivo para document');

        const audioExtensions = /\.(mp3|ogg|wav|aac|m4a|oga|opus)(\?.*)?$/i;
        const isAudio = audioExtensions.test(ruta_archivo);

        if (isAudio) {
          const { file: tmpFile } = require('tmp-promise');
          const fs = require('fs');
          const path = require('path');
          const FormData = require('form-data');
          const { execFile } = require('child_process');
          const { promisify } = require('util');
          const execFileAsync = promisify(execFile);

          // 1) Descargar el audio original
          console.log('[AUDIO_SEND] Descargando desde:', ruta_archivo);
          const dlResp = await axios.get(ruta_archivo, {
            responseType: 'arraybuffer',
            timeout: 60000,
          });
          const inputBuffer = Buffer.from(dlResp.data);
          console.log(
            `[AUDIO_SEND] Descargado: ${(inputBuffer.length / 1024).toFixed(1)} KB`,
          );

          // Detectar extensión real de la URL (mp3, m4a, wav, etc.)
          const urlPath = ruta_archivo.split('?')[0];
          const inputExt = path.extname(urlPath).toLowerCase() || '.mp3';

          // 2) Archivos temporales de entrada y salida
          const inputTmp = await tmpFile({ postfix: inputExt, keep: false });
          const outputTmp = await tmpFile({ postfix: '.ogg', keep: false });

          try {
            await fs.promises.writeFile(inputTmp.path, inputBuffer);

            // 3) Convertir a OGG/OPUS con execFile para control exacto de argumentos.
            //    WhatsApp exige: libopus, mono, 16000 Hz, sin streams de video.
            const ffmpegArgs = [
              '-y',
              '-i',
              inputTmp.path,
              '-vn', // eliminar video si existe
              '-c:a',
              'libopus',
              '-ar',
              '16000', // 16 kHz wideband
              '-ac',
              '1', // mono
              '-b:a',
              '16k', // 16 kbps CBR
              '-application',
              'voip', // application mode para voz
              '-frame_duration',
              '20', // frames de 20 ms
              '-f',
              'ogg',
              outputTmp.path,
            ];

            console.log('[AUDIO_SEND] ffmpeg args:', ffmpegArgs.join(' '));
            const { stderr } = await execFileAsync('ffmpeg', ffmpegArgs).catch(
              (err) => {
                throw new Error(`ffmpeg falló: ${err.stderr || err.message}`);
              },
            );
            if (stderr) console.log('[AUDIO_SEND] ffmpeg stderr:', stderr);

            const oggBuffer = await fs.promises.readFile(outputTmp.path);
            if (!oggBuffer || oggBuffer.length < 100) {
              throw new Error(
                `OGG generado inválido (${oggBuffer?.length ?? 0} bytes)`,
              );
            }
            console.log(
              `[AUDIO_SEND] Convertido OGG/OPUS: ${(oggBuffer.length / 1024).toFixed(1)} KB`,
            );

            // 4) Subir buffer OGG a Meta → obtener media_id
            const uploadForm = new FormData();
            uploadForm.append('file', oggBuffer, {
              filename: 'audio.ogg',
              contentType: 'audio/ogg; codecs=opus',
            });
            uploadForm.append('type', 'audio/ogg');
            uploadForm.append('messaging_product', 'whatsapp');

            const uploadResp = await axios.post(
              `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${fromTelefono}/media`,
              uploadForm,
              {
                headers: {
                  Authorization: `Bearer ${fromToken}`,
                  ...uploadForm.getHeaders(),
                },
                timeout: 120000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
              },
            );

            const mediaId = uploadResp.data?.id;
            if (!mediaId)
              throw new Error('Meta no retornó media_id para el audio');
            console.log(`[AUDIO_SEND] ✅ media_id: ${mediaId}`);

            // 5) Enviar como audio de voz con media_id (NO link)
            requestData = {
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to,
              type: 'audio',
              audio: {
                id: mediaId,
                voice: true,
              },
            };
          } finally {
            await inputTmp.cleanup();
            await outputTmp.cleanup();
          }
        } else {
          requestData = {
            messaging_product: 'whatsapp',
            to,
            type: 'document',
            document: {
              link: ruta_archivo,
              caption: mensaje || '',
            },
          };
        }
      } else {
        // ← SIN CAMBIOS
        requestData = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: true, body: mensaje || '' },
        };
      }

      // ← TODO LO DE ABAJO SIN CAMBIOS (envío + guardado BD)
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${fromToken}`,
      };

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestData),
      });

      const responseData = await response.json();

      if (responseData.error) {
        console.error('Error al enviar el mensaje:', responseData.error);
        throw new Error(responseData.error.message);
      }

      const wamid = responseData?.messages?.[0]?.id || null;

      const cliente = await ClientesChatCenter.findOne({
        where: { propietario: '1', id_configuracion },
      });

      const receptor = await ClientesChatCenter.findOne({
        where: { celular_cliente: to, id_configuracion },
      });

      const id_cliente = cliente ? cliente.id : null;
      const id_recibe = receptor ? receptor.id : null;

      const mensajeCliente = {
        id_configuracion: dataAdmin.id,
        mid_mensaje: fromTelefono,
        tipo_mensaje:
          requestData?.type ?? (tipo === 'file' ? 'document' : tipo),
        rol_mensaje: 1,
        id_cliente,
        uid_whatsapp: to,
        id_wamid_mensaje: wamid,
        responsable: nombre_encargado,
        texto_mensaje: mensaje || '',
        celular_recibe: id_recibe,
        informacion_suficiente: 1,
        visto: 0,
        created_at: new Date(),
        updated_at: new Date(),
      };

      if (ruta_archivo) mensajeCliente.ruta_archivo = ruta_archivo;

      const mensajeAgregado = await MensajesClientes.create(mensajeCliente);

      if (!mensajeAgregado) throw new Error('Error al guardar en BD');

      responseData.mensajeNuevo = mensajeAgregado;
      return responseData;
    } catch (error) {
      console.error('Error en la solicitud:', error);
      throw new Error('Ocurrió un error al enviar el mensaje.');
    }
  }

  /**
   * Buscador de destinatario del "+" del chat (nuevo chat / plantilla).
   *
   * Antes hacía `LIKE '%texto%'` sobre celular, nombre y apellido SIN límite:
   * con una letra devolvía miles de filas, el navegador las pintaba todas y la
   * pestaña se quedaba en blanco. Ahora usa exactamente la misma cláusula que
   * el buscador de /contactos (utils/buscarContactosClause.js: teléfono por
   * sufijo invertido, texto por FULLTEXT, 1-2 chars por prefijo), excluye
   * borrados y el número propio, y corta en `limit` filas.
   */
  async getCellphones(id_configuracion, texto, limit = 30) {
    try {
      const term = String(texto || '').trim();
      if (!id_configuracion || !term) return [];

      const s = buildSearchClause(term, 'c');
      if (!s) return [];

      const top = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 50);

      const rows = await db.query(
        `SELECT c.id, c.celular_cliente, c.nombre_cliente, c.apellido_cliente,
                c.id_encargado, c.source
           FROM clientes_chat_center c
          WHERE c.id_configuracion = ?
            AND c.deleted_at IS NULL
            AND c.propietario <> 1
            AND c.celular_cliente IS NOT NULL
            AND c.celular_cliente <> ''
            AND ${s.frag}
          ORDER BY c.ultimo_mensaje_at DESC, c.id DESC
          LIMIT ?`,
        {
          replacements: [id_configuracion, ...s.params, top],
          type: db.QueryTypes.SELECT,
        },
      );

      return rows;
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
        },
      );

      return mensajes;
    } catch (error) {
      throw new AppError(error.message, 500);
    }
  }

  async sendAudio(data) {}

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

  async findChatByIdentifier(id_configuracion, identifier) {
    try {
      const raw = String(identifier || '').trim();

      // Detectar si viene un ID numérico (chatId)
      const isNumericId = /^\d+$/.test(raw);

      // Si viene como "ext:xxxxx" (opcional)
      const isExternal = /^ext:/i.test(raw);
      const externalId = isExternal ? raw.replace(/^ext:/i, '').trim() : null;

      // Normalizar teléfono: dejar solo dígitos (por si viene +593...)
      const phoneDigits = raw.replace(/\D/g, '');

      let where = '';
      const replacements = { id_configuracion };

      if (isNumericId) {
        // ✅ PRIORIDAD: buscar por ID de cliente chat center
        where = 'AND id = :chatId';
        replacements.chatId = Number(raw);
      } else if (externalId) {
        // ✅ opcional: buscar por external_id si su vista lo tiene
        where = 'AND external_id = :external_id';
        replacements.external_id = externalId;
      } else {
        // ✅ fallback: buscar por celular_cliente (teléfono)
        where = 'AND celular_cliente = :phone';
        replacements.phone = phoneDigits || raw;
      }

      const sql = `
      SELECT *
      FROM vista_chats
      WHERE id_configuracion = :id_configuracion
      ${where}
      ORDER BY mensaje_created_at DESC, id DESC
      LIMIT 1
    `;

      const chat = await db.query(sql, {
        replacements,
        type: Sequelize.QueryTypes.SELECT,
      });

      // OJO: QueryTypes.SELECT devuelve array
      const encontrado = (Array.isArray(chat) ? chat[0] : chat) || null;
      if (encontrado) return encontrado;

      // Fallback: el cliente existe pero aún NO tiene mensajes, así que no
      // aparece en vista_chats (la vista requiere conversación). Devolvemos su
      // ficha base para abrir un chat vacío en vez de 404 (p. ej. contactos que
      // entraron por un pedido/carrito de Shopify y no han recibido mensaje).
      if (isExternal) return null; // sin fallback para external_id
      const base = await db.query(
        `SELECT * FROM clientes_chat_center
          WHERE id_configuracion = :id_configuracion ${where}
            AND deleted_at IS NULL
          ORDER BY id DESC
          LIMIT 1`,
        { replacements, type: Sequelize.QueryTypes.SELECT },
      );
      return (Array.isArray(base) ? base[0] : base) || null;
    } catch (err) {
      throw new AppError(err.message, 500);
    }
  }

  async getDataAsignar(id_configuracion, celular_recibe) {
    try {
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

      return ultimoMensaje;
    } catch (error) {
      throw new AppError(error.message, 500);
    }
  }

  async setDataAsignar(id_encargado, id_cliente_chat_center, id_configuracion) {
    try {
      if (!id_encargado) {
        return { status: 'fail', message: 'id_encargado es requerido' };
      }

      if (!id_cliente_chat_center || !id_configuracion) {
        return {
          status: 'fail',
          message:
            'id_cliente_chat_center o id_configuracion es requerido para WhatsApp',
        };
      }

      const Departamento = await DepartamentosChatCenter.findOne({
        where: { id_configuracion },
      });

      const id_departamento = Departamento?.id_departamento ?? null;

      await Historial_encargados.create({
        id_cliente_chat_center,
        id_encargado_nuevo: id_encargado,
        motivo: 'Auto-asignacion de chat',
        id_departamento_asginado: id_departamento,
      });

      await Clientes_chat_center.update(
        { id_encargado },
        { where: { id: id_cliente_chat_center } },
      );

      // Buscar el cliente propietario de esa configuración (igual que arriba)
      const cliente_configuracion = await Clientes_chat_center.findOne({
        where: {
          id_configuracion: id_configuracion,
          propietario: 1,
        },
      });

      // (opcional pero recomendado) si no existe propietario, evita crashear:
      if (!cliente_configuracion) {
        throw new Error(
          `No existe cliente propietario para id_configuracion=${configuracion_transferida.id_configuracion}`,
        );
      }

      await MensajesClientes.create({
        id_configuracion: id_configuracion,
        id_cliente: cliente_configuracion.id,
        mid_mensaje: cliente_configuracion.id_telefono,
        tipo_mensaje: 'notificacion',
        visto: 0,
        texto_mensaje: 'Te has asignado este chat',
        rol_mensaje: 3,
        celular_recibe: id_cliente_chat_center,
      });

      const ultimoMensaje = await this.getDataAsignar(
        id_configuracion,
        id_cliente_chat_center,
      );

      return {
        status: 'success',
        message: 'Chat asignado correctamente',
        data: ultimoMensaje,
      };
    } catch (error) {
      throw new AppError(error.message, 500);
    }
  }

  /**
   * Chats en los que el cliente escribió y sigue sin respuesta hace más de
   * `minutos`. Recorre TODA la configuración, no solo la página cargada en
   * la vista: los chats que más tiempo llevan esperando son justamente los
   * que quedan al final del listado y rara vez alcanzan a cargarse.
   *
   * El corte de tiempo se hace con NOW() de MySQL contra la misma columna,
   * así que no interviene la zona horaria del navegador.
   *
   * Alcance: el administrador ve toda la configuración; el asesor ve los
   * chats asignados a él y los que están sin asignar, que son los mismos
   * que puede abrir desde sus pestañas.
   */
  async findChatsSinRespuesta(
    id_configuracion,
    id_sub_usuario,
    rol,
    { minutos = 15, limit = 300 } = {},
  ) {
    try {
      const esAdmin = rol == 'administrador' || rol == 'admin_limitado';

      let whereClause = `
        WHERE id_configuracion = :id_configuracion
          AND propietario != 1
          AND chat_cerrado = 0
          AND mensaje_rol = 0
          AND mensaje_created_at <= NOW() - INTERVAL :minutos MINUTE`;

      if (!esAdmin) {
        // Mismo criterio que findChats: lo sin encargado solo cuenta si es
        // de un canal que este asesor atiende en la conexión.
        const filtroCanal = sqlFiltroCanales(
          await canalesDeUsuarioEnConfig(id_sub_usuario, id_configuracion),
        );
        whereClause += filtroCanal
          ? ` AND (id_encargado = :id_sub_usuario OR (id_encargado IS NULL AND ${filtroCanal}))`
          : ` AND (id_encargado = :id_sub_usuario OR id_encargado IS NULL)`;
      }

      // Se pide una fila de más: si vuelve, es que quedó recortado. Sale
      // más barato que un COUNT aparte, que era otra pasada completa por
      // la vista para un número que casi siempre es el largo de la lista.
      const replacements = {
        id_configuracion,
        minutos,
        limit: limit + 1,
      };
      if (!esAdmin) replacements.id_sub_usuario = id_sub_usuario;

      const chats = await db.query(
        `
        SELECT id,
               nombre_cliente,
               celular_cliente,
               texto_mensaje,
               source,
               id_encargado,
               nombre_encargado,
               mensaje_created_at,
               TIMESTAMPDIFF(MINUTE, mensaje_created_at, NOW()) AS minutos
        FROM vista_chats
        ${whereClause}
        ORDER BY mensaje_created_at ASC
        LIMIT :limit;
        `,
        { replacements, type: Sequelize.QueryTypes.SELECT },
      );

      const truncado = chats.length > limit;

      return {
        chats: truncado ? chats.slice(0, limit) : chats,
        total: truncado ? limit : chats.length,
        truncado,
      };
    } catch (error) {
      throw new AppError(error.message, 500);
    }
  }
}

module.exports = ChatService;
