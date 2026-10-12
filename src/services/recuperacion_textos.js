'use strict';

/**
 * Textos de las plantillas de las automatizaciones de recuperación.
 *
 * Son la fuente de verdad: al arrancar, el servicio los copia a
 * recuperacion_automatizacion_pasos.texto_sugerido (si cambiaron). Se
 * escriben tal como irán a Meta: {{1}}, {{2}}… en el orden de `parametros`
 * del paso, *negritas* con asteriscos y emojis (Meta los acepta). Ninguno
 * empieza ni termina con una variable: Meta rechaza esas plantillas.
 *
 * Tono acordado el 12-10-2026: cercano, directo, que se entienda que el bot
 * va a cerrar sus ventas y que el cliente diga "sí, quiero volver".
 */
module.exports = {
  pago_rebotado: {
    1: 'Hola {{1}} 👋 te escribe el equipo de ImporChat.\n\nIntentamos renovar tu plan *{{2}}* y tu banco no aprobó el cobro 💳❌ Tu cuenta quedó en pausa: el bot dejó de responder, los seguimientos automáticos están detenidos y tus clientes esperan.\n\n✅ Lo regularizas en un minuto aquí: {{3}}\n\nSi hubo un problema con la tarjeta, respóndeme y lo resolvemos juntos hoy 🙌',
    2: '⏸️ {{1}}, no quiero que tu negocio siga parado.\n\nMuchas veces el problema no es el pago, es el tiempo para dejar todo armado. Por eso te regalo una *sesión de implementación 1 a 1* 🎁 con nuestro equipo: dejamos tu bot, tus respuestas y tus seguimientos listos para vender solos 🤖💬\n\nSolo necesitamos tu cuenta activa 👉 {{2}}\n\n¿Agendamos? Respóndeme *sí* y te paso los horarios 📅',
    3: '🔥 {{1}}, última propuesta y es la mejor.\n\nYa dejamos activado un *10% de descuento* en tu plan {{2}} para tu próxima renovación 🎉 Paga hoy tu factura pendiente aquí 👉 {{3}} y tu bot vuelve a cerrar ventas en minutos.\n\nSi no es el momento, dímelo y dejo de escribirte. Pero si quieres volver, este es el día ✨',
  },
  cancelacion_programada: {
    1: 'Hola {{1}} 👋 vimos que programaste la cancelación de tu plan *{{2}}* (termina el {{3}}).\n\nAntes de que pase, quiero entender qué te frenó 🤔 ¿tiempo, resultados, precio, algo técnico?\n\nCuéntamelo en una línea. Si es algo que podemos resolver, lo hacemos esta misma semana 💪',
    2: '🛠️ {{1}}, si lo que faltó fue dejar todo implementado, lo hacemos nosotros.\n\nConfiguramos tu bot, tus plantillas y tus seguimientos automáticos *sin costo*, en una sesión 1 a 1. Es nuestra forma de que veas ImporChat trabajando de verdad antes de decidir 🚀\n\n¿Te agendo? Respóndeme *sí* 📅',
    3: '💙 {{1}}, queremos que te quedes.\n\nYa dejamos aplicado un *10% de descuento* en tu plan {{2}} para tu próxima renovación 🎉 Solo tienes que quitar la cancelación desde *Mi plan*, o responderme *me quedo* y lo hago por ti.\n\nSi decides irte, gracias por probarnos 🙏 la puerta queda abierta.',
  },
  nutricion: {
    1: 'Hola {{1}} 👋 ¿cómo va tu flujo de ventas en ImporChat?\n\n💡 *Tip de la semana:* activa las respuestas automáticas con tu catálogo y el bot cotiza solo 🤖 mientras tú atiendes lo importante.\n\nSi quieres, te muestro cómo en 10 minutos. Respóndeme *tip* ✨',
    2: '🔁 {{1}}, ¿ya probaste los *seguimientos automáticos*?\n\nA los clientes que no responden les llega un recordatorio solo y vuelven a la conversación. Es la función que más ventas recupera 💰\n\n¿Te ayudo a activarla? Respóndeme *seguimientos* 🙌',
    3: '💡 {{1}}, una idea rápida.\n\nConecta tus anuncios de Meta a ImporChat 📲 y cada lead entra con el producto que vio, sin copiar y pegar nada.\n\nDime *anuncios* y te lo configuramos 🚀',
    4: '💪 {{1}}, llevas un tiempo probando ImporChat y queremos que le saques todo.\n\nSi algo no te funcionó o te falta configurar, respóndeme y lo resolvemos juntos 🤝\n\nY si ya estás listo para activar tu plan completo, aquí está 👉 {{2}} 🎉',
  },
};
