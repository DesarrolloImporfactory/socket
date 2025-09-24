const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const InstagramService = require('../services/instagram.service');

function safeParseJson(raw) {
  if (!raw) return null;
  if (Buffer.isBuffer(raw)) {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      return null;
    }
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') return raw;
  return null;
}

exports.verifyWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Forbidden');
};

exports.receiveWebhook = catchAsync(async (req, res, next) => {
  const body = safeParseJson(req.body);
  if (!body) {
    console.warn('[IG_WEBHOOK] body vacío o no JSON');
    return res.sendStatus(200);
  }

  console.log(
    '[IG_WEBHOOK][RAW] object=',
    body.object,
    'entries=',
    body.entry?.length || 0
  );

  // ────────────────────────────────────────────────────────────────
  // B: formato Instagram product (object = 'instagram', entry[].changes[])
  //   fields típicos: messages, message_reactions, message_edit, comments, mentions, ...
  //   Para "messages", el payload viene en changes[].value.{from, id, timestamp, text, attachments...}
  // ────────────────────────────────────────────────────────────────
  if (body.object === 'instagram') {
    for (const entry of body.entry || []) {
      const ig_id = entry.id; // este es el IG Business Account ID (el de tu tabla instagram_pages)
      const changes = entry.changes || [];
      console.log(
        '[IG_WEBHOOK][INSTAGRAM] entry.id (ig_id)=',
        ig_id,
        'changes=',
        changes.length
      );

      for (const ch of changes) {
        const field = ch.field; // 'messages', 'message_reactions', etc.
        const v = ch.value || {}; // payload de valor

        console.log(
          '[IG_WEBHOOK][INSTAGRAM][CHANGE]',
          field,
          JSON.stringify(v)
        );

        // Sólo procesamos messaging para tu chat (ignora comments/mentions si no te interesan)
        if (
          field === 'messages' ||
          field === 'message_reactions' ||
          field === 'message_edit'
        ) {
          // v.from  => IGSID del usuario
          // v.id    => mid del mensaje
          // v.text  => { body: '...' } o string (según variante); manejamos ambas
          // v.attachments => opcional
          // v.to    => puede venir el destinatario

          const from = v.from;
          const mid = v.id;
          const text =
            typeof v.text === 'string'
              ? v.text
              : typeof v.text?.body === 'string'
              ? v.text.body
              : null;

          // Busca page_id + token por ig_id
          const row = await InstagramService.getPageRowByIgId(ig_id);
          if (!row) {
            console.warn(
              '[IG_WEBHOOK] No se encontró instagram_pages por ig_id=',
              ig_id
            );
            continue;
          }
          const page_id = row.page_id;

          // Construimos un "evento estilo Messenger" para tu InstagramService.routeEvent
          const fakeEvent = {
            messaging_product: 'instagram',
            sender: { id: from }, // IGSID del usuario
            recipient: { id: page_id }, // Page ID (lo usas para buscar config/token)
            timestamp: Number(v.timestamp) || Date.now(),
          };

          // message / attachments / reactions / edits
          if (field === 'messages') {
            fakeEvent.message = {
              mid: mid || null,
              text: text || null,
              attachments: Array.isArray(v.attachments)
                ? v.attachments
                : undefined,
              // NOTA: IG puede no mandar is_echo aquí; tu service ya es tolerante
            };
          } else if (field === 'message_reactions') {
            fakeEvent.message = {
              mid: mid || null,
              text: null,
              attachments: undefined,
              reactions: v.reactions || v.reaction || null,
            };
          } else if (field === 'message_edit') {
            fakeEvent.message = {
              mid: mid || null,
              text: text || null,
              edited: true,
            };
          }

          try {
            await InstagramService.routeEvent(fakeEvent);
          } catch (e) {
            console.error(
              '[IG_WEBHOOK][routeEvent][ERROR]',
              e?.response?.data || e.stack || e.message
            );
          }
        } else {
          // Opcional: loguea y omite otros campos (comments, mentions, etc.)
          console.log('[IG_WEBHOOK] Campo IG no manejado:', field);
        }
      }
    }
    return res.sendStatus(200);
  }

  // ────────────────────────────────────────────────────────────────
  // A: formato Page (object = 'page', entry.messaging / entry.standby)
  // (tu rama original, por si suscribes la Page como Messenger-style)
  // ────────────────────────────────────────────────────────────────
  if (body.object === 'page') {
    for (const entry of body.entry || []) {
      const events = entry.messaging || entry.standby || [];
      console.log(
        '[IG_WEBHOOK][PAGE] entry.id=',
        entry.id,
        'events=',
        events.length
      );

      for (const event of events) {
        console.log('[IG_WEBHOOK][PAGE][EVENT]', {
          messaging_product: event.messaging_product,
          sender: event.sender?.id,
          recipient: event.recipient?.id,
          hasMessage: !!event.message,
          hasPostback: !!event.postback,
        });

        try {
          await InstagramService.routeEvent(event);
        } catch (e) {
          console.error(
            '[IG_WEBHOOK][routeEvent][ERROR]',
            e?.response?.data || e.stack || e.message
          );
        }
      }
    }
    return res.sendStatus(200);
  }

  // Otro object → ignorar sin romper
  console.info('[IG_WEBHOOK] object desconocido, se ignora:', body.object);
  return res.sendStatus(200);
});
