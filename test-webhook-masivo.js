/**
 * Script de prueba local para webhook masivo
 * Ejecutar con: node test-webhook-masivo.js
 */

const axios = require('axios');

// Datos de prueba (mismos del controller)
const datos = [
  {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '109423835356604',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '593992717075',
                phone_number_id: '109565362009074',
              },
              contacts: [
                { profile: { name: 'Tony plaza' }, wa_id: '593981702066' },
              ],
              messages: [
                {
                  from: '593981702066',
                  id: 'wamid.HBgMNTkzOTgxNzAyMDY2FQIAEhgUM0YyQ0U1NUE1NDMzMTQ0ODE0QTIA',
                  timestamp: '1760650886',
                  text: { body: 'Hola' },
                  type: 'text',
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  },
  {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '109423835356604',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '593992717075',
                phone_number_id: '109565362009074',
              },
              contacts: [
                { profile: { name: 'Einzas' }, wa_id: '593980472544' },
              ],
              messages: [
                {
                  from: '593980472544',
                  id: 'wamid.HBgMNTkzOTgxNzAyMDY2FQIAEhgUM0YyQ0U1NUE1NDMzMTQ0ODE0QTIA',
                  timestamp: '1760650886',
                  text: { body: 'Hola, que productos ofreces?' },
                  type: 'text',
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  },
  {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '109423835356604',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '593992717075',
                phone_number_id: '109565362009074',
              },
              contacts: [{ profile: { name: 'Kevin' }, wa_id: '593983619835' }],
              messages: [
                {
                  from: '593983619835',
                  id: 'wamid.HBgMNTkzOTgxNzAyMDY2FQIAEhgUM0YyQ0U1NUE1NDMzMTQ0ODE0QTIA',
                  timestamp: '1760650886',
                  text: { body: 'Hola como estas?' },
                  type: 'text',
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  },
];

async function testWebhookMasivo() {
  console.log('🚀 Iniciando prueba masiva de webhook...');

  const url =
    'https://chat.imporfactory.app/api/v1/webhook_meta/webhook_whatsapp?webhook=ABCDEFG1234';

  let successful = 0;
  let failed = 0;
  let results = [];

  for (let i = 0; i < datos.length; i++) {
    const requestId = i + 1;
    console.log(`📤 Enviando request ${requestId}/${datos.length}...`);

    try {
      const response = await axios.post(url, datos[i], {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Test-Webhook-Masivo/1.0',
        },
        timeout: 10000,
        validateStatus: (status) => status >= 200 && status < 500,
      });

      const result = {
        request: requestId,
        status: response.status,
        success: response.status >= 200 && response.status < 300,
        data: response.data,
        from:
          datos[i].entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from ||
          'unknown',
        message:
          datos[i].entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body ||
          'unknown',
      };

      if (result.success) {
        successful++;
        console.log(`✅ Request ${requestId} exitoso (${response.status})`);
      } else {
        failed++;
        console.log(
          `⚠️ Request ${requestId} con advertencia (${response.status}):`,
          response.data
        );
      }

      results.push(result);
    } catch (error) {
      failed++;
      const errorResult = {
        request: requestId,
        status: error.response?.status || 0,
        success: false,
        error: error.message,
        from:
          datos[i].entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from ||
          'unknown',
      };

      results.push(errorResult);
      console.error(`❌ Error en request ${requestId}:`, error.message);
    }

    // Pausa entre requests
    if (i < datos.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  // Resumen
  console.log('\n📊 RESUMEN FINAL:');
  console.log(`Total: ${datos.length}`);
  console.log(`Exitosos: ${successful}`);
  console.log(`Fallidos: ${failed}`);
  console.log(
    `Tasa de éxito: ${((successful / datos.length) * 100).toFixed(2)}%`
  );

  console.log('\n📋 DETALLE POR REQUEST:');
  results.forEach((result) => {
    const status = result.success ? '✅' : '❌';
    console.log(
      `${status} Request ${result.request}: ${result.status} - ${
        result.from
      } - "${result.message?.substring(0, 30)}..."`
    );
  });

  return results;
}

// Ejecutar si es llamado directamente
if (require.main === module) {
  testWebhookMasivo()
    .then(() => {
      console.log('\n🎉 Prueba completada');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Error en la prueba:', error.message);
      process.exit(1);
    });
}

module.exports = { testWebhookMasivo };
