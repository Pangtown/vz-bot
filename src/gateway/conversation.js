/**
 * Conversation manager – turn loop: message → LLM → tools → response; persists to memory
 */

import * as memory from './memory.js';
import * as llm from '../llm/provider.js';
import * as tools from '../tools/registry.js';

const MAX_TOOL_ROUNDS = 10;

export async function handleTurn(conversationId, userMessage, options = {}) {
  const turns = await memory.load(conversationId);
  let messages = turns.map(t => ({ role: t.role, content: t.content }));
  messages.push({ role: 'user', content: userMessage });

  const llmOptions = {
    provider: options.llmProvider || process.env.LLM_PROVIDER || 'anthropic',
    apiKey: options.apiKey,
  };
  let text = null;
  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    const res = await llm.chat(messages, llmOptions);
    if (res.text) {
      text = res.text;
      break;
    }
    if (!res.toolCalls || res.toolCalls.length === 0) {
      text = 'No response from assistant.';
      break;
    }

    // Append assistant message (with tool_use blocks)
    if (res.assistantContent) {
      messages.push({ role: 'assistant', content: res.assistantContent });
    }

    const toolResults = [];
    for (const call of res.toolCalls) {
      console.log(`[TOOL_LOOP] Evaluating tool call: ${call.name}`);
      const allowed = tools.isAllowed(call.name);
      console.log(`[TOOL_LOOP] Allowed? ${allowed}`);
      if (!allowed) {
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, name: call.name, content: 'Error: action not allowed by policy.' });
        continue;
      }
      try {
        console.log(`[TOOL_LOOP] Running tool: ${call.name} with args`, call.args);
        const result = await tools.run(call.name, call.args);
        const content = typeof result === 'string' ? result : JSON.stringify(result);
        console.log(`[TOOL_LOOP] Success result sent to LLM.`);
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, name: call.name, content });
      } catch (err) {
        console.error(`[TOOL_LOOP] Tool Error:`, err.message);
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, name: call.name, content: `Error: ${err.message}` });
      }
    }
    messages.push({ role: 'user', content: toolResults });
    rounds++;
  }

  if (!text) text = 'I hit the tool loop limit. Please try again.';

  await memory.append(conversationId, 'user', userMessage);
  await memory.append(conversationId, 'assistant', text);
  return text;
}
