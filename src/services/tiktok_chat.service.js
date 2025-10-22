const { getModels } = require('../models/initModels');

exports.upsertTikTokConversations = async ({
  conversationId,
  senderId,
  metadata,
}) => {
  const { TikTokConversations } = getModels();
  const [conv, created] = await TikTokConversations.findOrCreate({
    where: { conversation_id: conversationId },
    defaults: {
      customer_external_id: senderId || null,
      metadata: metadata ? JSON.stringify(metadata) : null,
      last_message_at: new Date(),
    },
  });
  if (!created) {
    await conv.update({
      customer_external_id: senderId || conv.customer_external_id,
      last_message_at: new Date(),
    });
  }
  return conv;
};

exports.saveTikTokInbound = async ({
  conversationId,
  senderId,
  text,
  raw,
  timestamp,
}) => {
  const { TikTokMessages } = getModels();
  await TikTokMessages.create({
    conversation_id: conversationId,
    direction: 'in',
    sender_external_id: senderId || null,
    text: text || null,
    raw: raw ? JSON.stringify(raw) : null,
    created_at: timestamp ? new Date(timestamp) : new Date(),
  });
};
