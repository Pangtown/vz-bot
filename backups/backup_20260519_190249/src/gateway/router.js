/**
 * Message router – receives from channels, dispatches to conversation, sends reply back
 */

import * as conversation from './conversation.js';

export function createRouter(sendReply) {
  return {
    async handleIncoming(conversationId, userMessage, options = {}) {
      const reply = await conversation.handleTurn(conversationId, userMessage, options);
      if (sendReply) await sendReply(conversationId, reply);
      return reply;
    },
  };
}
