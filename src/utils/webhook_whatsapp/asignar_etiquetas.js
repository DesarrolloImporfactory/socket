const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs').promises;
const path = require('path');

const logsDir = path.join(process.cwd(), './src/logs/logs_meta');

const {
  asignar_etiqueta_automatizador,
} = require('../../services/asignar_etiquetas.service');

async function asignarEtiquetas(
  id_etiquetas = [],
  id_configuracion,
  id_cliente
) {
  await fs.mkdir(logsDir, { recursive: true });

  for (const id_etiqueta of id_etiquetas) {
    try {
      // 👇 aquí en vez de axios llamamos directamente al service
      const response = await asignar_etiqueta_automatizador({
        id_cliente_chat_center: id_cliente,
        id_etiqueta,
        id_configuracion,
      });

      if (response.status === 200 && response.asignado) {
        await log(`[Etiqueta] ✅ Asignada ID: ${id_etiqueta}`);
      } else {
        await log(`[Etiqueta] ⚠️ ${response.message} | ID: ${id_etiqueta}`);
      }
    } catch (error) {
      await log(
        `[Etiqueta] ❌ Error al asignar ID ${id_etiqueta}: ${error.message}`
      );
    }
  }
}

async function log(msg) {
  await fs.appendFile(
    path.join(logsDir, 'debug_log.txt'),
    `[${new Date().toISOString()}] ${msg}\n`
  );
}

async function log(msg) {
  await fs.appendFile(
    path.join(logsDir, 'debug_log.txt'),
    `[${new Date().toISOString()}] ${msg}\n`
  );
}

module.exports = { asignarEtiquetas };
