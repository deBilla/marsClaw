// Quick status: provider, db location, message counts, recent threads.

import { existsSync, statSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { DB_PATH } from '../db.ts';
import { PROVIDERS } from '../providers/registry.ts';

const providerName = process.env.AGENT_PROVIDER ?? 'gemini';
const provider = PROVIDERS[providerName as keyof typeof PROVIDERS];

console.log(`provider:        ${providerName}${provider ? '' : ' (unknown!)'}`);
console.log(`provider bin:    ${provider?.bin ?? '-'}`);
console.log(`telegram token:  ${process.env.TELEGRAM_BOT_TOKEN ? 'set' : 'missing'}`);
console.log(`db path:         ${DB_PATH}`);

if (!existsSync(DB_PATH)) {
  console.log('db:              not initialized yet (start the bot once)');
  process.exit(0);
}

const sizeKb = (statSync(DB_PATH).size / 1024).toFixed(1);
console.log(`db size:         ${sizeKb} KB`);

const db = new Database(DB_PATH, { readonly: true });
const messages = (db.query('SELECT COUNT(*) as n FROM messages').get() as { n: number }).n;
const threads  = (db.query('SELECT COUNT(DISTINCT thread_id) as n FROM messages').get() as { n: number }).n;
const pendingOutbox = (db.query('SELECT COUNT(*) as n FROM outbox WHERE delivered_at IS NULL').get() as { n: number }).n;
console.log(`threads:         ${threads}`);
console.log(`messages:        ${messages}`);
console.log(`pending outbox:  ${pendingOutbox}`);

const recent = db
  .query(
    `SELECT thread_id, MAX(created_at) as last, COUNT(*) as n
     FROM messages GROUP BY thread_id ORDER BY last DESC LIMIT 5`,
  )
  .all() as { thread_id: string; last: number; n: number }[];

if (recent.length) {
  console.log('\nrecent threads:');
  for (const r of recent) {
    const when = new Date(r.last * 1000).toISOString().replace('T', ' ').slice(0, 19);
    console.log(`  ${when}  ${r.n.toString().padStart(4)} msgs  ${r.thread_id}`);
  }
}

db.close();
