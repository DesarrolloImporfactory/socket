/* Pases del bot de Expertos con 2 h de oficina sin respuesta de una persona
   (soporteExpertos/avisoPases.js decide). SOLO LEE: imprime la lista; el
   WhatsApp interno lo encola Jeff desde el ERP (scripts/erp/aviso_pases_jeff.py),
   que guarda qué pases ya avisó. Nunca le escribe al cliente.

   Uso (en el servidor, desde /var/www/socket):
     node scripts/aviso_pases_sin_respuesta.js --config 265           # lista legible
     node scripts/aviso_pases_sin_respuesta.js --config 265 --json    # para Jeff

   Solo corre si la cuenta tiene soporte_expertos.proactivo (tramo 5). */

'use strict';

require('dotenv').config();
const { db } = require('../src/database/config');
const { getAjustesIA } = require('../src/utils/ajustesIA');
const { decidirAviso, textoAviso } = require('../src/utils/soporteExpertos/avisoPases');

const valor = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

async function main() {
  const id_configuracion = Number(valor('--config'));
  if (!id_configuracion) throw new Error('falta --config <id>');
  const json = process.argv.includes('--json');
  const ajustes = await getAjustesIA(id_configuracion);
  if (!ajustes?.soporte_expertos?.proactivo) {
    if (json) console.log('[]');
    else console.log(`Config ${id_configuracion}: soporte_expertos.proactivo apagado; no se avisa nada.`);
    return;
  }
  const horario = ajustes.soporte_expertos.horario_equipo || undefined;
  const [{ ahora }] = await db.query('SELECT UNIX_TIMESTAMP() * 1000 AS ahora', { type: db.QueryTypes.SELECT });
  // Chats con un mensaje de la IA en 3 días, con encargado.
  const chats = await db.query(
    `SELECT c.id, c.nombre_cliente, c.id_encargado, s.nombre_encargado
       FROM clientes_chat_center c
       LEFT JOIN sub_usuarios_chat_center s ON s.id_sub_usuario = c.id_encargado
      WHERE c.id_configuracion = ? AND c.propietario <> 1 AND c.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM mensajes_clientes m
                     WHERE m.celular_recibe = CAST(c.id AS CHAR) AND m.id_configuracion = c.id_configuracion
                       AND m.rol_mensaje = 1 AND m.responsable LIKE 'IA\\_%' AND m.created_at >= NOW() - INTERVAL 3 DAY)`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const avisos = [];
  for (const c of chats) {
    const filas = await db.query(
      `SELECT m.id, m.rol_mensaje AS rol, m.responsable AS resp, m.tipo_mensaje AS tm,
              m.texto_mensaje AS tx, UNIX_TIMESTAMP(m.created_at) * 1000 AS t
         FROM mensajes_clientes m
        WHERE m.celular_recibe = ? AND m.id_configuracion = ? AND m.deleted_at IS NULL
          AND m.created_at >= NOW() - INTERVAL 4 DAY
        ORDER BY m.id`,
      { replacements: [String(c.id), id_configuracion], type: db.QueryTypes.SELECT },
    );
    const mensajes = filas.map((f) => ({ ...f, rol: Number(f.rol), t: Number(f.t) }));
    const d = decidirAviso({ mensajes, ahora: Number(ahora), horario });
    if (!d.avisar) continue;
    const nombre = String(c.nombre_encargado || '').trim().split(/\s+/)[0] || null;
    const cliente = String(c.nombre_cliente || '').trim().split(/\s+/).slice(0, 2).join(' ') || null;
    avisos.push({
      config: id_configuracion,
      chat: Number(c.id),
      pase: d.paseId,
      encargado: c.id_encargado ? Number(c.id_encargado) : null,
      nombre,
      esperaMin: d.esperaMin,
      texto: textoAviso({ nombre, cliente, esperaMin: d.esperaMin, idChat: c.id, extracto: d.extracto }),
    });
  }
  if (json) {
    console.log(JSON.stringify(avisos));
    return;
  }
  console.log(`Config ${id_configuracion} · ${chats.length} chats con la IA en 3 días · ${avisos.length} pases con 2 h sin respuesta`);
  for (const a of avisos) console.log(`  → ${a.nombre || '(sin encargado)'} (${a.encargado}) · chat ${a.chat} · ${a.esperaMin} min\n    ${a.texto}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('ERROR', e.message);
    process.exit(1);
  });
