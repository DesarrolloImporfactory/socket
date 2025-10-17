const axios = require('axios');

let datos = [
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
                { profile: { name: 'msxtattooing' }, wa_id: '593962803007' },
              ],
              messages: [
                {
                  from: '593962803007',
                  id: 'wamid.HBgMNTkzOTgxNzAyMDY2FQIAEhgUM0YyQ0U1NUE1NDMzMTQ0ODE0QTIA',
                  timestamp: '1760650886',
                  text: { body: 'Hola me gustas, te amo, quedate conmigo' },
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
                { profile: { name: 'pruebasdev' }, wa_id: '0962803007' },
              ],
              messages: [
                {
                  from: '0962803007',
                  id: 'wamid.HBgMNTkzOTgxNzAyMDY2FQIAEhgUM0YyQ0U1NUE1NDMzMTQ0ODE0QTIA',
                  timestamp: '1760650886',
                  text: {
                    body: 'Lorem ipsum dolor sit amet consectetur adipiscing elit congue habitasse odio vivamus gravida netus',
                  },
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
                { profile: { name: 'pruebasdev' }, wa_id: '59393213' },
              ],
              messages: [
                {
                  from: '59393213',
                  id: 'wamid.HBgMNTkzOTgxNzAyMDY2FQIAEhgUM0YyQ0U1NUE1NDMzMTQ0ODE0QTIA',
                  timestamp: '1760650886',
                  text: {
                    body: 'Lorem ipsum dolor sit amet consectetur adipiscing elit congue habitasse odio vivamus gravida netus',
                  },
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

exports.prueba_masiva = async (req, res) => {
  try {
    // Iniciamos variables para manejar las respuestas
    let successfulRequests = 0;
    let failedRequests = 0;
    let results = [];

    console.log(`🚀 Iniciando prueba masiva con ${datos.length} requests...`);

    // Usar la URL correcta del servidor
    const baseUrl =
      process.env.NODE_ENV === 'production'
        ? 'https://chat.imporfactory.app'
        : 'http://localhost:3000';

    const url = `${baseUrl}/api/v1/webhook_meta/webhook_whatsapp?webhook=ABCDEFG1234`;
    console.log(`📡 URL de destino: ${url}`);

    for (let index = 0; index < datos.length; index++) {
      const body = datos[index];
      const requestId = index + 1;

      console.log(`📤 Enviando request ${requestId}/${datos.length}...`);

      try {
        // Realizamos la solicitud POST a la API con timeout
        const response = await axios.post(url, body, {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Webhook-Test-Masivo/1.0',
          },
          timeout: 10000, // 10 segundos de timeout
          validateStatus: function (status) {
            // Considerar exitoso cualquier status 2xx y algunos 4xx esperados
            return status >= 200 && status < 500;
          },
        });

        // Analizar la respuesta
        const result = {
          request: requestId,
          status: response.status,
          success: response.status >= 200 && response.status < 300,
          data: response.data,
          from:
            body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from ||
            'unknown',
          message:
            body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body?.substring(
              0,
              50
            ) || 'unknown',
        };

        if (result.success) {
          successfulRequests++;
          console.log(`✅ Request ${requestId} exitoso (${response.status})`);
        } else {
          failedRequests++;
          console.log(
            `⚠️ Request ${requestId} con advertencia (${response.status}):`,
            response.data
          );
        }

        results.push(result);
      } catch (error) {
        // Error de red, timeout, etc.
        failedRequests++;
        const errorResult = {
          request: requestId,
          status: error.response?.status || 0,
          success: false,
          error: error.message,
          from:
            body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from ||
            'unknown',
          message:
            body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body?.substring(
              0,
              50
            ) || 'unknown',
        };

        results.push(errorResult);
        console.error(`❌ Error en request ${requestId}:`, error.message);

        // Si es error de conexión, esperar un poco antes del siguiente
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
          console.log(`⏳ Esperando 1 segundo antes del siguiente request...`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      // Pequeña pausa entre requests para no saturar
      if (index < datos.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    // Resumen detallado
    const summary = {
      total: datos.length,
      successful: successfulRequests,
      failed: failedRequests,
      successRate: ((successfulRequests / datos.length) * 100).toFixed(2) + '%',
      details: results,
    };

    console.log(`📊 Resumen final:`, {
      total: summary.total,
      successful: summary.successful,
      failed: summary.failed,
      successRate: summary.successRate,
    });

    // Respuesta detallada
    res.status(200).json({
      message: 'Proceso de prueba masiva completado',
      timestamp: new Date().toISOString(),
      url: url,
      summary: {
        total: summary.total,
        successful: summary.successful,
        failed: summary.failed,
        successRate: summary.successRate,
      },
      details: results,
    });
  } catch (error) {
    console.error('❌ Error general en prueba masiva:', error);
    res.status(500).json({
      message: 'Hubo un error general al realizar las pruebas masivas',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
};

// Nueva función para pruebas concurrentes (más agresiva)
exports.prueba_masiva_concurrente = async (req, res) => {
  try {
    const { concurrency = 3, delay = 500 } = req.query;

    console.log(
      `🚀 Iniciando prueba masiva CONCURRENTE con ${datos.length} requests (concurrencia: ${concurrency})...`
    );

    const baseUrl =
      process.env.NODE_ENV === 'production'
        ? 'https://chat.imporfactory.app'
        : 'http://localhost:3000';

    const url = `${baseUrl}/api/v1/webhook_meta/webhook_whatsapp?webhook=ABCDEFG1234`;

    // Función para hacer un request individual
    const makeRequest = async (data, index) => {
      try {
        const response = await axios.post(url, data, {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Webhook-Test-Concurrente/1.0',
          },
          timeout: 15000,
        });

        return {
          request: index + 1,
          status: response.status,
          success: true,
          data: response.data,
          from:
            data.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from ||
            'unknown',
        };
      } catch (error) {
        return {
          request: index + 1,
          status: error.response?.status || 0,
          success: false,
          error: error.message,
          from:
            data.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from ||
            'unknown',
        };
      }
    };

    // Dividir en lotes para concurrencia controlada
    const results = [];
    for (let i = 0; i < datos.length; i += parseInt(concurrency)) {
      const batch = datos.slice(i, i + parseInt(concurrency));
      console.log(
        `📦 Procesando lote ${Math.floor(i / concurrency) + 1} (${
          batch.length
        } requests)...`
      );

      // Ejecutar lote en paralelo
      const batchPromises = batch.map((data, batchIndex) =>
        makeRequest(data, i + batchIndex)
      );

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Pausa entre lotes
      if (i + parseInt(concurrency) < datos.length) {
        await new Promise((resolve) => setTimeout(resolve, parseInt(delay)));
      }
    }

    // Calcular estadísticas
    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    console.log(`📊 Prueba concurrente completada:`, {
      total: results.length,
      successful,
      failed,
      successRate: ((successful / results.length) * 100).toFixed(2) + '%',
    });

    res.status(200).json({
      message: 'Prueba masiva concurrente completada',
      timestamp: new Date().toISOString(),
      config: { concurrency: parseInt(concurrency), delay: parseInt(delay) },
      summary: {
        total: results.length,
        successful,
        failed,
        successRate: ((successful / results.length) * 100).toFixed(2) + '%',
      },
      details: results,
    });
  } catch (error) {
    console.error('❌ Error en prueba concurrente:', error);
    res.status(500).json({
      message: 'Error en prueba masiva concurrente',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
};

// Función para verificar el endpoint antes de las pruebas
exports.verificar_endpoint = async (req, res) => {
  try {
    const baseUrl =
      process.env.NODE_ENV === 'production'
        ? 'https://chat.imporfactory.app'
        : 'http://localhost:3000';

    const url = `${baseUrl}/api/v1/webhook_meta/webhook_whatsapp?webhook=ABCDEFG1234`;

    console.log(`🔍 Verificando endpoint: ${url}`);

    // Hacer un request de prueba simple
    const testData = datos[0]; // Usar el primer elemento

    const response = await axios.post(url, testData, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Webhook-Test-Verificacion/1.0',
      },
      timeout: 10000,
    });

    res.status(200).json({
      message: 'Endpoint verificado correctamente',
      url,
      status: response.status,
      responseData: response.data,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('❌ Error verificando endpoint:', error.message);
    res.status(500).json({
      message: 'Error al verificar endpoint',
      url: `${
        process.env.NODE_ENV === 'production'
          ? 'https://chat.imporfactory.app'
          : 'http://localhost:3000'
      }/api/v1/webhook_meta/webhook_whatsapp?webhook=ABCDEFG1234`,
      error: error.message,
      details: {
        code: error.code,
        status: error.response?.status,
        responseData: error.response?.data,
      },
      timestamp: new Date().toISOString(),
    });
  }
};
