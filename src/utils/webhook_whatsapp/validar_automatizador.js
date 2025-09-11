const fs = require('fs').promises;
const path = require('path');
const { db } = require('../../database/config');

async function validarAutomatizador(payload, id_configuracion) {
  const logsDir = path.join(process.cwd(), './src/logs/logs_meta');
  await fs.mkdir(logsDir, { recursive: true });

  let jsonOutput, jsonBloques;

  try {
    const rows = await db.query(
      `
    SELECT automatizadores.json_output, automatizadores.json_bloques
       FROM automatizadores
       INNER JOIN condiciones ON automatizadores.id = condiciones.id_automatizador
       WHERE automatizadores.id_configuracion = ? AND condiciones.texto = ?
       LIMIT 1
    `,
      {
        replacements: [id_configuracion, payload],
        type: db.QueryTypes.SELECT,
      }
    );

    if (rows.length === 0) {
      await fs.appendFile(
        path.join(logsDir, 'debug_log.txt'),
        `[${new Date().toISOString()}] No se encontró automatizador con payload: ${payload}\n`
      );
      return { id_template: null, id_etiquetas: [] };
    }

    jsonOutput = JSON.parse(rows[0].json_output || '{}');
    jsonBloques = JSON.parse(rows[0].json_bloques || '[]');
  } catch (err) {
    await fs.appendFile(
      path.join(logsDir, 'debug_log.txt'),
      `[${new Date().toISOString()}] Error DB validarAutomatizador: ${
        err.message
      }\n`
    );
    return { id_template: null, id_etiquetas: [] };
  }

  let foundBlockId = null;

  for (const block of jsonOutput.blocks || []) {
    for (const dataItem of block.data || []) {
      if (dataItem.name === 'blockelemtype' && dataItem.value === '10') {
        const blockId = block.id;
        const bloqueInfo = jsonBloques.find(
          (b) => b.id_block === String(blockId)
        );
        if (bloqueInfo && bloqueInfo.texto_recibir === payload) {
          foundBlockId = blockId;
          break;
        }
      }
    }
    if (foundBlockId) break;
  }

  if (!foundBlockId) {
    await fs.appendFile(
      path.join(logsDir, 'debug_log.txt'),
      `[${new Date().toISOString()}] No se encontró coincidencia en validarAutomatizador\n`
    );
    return { id_template: null, id_etiquetas: [] };
  }

  let id_template = null,
    id_etiquetas = [];
  for (const block of jsonOutput.blocks || []) {
    if (String(block.parent) === String(foundBlockId)) {
      const bloqueInfo = jsonBloques.find(
        (b) => b.id_block === String(block.id)
      );
      if (bloqueInfo) {
        if (bloqueInfo['templates_a[]']) {
          id_template = bloqueInfo['templates_a[]'];
          break;
        }
        if (bloqueInfo['etiqueta_a[]']) {
          id_etiquetas = bloqueInfo['etiqueta_a[]'];
          break;
        }
      }
    }
  }

  return { id_template, id_etiquetas };
}

module.exports = {
  validarAutomatizador,
};
