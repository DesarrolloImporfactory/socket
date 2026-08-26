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
  /* ── Seguimiento de retiro en agencia (3 pasos, 24h entre cada uno) ──
     Van SÍ o SÍ como plantilla aprobada: a las 24h la ventana de 24h de Meta
     está cerrada (un template que nosotros enviamos NO la abre; solo la abre
     una respuesta del cliente), así que sin plantilla el motor cancela el
     envío y no manda nada. Tres textos distintos y no uno repetido, porque
     mandar el mismo mensaje tres veces castiga la calidad del número. */
  {
    // Nombre distinto de "…_recordatorio_k1" a propósito: esa primera versión
    // salió rechazada por categoría, se eliminó, y Meta bloquea el nombre de
    // una plantilla eliminada. Un rechazo se corrige EDITANDO la plantilla,
    // no borrándola.
    name: 'retiro_agencia_disponible_k1',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Hola {{1}} 😊, tu pedido ya está disponible para retiro en {{2}}.\n\nGuía: {{3}}\nPlazo de retiro: {{4}} días\n\nPor favor acércate con tu cédula y el número de guía. Si ya lo retiraste, respóndenos este mensaje y actualizamos tu pedido.',
        example: {
          body_text: [
            ['Daniel', 'Servientrega Guayaquil Centro', 'V123456789', '7'],
          ],
        },
      },
    ],
  },
  {
    name: 'retiro_agencia_recordatorio_k2',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        // {{4}} = días de permanencia. Va como variable y NO quemado: la
        // agencia guarda 7 días, pero cada dropshipper decide qué plazo
        // comunica (varios dicen 3 para apurar el retiro). Sale de
        // configuraciones.dias_retiro_agencia, que por defecto trae el real.
        text: 'Hola {{1}} 📦, tu pedido sigue esperándote en {{2}} con la guía {{3}}.\n\nLa agencia guarda los envíos {{4}} días; cumplido ese plazo el paquete se devuelve al remitente.\n\n¿Podrás acercarte a retirarlo, por favor?',
        example: {
          body_text: [
            ['Daniel', 'Servientrega Guayaquil Centro', 'V123456789', '7'],
          ],
        },
      },
    ],
  },
  {
    name: 'retiro_agencia_recordatorio_k3',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Hola {{1}} 💙, te escribimos por última vez sobre tu pedido en {{2}} (guía {{3}}).\n\nEl plazo de {{4}} días está por cumplirse y después el envío regresa automáticamente al remitente.\n\nSi todavía puedes pasar por él, por favor acércate antes de que se cumpla el plazo.',
        example: {
          body_text: [
            ['Daniel', 'Servientrega Guayaquil Centro', 'V123456789', '7'],
          ],
        },
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
    /* Reemplazo de retiro_agencia_k1. Nombre nuevo y no una edición porque
       cambia la cantidad de variables del cuerpo (1 → 2) y suma un botón:
       editar la aprobada obligaría a re-aprobación en las 256 WABAs que ya la
       tienen. Se ofrece como "mejora disponible" y cada cuenta decide.

       Dos cambios sobre el texto viejo, los dos por el mismo incidente
       (orden 6315272): el cliente fue a la agencia y el paquete no estaba.

       1. El número de guía. Sin él, el cliente no puede verificar nada y el
          único que puede rastrear es el vendedor. Y es el momento correcto
          para darlo: cuando el pedido llega a la agencia la guía ya se asentó,
          aunque la de guia_generada_k1 haya salido con una que Dropi reemplazó.

       2. "reporta" en vez de afirmarlo. Servientrega marca "PARA RETIRO EN
          AGENCIA" antes de que el paquete esté físicamente en el mostrador, y
          nosotros no tenemos forma de saberlo: lo único honesto es atribuirle
          el dato a quien lo dio y dejar que el cliente confirme antes de
          moverse.

       "Tu transportadora" y no "Servientrega": el estado también lo disparan
       ENVÍO LISTO EN OFICINA de otras transportadoras. */
    name: 'retiro_agencia_guia_k1',
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
        text: 'Estimado cliente:\nTu transportadora reporta que tu pedido ya está disponible para retiro en: {{1}}\nGuía: {{2}}\n\nAntes de acercarte te recomendamos confirmar el estado con el botón de abajo.',
        example: { body_text: [['Agencia Norte Quito', 'V123456789']] },
      },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: 'Rastrear mi envío',
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
    name: 'confirmacion_pedido_k1',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Hola {{1}}, Acabo de recibir tu pedido de compra por el valor de ${{2}}\nQuiero confirmar tus datos de envío:\n\n✅Producto: {{3}}\n👤Nombre: {{4}}\n📱Teléfono: {{5}}\n📍Dirección: {{6}}\n🏙️Ciudad: {{7}}\n\nPor favor, selecciona *CONFIRMAR PEDIDO* si tus datos son correctos ✅, o *ACTUALIZAR INFORMACIÓN* para corregirlos antes de proceder con el envío de tu producto. 🚚',
        example: {
          body_text: [
            [
              'Daniel',
              '35.00',
              'Audífonos Bluetooth',
              'Daniel Bonilla',
              '0987654321',
              'Av. Simón Bolívar y Mariscal Sucre',
              'Quito',
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
    /* Versión con encabezado de IMAGEN: es la que instala por defecto el
       estado PENDIENTE CONFIRMACION (ver DROPI_CONFIG_POR_DEFECTO). La
       imagen de ejemplo es genérica; en cada envío el sistema la reemplaza
       por la FOTO DEL PRODUCTO del pedido (galería de la orden Dropi →
       catálogo por ID → nombre; ver utils/imagenProductoOrden). La k1 de
       texto se conserva para las cuentas que ya la tienen aprobada. */
    name: 'confirmacion_pedido_img_k1',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'HEADER',
        format: 'IMAGE',
        example: {
          header_handle: [
            'https://imp-datas.s3.amazonaws.com/images/2026-08-26T16-07-59-102Z-img_example.png',
          ],
        },
      },
      {
        type: 'BODY',
        text: 'Hola {{1}}, Acabo de recibir tu pedido de compra por el valor de ${{2}}\nQuiero confirmar tus datos de envío:\n\n✅Producto: {{3}}\n👤Nombre: {{4}}\n📱Teléfono: {{5}}\n📍Dirección: {{6}}\n🏙️Ciudad: {{7}}\n\nPor favor, selecciona *CONFIRMAR PEDIDO* si tus datos son correctos ✅, o *ACTUALIZAR INFORMACIÓN* para corregirlos antes de proceder con el envío de tu producto. 🚚',
        example: {
          body_text: [
            [
              'Daniel',
              '35.00',
              'Audífonos Bluetooth',
              'Daniel Bonilla',
              '0987654321',
              'Av. Simón Bolívar y Mariscal Sucre',
              'Quito',
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
    /* Respaldo del remarketing de pendiente_confirmacion (secuencia 1). La
       IA solo puede escribir si el cliente respondió hace <24h; el comprador
       de Shopify que nunca contesta —justo el del recordatorio— necesita
       plantilla o no le sale nada. Sin variables ni emojis en botones (Meta
       los rechaza en botones). Probada primero en la 889 y promovida aquí. */
    name: 'recordatorio_confirmacion_k1',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Hola 👋 Tenemos tu pedido listo para ser despachado, pero aún está pendiente de confirmación. ¿Nos confirmas que deseas recibirlo? Respóndenos por aquí y lo procesamos de inmediato.',
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Sí, confirmar' },
          { type: 'QUICK_REPLY', text: 'Cancelar pedido' },
        ],
      },
    ],
  },
  {
    // Respaldo del remarketing de pendiente_confirmacion (secuencia 2 y última).
    name: 'recordatorio_confirmacion_k2',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: '⏰ Tu pedido sigue reservado, pero está a punto de liberarse. Confírmalo hoy y lo despachamos de inmediato 🚚 Si ya no lo deseas, también puedes decírnoslo por aquí.',
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Confirmar ahora' },
          { type: 'QUICK_REPLY', text: 'Ya no lo quiero' },
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
    // v2: botón URL dinámico (la vieja 'carritos_abandonados' tenía botón
    // quemado). Nombre nuevo para no chocar con la ya aprobada en Meta.
    //
    // NO se instala con el tablero kanban: la crea el flujo de Shopify al
    // vincular la tienda (shopifyConfiguracionesController → _crearTemplatesMeta
    // con esta sola plantilla) y configurarRecuperacionShopifyV2 apunta
    // shopify_configuraciones.nombre_template_recuperacion aquí. Por eso en el
    // editor de la plantilla global aparece DESMARCADA y así debe quedarse: una
    // cuenta sin Shopify no la necesita y crearla le gasta cupo de la WABA.
    //
    // Pero tiene que seguir EN el catálogo: _crearTemplatesMeta resuelve la
    // definición por nombre desde aquí. Si se borra, vincular Shopify deja de
    // crear la plantilla y la recuperación de carritos se rompe sin avisar.
    name: 'carritos_abandonados_v2',
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
        // Botón URL DINÁMICO: {{1}} = checkout_token del carrito. Apunta a
        // /kanban_plantillas/carrito/:token, que redirige a la landing real
        // (abandoned_checkout_url) de ESE cliente. Ya no es un botón quemado.
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: 'Finalizar compra',
            url: 'https://chat.imporfactory.app/api/v1/kanban_plantillas/carrito/{{1}}',
            example: [
              'https://chat.imporfactory.app/api/v1/kanban_plantillas/carrito/abc123token',
            ],
          },
        ],
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
    /* La versión con imagen: el header lo llena el sistema con la foto del
       producto de cada pedido. Mismo body y mismos parámetros que la k1. */
    nombre_template: 'confirmacion_pedido_img_k1',
    columna_destino: null,
    activo: 1,
    usar_respuesta_rapida: 1,
    mensaje_rapido: null,
    parametros: {
      body: [
        'nombre',
        'costo',
        'contenido',
        'nombre',
        'telefono',
        'direccion',
        'ciudad',
      ],
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
    // El botón de rastreo recibe el número de guía, no una URL: el redirect
    // /kanban_plantillas/t/:guide arma el link de la transportadora que
    // corresponda (mismo patrón que guia_generada_k1).
    nombre_template: 'retiro_agencia_guia_k1',
    columna_destino: 'retiro_agencia',
    activo: 1,
    usar_respuesta_rapida: 0,
    mensaje_rapido: null,
    parametros: {
      body: ['direccion', 'numero_guia'],
      buttons: [{ index: 0, variable: 'numero_guia' }],
    },
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
  {
    // Devolución: sin plantilla → solo mueve al cliente a la columna
    // 'devolucion' (sin IA ni mensaje). Cubre las ~13 variantes de estado que
    // Dropi manda (todas mapean a 'DEVOLUCION' en mapDropiStatusToEstadoConfig).
    estado_dropi: 'DEVOLUCION',
    nombre_template: '',
    columna_destino: 'devolucion',
    activo: 1,
    usar_respuesta_rapida: 0,
    mensaje_rapido: null,
    parametros: null,
  },
  {
    // Entregada: igual que devolucion, sin plantilla → solo mueve al cliente a
    // 'entregada' (sin IA ni mensaje). Si el cliente elige mandar template o
    // mensaje rápido, lo configura y deja de ser solo-mover.
    estado_dropi: 'ENTREGADA',
    nombre_template: '',
    columna_destino: 'entregada',
    activo: 1,
    usar_respuesta_rapida: 0,
    mensaje_rapido: null,
    parametros: null,
  },
  {
    // A propósito sin plantilla: avisarle a alguien que su pedido se canceló
    estado_dropi: 'CANCELADO',
    nombre_template: '',
    columna_destino: 'cancelados',
    activo: 1,
    usar_respuesta_rapida: 0,
    mensaje_rapido: null,
    parametros: null,
  },
];

const REMARKETING_POR_DEFECTO = [
  {
    /* Retiro en agencia: 3 recordatorios, 24h entre cada uno.
       El tiempo se cuenta desde el envío ANTERIOR (así encadena el cron), por
       eso los tres van con 24h y no 24/48/72.
       Los tres llevan plantilla obligatoria: a las 24h la ventana de Meta ya
       está cerrada y sin plantilla el motor cancela sin enviar. `metodo_dentro_24h:'ia'`
       es el caso bueno — si el cliente respondió, contesta el bot con contexto;
       si no, sale la plantilla.
       estado_destino se deja en la misma columna: mientras el paquete siga en
       la agencia el contacto no debe moverse. */
    estado_contacto: 'retiro_agencia',
    secuencias: [
      {
        secuencia: 1,
        tiempo_espera_minutos: 1440, // 24h
        nombre_template: 'retiro_agencia_disponible_k1',
        language_code: 'es',
        estado_destino: 'retiro_agencia',
        header_format: null,
        metodo_dentro_24h: 'ia',
        prompt_ia:
          dedent(`El cliente tiene un pedido esperándolo en una agencia y ya respondió, así que estás DENTRO de la conversación.

        OBJETIVO
        Confirmar si ya retiró el pedido o ayudarlo a hacerlo.

        REGLAS
        - Tuteo natural LATAM, tono de servicio, NO de venta
        - Si dice que ya lo retiró: agradece y cierra, no insistas
        - Si dice que no ha podido: pregunta qué lo detiene y ofrece ayuda concreta
        - NO inventes plazos, direcciones ni números de guía: usa solo lo que aparezca en la conversación
        - Máximo 3 líneas

        Solo devuelve el texto del mensaje, sin comillas.`),
      },
      {
        secuencia: 2,
        tiempo_espera_minutos: 1440, // 24h
        nombre_template: 'retiro_agencia_recordatorio_k2',
        language_code: 'es',
        estado_destino: 'retiro_agencia',
        header_format: null,
        metodo_dentro_24h: 'ia',
        prompt_ia:
          dedent(`Segundo contacto sobre un pedido que sigue en la agencia sin retirar.

        OBJETIVO
        Explicar que la agencia guarda el paquete por tiempo limitado y que después se devuelve, sin sonar amenazante.

        REGLAS
        - Tuteo natural LATAM, tono de servicio
        - El plazo de retiro que comunicamos es: {{PLAZO_RETIRO}}. Usa ESE plazo y ningún otro — el cron lo reemplaza por el que configuró la tienda, que no siempre es el que da la transportadora
        - Pregunta si podrá acercarse a retirarlo
        - NO ofrezcas alternativas (reprogramar, cambiar de dirección, extender el plazo): no existen, el paquete se devuelve
        - Máximo 3 líneas

        Solo devuelve el texto del mensaje, sin comillas.`),
      },
      {
        secuencia: 3,
        tiempo_espera_minutos: 1440, // 24h
        nombre_template: 'retiro_agencia_recordatorio_k3',
        language_code: 'es',
        estado_destino: 'retiro_agencia',
        header_format: null,
        metodo_dentro_24h: 'ia',
        prompt_ia:
          dedent(`Último contacto sobre un pedido en agencia a punto de devolverse.

        OBJETIVO
        Avisarle que el plazo se cumple y que después el paquete se devuelve, para que alcance a retirarlo.

        REGLAS
        - Tuteo natural LATAM, cero presión agresiva
        - El plazo de retiro que comunicamos es: {{PLAZO_RETIRO}}. Usa ESE plazo y ningún otro
        - NO ofrezcas alternativas de ningún tipo (reprogramar el envío, mandarlo a otra dirección, extender el plazo, que lo retire otra persona): no existen. La agencia no espera más y el paquete regresa al remitente. Prometer una salida que no podemos cumplir es peor que no decir nada.
        - NO inventes políticas de la transportadora
        - Máximo 3 líneas

        Solo devuelve el texto del mensaje, sin comillas.`),
      },
    ],
  },
  {
    estado_contacto: 'contacto_inicial',
    secuencias: [
      {
        secuencia: 1,
        tiempo_espera_minutos: 60, // 1h
        nombre_template: '', // sin plantilla → dentro de 24h usa IA
        language_code: 'es',
        // Intermedio: no mueve de columna (solo el último va a remarketing).
        estado_destino: 'contacto_inicial',
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
        // Intermedio: no mueve de columna.
        estado_destino: 'contacto_inicial',
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
        // ÚLTIMO: este sí mueve al cliente a la columna remarketing.
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
  {
    // Remarketing de la columna principal Dropi (Shopify/landing). El cliente
    // YA tiene su pedido creado en Dropi (PENDIENTE CONFIRMACION) y no ha
    // confirmado. Los nudges lo DEJAN en pendiente_confirmacion: si responde,
    // lo atiende el bot de confirmación (no el de ventas) y no se duplica orden.
    //
    // Con PLANTILLA de respaldo obligatoria: el que entra por Shopify muchas
    // veces NUNCA ha escrito, la ventana de 24h está cerrada y la IA no puede
    // hablarle — sin plantilla el motor cancelaba sin enviar y el remarketing
    // no existía justo para quien más lo necesita (caso 889).
    estado_contacto: 'pendiente_confirmacion',
    secuencias: [
      {
        secuencia: 1,
        tiempo_espera_minutos: 120, // 2h
        nombre_template: 'recordatorio_confirmacion_k1',
        language_code: 'es',
        estado_destino: 'pendiente_confirmacion', // se queda
        header_format: null,
        metodo_dentro_24h: 'ia',
        prompt_ia:
          dedent(`Genera UN mensaje corto para un cliente que YA hizo un pedido y solo falta que lo CONFIRME por WhatsApp para despacharlo. PRIMER recordatorio.

        CONTEXTO
        - El cliente ya tiene su pedido registrado (llegó desde una tienda/landing).
        - Pago contra entrega. No estás vendiendo, solo confirmando.

        ESTRUCTURA DEL MENSAJE
        1. Emoji 📦 + recordatorio amable de que su pedido está reservado y listo
        2. Una línea pidiendo que confirme para despacharlo
        3. Cierre corto: puede responder "confirmo" o pedir corregir algún dato

        REGLAS
        - Tuteo natural LATAM, cálido y breve (3-4 líneas)
        - NO inventes precios, productos ni descuentos
        - NO pidas todos los datos de nuevo
        - Máximo 1 emoji

        Solo devuelve el texto del mensaje, sin comillas.`),
      },
      {
        secuencia: 2,
        tiempo_espera_minutos: 480, // 8h
        nombre_template: 'recordatorio_confirmacion_k2',
        language_code: 'es',
        estado_destino: 'pendiente_confirmacion', // se queda
        header_format: null,
        metodo_dentro_24h: 'ia',
        prompt_ia:
          dedent(`Genera UN mensaje corto para un cliente que hizo un pedido y aún no lo confirma. SEGUNDO y último recordatorio.

        CONTEXTO
        - El pedido sigue reservado, esperando su confirmación para salir a despacho.
        - Pago contra entrega. No estás vendiendo, solo confirmando.

        ÁNGULO
        "Tu pedido está por liberarse". Si no confirma, el cupo se libera; darle una razón amable para responder ya.

        ESTRUCTURA DEL MENSAJE
        1. Emoji ⏳ + aviso amable de que su pedido está por liberarse si no confirma
        2. Una línea pidiendo que confirme para asegurarlo
        3. Cierre corto: responde "confirmo" o dime si quieres corregir algo

        REGLAS
        - Tuteo natural LATAM, breve (3-4 líneas)
        - NO uses falsa urgencia agresiva ni supliques
        - NO inventes precios, productos ni descuentos
        - Máximo 1 emoji

        Solo devuelve el texto del mensaje, sin comillas.`),
      },
    ],
  },
];

/* ════════════════════════════════════════════════════════════════
   COLUMNA "RETIRO EN AGENCIA" — asistente de cierre

   Las columnas del tablero NO viven aquí: viven en el `data` JSON de
   `kanban_plantillas_globales`, que se edita desde el admin. Esta constante es
   la excepción: es la definición canónica de UNA columna que necesita un prompt
   revisable en código, y la instala en las plantillas globales el script
   `scripts/instalar_columna_retiro_agencia.js`. De ahí en adelante el flujo es
   el normal — cada cliente la recibe al pulsar "Actualizar tablero", que le
   crea el asistente con SU api_key y le inserta la acción.

   Por qué existe: la secuencia de recordatorios de agencia (ver
   REMARKETING_POR_DEFECTO más arriba) le escribe al cliente hasta 3 veces, pero
   sin asistente en la columna nadie lee la respuesta. El cliente contesta "ya lo
   retiré" y no solo se queda sin respuesta: como el webhook reprograma la
   secuencia con el estado en el que sigue estando, vuelve a recibir el mismo
   recordatorio al día siguiente.

   Alcance a propósito mínimo: este bot NO vende ni toma pedidos. Solo cierra el
   seguimiento — confirma el retiro (y con eso mueve al contacto a 'entregada',
   que no tiene secuencia, así que ahí se apaga todo) o averigua qué lo detiene.
   ════════════════════════════════════════════════════════════════ */
const COLUMNA_RETIRO_AGENCIA = {
  nombre: 'Retiro en agencia',
  estado_db: 'retiro_agencia',
  color_fondo: '#FEF3C7',
  color_texto: '#B45309',
  icono: 'bx bx-store',
  activo: 1,
  es_estado_final: 0,
  es_principal: 0,
  es_dropi_principal: 0,
  activa_ia: 1,
  max_tokens: 500,
  modelo: 'gpt-4o-mini',
  instrucciones:
    dedent(`Eres [NOMBRE_ASISTENTE], del equipo de [NOMBRE_TIENDA], y escribes por WhatsApp.

  CONTEXTO
  El cliente ya compró. Su pedido llegó a una agencia de la transportadora y lo
  espera ahí para que lo retire en persona. Le enviamos recordatorios y él
  respondió: por eso estás en esta conversación.

  TU ÚNICA MISIÓN
  Saber si ya retiró el pedido. Nada más: no vendes, no tomas pedidos nuevos y no
  resuelves dudas.

  LAS TRES SALIDAS — elige UNA en cada mensaje

  1) YA LO RETIRÓ
  Agradece en una línea y agrega al final, en línea aparte:
  [pedido_retirado]:true
  Solo cuando el pedido YA está en sus manos: "ya lo retiré", "ya lo tengo",
  "lo recogí ayer", "todo perfecto, ya me llegó".

  2) TODAVÍA NO LO RETIRÓ
  Responde amable, dile que ahí lo esperan, y NO pongas ningún tag.
  Aquí entra toda intención o promesa: "hoy paso", "mañana voy", "esta semana lo
  retiro", "estoy en camino", "va a ir mi hermano". Prometer NO es retirar. Si
  pones el tag de retiro aquí, el pedido queda como entregado sin estarlo y
  dejamos de recordárselo.

  3) PREGUNTA, DUDA O RECLAMO
  Responde UNA línea amable diciendo que un asesor lo ayuda enseguida y agrega al
  final, en línea aparte:
  [asesor]:true
  Aquí entra TODO lo que no sea "ya lo retiré" o "todavía no": si aceptan pago en
  efectivo, formas de pago, precios, dirección u horario de la agencia, cambiar la
  dirección, devolver, reclamar, comprar otra cosa, o cualquier pregunta que no
  puedas contestar con lo que ya está en esta conversación. No adivines ni
  improvises: pásalo a un asesor.

  NUNCA INVENTES
  No inventes dirección de agencia, horarios, número de guía, plazos, formas de
  pago ni políticas de la transportadora. Si el dato no está en la conversación,
  es caso de asesor (salida 3).

  Y NUNCA PROMETAS ALTERNATIVAS
  No ofrezcas reprogramar el envío, mandarlo a otra dirección, extender el plazo
  ni nada parecido: no existe ninguna de esas opciones. La agencia no espera más
  y, cumplido el plazo, el paquete regresa al remitente. Si el cliente dice que
  no puede acercarse, no le prometas una salida — es caso de asesor (salida 3).

  ESTILO
  - Tuteo natural LATAM, cálido y agradecido — nunca de venta ni de cobro.
  - Máximo 3 líneas y 1 emoji.
  - Una sola pregunta por mensaje.
  - Si el cliente ya se despidió, responde corto y no preguntes más.

  CUANDO TE PIDAN REDACTAR UN RECORDATORIO
  A veces se te pide escribir un recordatorio proactivo, sin que el cliente acabe
  de escribir. En ese caso NUNCA uses tags: son solo para responderle a él.

  [BLOQUE_TONO_PERSONALIZADO]
  [BLOQUE_INSTRUCCIONES_EXTRA]`),
  acciones: [
    {
      // El trigger es un `includes` sobre la respuesta del bot
      // (kanban_ia.service → acción cambiar_estado) y el tag se limpia del texto
      // antes de enviarlo, así que el cliente nunca lo ve. Sin espacio tras los
      // dos puntos, igual que [asesor]:true y el resto de los tags del sistema:
      // dos formatos distintos en un mismo prompt invitan al modelo a
      // normalizarlos y romper uno.
      //
      // Destino 'entregada' a propósito: no tiene secuencia de remarketing, así
      // que al mover ahí el seguimiento se apaga solo.
      tipo_accion: 'cambiar_estado',
      config: {
        trigger: '[pedido_retirado]:true',
        estado_destino: 'entregada',
      },
      activo: 1,
      orden: 1,
    },
    {
      // Mismo mecanismo que en contacto_inicial y pendiente_confirmacion: lo que
      // el bot no puede resolver se manda a la columna del asesor, que NO tiene
      // IA — el humano toma la conversación y el bot se calla.
      //
      // Aquí es más importante que en las columnas de venta: de un pedido que ya
      // está en la agencia no sabemos casi nada (formas de pago, horarios,
      // dirección exacta), así que cualquier pregunta es caso de asesor. Es
      // preferible eso a un bot que improvisa datos de la transportadora.
      tipo_accion: 'cambiar_estado',
      config: {
        trigger: '[asesor]:true',
        estado_destino: 'asesor',
      },
      activo: 1,
      orden: 2,
    },
  ],
};

module.exports = {
  KANBAN_TEMPLATES_META,
  KANBAN_RESPUESTAS_RAPIDAS,
  DROPI_CONFIG_POR_DEFECTO,
  REMARKETING_POR_DEFECTO,
  COLUMNA_RETIRO_AGENCIA,
};
