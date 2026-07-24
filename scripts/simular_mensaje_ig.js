// scripts/simular_mensaje_ig.js
// -----------------------------------------------------------------------------
// Simula un mensaje ENTRANTE de Instagram llamando directo a
// InstagramService.routeEvent(event), SIN pasar por HTTP ni por la firma HMAC
// de Meta. Ideal para probar en local cómo reacciona la IA kanban.
//
// Uso:
//   node scripts/simular_mensaje_ig.js <ig_id> <sender_igsid> ["texto del mensaje"]
//
//   <ig_id>         = ig_id del negocio (instagram_pages.ig_id, status='active').
//                     Es el "recipient" del evento.
//   <sender_igsid>  = IGSID del cliente que "escribe".
//                       • Inventado (ej. 9999999999) → la IA se ejecuta y verás
//                         la respuesta en logs, pero el envío final a la Graph
//                         API fallará (IGSID inexistente) y NO se guardará.
//                       • Real (un external_id que te haya escrito en <24h) →
//                         round-trip completo: la respuesta se entrega y guarda.
//   [texto]         = opcional. Default: un saludo de prueba.
//
// Ejemplos:
//   node scripts/simular_mensaje_ig.js 17841400000000000 9999999999
//   node scripts/simular_mensaje_ig.js 17841400000000000 9999999999 "hola, precio?"
//
// Para descubrir un ig_id válido conectado a una config kanban:
//   SELECT ip.ig_id, c.id AS id_configuracion, c.tipo_configuracion
//   FROM instagram_pages ip
//   JOIN configuraciones c ON c.id = ip.id_configuracion
//   WHERE ip.status = 'active';
// -----------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { db } = require('../src/database/config');
const initModels = require('../src/models/initModels');
const InstagramService = require('../src/services/instagram.service');

(async () => {
  const igId = process.argv[2];
  const senderIgsid = process.argv[3];
  const texto =
    process.argv[4] || 'Hola, quiero información del producto 😊';

  if (!igId || !senderIgsid) {
    console.error(
      'Uso: node scripts/simular_mensaje_ig.js <ig_id> <sender_igsid> ["texto"]',
    );
    process.exit(1);
  }

  try {
    // Bootstrap mínimo: conexión + asociaciones (igual que el server).
    await db.authenticate();
    initModels();

    // Verificación rápida de que el destino es simulable.
    const [pageRow] = await db.query(
      `SELECT ip.ig_id, ip.page_id, ip.status,
              c.id AS id_configuracion, c.tipo_configuracion, c.openai_activo
         FROM instagram_pages ip
         JOIN configuraciones c ON c.id = ip.id_configuracion
        WHERE ip.ig_id = ? AND ip.status = 'active'
        LIMIT 1`,
      { replacements: [igId], type: db.QueryTypes.SELECT },
    );

    if (!pageRow) {
      console.error(
        `❌ No hay instagram_pages activa con ig_id=${igId}. Revisa el ig_id.`,
      );
      process.exit(1);
    }

    console.log('──────────────────────────────────────────────');
    console.log('🎯 Destino simulado:');
    console.log('   ig_id            :', pageRow.ig_id);
    console.log('   page_id          :', pageRow.page_id);
    console.log('   id_configuracion :', pageRow.id_configuracion);
    console.log('   tipo_configuracion:', pageRow.tipo_configuracion);
    console.log('   openai_activo    :', pageRow.openai_activo);
    console.log('   sender (cliente) :', senderIgsid);
    console.log('   texto            :', texto);
    if (pageRow.tipo_configuracion !== 'kanban') {
      console.log(
        '   ⚠️ tipo_configuracion != "kanban": el mensaje se guardará pero la IA NO disparará.',
      );
    }
    console.log('──────────────────────────────────────────────');

    // Evento a nivel "messaging" (lo mismo que el controller pasa a routeEvent).
    const event = {
      sender: { id: String(senderIgsid) },
      recipient: { id: String(igId) },
      timestamp: Date.now(),
      message: {
        mid: `sim_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, // único
        text: texto,
      },
    };

    console.log('🚀 Enviando evento a InstagramService.routeEvent()...\n');
    await InstagramService.routeEvent(event);

    console.log(
      '\n✅ Listo. Revisa la consola de arriba y src/logs/logs_meta/debug_log.txt',
    );
    console.log(
      '   (Si el sender es inventado, el envío a la Graph API habrá fallado; es normal.)',
    );
    process.exit(0);
  } catch (err) {
    console.error('❌ Error simulando mensaje IG:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
