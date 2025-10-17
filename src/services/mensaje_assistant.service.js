const axios = require('axios');
const { db } = require('../database/config');
const {
  obtenerDatosClienteParaAssistant,
  obtenerDatosCalendarioParaAssistant,
} = require('../utils/datosClienteAssistant'); // Ajustar según organización
const fs = require('fs').promises;
const path = require('path');
const FormData = require('form-data');
const fsSync = require('fs'); // Para `fs.createReadStream`

const logsDir = path.join(process.cwd(), './src/logs/logs_meta');

async function log(msg) {
  await fs.mkdir(logsDir, { recursive: true });
  await fs.appendFile(
    path.join(logsDir, 'debug_log.txt'),
    `[${new Date().toISOString()}] ${msg}\n`
  );
}

async function procesarAsistenteMensaje(body) {
  const {
    mensaje,
    id_thread,
    id_plataforma,
    id_configuracion,
    telefono,
    api_key_openai,
    business_phone_id,
    accessToken,
  } = body;

  try {
    /* buscar informacion del thread */
    const openai_threads = await db.query(
      `SELECT numero_factura, numero_guia, bloque_productos
     FROM openai_threads 
     WHERE thread_id = ?`,
      {
        replacements: [id_thread],
        type: db.QueryTypes.SELECT,
      }
    );
    const openai_thread = openai_threads[0];

    if (!openai_thread) {
      await log(
        `⚠️ No se encontró información del thread para id_thread: ${id_thread}`
      );
      return {
        status: 400,
        error: 'No se encontró información del thread.',
      };
    }

    // 1. Obtener assistants activos
    const assistants = await db.query(
      `SELECT assistant_id, tipo, productos, tiempo_remarketing, tomar_productos, bloque_productos, ofrecer 
     FROM openai_assistants 
     WHERE id_configuracion = ? AND activo = 1`,
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      }
    );

    if (!assistants || assistants.length === 0) {
      await log(
        `⚠️ No se encontró un assistant válido para id_configuracion: ${id_configuracion}`
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

    if (id_plataforma) {
      // Si tienes IA de ventas y 'ofrecer' es "servicios", omites la consulta de datos del cliente
      const sales = assistants.find((a) => a.tipo.toLowerCase() === 'ventas');

      if (sales && sales.ofrecer == 'productos') {
        const datosCliente = await obtenerDatosClienteParaAssistant(
          id_plataforma,
          telefono,
          id_thread
        );
        bloqueInfo = datosCliente.bloque || '';
        tipoInfo = datosCliente.tipo || null;
      } else if (sales && sales.ofrecer == 'servicios') {
        const datosCliente = await obtenerDatosCalendarioParaAssistant(
          id_configuracion
        );
        bloqueInfo = datosCliente.bloque || '';
        tipoInfo = datosCliente.tipo || null;
      }
    }

    if (tipoInfo === 'datos_guia') {
      const logistic = assistants.find(
        (a) => a.tipo.toLowerCase() === 'logistico'
      );
      assistant_id = logistic?.assistant_id;
      tipo_asistente = 'IA_logistica';
    } else if (tipoInfo === 'datos_pedido') {
      console.log('datos_pedido');
      await log(
        `⚠️ Intento de procesar un pedido para id_thread: ${id_thread}, pero el asistente no responde a pedidos.`
      );
      return {
        status: 400,
        error: 'El asistente no respnde a pedidos',
      };
    }
    {
      const sales = assistants.find((a) => a.tipo.toLowerCase() === 'ventas');
      assistant_id = sales?.assistant_id;
      tipo_asistente = 'IA_ventas';
      tiempo_remarketing = sales?.tiempo_remarketing;

      if (sales.bloque_productos) {
        if (openai_thread.bloque_productos != sales.bloque_productos) {
          if (sales.ofrecer == 'productos') {
            bloqueInfo +=
              '📦 Información de todos los productos que ofrecemos pero que no necesariamente estan en el pedido. Olvidearse de los productos o servicios anteriores a este mensaje:\n\n';
            bloqueInfo += sales.bloque_productos;
          } else if (sales.ofrecer == 'servicios') {
            bloqueInfo +=
              '📦 Información de todos los servicios que ofrecemos pero que no necesariamente estan en el pedido. Olvidearse de los servicios o productos anteriores a este mensaje:\n\n';
            bloqueInfo += sales.bloque_productos;
          }

          // Actualizar tabla openai_threads con numero_factura y numero_guia
          const updateSql = `
          UPDATE openai_threads
          SET bloque_productos = ?
          WHERE thread_id = ?
        `;
          /* console.log('thread_id: ' + id_thread); */
          await db.query(updateSql, {
            replacements: [sales.bloque_productos, id_thread],
            type: db.QueryTypes.UPDATE,
          });
        }
      }
    }

    if (!assistant_id) {
      await log(
        `⚠️ No se encontró un assistant válido para id_thread: ${id_thread}`
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
          { headers }
        )
        .catch(async (err) => {
          await log(
            `⚠️ Error al enviar mensaje del cliente a OpenAI para id_thread: ${id_thread}. Error: ${err.message}`
          );
        });
    }

    await axios
      .post(
        `https://api.openai.com/v1/threads/${id_thread}/messages`,
        { role: 'user', content: mensaje },
        { headers }
      )
      .catch(async (err) => {
        await log(
          `⚠️ Error al enviar mensaje de usuario a OpenAI para id_thread: ${id_thread}. Error: ${err.message}`
        );
      });

    // 3. Ejecutar assistant
    const runRes = await axios
      .post(
        `https://api.openai.com/v1/threads/${id_thread}/runs`,
        { assistant_id, max_completion_tokens: 200 },
        { headers }
      )
      .catch(async (err) => {
        await log(
          `⚠️ Error al ejecutar assistant para id_thread: ${id_thread}. Error: ${err.message}`
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

    await log('id_thread antes del bucle: ' + id_thread);
    let gargar = "";

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
      const statusRes = await axios
        .get(`https://api.openai.com/v1/threads/${id_thread}/runs/${run_id}`, {
          headers,
        })
        .catch(async (err) => {
          await log(
            `⚠️ Error al consultar estado de ejecución del assistant para id_thread: ${id_thread}. Error: ${
              err.message
            }`
          );
        });

        gargar = statusRes;
      statusRun = statusRes.data.status;
    }

    await log('statusRun: ' + statusRun);

    if (statusRun === 'failed') {
      await log(
        `⚠️ La ejecución del assistant falló para id_thread: ${id_thread}`
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
          `⚠️ Error al obtener mensajes de OpenAI para id_thread: ${id_thread}. Error: ${err.message}`
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
        }
      );

      if (existing.length === 0) {
        await db
          .query(
            `INSERT INTO remarketing_pendientes
         (telefono, id_configuracion, business_phone_id, access_token, openai_token, assistant_id, mensaje, tipo_asistente, tiempo_disparo, id_thread)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            {
              replacements: [
                telefono,
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
            }
          )
          .catch(async (err) => {
            await log(
              `⚠️ Error al insertar remarketing para telefono: ${telefono}, id_thread: ${id_thread}. Error: ${err.message}`
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
    };
  } catch (err) {
    await log(
      `⚠️ Error en la función procesarAsistenteMensaje. Error: ${err.message}`
    );
    return {
      status: 500,
      error: 'Hubo un error interno en el servidor.',
    };
  }
}

module.exports = {
  procesarAsistenteMensaje,
};
