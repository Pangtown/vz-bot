#!/usr/bin/env node

/**
 * vz-bot Codebase Backup & Rollback CLI Tool
 */

import { createBackup, listBackups, restoreBackup } from './utils/backupManager.js';

const args = process.argv.slice(2);
const command = args[0] ? args[0].toLowerCase() : 'help';

async function main() {
  switch (command) {
    case 'create':
    case 'backup': {
      const reason = args.slice(1).join(' ') || 'Manual codebase backup before updates';
      try {
        const metadata = await createBackup(reason);
        console.log('\n=========================================');
        console.log('SUCCESS: Codebase Snapshot Created');
        console.log(`Folder:  ${metadata.name}`);
        console.log(`Created: ${metadata.created}`);
        console.log(`Reason:  ${metadata.reason}`);
        console.log('=========================================');
      } catch (err) {
        console.error(`\nERROR creating backup: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case 'list': {
      try {
        const backups = await listBackups();
        console.log('\nAvailable Codebase Backups:');
        console.log('========================================================================');
        if (backups.length === 0) {
          console.log('No backups found.');
        } else {
          backups.forEach((b) => {
            console.log(`Folder:  ${b.name}`);
            console.log(`Created: ${b.created}`);
            console.log(`Reason:  ${b.reason}`);
            console.log(`Files:   [${b.files.join(', ')}]`);
            console.log('------------------------------------------------------------------------');
          });
        }
      } catch (err) {
        console.error(`\nERROR listing backups: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case 'restore':
    case 'rollback': {
      const targetBackup = args[1];
      if (!targetBackup) {
        console.error('\nERROR: You must specify a backup folder name to restore.');
        console.log('Usage: npm run codebase:restore <backup_folder_name>');
        process.exit(1);
      }
      try {
        await restoreBackup(targetBackup);
        console.log('\n=========================================');
        console.log('SUCCESS: Codebase Reverted');
        console.log(`Restored state: ${targetBackup}`);
        console.log('=========================================');
      } catch (err) {
        console.error(`\nERROR restoring backup: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.log('\nvz-bot Codebase Backup & Rollback Utility');
      console.log('=========================================');
      console.log('Usage:');
      console.log('  npm run codebase:backup [reason]   - Take a new snapshot of the source code');
      console.log('  npm run codebase:list              - List all available snapshot versions');
      console.log('  npm run codebase:restore <folder>  - Roll back codebase to the targeted snapshot');
      console.log('\nExample:');
      console.log('  npm run codebase:backup "Pre rate limit implementation"');
      console.log('  npm run codebase:restore backup_20260520_123456');
      console.log('=========================================');
      break;
  }
}

main();
