// Outbox table: messages the agent has produced but the channel hasn't
// confirmed delivered yet. Drained by the loop in src/index.ts.
//
// Delivery attempt model: each failed `send` increments `attempts` and
// records `last_error`. After MAX_ATTEMPTS the row is marked permanently
// failed and excluded from future polls — avoids hammering the channel
// on a row that's not going to work (auth expired, JID invalid, etc).

import type { Database } from 'bun:sqlite';

export const MAX_ATTEMPTS = 3;

export interface OutboxRow {
  id: number;
  thread_id: string;
  text: string;
  audio_path: string | null;
  file_path: string | null;
  file_name: string | null;
  attempts: number;
}

export function takePendingOutbox(db: Database, limit = 20): OutboxRow[] {
  return db
    .query(
      `SELECT id, thread_id, text, audio_path, file_path, file_name, attempts
       FROM outbox
       WHERE delivered_at IS NULL
         AND failed_at IS NULL
         AND attempts < ?
       ORDER BY id
       LIMIT ?`,
    )
    .all(MAX_ATTEMPTS, limit) as OutboxRow[];
}

export function markOutboxDelivered(db: Database, id: number): void {
  db.query('UPDATE outbox SET delivered_at = unixepoch() WHERE id = ?').run(id);
}

export function incrementOutboxAttempt(db: Database, id: number, error: string): void {
  db.query(
    'UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?',
  ).run(error.slice(0, 500), id);
}

export function markOutboxFailed(db: Database, id: number, error: string): void {
  db.query(
    'UPDATE outbox SET failed_at = unixepoch(), last_error = ? WHERE id = ?',
  ).run(error.slice(0, 500), id);
}
