import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audit } from '../src/lib/audit-log.ts';

let SANDBOX: string;
let LOG_PATH: string;

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'marsclaw-audit-'));
  LOG_PATH = join(SANDBOX, 'audit.log');
  process.env.MARSCLAW_AUDIT_LOG = LOG_PATH;
});

afterEach(() => {
  delete process.env.MARSCLAW_AUDIT_LOG;
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true });
});

describe('audit log', () => {
  it('writes one JSON object per line, append-only, with timestamps', () => {
    audit({ tool: 'Bash', decision: 'deny', layer: 'shell-disabled', reason: 'allow_shell=false' });
    audit({ tool: 'WebFetch', decision: 'allow', layer: 'url-allowlist', subject: 'https://wikipedia.org/' });

    expect(existsSync(LOG_PATH)).toBe(true);
    const lines = readFileSync(LOG_PATH, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const ln of lines) {
      const rec = JSON.parse(ln);
      expect(rec.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(typeof rec.pid).toBe('number');
      expect(['allow', 'deny', 'blocked']).toContain(rec.decision);
    }
    const denied = JSON.parse(lines[0]!);
    expect(denied.tool).toBe('Bash');
    expect(denied.reason).toBe('allow_shell=false');
  });

  it('creates the log directory if missing', () => {
    const nested = join(SANDBOX, 'subdir', 'audit.log');
    process.env.MARSCLAW_AUDIT_LOG = nested;
    audit({ tool: 'Read', decision: 'allow' });
    expect(existsSync(nested)).toBe(true);
  });
});
