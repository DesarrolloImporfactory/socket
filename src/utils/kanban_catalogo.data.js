/* FUENTE ÚNICA DE VERDAD del catálogo Kanban global.
 Estas constantes las consumen DOS controllers:
   - kanban_plantillas.controller.js  → al aplicar el global (crea todo)
   - kanban_plantillas_admin.controller.js → catalogoSetup (lista al editor)
 Si agregas/editas una plantilla Meta, respuesta rápida, secuencia de remarketing o estado Dropi, hazlo SOLO aquí. */

// ════════════════════════════════════════════════════════════════
// dedent(): quita la sangría común de un template literal en runtime.
// Sirve para escribir los prompt_ia indentados (código ordenado) sin que
// esos espacios viajen al front. Calcula la sangría mínima de las líneas
// con texto (ignorando la 1ª, que va pegada al backtick) y se la resta a
// todas, además de limpiar espacios al final de cada línea.
// ════════════════════════════════════════════════════════════════
function dedent(str) {
  if (typeof str !== 'string') return str;
  const lines = str.split('\n');
  const indents = lines
    .slice(1)
    .filter((l) => l.trim() !== '')
    .map((l) => l.match(/^[ \t]*/)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines
    .map((l, i) => (i === 0 ? l : l.slice(min)))
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

const KANBAN_TEMPLATES_META = [
  {
    name: 'remarketing_k1',
    language: 'es',
    category: 'MARKETING',
    components: [
      {
        type: 'HEADER',
        format: 'VIDEO',
        example: {
          header_handle: [
            'https://new.imporsuitpro.com/Videos/stream/3619a3291e1ccfe2388174618b50b550',
          ],
        },
      },
      {
        type: 'BODY',
        text: 'Tu pedido ya está listo para salir. Compárteme tu ubicación para coordinar el envío de inmediato.',
      },
    ],
  },
  {
    name: 'remarketing_k2',
    language: 'es',
    category: 'MARKETING',
    components: [
      {
        type: 'HEADER',
        format: 'VIDEO',
        example: {
          header_handle: [
            'https://new.imporsuitpro.com/Videos/stream/58b0a69a64359e85d12dd722f27f7afe',
          ],
        },
      },
      {
        type: 'BODY',
        text: 'Tu pedido está listo y tenemos cupos de envío GRATIS disponibles por poco tiempo.\nRecuerda, el pago lo realizas directamente al transportista al momento de la entrega.',
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Quiero envío hoy' },
          { type: 'QUICK_REPLY', text: 'Tengo una consulta' },
        ],
      },
    ],
  },
  {
    name: 'remarketing_k3',
    language: 'es',
    category: 'MARKETING',
    components: [
      {
        type: 'HEADER',
        format: 'IMAGE',
        example: {
          header_handle: [
            'https://imp-datas.s3.amazonaws.com/images/2026-04-07T21-27-32-154Z-534427295_813699714500800_6839605187360868450_n.png',
          ],
        },
      },
      {
        type: 'BODY',
        text: 'Se aplicó un ajuste especial del 10% a tu pedido. Envíame tu ubicación para coordinar el despacho.',
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Quiero mi descuento' },
          { type: 'QUICK_REPLY', text: 'Enviar ubicación' },
        ],
      },
    ],
  },
  {
    name: 'remarketing_despacho_listo',
    language: 'es',
    category: 'MARKETING',
    components: [
      {
        type: 'BODY',
        text: '🚛 Tu pedido ya está listo para salir\n\nBuenas noticias 👇\n\nTu paquete ya está empacado en bodega y solo espera tu ubicación exacta 📍 para entrar en la próxima ruta del día.\n\n⏰ Última salida hoy: 4:00 PM\n📦 Si confirmas ahora: lo recibes en 24 a 48 horas\n💵 Pago: contraentrega — pagas solo cuando te lo entreguen\n\nSolo necesito tu ubicación para enviarlo. ⬇',
      },
    ],
  },
  {
    name: 'remarketing_envio_gratis',
    language: 'es',
    category: 'MARKETING',
    components: [
      {
        type: 'BODY',
        text: '🎁 Envío GRATIS asignado a tu pedido\n\nTe ahorras el costo de envío ($8) — el beneficio *estará activo por hoy*\n\n📦 Tu paquete: ya empacado en bodega\n🚛 Envío: GRATIS por esta semana\n💵 Pago: contraentrega — pagas al recibir\n\n¿Realizo tu envío hoy?',
      },
    ],
  },
  {
    name: 'remarketing_descuento_aprobado',
    language: 'es',
    category: 'MARKETING',
    components: [
      {
        type: 'BODY',
        text: '🎁 Se aplicó un descuento del 10% a tu pedido\n\nEl código quedó cargado a tu contacto y se cae automático hoy a las 23:59.\n\n💸 Descuento: 10% OFF aplicado\n⏰ Vigencia: solo hoy\n\nSi el precio era lo que te frenaba → ahí está resuelto ✅\n\nSolo necesito tu ubicación para coordinar el despacho. 📍',
      },
    ],
  },
  {
    name: 'remarketing_stock_agotado',
    language: 'es',
    category: 'MARKETING',
    components: [
      {
        type: 'BODY',
        text: '⚠️ Stock casi agotado — quedan pocas unidades\n\nEn bodega quedan menos de 10 unidades y hoy se están yendo rápido.\n\nY algo más: el próximo lote llega en 3 a 4 semanas y entrará con precio más alto — subieron los costos de importación.\n\nSi lo aseguras hoy, te queda al precio actual 🔒\n\nMándame tu ubicación 📍 (sigues pagando contraentrega).',
      },
    ],
  },
  {
    name: 'remarketing_stock_apartado',
    language: 'es',
    category: 'MARKETING',
    components: [
      {
        type: 'BODY',
        text: '📦 Stock reservado a tu nombre — vence en 12 horas\n\nHoy ya despachamos 837 pedidos a nivel nacional. Tu unidad está apartada en bodega y lista para salir, pero la reserva vence hoy a medianoche ⏰\n\nDespués de hoy, la unidad regresa al stock general y se están agotando rápido.\n\n¿Realizo tu envío? 🙌 (envíame tu ubicación).',
      },
    ],
  },
  {
    name: 'antes_generar_guia_k1',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Perfecto, en este momento procedemos con su despacho, en un momento le comparto su guía de envío. 😊\nCualquier duda que tenga estoy para ayudarle 📦',
      },
    ],
  },
  {
    name: 'guia_generada_k1',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'La guía de envío de tu pedido ha sido generada. El tiempo estimado de entrega es de 2 a 3 días hábiles.',
      },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: 'Descargar Guía',
            url: 'https://d39ru7awumhhs2.cloudfront.net/{{1}}',
            example: [
              'https://d39ru7awumhhs2.cloudfront.net/guias/ejemplo.pdf',
            ],
          },
          {
            type: 'URL',
            text: 'Seguimiento del pedido',
            url: 'https://chat.imporfactory.app/api/v1/kanban_plantillas/t/{{1}}',
            example: [
              'https://chat.imporfactory.app/api/v1/kanban_plantillas/t/LC123456',
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'novedad_k1',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Te comento que se ha gestionado un nuevo intento de entrega con la transportadora. Por favor, estar atento para que puedas recibir tu pedido sin inconvenientes.',
      },
    ],
  },
  {
    name: 'novedadk2',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Estimado cliente, le recordamos que al seleccionar pago contraentrega, usted se comprometió a recibir y pagar el pedido, conforme a la ley 67 del 2022 de Comercio Electrónico.\n\nEl costo del envío ya fue asumido por nuestra empresa.\nNecesitamos programar un nuevo intento de entrega lo antes posible por favor.\n\nEs importante contar con su disponibilidad para evitar cancelación del pedido y posibles restricciones en futuras compras.',
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Confirmo recepción' },
          { type: 'QUICK_REPLY', text: 'Reprogramar entrega' },
        ],
      },
    ],
  },
  {
    name: 'retiro_agencia_k1',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'HEADER',
        format: 'TEXT',
        text: 'AVISO IMPORTANTE',
      },
      {
        type: 'BODY',
        text: 'Estimado Cliente:\nServientrega le notifica que su pedido esta listo para ser retirado en agencia: {{1}}\nPor favor acercarse lo más pronto posible.',
        example: { body_text: [['Agencia Norte Quito']] },
      },
    ],
  },
  {
    name: 'confirmacion_pedido_k1',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Hola {{1}}, Acabo de recibir tu pedido de compra por el valor de ${{2}}\nQuiero confirmar tus datos de envío:\n\n✅Producto: {{3}}\n👤Nombre: {{4}}\n📱Teléfono: {{5}}\n📍Dirección: {{6}}\n\nPor favor, selecciona *CONFIRMAR PEDIDO* si tus datos son correctos ✅, o *ACTUALIZAR INFORMACIÓN* para corregirlos antes de proceder con el envío de tu producto. 🚚',
        example: {
          body_text: [
            [
              'Daniel',
              '35.00',
              'Audífonos Bluetooth',
              'Daniel Bonilla',
              '0987654321',
              'Av. Simón Bolívar y Mariscal Sucre',
            ],
          ],
        },
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'CONFIRMAR PEDIDO' },
          { type: 'QUICK_REPLY', text: 'ACTUALIZAR INFORMACIÓN' },
        ],
      },
    ],
  },
  {
    name: 'zona_entrega_k1',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'HEADER',
        format: 'TEXT',
        text: 'Llego el día de entrega',
      },
      {
        type: 'BODY',
        text: 'Hoy tu pedido ha llegado 📦✅ a {{1}} y está próximo a ser entregado en {{2}}, en el horario de 9 am a 6 pm. ¡Te recordamos tener el valor total de {{3}} en efectivo! Agradecemos estar atento a las llamadas del courier 🚚 Revisa el estado de tu guía aquí {{4}} 😊.',
        example: {
          body_text: [
            [
              'Quito',
              'Av. Amazonas 123',
              '$20.00',
              'https://fenixoper.laarcourier.com/Tracking/Guiacompleta.aspx?guia=LC123',
            ],
          ],
        },
      },
    ],
  },
  {
    name: 'carritos_abandonados',
    language: 'es',
    category: 'MARKETING',
    components: [
      {
        type: 'BODY',
        text: '🛒 ¡Aún tienes tu pedido de {{1}} pendiente! No dejes que se agote. Completa tu compra ahora y recibe un descuento especial. 👇',
        example: {
          body_text: [['Contiene']],
        },
      },
      {
        type: 'BUTTONS',
        buttons: [{ type: 'QUICK_REPLY', text: 'Completar Compra' }],
      },
    ],
  },
];

const KANBAN_RESPUESTAS_RAPIDAS = [
  {
    atajo: 'orden_aprobada',
    mensaje:
      'Tu orden ya ha sido aprobada correctamente.\nEstamos a la espera de que la transportadora genere la guía de envío. 📦 Apenas esté disponible, te la compartiré de inmediato para que puedas hacer el seguimiento.',
  },
  {
    atajo: 'agradecimiento',
    mensaje:
      'Muchas gracias por confiar en nosotros y bienvenid@ a la familia 🙌🛍 espero disfrutes de nuestros productos.',
  },
  {
    atajo: 'pago_contraentrega',
    mensaje:
      'El pago es CONTRA-ENTREGA 💵, es decir, que vas a pagar tu pedido en efectivo cuando el transportista te lo entregue.',
  },
  {
    atajo: 'genera_preguntas',
    mensaje:
      '¿Tienes alguna pregunta específica sobre el producto? 🤔\nEstoy aquí para proporcionarte más información y aclarar cualquier duda que puedas tener. 😊',
  },
  {
    atajo: 'despedida',
    mensaje:
      'Agradezco tu tiempo y consideración. 🙌\nEspero con ansias tu respuesta y la oportunidad de brindarte una solución de calidad. ¡Que tengas un maravilloso día! ✨',
  },
  {
    atajo: 'ubicacion_incorrecta',
    mensaje:
      'Genial, en este momento procedo con el empaque de su pedido. 📦\nPor favor si me ayuda con la ubicación por Google Maps 📍 para que el transportista llegue con facilidad.',
  },
  {
    atajo: 'antes_generar_guia',
    mensaje:
      'Perfecto, en este momento procedemos con su despacho, en un momento le comparto su guía de envío. 😊\nCualquier duda que tenga estoy para ayudarle 📦',
  },

  // ── REMARKETING (priorizadas sobre plantillas Meta) ──────────
  {
    atajo: 'remarketing_1',
    tipo_mensaje: 'video',
    ruta_archivo:
      'https://new.imporsuitpro.com/Videos/stream/3619a3291e1ccfe2388174618b50b550',
    mime_type: 'video/mp4',
    file_name: 'remarketing_1_despacho_listo.mp4',
    mensaje:
      '🚛 Tu pedido ya está listo para salir\n\nBuenas noticias 👇\n\nTu paquete ya está empacado en bodega y solo espera tu ubicación exacta 📍 para entrar en la próxima ruta del día.\n\n⏰ Última salida hoy: 4:00 PM\n📦 Si confirmas ahora: lo recibes en 24 a 48 horas\n💵 Pago: contraentrega — pagas solo cuando te lo entreguen\n\nSolo necesito tu ubicación para enviarlo. ⬇',
  },
  {
    atajo: 'remarketing_2',
    tipo_mensaje: 'image',
    ruta_archivo:
      'https://imp-datas.s3.amazonaws.com/images/2026-05-18T19-15-27-523Z-ENVIO_GRATIS_.png',
    mime_type: 'image/png',
    file_name: 'remarketing_2_envio_gratis.png',
    mensaje:
      '🎁 Envío GRATIS asignado a tu pedido\n\nTe ahorras el costo de envío (≈$8) — el beneficio *estará activo por hoy*\n\n📦 Tu paquete: ya empacado en bodega\n🚛 Envío: GRATIS por esta semana\n💵 Pago: contraentrega — pagas al recibir\n\n¿Realizo tu envío hoy?',
  },
  {
    atajo: 'remarketing_3',
    tipo_mensaje: 'image',
    ruta_archivo:
      'https://imp-datas.s3.amazonaws.com/images/2026-04-07T21-27-32-154Z-534427295_813699714500800_6839605187360868450_n.png',
    mime_type: 'image/png',
    file_name: 'remarketing_3_descuento.png',
    mensaje:
      '🎁 Se aplicó un descuento del 10% a tu pedido\n\nEl código quedó cargado a tu contacto y se cae automático hoy a las 23:59.\n\n💸 Descuento: 10% OFF aplicado\n⏰ Vigencia: solo hoy\n\nSi el precio era lo que te frenaba → ahí está resuelto ✅\n\nSolo necesito tu ubicación para coordinar el despacho. 📍',
  },
  {
    atajo: 'remarketing_4',
    tipo_mensaje: 'video',
    ruta_archivo:
      'https://new.imporsuitpro.com/Videos/stream/58b0a69a64359e85d12dd722f27f7afe',
    mime_type: 'video/mp4',
    file_name: 'remarketing_4_stock_agotado.mp4',
    mensaje:
      '⚠️ Stock casi agotado — quedan pocas unidades\n\nEn bodega quedan menos de 10 unidades y hoy se están yendo rápido.\n\nY algo más: el próximo lote llega en 3 a 4 semanas y entrará con precio más alto — subieron los costos de importación.\n\nSi lo aseguras hoy, te queda al precio actual 🔒\n\nMándame tu ubicación 📍 (sigues pagando contraentrega).',
  },
  {
    atajo: 'remarketing_5',
    tipo_mensaje: 'video',
    ruta_archivo:
      'https://new.imporsuitpro.com/Videos/stream/e8505075909c2d0bf42dde1ffad6643e',
    mime_type: 'video/mp4',
    file_name: 'remarketing_5_entregas_exitosas.mp4',
    mensaje:
      '✅ Cientos de entregas exitosas esta semana\n\nTe muestro entregas reales 👆 — clientes que recibieron su pedido, lo revisaron y recién ahí pagaron al mensajero.\n\n📦 Cientos de pedidos despachados cada semana\n🛡 Garantía por producto\n💵 Pago contraentrega — cero riesgo para ti\n\nTu pedido entra al mismo flujo. Solo me falta tu ubicación 📍',
  },
  {
    atajo: 'remarketing_6',
    mensaje:
      '📦 Flujo diario y tu stock está reservado a tu nombre — vence en 12 horas\n\nHoy ya despachamos 837 pedidos a nivel nacional. Tu unidad está apartada en bodega y lista para salir, pero la reserva vence hoy a medianoche ⏰\n\nDespués de hoy, la unidad regresa al stock general y se están agotando rápido.\n\n¿Realizo tu envío? 🙌 (envíame tu ubicación).',
  },
];

const DROPI_CONFIG_POR_DEFECTO = [
  {
    estado_dropi: 'PENDIENTE CONFIRMACION',
    nombre_template: 'confirmacion_pedido_k1',
    columna_destino: null,
    activo: 1,
    usar_respuesta_rapida: 1,
    mensaje_rapido: null,
    parametros: {
      body: ['nombre', 'costo', 'contenido', 'nombre', 'telefono', 'direccion'],
      buttons: [],
    },
  },
  {
    estado_dropi: 'PENDIENTE',
    nombre_template: 'antes_generar_guia_k1',
    columna_destino: 'guia_creada',
    activo: 1,
    usar_respuesta_rapida: 1,
    mensaje_rapido:
      'Perfecto, en este momento procedemos con su despacho, en un momento le comparto su guía de envío. 😊\nCualquier duda que tenga estoy para ayudarle 📦',
    parametros: null,
  },
  {
    estado_dropi: 'GUIA GENERADA',
    nombre_template: 'guia_generada_k1',
    columna_destino: 'guia_generada',
    activo: 1,
    usar_respuesta_rapida: 0,
    mensaje_rapido: null,
    parametros: {
      body: [],
      buttons: [
        { index: 0, variable: 'guia_pdf' },
        { index: 1, variable: 'numero_guia' },
      ],
    },
  },
  {
    estado_dropi: 'EN TRANSITO',
    nombre_template: 'zona_entrega_k1',
    columna_destino: 'en_transito',
    activo: 1,
    usar_respuesta_rapida: 0,
    mensaje_rapido: null,
    parametros: {
      body: ['ciudad', 'direccion', 'costo', 'tracking'],
      buttons: [],
    },
  },
  {
    estado_dropi: 'RETIRO EN AGENCIA',
    nombre_template: 'retiro_agencia_k1',
    columna_destino: 'retiro_agencia',
    activo: 1,
    usar_respuesta_rapida: 0,
    mensaje_rapido: null,
    parametros: { body: ['direccion'], buttons: [] },
  },
  {
    estado_dropi: 'NOVEDAD',
    nombre_template: 'novedadk2',
    columna_destino: 'novedad',
    activo: 1,
    usar_respuesta_rapida: 0,
    mensaje_rapido: null,
    parametros: null,
  },
];

const REMARKETING_POR_DEFECTO = [
  {
    estado_contacto: 'contacto_inicial',
    secuencias: [
      {
        secuencia: 1,
        tiempo_espera_minutos: 60, // 1h
        nombre_template: '', // sin plantilla → dentro de 24h usa IA
        language_code: 'es',
        estado_destino: 'remarketing',
        header_format: null,
        metodo_dentro_24h: 'ia',
        prompt_ia:
          dedent(`Genera UN mensaje de remarketing para el cliente de esta conversación. PRIMER intento de reactivación.

        ÁNGULO
        "Tu problema sigue ahí". Recordar que el dolor/motivo que llevó al cliente a interesarse sigue sin resolverse, y que su solución ya está empacada esperándolo.

        CONFIGURACIÓN DE TU NEGOCIO (edita estos valores)
        - Tiempo de entrega: 48-72 horas
        - Forma de pago: contra entrega

        ESTRUCTURA DEL MENSAJE
        1. Emoji 🚛 + título corto: el pedido está empacado y listo para salir
        2. Un párrafo retomando el dolor/motivo específico que el cliente mencionó en la conversación
        3. Tres bullets cortos con emojis: estado del pedido, tiempo de entrega, forma de pago
        4. Cierre breve pidiendo la ubicación con emoji 📍

        REGLAS
        - Tuteo natural LATAM
        - En el párrafo del medio, RETOMA puntualmente lo que el cliente dijo (sin inventar)
        - USA los datos exactos de CONFIGURACIÓN
        - NO inventes precios, descuentos ni promociones
        - NO uses falsa urgencia
        - Largo total: 5-7 líneas

        Solo devuelve el texto del mensaje, sin comillas.`),
      },
      {
        secuencia: 2,
        tiempo_espera_minutos: 180, // 3h
        nombre_template: '',
        language_code: 'es',
        estado_destino: 'remarketing',
        header_format: null,
        metodo_dentro_24h: 'ia',
        prompt_ia:
          dedent(`Genera UN mensaje de remarketing para el cliente de esta conversación. SEGUNDO intento de reactivación.

        ÁNGULO
        "Estás perdiendo plata". Le asignaste envío gratis hoy, pero se cae al cerrar el día. Si compra mañana, paga el envío.

        CONFIGURACIÓN DE TU NEGOCIO (edita estos valores)
        - Costo normal del envío: $8
        - Validez de la promoción: solo hoy
        - Forma de pago: contra entrega

        ESTRUCTURA DEL MENSAJE
        1. Emoji 🎁 + título: envío GRATIS pero se cae hoy
        2. Un párrafo explicando cuánto cuesta normalmente y por qué pierde plata si no aprovecha hoy
        3. Tres bullets cortos con emojis: estado del paquete, beneficio (envío gratis hoy), forma de pago
        4. Cierre breve pidiendo la ubicación con emoji 📍

        REGLAS
        - Tuteo natural LATAM
        - USA los datos exactos de CONFIGURACIÓN (no inventes el costo)
        - NO ofrezcas descuento, eso es del tercer mensaje
        - NO uses urgencia falsa más allá de "solo hoy"
        - Largo total: 5-7 líneas

        Solo devuelve el texto del mensaje, sin comillas.`),
      },
      {
        secuencia: 3,
        tiempo_espera_minutos: 300, // 5h
        nombre_template: '',
        language_code: 'es',
        estado_destino: 'remarketing',
        header_format: null,
        metodo_dentro_24h: 'ia',
        prompt_ia:
          dedent(`Genera UN mensaje de remarketing para el cliente de esta conversación. TERCER y ÚLTIMO intento.

        ÁNGULO
        "Última oportunidad". Activaste un descuento directo sobre el pedido, ya aplicado, pero vence hoy a las 23:59. Es tu última escritura para no insistir más.

        CONFIGURACIÓN DE TU NEGOCIO (edita estos valores)
        - Porcentaje de descuento: 10%
        - Vencimiento: hoy a las 23:59
        - Forma de pago: contra entrega

        ESTRUCTURA DEL MENSAJE
        1. Emoji 💸 + título: descuento aplicado + aclaración de que es el último mensaje
        2. Un párrafo reconociendo que tal vez el precio fue lo que frenó al cliente, y por eso lo activas
        3. Tres bullets cortos con emojis: descuento aplicado, vencimiento, forma de pago
        4. Frase corta con ✅ tipo "si el precio era lo que te frenaba, ya no hay excusa"
        5. Cierre breve pidiendo la ubicación con emoji 📍

        REGLAS
        - Tuteo natural LATAM
        - USA los datos exactos de CONFIGURACIÓN (no inventes %)
        - NO supliques ni te victimices
        - NO ofrezcas más descuentos
        - Largo total: 6-8 líneas

        Solo devuelve el texto del mensaje, sin comillas.`),
      },
    ],
  },
];

module.exports = {
  KANBAN_TEMPLATES_META,
  KANBAN_RESPUESTAS_RAPIDAS,
  DROPI_CONFIG_POR_DEFECTO,
  REMARKETING_POR_DEFECTO,
};
