import { appendFile, readFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const HISTORY_FILE = join(DATA_DIR, 'billing_history.jsonl');

/**
 * Save a billing snapshot to history.
 * @param {object} snapshot { vCpu, ramGb, storageGb, networkTraffic, timestamp }
 */
export async function saveSnapshot(snapshot) {
  try {
    console.log('Saving billing snapshot to history...', snapshot.timestamp);
    await mkdir(DATA_DIR, { recursive: true });
    const line = JSON.stringify(snapshot) + '\n';
    await appendFile(HISTORY_FILE, line, 'utf8');
    console.log('Snapshot saved successfully to', HISTORY_FILE);
  } catch (err) {
    console.error('Failed to save billing snapshot:', err.message);
  }
}

/**
 * Get snapshots within a date range.
 * @param {string} from ISO date string
 * @param {string} to ISO date string
 * @returns {Promise<Array>}
 */
export async function getHistory(from, to) {
  try {
    const content = await readFile(HISTORY_FILE, 'utf8').catch(() => '');
    if (!content) return [];
    
    const lines = content.trim().split('\n');
    const records = [];
    
    const fromTime = from ? new Date(from).getTime() : 0;
    const toTime = to ? new Date(to).getTime() : Infinity;

    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        const recordTime = new Date(record.timestamp).getTime();
        if (recordTime >= fromTime && recordTime <= toTime) {
          records.push(record);
        }
      } catch (e) {
        // Skip malformed lines
      }
    }
    return records;
  } catch (err) {
    console.error('Failed to read billing history:', err.message);
    return [];
  }
}
