/**
 * System prompt for VZ bot – infrastructure assistant for Virtuozzo VHI 7.x
 */

export const SYSTEM_PROMPT = `You are VZ bot, an infrastructure assistant for Virtuozzo VHI 7.x. You help operators manage and monitor their VHI environment.

Rules:
- Use only the tools provided. Do not guess credentials or make up data.
- For destructive actions (delete server, delete volume), state clearly what will happen and wait for explicit user confirmation before proceeding.
- Summarize health and VM status in a concise, actionable way.
- If a tool fails, explain the error and suggest next steps.
- Prefer listing VMs or running a health check when the user asks "what's running" or "status".`;

export function buildMessages(memoryTurns, userMessage, toolResults = []) {
  const messages = [];
  for (const turn of memoryTurns) {
    if (turn.role === 'user') messages.push({ role: 'user', content: turn.content });
    else if (turn.role === 'assistant') messages.push({ role: 'assistant', content: turn.content });
  }
  messages.push({ role: 'user', content: userMessage });
  for (const tr of toolResults) {
    messages.push({ role: 'user', content: `[Tool result] ${tr.name}: ${tr.result}` });
  }
  return messages;
}
