/* Seguimiento a los clientes de Expertos que quedaron esperando
   (soporteExpertos/seguimiento.js decide; este script lee la base y, solo si
   todo está aprobado, escribe).

   Uso (en el servidor, desde /var/www/socket):
     node scripts/seguimiento_soporte_expertos.js --config 265            # en seco: solo cuenta
     node scripts/seguimiento_soporte_expertos.js --config 265 --lista    # además, ids de chat por persona
     node scripts/seguimiento_soporte_expertos.js --config 265 --enviar   # escribe al cliente

   --enviar solo escribe si se cumplen las TRES:
     1. ia_ajustes → soporte_expertos.seguimiento = 'real'
     2. textos.SEGUIMIENTO_APROBADO = true (Daniel aprobó el texto)
     3. el caso es «espera_asesor» con acción «texto» (dentro de la ventana de 24 h)
   Fuera de la ventana nunca escribe (la plantilla de Meta no existe todavía).
   Sin --enviar no toca nada. No deja notas internas: una nota (rol 3) pisa el
   último rol del chat y lo esconde de «cliente esperando» en el panel (ver
   liberar_sin_respuesta.service). */

'use strict';

require('dotenv').config();
const { db } = require('../src/database/config');
const { getAjustesIA } = require('../src/utils/ajustesIA');
const { decidirSeguimiento, RESPONSABLE } = require('../src/utils/soporteExpertos/seguimiento');
const T = require('../src/utils/soporteExpertos/textos');

const arg = (n) => process.argv.includes(n);
const valor = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

async function main() {
  const id_configuracion = Number(valor('--config'));
  if (!id_configuracion) throw new Error('falta --config <id>');
  const dias = Math.min(Math.max(Number(valor('--dias', 3)) || 3, 1), 7);
  const enviar = arg('--enviar');

  const ajustes = await getAjustesIA(id_configuracion);
  const modo = ajustes?.soporte_expertos?.seguimiento || false;
  const puedeEscribir = enviar && modo === 'real' && T.SEGUIMIENTO_APROBADO === true;
  if (enviar && !puedeEscribir)
    console.log(
      `⚠️ --enviar pedido pero no se escribe: seguimiento=${modo || 'apagado'}, texto aprobado=${T.SEGUIMIENTO_APROBADO}. Corre en seco.`,
    );

  const [{ ahora }] = await db.query('SELECT UNIX_TIMESTAMP() * 1000 AS ahora', { type: db.QueryTypes.SELECT });
  // Chats con algo del cliente en los últimos `dias` días, abiertos y con el bot sin apagar.
  const chats = await db.query(
    `SELECT c.id, c.celular_cliente, c.id_encargado, c.bot_openia
       FROM clientes_chat_center c
      WHERE c.id_configuracion = ? AND c.propietario <> 1 AND c.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM mensajes_clientes m
                     WHERE m.celular_recibe = CAST(c.id AS CHAR) AND m.id_configuracion = c.id_configuracion
                       AND m.rol_mensaje = 0 AND m.created_at >= NOW() - INTERVAL ? DAY)`,
    { replacements: [id_configuracion, dias], type: db.QueryTypes.SELECT },
  );

  const cuenta = {};
  const lista = {};
  let escritos = 0;
  for (const c of chats) {
    if (Number(c.bot_openia) === 0) {
      cuenta['bot apagado en el chat'] = (cuenta['bot apagado en el chat'] || 0) + 1;
      continue;
    }
    const filas = await db.query(
      `SELECT m.id, m.rol_mensaje AS rol, m.responsable AS resp, m.tipo_mensaje AS tm,
              m.texto_mensaje AS tx, UNIX_TIMESTAMP(m.created_at) * 1000 AS t
         FROM mensajes_clientes m
        WHERE m.celular_recibe = ? AND m.id_configuracion = ? AND m.deleted_at IS NULL
          AND m.created_at >= NOW() - INTERVAL 8 DAY
        ORDER BY m.id`,
      // celular_recibe es texto: con el id como texto la búsqueda usa el índice.
      { replacements: [String(c.id), id_configuracion], type: db.QueryTypes.SELECT },
    );
    const mensajes = filas.map((f) => ({ ...f, rol: Number(f.rol), t: Number(f.t) }));
    const d = decidirSeguimiento({
      mensajes,
      ahora: Number(ahora),
      horario: ajustes?.soporte_expertos?.horario_equipo,
      telefono: c.celular_cliente,
    });
    const clave = d.caso ? `${d.caso} · ${d.accion} · ${d.destino.nombre}` : `nada: ${d.razon.replace(/\d+/g, 'N')}`;
    cuenta[clave] = (cuenta[clave] || 0) + 1;
    if (d.caso) (lista[d.destino.nombre] = lista[d.destino.nombre] || []).push(`${c.id}(${Math.round(d.esperaMin / 60)}h)`);

    if (puedeEscribir && d.caso === 'espera_asesor' && d.accion === 'texto') {
      const [cfg] = await db.query('SELECT id_telefono, token FROM configuraciones WHERE id = ? LIMIT 1', {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      });
      if (!cfg?.id_telefono || !cfg?.token) {
        cuenta['no se escribió: la cuenta no tiene teléfono o token'] = (cuenta['no se escribió: la cuenta no tiene teléfono o token'] || 0) + 1;
        continue;
      }
      const { enviarMensajeWhatsapp } = require('../src/utils/webhook_whatsapp/enviarMensajes');
      await enviarMensajeWhatsapp({
        phone_whatsapp_to: c.celular_cliente,
        texto_mensaje: d.texto,
        business_phone_id: cfg.id_telefono,
        accessToken: cfg.token,
        id_configuracion,
        responsable: RESPONSABLE,
      });
      escritos++;
    }
  }

  console.log(`Config ${id_configuracion} · ${chats.length} chats con mensajes del cliente en ${dias} días · ${puedeEscribir ? 'ESCRIBE' : 'en seco'}`);
  for (const [k, n] of Object.entries(cuenta).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
  if (arg('--lista')) for (const [p, ids] of Object.entries(lista)) console.log(`\n${p} (${ids.length}): ${ids.join(', ')}`);
  if (puedeEscribir) console.log(`\nSeguimientos escritos: ${escritos}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('ERROR', e.message);
    process.exit(1);
  });
