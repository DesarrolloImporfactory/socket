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
    // Iniciamos una variable para manejar las respuestas
    let successfulRequests = 0;
    let failedRequests = 0;

    for (let index = 0; index < datos.length; index++) {
      // Definimos la URL de la API de destino
      const url =
        'http://localhost:3000/api/v1/webhook_meta/webhook_whatsapp?webhook=ABCDEFG1234';

      // Cuerpo (body) de la solicitud que se enviará
      const body = datos[index];

      try {
        // Realizamos la solicitud POST a la API
        const response = await axios.post(url, body, {
          headers: {
            'Content-Type': 'application/json',
          },
        });

        // Si la respuesta es exitosa
        if (response.status === 200) {
          successfulRequests++;
          console.log(`Solicitud ${index + 1} exitosa.`);
        }
      } catch (error) {
        // Si ocurrió un error con la solicitud actual
        failedRequests++;
        console.error(`Error en la solicitud ${index + 1}:`, error.message);
      }
    }

    // Si la llamada fue exitosa, respondemos con los datos obtenidos
    res.status(200).json({
      message: 'Proceso completado',
      successfulRequests,
      failedRequests,
    });
  } catch (error) {
    // Si ocurrió un error general, lo manejamos aquí
    console.error('Error general:', error);
    res.status(500).json({
      message: 'Hubo un error al realizar las solicitudes',
      error: error.message,
    });
  }
};
