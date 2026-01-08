const fs = require('fs').promises;
const path = require('path');

const ClientesChatCenter = require('../../models/clientes_chat_center.model');
const MensajeCliente = require('../../models/mensaje_cliente.model');

const logsDir = path.join(process.cwd(), './src/logs/logs_meta');

async function procesarMensajeTexto({
  id_configuracion,
  business_phone_id,
  nombre_cliente,
  apellido_cliente,
  telefono_configuracion,
  phone_whatsapp_to,
  tipo_mensaje,
  texto_mensaje,
  ruta_archivo = null,
  responsable = 'sistema',
  wamid,
  total_tokens = 0,
}) {
  try {
    await fs.mkdir(logsDir, { recursive: true });

    // Buscar o crear cliente emisor
    let cliente = await ClientesChatCenter.findOne({
      where: {
        celular_cliente: telefono_configuracion,
        id_configuracion,
      },
    });

    if (!cliente) {
      cliente = await ClientesChatCenter.create({
        id_configuracion,
        uid_cliente: business_phone_id,
        nombre_cliente,
        apellido_cliente,
        celular_cliente: telefono_configuracion,
        propietario: 1,
      });
    }

    const id_cliente = cliente.id;

    // Buscar cliente receptor
    const receptor = await ClientesChatCenter.findOne({
      where: {
        celular_cliente: phone_whatsapp_to,
        id_configuracion,
      },
    });

    const id_cliente_recibe = receptor ? receptor.id : 0;

    // Insertar mensaje
    await MensajeCliente.create({
      id_configuracion,
      id_cliente,
      mid_mensaje: business_phone_id,
      tipo_mensaje,
      responsable,
      texto_mensaje,
      ruta_archivo,
      rol_mensaje: 1,
      celular_recibe: id_cliente_recibe,
      uid_whatsapp: phone_whatsapp_to,
      id_wamid_mensaje: wamid,
      total_tokens_openai_mensaje: total_tokens,
    });

    await logInfo(
      `💬 Mensaje insertado correctamente para ${phone_whatsapp_to}`
    );
  } catch (err) {
    await logError(`❌ Error en procesarMensajeTexto: ${err.message}`);
  }
}

async function logInfo(msg) {
  await fs.appendFile(
    path.join(logsDir, 'debug_log.txt'),
    `[${new Date().toISOString()}] ${msg}\n`
  );
}

async function logError(msg) {
  await fs.appendFile(
    path.join(logsDir, 'debug_log.txt'),
    `[${new Date().toISOString()}] ${msg}\n`
  );
}

module.exports = { procesarMensajeTexto };
