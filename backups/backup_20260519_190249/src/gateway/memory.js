/**
 * File-based conversation memory – last N turns per conversation
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const MEMORY_DIR = process.env.MEMORY_PATH || 'memory';
const MAX_TURNS = Number(process.env.MEMORY_MAX_TURNS) || 20;

function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function pathFor(conversationId) {
  return join(MEMORY_DIR, `${safeId(conversationId)}.json`);
}

export async function load(conversationId) {
  try {
    const p = pathFor(conversationId);
    const raw = await readFile(p, 'utf8');
    const data = JSON.parse(raw);
    return data.turns || [];
  } catch (_) {
    return [];
  }
}

export async function save(conversationId, turns) {
  await mkdir(MEMORY_DIR, { recursive: true });
  const trimmed = turns.slice(-MAX_TURNS);
  const p = pathFor(conversationId);
  await writeFile(p, JSON.stringify({ turns: trimmed, updatedAt: new Date().toISOString() }, null, 2));
}

export async function append(conversationId, role, content) {
  const turns = await load(conversationId);
  turns.push({ role, content, at: new Date().toISOString() });
  await save(conversationId, turns);
  return turns;
}
