const axios = require('axios');
const flatted = require('flatted');
const { db } = require('../database/config');
const {
  obtenerDatosClienteParaAssistant,
  obtenerDatosCalendarioParaAssistant,
  obtenerCalendarioClasImporfactory,
  procesarCombosParaIA,
} = require('../utils/datosClienteAssistant'); // Ajustar según organización
const {
  getConfigFromDB,
  onlyDigits,
} = require('../utils/whatsappTemplate.helpers');

const fs = require('fs').promises;
const path = require('path');
const FormData = require('form-data');
const fsSync = require('fs'); // Para `fs.createReadStream`

const logsDir = path.join(process.cwd(), './src/logs/logs_meta');

// Definición de la función estCosto
function estCosto(model, inputTokens = 0, outputTokens = 0) {
  // Precios por millón de tokens, ajusta estos valores según tu modelo y tarifas
  const PRICES = {
    'gpt-4-turbo': { inPer1M: 0.3, outPer1M: 1.2 }, // Estos son ejemplos, ajústalos a tus tarifas
  };

  // Si el modelo no tiene tarifas definidas, retornamos 0 como costo
  const price = PRICES[model] || { inPer1M: 0, outPer1M: 0 };

  // Calculamos el costo aproximado
  const inputCost = (inputTokens / 1_000_000) * price.inPer1M;
  const outputCost = (outputTokens / 1_000_000) * price.outPer1M;

  return (inputCost + outputCost).toFixed(6); // Retornamos el costo aproximado redondeado
}

async function log(msg) {
  await fs.mkdir(logsDir, { recursive: true });
  await fs.appendFile(
    path.join(logsDir, 'debug_log.txt'),
    `[${new Date().toISOString()}] ${msg}\n`,
  );
}

async function procesarAsistenteMensajeVentas(body) {
  const {
    mensaje,
    id_thread,
    id_plataforma,
    id_configuracion,
    telefono,
    api_key_openai,
    business_phone_id,
    accessToken,
    estado_contacto,
    id_cliente,
    lista_productos = null,
  } = body;

  try {
    await db.query(
      `UPDATE remarketing_pendientes
        SET cancelado = 1
        WHERE telefono = ?
        AND id_configuracion = ?
        AND enviado = 0
        AND cancelado = 0`,
      {
        replacements: [telefono, id_configuracion],
        type: db.QueryTypes.UPDATE,
      },
    );

    /* consulta de productos */
    // Si lista_productos es un array, procesamos la consulta
    let bloqueProductos = '';
    let lista_productos_depurada = '';

    if (typeof lista_productos === 'string') {
      try {
        lista_productos_depurada = JSON.parse(lista_productos);
      } catch (e) {
        // si no era JSON válido, lo tratamos como un solo producto
        lista_productos_depurada = [lista_productos];
      }
    }

    if (
      Array.isArray(lista_productos_depurada) &&
      lista_productos_depurada.length > 0
    ) {
      // Variable para almacenar el bloque de productos

      // Iterar sobre cada producto en lista_productos
      for (let producto of lista_productos_depurada) {
        // Consultar la tabla productos_chat_center usando LIKE
        const productosEncontrados = await db.query(
          `SELECT 
        pc.nombre AS nombre_producto,
            pc.descripcion AS descripcion_producto,
            pc.tipo AS tipo,
            pc.precio AS precio_producto,
            pc.duracion AS duracion,
            pc.imagen_url AS image_path,
            pc.video_url AS video_path,
            pc.stock AS stock,
            pc.nombre_upsell AS nombre_upsell,
            pc.descripcion_upsell AS descripcion_upsell,
            pc.precio_upsell AS precio_upsell,
            pc.imagen_upsell_url AS imagen_upsell_path,
            pc.combos_producto AS combos_producto,
        cc.nombre AS nombre_categoria
      FROM productos_chat_center pc
      INNER JOIN categorias_chat_center cc ON cc.id = pc.id_categoria
      WHERE pc.nombre LIKE :producto
      AND pc.id_configuracion = :id_configuracion`,
          {
            replacements: {
              producto: `%${producto}%`,
              id_configuracion: id_configuracion,
            },
            type: db.QueryTypes.SELECT,
          },
        );

        // Si encontramos productos, agregarlos al bloqueProductos
        if (productosEncontrados && productosEncontrados.length > 0) {
          for (let infoProducto of productosEncontrados) {
            const { combosNormalizados, bloqueCombos } = procesarCombosParaIA(
              infoProducto.combos_producto,
            );

            bloqueProductos += `🛒 Producto: ${infoProducto.nombre_producto}\n`;
            bloqueProductos += `📃 Descripción: ${infoProducto.descripcion_producto}\n`;
            bloqueProductos += `Precio: ${infoProducto.precio_producto}\n`;
            /* bloqueProductos += `Stock: ${infoProducto.stock}\n`; */
            bloqueProductos += bloqueCombos;
            bloqueProductos += `[producto_imagen_url]: ${infoProducto.image_path}\n\n`; // Recurso para el asistente
            bloqueProductos += `[producto_video_url]: ${infoProducto.video_path}\n\n`; // Recurso para el asistente
            bloqueProductos += `Tipo: ${infoProducto.tipo}\n`;
            bloqueProductos += `Categoría: ${infoProducto.nombre_categoria}\n`;
            bloqueProductos += `Nombre_upsell: ${infoProducto.nombre_upsell}\n`;
            bloqueProductos += `Descripcion_upsell: ${infoProducto.descripcion_upsell}\n`;
            bloqueProductos += `Precio_upsell: ${infoProducto.precio_upsell}\n`;
            bloqueProductos += ` [upsell_imagen_url]: ${infoProducto.imagen_upsell_path}\n`;
            bloqueProductos += `\n`;
          }
        }
      }

      // Si encontramos productos, los registramos en el log
      if (bloqueProductos) {
        await log(`✅ Productos encontrados:\n${bloqueProductos}`);
      } else {
        await log(
          '⚠️ No se encontraron productos con los nombres proporcionados.',
        );
      }
    }
    /* consulta de productos */

    // 1. Obtener assistants activos
    const assistants = await db.query(
      `SELECT assistant_id, tipo, productos, tiempo_remarketing, tomar_productos, ofrecer 
     FROM openai_assistants 
     WHERE id_configuracion = ? AND activo = 1`,
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      },
    );

    if (!assistants || assistants.length === 0) {
      await log(
        `⚠️ No se encontró un assistant válido ventas para id_configuracion: ${id_configuracion}`,
      );
      return {
        status: 400,
        error: 'No se encontró un assistant válido para este contexto',
      };
    }

    let bloqueInfo = '';
    let tipoInfo = null;

    let assistant_id = null;
    let tipo_asistente = '';
    let tiempo_remarketing = null;

    // Si tienes IA de ventas y 'ofrecer' es "servicios", omites la consulta de datos del cliente
    const sales = assistants.find((a) => a.tipo.toLowerCase() === 'ventas');

    if (sales && sales.ofrecer == 'servicios') {
      const datosCliente =
        await obtenerDatosCalendarioParaAssistant(id_configuracion);
      bloqueInfo = datosCliente.bloque || '';
      tipoInfo = datosCliente.tipo || null;
    }

    let nombre_estado = 'contacto_inicial';

    /* console.log('estado_contacto: ' + estado_contacto); */

    if (estado_contacto == 'contacto_inicial') {
      nombre_estado = 'contacto_inicial_ventas';
      tipo_asistente = 'IA_contacto_ventas';
    } else if (estado_contacto == 'ia_ventas') {
      if (sales.ofrecer == 'productos') {
        nombre_estado = 'ventas_productos';
        tipo_asistente = 'IA_productos_ventas';
      } else if (sales.ofrecer == 'servicios') {
        nombre_estado = 'ventas_servicios';
        tipo_asistente = 'IA_servicios_ventas';
      }
    } else if (estado_contacto == 'ia_ventas_imporshop') {
      if (sales.ofrecer == 'productos') {
        nombre_estado = 'ventas_productos_imporshop';
        tipo_asistente = 'IA_productos_ventas_imporshop';
      } /*  else if (sales.ofrecer == 'servicios') {
        nombre_estado = 'ventas_servicios';
        tipo_asistente = 'IA_servicios_ventas';
      } */
    } else {
      nombre_estado = '';
    }

    /* console.log('nombre_estado: ' + nombre_estado); */

    const oia_asistentes = await db.query(
      `SELECT template_key, assistant_id 
     FROM oia_assistants_cliente 
     WHERE template_key = '${nombre_estado}' AND id_configuracion = '${id_configuracion}'`,
      {
        type: db.QueryTypes.SELECT,
      },
    );

    if (!oia_asistentes || oia_asistentes.length === 0) {
      await log(`⚠️ No se encontró un assistant válido ventas`);
      return {
        status: 400,
        error: 'No se encontró un assistant válido para este contexto',
      };
    }

    assistant_id = oia_asistentes[0].assistant_id;
    tiempo_remarketing = sales?.tiempo_remarketing;

    if (
      estado_contacto == 'ia_ventas' ||
      estado_contacto == 'ia_ventas_imporshop'
    ) {
      if (bloqueProductos) {
        if (sales.ofrecer == 'productos') {
          bloqueInfo +=
            '📦 Información de todos los productos que ofrecemos pero que no necesariamente estan en el pedido. Olvidearse de los productos o servicios anteriores a este mensaje:\n\n';
          bloqueInfo += bloqueProductos;
        } else if (sales.ofrecer == 'servicios') {
          bloqueInfo +=
            '📦 Información de todos los servicios que ofrecemos pero que no necesariamente estan en el pedido. Olvidearse de los servicios o productos anteriores a este mensaje:\n\n';
          bloqueInfo += bloqueProductos;
        }
      }
    }

    if (!assistant_id) {
      await log(
        `⚠️ No se encontró un assistant válido ventas para id_thread: ${id_thread}`,
      );
      return {
        status: 400,
        error: 'No se encontró un assistant válido para este contexto',
      };
    }

    const headers = {
      Authorization: `Bearer ${api_key_openai}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'assistants=v2',
    };

    // 2. Enviar contexto y mensaje del usuario
    if (bloqueInfo) {
      await axios
        .post(
          `https://api.openai.com/v1/threads/${id_thread}/messages`,
          {
            role: 'user',
            content: `🧾 Información del cliente:\n\n${bloqueInfo}`,
          },
          { headers },
        )
        .catch(async (err) => {
          await log(
            `⚠️ Error al enviar mensaje del cliente a OpenAI para id_thread: ${id_thread}. Error: ${err.message}`,
          );
        });
    }

    await axios
      .post(
        `https://api.openai.com/v1/threads/${id_thread}/messages`,
        { role: 'user', content: mensaje },
        { headers },
      )
      .catch(async (err) => {
        await log(
          `⚠️ Error al enviar mensaje de usuario a OpenAI para id_thread: ${id_thread}. Error: ${err.message}`,
        );
      });

    // 3. Ejecutar assistant
    const runRes = await axios
      .post(
        `https://api.openai.com/v1/threads/${id_thread}/runs`,
        { assistant_id, max_completion_tokens: 200 },
        { headers },
      )
      .catch(async (err) => {
        await log(
          `⚠️ Error al ejecutar assistant para id_thread: ${id_thread}. Error: ${err.message}`,
        );
      });

    const run_id = runRes.data.id;
    if (!run_id) {
      await log(`⚠️ No se pudo obtener run_id para id_thread: ${id_thread}`);
      return {
        status: 400,
        error: 'No se pudo ejecutar el assistant.',
      };
    }

    let prompt_tokens = 0;
    let completion_tokens = 0;
    let total_tokens = 0;
    // 4. Esperar respuesta con polling
    let statusRun = 'queued',
      attempts = 0;
    while (
      statusRun !== 'completed' &&
      statusRun !== 'failed' &&
      attempts < 20
    ) {
      await new Promise((r) => setTimeout(r, 1000));
      attempts++;
      try {
        const statusRes = await axios.get(
          `https://api.openai.com/v1/threads/${id_thread}/runs/${run_id}`,
          { headers },
        );

        // Aquí podrías inspeccionar el objeto para evitar errores
        /* await log('Estatus de la respuesta recibida: ' + statusRes.status); */

        // Usar flatted.stringify solo si está seguro de que el objeto no tiene ciclos
        const objSinCiclos = flatted.stringify(statusRes.data);
        await log('objSinCiclos: ' + objSinCiclos);

        statusRun = statusRes.data.status;

        /* await log('statusRun: ' + statusRun); */

        // 🔎 Si el backend ya expone usage durante el run, lo registramos

        if (statusRes.data.usage) {
          await log(
            'Respuesta completa de usage: ' +
              flatted.stringify(statusRes.data.usage),
          ); // Esto te ayudará a ver la estructura completa

          ({
            prompt_tokens = 0, // Este es el valor para input_tokens
            completion_tokens = 0, // Este es el valor para output_tokens
            total_tokens = 0, // Total de tokens procesados
          } = statusRes.data.usage);

          const model = statusRes.data.model || 'gpt-4.1-mini';
          const costo = estCosto(model, prompt_tokens, completion_tokens);
          await log(
            `📊 USO (parcial): input=${prompt_tokens}, output=${completion_tokens}, total=${total_tokens}, modelo=${model}, costo≈$${costo}`,
          );
        }

        // Verifica si el estado es 'failed' para procesar el error
        if (statusRun === 'failed') {
          // Si hay un error en el campo 'error' de la respuesta
          if (statusRes.data.error) {
            await log('statusRes.data.error: ' + statusRes.data.error);

            // Validar si el error es por cuota excedida
            if (statusRes.data.error.code === 'rate_limit_exceeded') {
              await log(
                '🚨 Se excedió la cuota de la API. Revisa tu plan y detalles de facturación.',
              );
              return {
                status: 400,
                error:
                  'Se excedió la cuota de la API. Revisa tu plan y detalles de facturación.',
              };
            } else if (statusRes.data.error.code === '15') {
              await log(
                '🚨 Error de pago: falta de fondos. Por favor, revisa tu método de pago.',
              );
              return {
                status: 400,
                error:
                  'Error de pago: falta de fondos. Por favor, revisa tu método de pago.',
              };
            } else {
              await log(
                `⚠️ Error desconocido: ${statusRes.data.error.code} - ${statusRes.data.error.message}`,
              );
            }
          } else {
            // Si no se encuentra el campo error, revisa otros posibles campos
            await log(
              '⚠️ No se encontró un campo de error en la respuesta, pero la ejecución falló.',
            );

            // Verifica si hay un mensaje sobre cuota excedida
            if (
              statusRes.data.last_error &&
              statusRes.data.last_error.includes(
                'You exceeded your current quota',
              )
            ) {
              await log(
                '🚨 Se excedió la cuota de la API. Revisa tu plan y detalles de facturación.',
              );
            }

            // Verifica si 'last_error' contiene información
            if (statusRes.data.last_error) {
              await log(
                `Último error registrado: ${JSON.stringify(
                  statusRes.data.last_error,
                )}`,
              );
            }

            // Si hay algún mensaje adicional sobre el fallo
            if (statusRes.data.message) {
              await log(`Mensaje adicional: ${statusRes.data.message}`);
            }
          }
        }
        // Verifica si el estado es 'failed' para procesar el error
      } catch (err) {
        await log(
          `⚠️ Error al consultar estado de ejecución del assistant para id_thread: ${id_thread}. Error: ${err.message}`,
        );
        break; // Rompe el bucle en caso de error
      }
    }

    /* await log('statusRun: ' + statusRun); */

    if (statusRun === 'failed') {
      await log(
        `⚠️ La ejecución del assistant falló para id_thread: ${id_thread}`,
      );
      return {
        status: 400,
        error: 'Falló la ejecución del assistant.',
      };
    }

    const messagesRes = await axios
      .get(`https://api.openai.com/v1/threads/${id_thread}/messages`, {
        headers,
      })
      .catch(async (err) => {
        await log(
          `⚠️ Error al obtener mensajes de OpenAI para id_thread: ${id_thread}. Error: ${err.message}`,
        );
      });

    const mensajes = messagesRes.data.data || [];
    const respuesta = mensajes
      .reverse()
      .find((m) => m.role === 'assistant' && m.run_id === run_id)?.content?.[0]
      ?.text?.value;

    // 5. Programar remarketing basado en configuración por estado
    const [configRemarketing] = await db.query(
      `SELECT *
   FROM configuracion_remarketing
   WHERE id_configuracion = ?
     AND estado_contacto = ?
     AND activo = 1
   LIMIT 1`,
      {
        replacements: [id_configuracion, estado_contacto],
        type: db.QueryTypes.SELECT,
      },
    );

    const cfg = await getConfigFromDB(Number(id_configuracion));
    const telefono_configuracion = cfg?.telefono_configuracion
      ? String(cfg.telefono_configuracion)
      : null;

    console.log('xd:' + telefono_configuracion);
    console.log('xd2:', telefono_configuracion);

    if (!telefono_configuracion) {
      await log(
        `❌ No pude resolver telefono_configuracion desde cfg (id_configuracion=${id_configuracion})`,
      );
      throw new Error('No se pudo resolver telefono_configuracion');
    }

    if (configRemarketing) {
      const tiempoHoras = configRemarketing.tiempo_espera_horas;
      const tiempoDisparo = new Date(Date.now() + tiempoHoras * 3600000);

      await db.query(
        `INSERT INTO remarketing_pendientes
     (telefono,
     telefono_configuracion,
      id_cliente_chat_center,
      id_configuracion,
      estado_contacto_origen,
      nombre_template,
      language_code,
      tiempo_disparo,
      enviado,
      cancelado)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
        {
          replacements: [
            telefono,
            telefono_configuracion,
            id_cliente,
            id_configuracion,
            estado_contacto,
            configRemarketing.nombre_template,
            configRemarketing.language_code,
            tiempoDisparo,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
    }

    /* console.log('bloqueInfo: ' + bloqueInfo); */

    return {
      status: 200,
      respuesta: respuesta || '',
      tipo_asistente,
      bloqueInfo,
      tipoInfo,
      total_tokens,
    };
  } catch (err) {
    await log(
      `⚠️ Error en la función procesarAsistenteMensajeVentas. Error: ${err.message}`,
    );
    return {
      status: 500,
      error: 'Hubo un error interno en el servidor.',
    };
  }
}

async function procesarAsistenteMensajeEventos(body) {
  const {
    mensaje,
    id_thread,
    id_plataforma,
    id_configuracion,
    telefono,
    api_key_openai,
    business_phone_id,
    accessToken,
    estado_contacto,
    id_cliente,
    lista_productos = null,
  } = body;

  try {
    // 1. Obtener assistants activos
    const assistants = await db.query(
      `SELECT assistant_id, tipo, productos, tiempo_remarketing, tomar_productos, ofrecer 
     FROM openai_assistants 
     WHERE id_configuracion = ? AND activo = 1`,
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      },
    );

    if (!assistants || assistants.length === 0) {
      await log(
        `⚠️ No se encontró un assistant válido eventos para id_configuracion: ${id_configuracion}`,
      );
      return {
        status: 400,
        error: 'No se encontró un assistant válido para este contexto',
      };
    }

    let bloqueInfo = '';
    let tipoInfo = null;

    let assistant_id = null;
    let tipo_asistente = '';
    let tiempo_remarketing = null;

    // Si tienes IA de ventas y 'ofrecer' es "servicios", omites la consulta de datos del cliente
    const sales = assistants.find((a) => a.tipo.toLowerCase() === 'ventas');

    if (sales && sales.ofrecer == 'servicios') {
      const datosCliente =
        await obtenerDatosCalendarioParaAssistant(id_configuracion);
      bloqueInfo = datosCliente.bloque || '';
      tipoInfo = datosCliente.tipo || null;
    }

    let nombre_estado = 'contacto_inicial';

    /* console.log('estado_contacto: ' + estado_contacto); */

    if (estado_contacto == 'contacto_inicial') {
      nombre_estado = 'contacto_inicial_eventos';
      tipo_asistente = 'IA_contacto_eventos';
    } else if (estado_contacto == 'ia_ventas') {
      if (sales.ofrecer == 'productos') {
        nombre_estado = 'ventas_eventos';
        tipo_asistente = 'IA_ventas_eventos';
      } else if (sales.ofrecer == 'servicios') {
        nombre_estado = 'ventas_eventos';
        tipo_asistente = 'IA_ventas_eventos';
      }
    } else if (estado_contacto == 'ia_ventas_imporshop') {
      if (sales.ofrecer == 'productos') {
        nombre_estado = 'ventas_productos_imporshop';
        tipo_asistente = 'IA_productos_ventas_imporshop';
      } /*  else if (sales.ofrecer == 'servicios') {
        nombre_estado = 'ventas_servicios';
        tipo_asistente = 'IA_servicios_ventas';
      } */
    } else {
      nombre_estado = '';
    }

    /* console.log('nombre_estado: ' + nombre_estado); */

    const oia_asistentes = await db.query(
      `SELECT template_key, assistant_id 
     FROM oia_assistants_cliente 
     WHERE template_key = '${nombre_estado}' AND id_configuracion = '${id_configuracion}'`,
      {
        type: db.QueryTypes.SELECT,
      },
    );

    if (!oia_asistentes || oia_asistentes.length === 0) {
      await log(`⚠️ No se encontró un assistant válido eventos`);
      return {
        status: 400,
        error: 'No se encontró un assistant válido para este contexto',
      };
    }

    assistant_id = oia_asistentes[0].assistant_id;
    tiempo_remarketing = sales?.tiempo_remarketing;

    if (!assistant_id) {
      await log(
        `⚠️ No se encontró un assistant válido eventos para id_thread: ${id_thread}`,
      );
      return {
        status: 400,
        error: 'No se encontró un assistant válido para este contexto',
      };
    }

    const headers = {
      Authorization: `Bearer ${api_key_openai}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'assistants=v2',
    };

    // 2. Enviar contexto y mensaje del usuario
    if (bloqueInfo) {
      await axios
        .post(
          `https://api.openai.com/v1/threads/${id_thread}/messages`,
          {
            role: 'user',
            content: `🧾 Información del cliente:\n\n${bloqueInfo}`,
          },
          { headers },
        )
        .catch(async (err) => {
          await log(
            `⚠️ Error al enviar mensaje del cliente a OpenAI para id_thread: ${id_thread}. Error: ${err.message}`,
          );
        });
    }

    await axios
      .post(
        `https://api.openai.com/v1/threads/${id_thread}/messages`,
        { role: 'user', content: mensaje },
        { headers },
      )
      .catch(async (err) => {
        await log(
          `⚠️ Error al enviar mensaje de usuario a OpenAI para id_thread: ${id_thread}. Error: ${err.message}`,
        );
      });

    // 3. Ejecutar assistant
    const runRes = await axios
      .post(
        `https://api.openai.com/v1/threads/${id_thread}/runs`,
        { assistant_id, max_completion_tokens: 200 },
        { headers },
      )
      .catch(async (err) => {
        await log(
          `⚠️ Error al ejecutar assistant para id_thread: ${id_thread}. Error: ${err.message}`,
        );
      });

    const run_id = runRes.data.id;
    if (!run_id) {
      await log(`⚠️ No se pudo obtener run_id para id_thread: ${id_thread}`);
      return {
        status: 400,
        error: 'No se pudo ejecutar el assistant.',
      };
    }

    let prompt_tokens = 0;
    let completion_tokens = 0;
    let total_tokens = 0;
    // 4. Esperar respuesta con polling
    let statusRun = 'queued',
      attempts = 0;
    while (
      statusRun !== 'completed' &&
      statusRun !== 'failed' &&
      attempts < 20
    ) {
      await new Promise((r) => setTimeout(r, 1000));
      attempts++;
      try {
        const statusRes = await axios.get(
          `https://api.openai.com/v1/threads/${id_thread}/runs/${run_id}`,
          { headers },
        );

        // Aquí podrías inspeccionar el objeto para evitar errores
        /* await log('Estatus de la respuesta recibida: ' + statusRes.status); */

        // Usar flatted.stringify solo si está seguro de que el objeto no tiene ciclos
        const objSinCiclos = flatted.stringify(statusRes.data);
        await log('objSinCiclos: ' + objSinCiclos);

        statusRun = statusRes.data.status;

        /* await log('statusRun: ' + statusRun); */

        // 🔎 Si el backend ya expone usage durante el run, lo registramos

        if (statusRes.data.usage) {
          await log(
            'Respuesta completa de usage: ' +
              flatted.stringify(statusRes.data.usage),
          ); // Esto te ayudará a ver la estructura completa

          ({
            prompt_tokens = 0, // Este es el valor para input_tokens
            completion_tokens = 0, // Este es el valor para output_tokens
            total_tokens = 0, // Total de tokens procesados
          } = statusRes.data.usage);

          const model = statusRes.data.model || 'gpt-4.1-mini';
          const costo = estCosto(model, prompt_tokens, completion_tokens);
          await log(
            `📊 USO (parcial): input=${prompt_tokens}, output=${completion_tokens}, total=${total_tokens}, modelo=${model}, costo≈$${costo}`,
          );
        }

        // Verifica si el estado es 'failed' para procesar el error
        if (statusRun === 'failed') {
          // Si hay un error en el campo 'error' de la respuesta
          if (statusRes.data.error) {
            await log('statusRes.data.error: ' + statusRes.data.error);

            // Validar si el error es por cuota excedida
            if (statusRes.data.error.code === 'rate_limit_exceeded') {
              await log(
                '🚨 Se excedió la cuota de la API. Revisa tu plan y detalles de facturación.',
              );
              return {
                status: 400,
                error:
                  'Se excedió la cuota de la API. Revisa tu plan y detalles de facturación.',
              };
            } else if (statusRes.data.error.code === '15') {
              await log(
                '🚨 Error de pago: falta de fondos. Por favor, revisa tu método de pago.',
              );
              return {
                status: 400,
                error:
                  'Error de pago: falta de fondos. Por favor, revisa tu método de pago.',
              };
            } else {
              await log(
                `⚠️ Error desconocido: ${statusRes.data.error.code} - ${statusRes.data.error.message}`,
              );
            }
          } else {
            // Si no se encuentra el campo error, revisa otros posibles campos
            await log(
              '⚠️ No se encontró un campo de error en la respuesta, pero la ejecución falló.',
            );

            // Verifica si hay un mensaje sobre cuota excedida
            if (
              statusRes.data.last_error &&
              statusRes.data.last_error.includes(
                'You exceeded your current quota',
              )
            ) {
              await log(
                '🚨 Se excedió la cuota de la API. Revisa tu plan y detalles de facturación.',
              );
            }

            // Verifica si 'last_error' contiene información
            if (statusRes.data.last_error) {
              await log(
                `Último error registrado: ${JSON.stringify(
                  statusRes.data.last_error,
                )}`,
              );
            }

            // Si hay algún mensaje adicional sobre el fallo
            if (statusRes.data.message) {
              await log(`Mensaje adicional: ${statusRes.data.message}`);
            }
          }
        }
        // Verifica si el estado es 'failed' para procesar el error
      } catch (err) {
        await log(
          `⚠️ Error al consultar estado de ejecución del assistant para id_thread: ${id_thread}. Error: ${err.message}`,
        );
        break; // Rompe el bucle en caso de error
      }
    }

    /* await log('statusRun: ' + statusRun); */

    if (statusRun === 'failed') {
      await log(
        `⚠️ La ejecución del assistant falló para id_thread: ${id_thread}`,
      );
      return {
        status: 400,
        error: 'Falló la ejecución del assistant.',
      };
    }

    const messagesRes = await axios
      .get(`https://api.openai.com/v1/threads/${id_thread}/messages`, {
        headers,
      })
      .catch(async (err) => {
        await log(
          `⚠️ Error al obtener mensajes de OpenAI para id_thread: ${id_thread}. Error: ${err.message}`,
        );
      });

    const mensajes = messagesRes.data.data || [];
    const respuesta = mensajes
      .reverse()
      .find((m) => m.role === 'assistant' && m.run_id === run_id)?.content?.[0]
      ?.text?.value;

    // 5. Guardar remarketing si aplica
    if (tiempo_remarketing > 0) {
      const tiempoDisparo = new Date(Date.now() + tiempo_remarketing * 3600000);

      const existing = await db.query(
        `SELECT tiempo_disparo FROM remarketing_pendientes
       WHERE telefono = ? AND id_configuracion = ? AND DATE(tiempo_disparo) = DATE(?)
       LIMIT 1`,
        {
          replacements: [telefono, id_configuracion, tiempoDisparo],
          type: db.QueryTypes.SELECT,
        },
      );

      if (existing.length === 0) {
        await db
          .query(
            `INSERT INTO remarketing_pendientes
         (telefono, id_cliente_chat_center, id_configuracion, business_phone_id, access_token, openai_token, assistant_id, mensaje, tipo_asistente, tiempo_disparo, id_thread)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            {
              replacements: [
                telefono,
                id_cliente,
                id_configuracion,
                business_phone_id,
                accessToken,
                api_key_openai,
                assistant_id,
                respuesta,
                tipo_asistente,
                tiempoDisparo,
                id_thread,
              ],
              type: db.QueryTypes.INSERT,
            },
          )
          .catch(async (err) => {
            await log(
              `⚠️ Error al insertar remarketing para telefono: ${telefono}, id_thread: ${id_thread}. Error: ${err.message}`,
            );
          });
      }
    }

    /* console.log('bloqueInfo: ' + bloqueInfo); */

    return {
      status: 200,
      respuesta: respuesta || '',
      tipo_asistente,
      bloqueInfo,
      tipoInfo,
      total_tokens,
    };
  } catch (err) {
    await log(
      `⚠️ Error en la función procesarAsistenteMensajeEventos. Error: ${err.message}`,
    );
    return {
      status: 500,
      error: 'Hubo un error interno en el servidor.',
    };
  }
}

async function procesarAsistenteMensajeImporfactory(body) {
  const {
    mensaje,
    id_thread,
    id_plataforma,
    id_configuracion,
    telefono,
    api_key_openai,
    business_phone_id,
    accessToken,
    estado_contacto,
  } = body;

  try {
    // 1. Obtener assistants activos
    const assistants = await db.query(
      `SELECT template_key, assistant_id 
     FROM oia_assistants_cliente 
     WHERE template_key = '${estado_contacto}'`,
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      },
    );

    if (!assistants || assistants.length === 0) {
      await log(
        `⚠️ No se encontró un assistant válido imporfactory para id_configuracion: ${id_configuracion}`,
      );
      return {
        status: 400,
        error: 'No se encontró un assistant válido para este contexto',
      };
    }

    let bloqueInfo = '';
    let tipoInfo = null;

    let assistant_id = assistants[0].assistant_id;
    let tipo_asistente = `IA_${estado_contacto}`;

    if (!assistant_id) {
      await log(
        `⚠️ No se encontró un assistant válido imporfactory para id_thread: ${id_thread}`,
      );
      return {
        status: 400,
        error: 'No se encontró un assistant válido para este contexto',
      };
    }

    /* console.log('estado_contacto: ' + estado_contacto); */
    if (estado_contacto == 'plataformas_clases') {
      const datosCliente = await obtenerCalendarioClasImporfactory();
      bloqueInfo = datosCliente.bloque || '';
    }

    const headers = {
      Authorization: `Bearer ${api_key_openai}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'assistants=v2',
    };

    // 2. Enviar contexto y mensaje del usuario
    if (bloqueInfo) {
      await axios
        .post(
          `https://api.openai.com/v1/threads/${id_thread}/messages`,
          {
            role: 'user',
            content: `${bloqueInfo}`,
          },
          { headers },
        )
        .catch(async (err) => {
          await log(
            `⚠️ Error al enviar mensaje del cliente a OpenAI para id_thread: ${id_thread}. Error: ${err.message}`,
          );
        });
    }

    await axios
      .post(
        `https://api.openai.com/v1/threads/${id_thread}/messages`,
        { role: 'user', content: mensaje },
        { headers },
      )
      .catch(async (err) => {
        await log(
          `⚠️ Error al enviar mensaje de usuario a OpenAI para id_thread: ${id_thread}. Error: ${err.message}`,
        );
      });

    // 3. Ejecutar assistant
    const runRes = await axios
      .post(
        `https://api.openai.com/v1/threads/${id_thread}/runs`,
        { assistant_id, max_completion_tokens: 200 },
        { headers },
      )
      .catch(async (err) => {
        await log(
          `⚠️ Error al ejecutar assistant para id_thread: ${id_thread}. Error: ${err.message}`,
        );
      });

    const run_id = runRes.data.id;
    if (!run_id) {
      await log(`⚠️ No se pudo obtener run_id para id_thread: ${id_thread}`);
      return {
        status: 400,
        error: 'No se pudo ejecutar el assistant.',
      };
    }

    let prompt_tokens = 0;
    let completion_tokens = 0;
    let total_tokens = 0;

    // 4. Esperar respuesta con polling
    let statusRun = 'queued',
      attempts = 0;
    while (
      statusRun !== 'completed' &&
      statusRun !== 'failed' &&
      attempts < 20
    ) {
      await new Promise((r) => setTimeout(r, 1000));
      attempts++;
      try {
        const statusRes = await axios.get(
          `https://api.openai.com/v1/threads/${id_thread}/runs/${run_id}`,
          { headers },
        );

        // Aquí podrías inspeccionar el objeto para evitar errores
        /* await log('Estatus de la respuesta recibida: ' + statusRes.status); */

        // Usar flatted.stringify solo si está seguro de que el objeto no tiene ciclos
        const objSinCiclos = flatted.stringify(statusRes.data);
        await log('objSinCiclos: ' + objSinCiclos);

        statusRun = statusRes.data.status;

        /* await log('statusRun: ' + statusRun); */

        // 🔎 Si el backend ya expone usage durante el run, lo registramos

        if (statusRes.data.usage) {
          await log(
            'Respuesta completa de usage: ' +
              flatted.stringify(statusRes.data.usage),
          ); // Esto te ayudará a ver la estructura completa

          ({
            prompt_tokens = 0, // Este es el valor para input_tokens
            completion_tokens = 0, // Este es el valor para output_tokens
            total_tokens = 0, // Total de tokens procesados
          } = statusRes.data.usage);
          const model = statusRes.data.model || 'gpt-4.1-mini';
          const costo = estCosto(model, prompt_tokens, completion_tokens);
          await log(
            `📊 USO (parcial): input=${prompt_tokens}, output=${completion_tokens}, total=${total_tokens}, modelo=${model}, costo≈$${costo}`,
          );
        }

        // Verifica si el estado es 'failed' para procesar el error
        if (statusRun === 'failed') {
          // Si hay un error en el campo 'error' de la respuesta
          if (statusRes.data.error) {
            await log('statusRes.data.error: ' + statusRes.data.error);

            // Validar si el error es por cuota excedida
            if (statusRes.data.error.code === 'rate_limit_exceeded') {
              await log(
                '🚨 Se excedió la cuota de la API. Revisa tu plan y detalles de facturación.',
              );
              return {
                status: 400,
                error:
                  'Se excedió la cuota de la API. Revisa tu plan y detalles de facturación.',
              };
            } else if (statusRes.data.error.code === '15') {
              await log(
                '🚨 Error de pago: falta de fondos. Por favor, revisa tu método de pago.',
              );
              return {
                status: 400,
                error:
                  'Error de pago: falta de fondos. Por favor, revisa tu método de pago.',
              };
            } else {
              await log(
                `⚠️ Error desconocido: ${statusRes.data.error.code} - ${statusRes.data.error.message}`,
              );
            }
          } else {
            // Si no se encuentra el campo error, revisa otros posibles campos
            await log(
              '⚠️ No se encontró un campo de error en la respuesta, pero la ejecución falló.',
            );

            // Verifica si hay un mensaje sobre cuota excedida
            if (
              statusRes.data.last_error &&
              statusRes.data.last_error.includes(
                'You exceeded your current quota',
              )
            ) {
              await log(
                '🚨 Se excedió la cuota de la API. Revisa tu plan y detalles de facturación.',
              );
            }

            // Verifica si 'last_error' contiene información
            if (statusRes.data.last_error) {
              await log(
                `Último error registrado: ${JSON.stringify(
                  statusRes.data.last_error,
                )}`,
              );
            }

            // Si hay algún mensaje adicional sobre el fallo
            if (statusRes.data.message) {
              await log(`Mensaje adicional: ${statusRes.data.message}`);
            }
          }
        }
        // Verifica si el estado es 'failed' para procesar el error
      } catch (err) {
        await log(
          `⚠️ Error al consultar estado de ejecución del assistant para id_thread: ${id_thread}. Error: ${err.message}`,
        );
        break; // Rompe el bucle en caso de error
      }
    }

    /* await log('statusRun: ' + statusRun); */

    if (statusRun === 'failed') {
      await log(
        `⚠️ La ejecución del assistant falló para id_thread: ${id_thread}`,
      );
      return {
        status: 400,
        error: 'Falló la ejecución del assistant.',
      };
    }

    const messagesRes = await axios
      .get(`https://api.openai.com/v1/threads/${id_thread}/messages`, {
        headers,
      })
      .catch(async (err) => {
        await log(
          `⚠️ Error al obtener mensajes de OpenAI para id_thread: ${id_thread}. Error: ${err.message}`,
        );
      });

    const mensajes = messagesRes.data.data || [];
    const respuesta = mensajes
      .reverse()
      .find((m) => m.role === 'assistant' && m.run_id === run_id)?.content?.[0]
      ?.text?.value;

    /* console.log('bloqueInfo: ' + bloqueInfo); */

    return {
      status: 200,
      respuesta: respuesta || '',
      tipo_asistente,
      bloqueInfo,
      tipoInfo,
      total_tokens,
      costo_tokens: costo,
    };
  } catch (err) {
    await log(
      `⚠️ Error en la función procesarAsistenteMensajeImporfactory. Error: ${err.message}`,
    );
    return {
      status: 500,
      error: 'Hubo un error interno en el servidor.',
    };
  }
}

async function separadorProductos({
  mensaje,
  id_plataforma,
  id_configuracion,
  telefono,
  api_key_openai,
  id_thread,
  business_phone_id,
  accessToken,
  estado_contacto,
  id_cliente,
}) {
  try {
    // Obtener el tipo de asistente para separador_productos
    const oia_asistentes = await db.query(
      `SELECT template_key, assistant_id 
       FROM oia_assistants_cliente 
       WHERE template_key = 'separador_productos' AND id_configuracion = '${id_configuracion}'`,
      {
        type: db.QueryTypes.SELECT,
      },
    );

    if (!oia_asistentes || oia_asistentes.length === 0) {
      await log(
        '⚠️ No se encontró un assistant válido para separador_productos',
      );
      return {
        status: 400,
        error: 'No se encontró un assistant válido para separador_productos',
      };
    }

    const assistant_id = oia_asistentes[0].assistant_id;

    const headers = {
      Authorization: `Bearer ${api_key_openai}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'assistants=v2',
    };

    // Paso 1: Enviar el mensaje del usuario al thread
    await axios.post(
      `https://api.openai.com/v1/threads/${id_thread}/messages`,
      { role: 'user', content: mensaje },
      { headers },
    );

    // Paso 2: Ejecutar el run
    const runRes = await axios.post(
      `https://api.openai.com/v1/threads/${id_thread}/runs`,
      { assistant_id, max_completion_tokens: 200 },
      { headers },
    );

    const run_id = runRes.data.id;
    if (!run_id) {
      await log(`⚠️ No se pudo obtener run_id para separador_productos.`);
      return {
        status: 400,
        error: 'No se pudo ejecutar el assistant separador_productos.',
      };
    }

    let prompt_tokens = 0;
    let completion_tokens = 0;
    let total_tokens = 0;

    // Paso 3: Esperar la respuesta con polling
    let statusRun = 'queued',
      attempts = 0;
    let respuestaSeparador = '';
    while (
      statusRun !== 'completed' &&
      statusRun !== 'failed' &&
      attempts < 20
    ) {
      await new Promise((r) => setTimeout(r, 1000));
      attempts++;

      try {
        const statusRes = await axios.get(
          `https://api.openai.com/v1/threads/${id_thread}/runs/${run_id}`,
          { headers },
        );

        statusRun = statusRes.data.status;

        if (statusRun === 'completed') {
          const messagesRes = await axios.get(
            `https://api.openai.com/v1/threads/${id_thread}/messages`,
            { headers },
          );

          if (statusRes.data.usage) {
            await log(
              'Respuesta completa de usage: ' +
                flatted.stringify(statusRes.data.usage),
            ); // Esto te ayudará a ver la estructura completa

            ({
              prompt_tokens = 0, // Este es el valor para input_tokens
              completion_tokens = 0, // Este es el valor para output_tokens
              total_tokens = 0, // Total de tokens procesados
            } = statusRes.data.usage);
            const model = statusRes.data.model || 'gpt-4.1-mini';
            const costo = estCosto(model, prompt_tokens, completion_tokens);
            await log(
              `📊 USO (parcial): input=${prompt_tokens}, output=${completion_tokens}, total=${total_tokens}, modelo=${model}, costo≈$${costo}`,
            );
          }

          const mensajes = messagesRes.data.data || [];
          respuestaSeparador =
            mensajes
              .reverse()
              .find((m) => m.role === 'assistant' && m.run_id === run_id)
              ?.content?.[0]?.text?.value || '';
        }
      } catch (err) {
        await log(
          `⚠️ Error al consultar el estado del assistant separador_productos: ${err.message}`,
        );
        break; // Romper el bucle en caso de error
      }
    }

    if (statusRun === 'failed') {
      await log(
        `⚠️ La ejecución del assistant separador_productos falló para id_thread: ${id_thread}`,
      );
      return {
        status: 400,
        error: 'Falló la ejecución del assistant separador_productos.',
      };
    }

    return {
      status: 200,
      respuesta: respuestaSeparador,
      total_tokens,
    };
  } catch (err) {
    await log(
      `⚠️ Error en la función separadorProductos. Error: ${err.message}`,
    );
    return {
      status: 500,
      error: 'Hubo un error interno en el servidor.',
    };
  }
}

module.exports = {
  procesarAsistenteMensajeVentas,
  procesarAsistenteMensajeEventos,
  procesarAsistenteMensajeImporfactory,
  separadorProductos,
};
