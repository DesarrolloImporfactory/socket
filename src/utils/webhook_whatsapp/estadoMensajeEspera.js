const fs = require('fs').promises;
const path = require('path');
const { db } = require('../../database/config');

const logsDir = path.join(process.cwd(), './src/logs/logs_meta');

async function estadoMensajeEspera(id_cliente) {
  await fs.mkdir(logsDir, { recursive: true });
  const logFile = path.join(logsDir, 'debug_log.txt');

  try {
    await logDebug(
      `Iniciando estadoMensajeEspera para cliente ID ${id_cliente}`,
      logFile
    );

    console.log(
      `Iniciando estadoMensajeEspera para cliente ID ${id_cliente}`,
      logFile
    );

    // Obtener ID del último mensaje recibido
    const mensajes = await db.query(
      `SELECT id FROM mensajes_clientes WHERE celular_recibe = ? ORDER BY id DESC LIMIT 1`,
      { replacements: [id_cliente] }
    );

    const idUltimoMensaje = mensajes?.id;
    console.log('idUltimoMensaje: ' + idUltimoMensaje);
    console.log('mensajes?.id: ' + mensajes?.id);
    if (!idUltimoMensaje) {
      await logDebug(
        `No se encontraron mensajes para el cliente ${id_cliente}`,
        logFile
      );
      console.log(
        `No se encontraron mensajes para el cliente ${id_cliente}`,
        logFile
      );
      return;
    }

    await logDebug(
      `Último mensaje del cliente: ID = ${idUltimoMensaje}`,
      logFile
    );
    console.log(`Último mensaje del cliente: ID = ${idUltimoMensaje}`, logFile);

    // Buscar mensaje en espera
    const espera = await db.query(
      `SELECT id, id_mensajes_clientes FROM mensajes_espera WHERE id_cliente_chat_center = ? LIMIT 1`,
      { replacements: [id_cliente] }
    );

    if (!espera) {
      await logDebug(
        ` No hay mensajes en espera para cliente ID ${id_cliente}`,
        logFile
      );
      console.log(
        ` No hay mensajes en espera para cliente ID ${id_cliente}`,
        logFile
      );
      return;
    }

    const { id: idWait, id_mensajes_clientes: idMensajeEspera } = espera;
    await logDebug(
      `Mensaje en espera: ID = ${idWait}, Último mensaje guardado = ${idMensajeEspera}`,
      logFile
    );
    console.log(
      `Mensaje en espera: ID = ${idWait}, Último mensaje guardado = ${idMensajeEspera}`,
      logFile
    );

    if (idUltimoMensaje !== idMensajeEspera) {
      // Actualizar estado
      await db.query(`UPDATE mensajes_espera SET estado = 1 WHERE id = ?`, {
        replacements: [idWait],
      });
      await logDebug(
        ` Estado actualizado a 1 para mensaje en espera ID = ${idWait}`,
        logFile
      );
      console.log(
        ` Estado actualizado a 1 para mensaje en espera ID = ${idWait}`,
        logFile
      );
    } else {
      await logDebug(` No se requiere actualización. IDs coinciden.`, logFile);
      console.log(` No se requiere actualización. IDs coinciden.`, logFile);
    }
  } catch (error) {
    await logDebug(
      `❌ Error en estadoMensajeEspera: ${error.message}`,
      logFile
    );
    console.log(`❌ Error en estadoMensajeEspera: ${error.message}`, logFile);
  }
}

async function logDebug(message, logFile) {
  const timestamp = new Date().toISOString();
  await fs.appendFile(logFile, `[${timestamp}] ${message}\n`);
}

module.exports = { estadoMensajeEspera };
