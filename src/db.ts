import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DB_PATH = process.env.NOTHINGCLAW_DB ?? 'data/nothingclaw.db';

export interface HistoryRow {
  role: 'user' | 'assistant';
  text: string;
}

export interface OutboxRow {
  id: number;
  thread_id: string;
  text: string;
}

export function initDb(): Database {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages(thread_id, id);

    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      text TEXT NOT NULL,
      delivered_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(delivered_at, id);
  `);
  return db;
}

export function loadHistory(db: Database, threadId: string, limit = 20): HistoryRow[] {
  const rows = db
    .query('SELECT role, text FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?')
    .all(threadId, limit) as HistoryRow[];
  return rows.reverse();
}

export function appendMessage(db: Database, threadId: string, role: 'user' | 'assistant', text: string): void {
  db.query('INSERT INTO messages (thread_id, role, text) VALUES (?, ?, ?)').run(threadId, role, text);
}

export function takePendingOutbox(db: Database, limit = 20): OutboxRow[] {
  return db
    .query('SELECT id, thread_id, text FROM outbox WHERE delivered_at IS NULL ORDER BY id LIMIT ?')
    .all(limit) as OutboxRow[];
}

export function markOutboxDelivered(db: Database, id: number): void {
  db.query('UPDATE outbox SET delivered_at = unixepoch() WHERE id = ?').run(id);
}
