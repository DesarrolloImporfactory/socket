const axios = require('axios');
const FB_VERSION = 'v22.0';

async function callSendAPI(body, pageAccessToken) {
  console.log('[SEND_API][REQUEST]', JSON.stringify(body));
  try {
    const { data } = await axios.post(
      `https://graph.facebook.com/${FB_VERSION}/me/messages`,
      body,
      { params: { access_token: pageAccessToken } }
    );
    console.log('[SEND_API][RESPONSE]', data);
    return data;
  } catch (e) {
    console.error('[SEND_API][ERROR]', {
      status: e.response?.status,
      data: e.response?.data || e.message,
    });
    throw e;
  }
}

function buildMessagingFields(opts = {}) {
  const out = {};
  // messaging_type:
  // - 'RESPONSE' si dentro de 24h
  // - 'MESSAGE_TAG' con 'tag' válido si fuera de 24h
  if (opts.messaging_type) {
    out.messaging_type = opts.messaging_type;
  } else if (opts.tag) {
    out.messaging_type = 'MESSAGE_TAG';
  } else {
    out.messaging_type = 'RESPONSE';
  }

  if (opts.tag) out.tag = opts.tag; // e.g. HUMAN_AGENT, ACCOUNT_UPDATE
  if (opts.metadata) {
    // Graph acepta metadata (string). Asegúrate de mandarla como string corta.
    out.metadata =
      typeof opts.metadata === 'string'
        ? opts.metadata
        : JSON.stringify(opts.metadata).slice(0, 900); // por si acaso
  }
  return out;
}

exports.sendText = async (psid, text, pageAccessToken, opts = {}) => {
  const body = {
    recipient: { id: psid },
    message: { text },
    ...buildMessagingFields(opts),
  };
  return callSendAPI(body, pageAccessToken);
};

exports.sendSenderAction = async (psid, action, pageAccessToken) => {
  const body = { recipient: { id: psid }, sender_action: action };
  return callSendAPI(body, pageAccessToken);
};
