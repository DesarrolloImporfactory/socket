const axios = require('axios');
const FB_VERSION = 'v22.0';

async function callSendApi(body, pageAccessToken) {
  console.log('[IG SEND_API][REQUEST]', JSON.stringify(body));
  try {
    const { data } = await axios.post(
      `https://graph.facebook.com/${FB_VERSION}/me/messages`,
      body,
      { params: { access_token: pageAccessToken } }
    );
    console.log('[IG  SEND_API][RESPONSE]', data);
    return data;
  } catch (e) {
    console.error('[IG SEND_API][ERROR]', {
      status: e.response?.status,
      data: e.response?.data || e.message,
    });
    throw e;
  }
}

function buildMessagingFields(opts = {}) {
  const out = {};
  // Dentro de 24h usa RESPONSE. Fuera de 24h, MESSAGE_TAG + tag válido.
  if (opts.messaging_type) {
    out.messaging_type = opts.messaging_type;
  } else if (opts.tag) {
    out.messaging_type = 'MESSAGE_TAG';
  } else {
    out.messaging_type = 'RESPONSE';
  }
  if (opts.tag) out.tag = opts.tag;
  if (opts.metadata) {
    out.metadata =
      typeof opts.metadata === 'string'
        ? opts.metadata
        : JSON.stringify(opts.metadata).slice(0, 900);
  }
  return out;
}

exports.sendText = async (igsid, text, pageAccessToken, opts = {}) => {
  const body = {
    recipient: { id: igsid },
    message: { text },
    ...buildMessagingFields(opts),
  };
  return callSendApi(body, pageAccessToken);
};

exports.sendAttachment = async (
  igsid,
  attachment,
  pageAccessToken,
  opts = {}
) => {
  const body = {
    recipient: { id: igsid },
    message: {
      attachment: {
        type: attachment.type,
        payload: { url: attachment.url, is_reusable: true },
      },
    },
    ...buildMessagingFields(opts),
  };
  return callSendApi(body, pageAccessToken);
};

exports.sendSenderAction = async (igsid, action, pageAccessToken) => {
  const body = { recipient: { id: igsid }, sender_action: action };
  return callSendApi(body, pageAccessToken);
};

exports.getUserProfile = async function (igsid, pageAccessToken) {
  // IG profile endpoint: https://graph.facebook.com/{version}/{IGSID}?fields=name,profile_pic&access_token=...
  const url = `https://graph.facebook.com/${FB_VERSION}/${igsid}`;
  const params = { fields: 'name,profile_pic', access_token: pageAccessToken };

  const { data } = await axios.get(url, { params });
  // data: { id: '...', name: '...', profile_pic: 'https://...' }
  return data;
};
