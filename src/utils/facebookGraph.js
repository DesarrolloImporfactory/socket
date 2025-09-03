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
    // Suele traer { recipient_id, message_id }
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

exports.sendText = async (psid, text, pageAccessToken) => {
  const body = { recipient: { id: psid }, message: { text } };
  return callSendAPI(body, pageAccessToken);
};

exports.sendSenderAction = async (psid, action, pageAccessToken) => {
  const body = { recipient: { id: psid }, sender_action: action };
  return callSendAPI(body, pageAccessToken);
};
