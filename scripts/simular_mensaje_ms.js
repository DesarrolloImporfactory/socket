// scripts/simular_mensaje_ms.js
// -----------------------------------------------------------------------------
// Simula un mensaje ENTRANTE de Messenger llamando directo a
// MessengerService.routeEvent(event), SIN pasar por HTTP ni firma de Meta.
// Ideal para probar en local cómo reacciona la IA kanban + remarketing MS.
//
// Uso:
//   node scripts/simular_mensaje_ms.js <page_id> <sender_psid> ["texto"]
//
//   <page_id>      = page_id de la página de Facebook (messenger_pages.page_id,
//                    status='active'). Es el "recipient" del evento.
//   <sender_psid>  = PSID del cliente que "escribe".
//                      • Inventado → la IA se ejecuta y verás la respuesta en
//                        logs, pero el envío a la Graph API fallará (PSID inexistente).
//                      • Real (un external_id que te escribió en <24h) → round-trip.
//   [texto]        = opcional. Default: un saludo de prueba.
//
// Descubrir un page_id válido conectado a una config kanban:
//   SELECT mp.page_id, c.id AS id_configuracion, c.tipo_configuracion
//   FROM messenger_pages mp
//   JOIN configuraciones c ON c.id = mp.id_configuracion
//   WHERE mp.status = 'active';
// -----------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { db } = require('../src/database/config');
const initModels = require('../src/models/initModels');
const MessengerService = require('../src/services/messenger.service');

(async () => {
  const pageId = process.argv[2];
  const senderPsid = process.argv[3];
  const texto = process.argv[4] || 'Hola, quiero información del producto 😊';

  if (!pageId || !senderPsid) {
    console.error(
      'Uso: node scripts/simular_mensaje_ms.js <page_id> <sender_psid> ["texto"]',
    );
    process.exit(1);
  }

  try {
    await db.authenticate();
    initModels();

    const [pageRow] = await db.query(
      `SELECT mp.page_id, mp.status,
              c.id AS id_configuracion, c.tipo_configuracion, c.openai_activo
         FROM messenger_pages mp
         JOIN configuraciones c ON c.id = mp.id_configuracion
        WHERE mp.page_id = ? AND mp.status = 'active'
        LIMIT 1`,
      { replacements: [pageId], type: db.QueryTypes.SELECT },
    );

    if (!pageRow) {
      console.error(
        `❌ No hay messenger_pages activa con page_id=${pageId}. Revisa el page_id.`,
      );
      process.exit(1);
    }

    console.log('──────────────────────────────────────────────');
    console.log('🎯 Destino simulado (Messenger):');
    console.log('   page_id          :', pageRow.page_id);
    console.log('   id_configuracion :', pageRow.id_configuracion);
    console.log('   tipo_configuracion:', pageRow.tipo_configuracion);
    console.log('   openai_activo    :', pageRow.openai_activo);
    console.log('   sender (cliente) :', senderPsid);
    console.log('   texto            :', texto);
    if (pageRow.tipo_configuracion !== 'kanban') {
      console.log(
        '   ⚠️ tipo_configuracion != "kanban": el mensaje se guardará pero la IA NO disparará.',
      );
    }
    console.log('──────────────────────────────────────────────');

    // Evento a nivel "messaging" (lo mismo que el controller pasa a routeEvent).
    const event = {
      sender: { id: String(senderPsid) },
      recipient: { id: String(pageId) },
      timestamp: Date.now(),
      message: {
        mid: `sim_ms_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
        text: texto,
      },
    };

    console.log('🚀 Enviando evento a MessengerService.routeEvent()...\n');
    await MessengerService.routeEvent(event);

    console.log(
      '\n✅ Listo. Revisa la consola de arriba y src/logs/logs_meta/debug_log.txt',
    );
    console.log(
      '   (Si el sender es inventado, el envío a la Graph API habrá fallado; es normal.)',
    );
    process.exit(0);
  } catch (err) {
    console.error('❌ Error simulando mensaje MS:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
