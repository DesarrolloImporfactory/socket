const axios = require('axios');

const GRAPH_URL = 'https://graph.facebook.com/v22.0';
const PAGE_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;

async function callSendAPI(body) {
  const { data } = await axios.post(`${GRAPH_URL}/me/messages`, body, {
    params: { access_token: PAGE_TOKEN },
  });
  return data;
}

exports.sendText = async (psid, text) => {
  const body = {
    recipient: { id: psid },
    message: { text },
  };
  return callSendAPI(body);
};

exports.sendSenderAction = async (psid, action) => {
  const body = {
    recipient: { id: psid },
    sender_action: action,
  };
  return callSendAPI(body);
};

// Puedes extender con quick_replies, templates, attachments, etc.
