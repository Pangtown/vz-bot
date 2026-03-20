/**
 * System prompt for VZ bot – infrastructure assistant for Virtuozzo VHI 7.x
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let vinfraCommands = '';
try {
  vinfraCommands = fs.readFileSync(path.join(__dirname, 'vinfra-commands.txt'), 'utf8');
} catch (e) {
  // ignore
}

export const SYSTEM_PROMPT = `You are VZ bot, an infrastructure assistant for Virtuozzo VHI 7.x. You help operators manage and monitor their VHI environment.

Rules:
- ALWAYS use the tools provided to answer user requests. Do not guess credentials or make up data. You have the ability to list VMs, check health, list block volumes, list networks, and list images. If the user asks you to do any of these, USE YOUR TOOLS!
- If the user asks you to perform an advanced virtualization task or view cluster/node information, USE the \`execute_vinfra_cli\` tool to run arbitrary vinfra commands over SSH. You have full infrastructure management capabilities.
- For destructive actions (delete server, delete volume), state clearly what will happen and wait for explicit user confirmation before proceeding.
- Summarize health and VM status in a concise, actionable way.
- If a tool fails, explain the error and suggest next steps.
- Prefer listing VMs or running a health check when the user asks "what's running" or "status".

Available vinfra commands (for use with execute_vinfra_cli):
${vinfraCommands}
`;

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
