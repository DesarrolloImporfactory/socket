const axios = require('axios');
const FB_VERSION = 'v22.0';

async function callSendAPI(body, pageAccessToken) {
  const { data } = await axios.post(
    `https://graph.facebook.com/${FB_VERSION}/me/messages`,
    body,
    { params: { access_token: pageAccessToken } }
  );
  return data;
}

exports.sendText = async (psid, text, pageAccessToken) => {
  const body = { recipient: { id: psid }, message: { text } };
  return callSendAPI(body, pageAccessToken);
};

exports.sendSenderAction = async (psid, action, pageAccessToken) => {
  const body = { recipient: { id: psid }, sender_action: action };
  return callSendAPI(body, pageAccessToken);
};
