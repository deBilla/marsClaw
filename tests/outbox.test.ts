import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../src/db/migrations.ts';
import {
  MAX_ATTEMPTS,
  incrementOutboxAttempt,
  markOutboxDelivered,
  markOutboxFailed,
  takePendingOutbox,
} from '../src/db/outbox.ts';

function freshDb(): Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function seed(db: Database, text: string): number {
  const r = db
    .query('INSERT INTO outbox (thread_id, text) VALUES (?, ?) RETURNING id')
    .get('whatsapp:test', text) as { id: number };
  return r.id;
}

describe('outbox', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('takePendingOutbox returns un-delivered rows', () => {
    seed(db, 'a');
    seed(db, 'b');
    const pending = takePendingOutbox(db);
    expect(pending).toHaveLength(2);
    expect(pending.map((r) => r.text)).toEqual(['a', 'b']);
  });

  it('markOutboxDelivered excludes the row from future polls', () => {
    const id = seed(db, 'hello');
    markOutboxDelivered(db, id);
    expect(takePendingOutbox(db)).toHaveLength(0);
  });

  it('incrementOutboxAttempt bumps attempts and stores last_error', () => {
    const id = seed(db, 'fail');
    incrementOutboxAttempt(db, id, 'connect ECONNREFUSED');
    const row = db.query('SELECT attempts, last_error FROM outbox WHERE id = ?').get(id) as {
      attempts: number;
      last_error: string;
    };
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('ECONNREFUSED');
  });

  it('rows with attempts >= MAX_ATTEMPTS are excluded from polls', () => {
    const id = seed(db, 'too many');
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      incrementOutboxAttempt(db, id, `attempt ${i + 1}`);
    }
    expect(takePendingOutbox(db)).toHaveLength(0);
  });

  it('markOutboxFailed prevents future polling regardless of attempts', () => {
    const id = seed(db, 'permanent');
    markOutboxFailed(db, id, 'auth expired');
    expect(takePendingOutbox(db)).toHaveLength(0);
  });

  it('long error messages are truncated to fit', () => {
    const id = seed(db, 'long-err');
    const huge = 'x'.repeat(2000);
    incrementOutboxAttempt(db, id, huge);
    const row = db.query('SELECT last_error FROM outbox WHERE id = ?').get(id) as {
      last_error: string;
    };
    expect(row.last_error.length).toBeLessThanOrEqual(500);
  });
});
