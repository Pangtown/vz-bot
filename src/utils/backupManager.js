import { cp, rm, readdir, readFile, writeFile, mkdir, access } from 'fs/promises';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const BACKUPS_DIR = join(PROJECT_ROOT, 'backups');

/**
 * Clean path helper for consistent formatting
 */
function cleanPath(path) {
  return relative(PROJECT_ROOT, path) || '.';
}

/**
 * Format Date into YYYYMMDD_HHMMSS
 */
function getTimestampString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Recursively check if a path exists
 */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a codebase backup snapshot
 * @param {string} reason - Description/reason for the backup
 * @returns {Promise<Object>} - Metadata of the created backup
 */
export async function createBackup(reason = 'Manual codebase backup before updates') {
  const timestamp = getTimestampString();
  const backupFolderName = `backup_${timestamp}`;
  const targetBackupDir = join(BACKUPS_DIR, backupFolderName);

  // Ensure backups directory exists
  if (!(await exists(BACKUPS_DIR))) {
    await mkdir(BACKUPS_DIR, { recursive: true });
  }

  console.log(`[BACKUP] Starting codebase backup to: ${cleanPath(targetBackupDir)}`);

  // Define files/folders to copy
  const entriesToBackup = [
    'src',
    'public',
    'config',
    'package.json',
    'package-lock.json',
    'README.md',
    'IMPROVEMENTS.md',
    '.env.example',
    '.gitignore'
  ];

  const backedUpFiles = [];

  for (const entryName of entriesToBackup) {
    const sourcePath = join(PROJECT_ROOT, entryName);
    const destPath = join(targetBackupDir, entryName);

    if (await exists(sourcePath)) {
      console.log(`[BACKUP] Copying ${entryName}...`);
      await cp(sourcePath, destPath, { recursive: true });
      backedUpFiles.push(entryName);
    } else {
      console.log(`[BACKUP] Warning: ${entryName} not found, skipping.`);
    }
  }

  // Save metadata JSON
  const info = {
    name: backupFolderName,
    created: new Date().toISOString(),
    reason,
    files: backedUpFiles,
  };

  await writeFile(
    join(targetBackupDir, 'backup_info.json'),
    JSON.stringify(info, null, 2),
    'utf8'
  );

  console.log(`[BACKUP] Codebase backup ${backupFolderName} created successfully.`);
  return info;
}

/**
 * List all available backups
 * @returns {Promise<Array<Object>>} - List of backup metadata objects
 */
export async function listBackups() {
  if (!(await exists(BACKUPS_DIR))) {
    return [];
  }

  const entries = await readdir(BACKUPS_DIR, { withFileTypes: true });
  const backups = [];

  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('backup_')) {
      const backupPath = join(BACKUPS_DIR, entry.name);
      const infoPath = join(backupPath, 'backup_info.json');

      if (await exists(infoPath)) {
        try {
          const raw = await readFile(infoPath, 'utf8');
          const info = JSON.parse(raw);
          backups.push(info);
        } catch (e) {
          backups.push({
            name: entry.name,
            created: 'Unknown (Corrupted info file)',
            reason: `Error reading info: ${e.message}`,
            files: []
          });
        }
      } else {
        // Fallback for legacy manually-created folders
        backups.push({
          name: entry.name,
          created: 'Legacy / Manual',
          reason: 'Manual structural snapshot folder without metadata',
          files: ['package.json', 'src', 'README.md', 'IMPROVEMENTS.md']
        });
      }
    }
  }

  // Sort newest first
  return backups.sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * Restore codebase from a specific backup
 * @param {string} backupName - Name of the backup folder (e.g. backup_20260520_120000)
 * @returns {Promise<boolean>} - Success state
 */
export async function restoreBackup(backupName) {
  const targetBackupDir = join(BACKUPS_DIR, backupName);

  if (!(await exists(targetBackupDir))) {
    throw new Error(`Backup folder "${backupName}" does not exist in backups directory.`);
  }

  console.log(`[RESTORE] Initiating rollback using: ${backupName}`);

  // Items to delete before restoring (to prevent stale files remaining in directories)
  const pathsToClear = ['src', 'public', 'config'];
  for (const pathName of pathsToClear) {
    const fullPath = join(PROJECT_ROOT, pathName);
    if (await exists(fullPath)) {
      console.log(`[RESTORE] Clearing current ${pathName}/ folder...`);
      await rm(fullPath, { recursive: true, force: true });
    }
  }

  // Check what backed up files exist in the folder
  const filesToRestore = await readdir(targetBackupDir);

  for (const file of filesToRestore) {
    if (file === 'backup_info.json' || file === 'BACKUP_INFO.txt') {
      continue; // Skip metadata files
    }

    const sourcePath = join(targetBackupDir, file);
    const destPath = join(PROJECT_ROOT, file);

    console.log(`[RESTORE] Rolling back ${file}...`);
    await cp(sourcePath, destPath, { recursive: true });
  }

  console.log(`[RESTORE] Codebase rollback completed successfully. Reverted to: ${backupName}`);
  return true;
}
