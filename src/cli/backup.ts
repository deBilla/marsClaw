// `bun run backup` — manual run of the daily backup.
import { runBackup } from '../lib/backup.ts';

const r = runBackup();
console.log('db:           ', r.db ?? '(skipped)');
console.log('memory:       ', r.memory ?? '(skipped)');
console.log('whatsapp-auth:', r.whatsappAuth ?? '(skipped)');
