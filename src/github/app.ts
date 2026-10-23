// GitHub client for the report_issue MCP tool — a GitHub App installed on ONE repo.
//
// marsClaw authenticates as the app, never with a personal token: an RS256 JWT
// signed with the app's private key buys a 1-hour installation token, cached
// here. Install the app with "Only select repositories" and give it Issues:
// read & write only, and the token can't touch code, PRs or any other repo.
// The repo itself comes from config (github_issue_repo), never from the agent.
//
// Secrets stay in .env (the sensitive-path gate keeps the agent out of it):
//   MARSCLAW_GITHUB_APP_ID, MARSCLAW_GITHUB_APP_INSTALLATION_ID,
//   MARSCLAW_GITHUB_APP_PRIVATE_KEY (base64 of the .pem, or the PEM with \n escapes)
//
// See docs/github-issues.md.

import { createSign } from 'node:crypto';
import { loadConfig } from '../lib/config.ts';

const API = 'https://api.github.com';
const TIMEOUT_MS = 20_000;
const HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };

/** A GitHub 4xx/5xx carrying GitHub's own explanation (message + errors[].message). */
export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string = '',
  ) {
    super(detail ? `GitHub API ${status}: ${detail}` : `GitHub API ${status}`);
  }
}

interface AppCreds {
  appId: string;
  installationId: string;
  privateKey: string;
}

function creds(): AppCreds {
  return {
    appId: (process.env.MARSCLAW_GITHUB_APP_ID ?? '').trim(),
    installationId: (process.env.MARSCLAW_GITHUB_APP_INSTALLATION_ID ?? '').trim(),
    privateKey: (process.env.MARSCLAW_GITHUB_APP_PRIVATE_KEY ?? '').trim(),
  };
}

/** True only when the app credentials AND the target repo are all set. */
export function isEnabled(): boolean {
  const c = creds();
  return Boolean(c.appId && c.installationId && c.privateKey && loadConfig().github_issue_repo);
}

export function issueRepo(): string {
  return loadConfig().github_issue_repo;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

/** The app key as PEM text: .env holds it base64-encoded (one line) or as a PEM
 *  with literal \n escapes; both are accepted. */
export function privateKeyPem(raw: string = creds().privateKey): string {
  if (raw.includes('BEGIN')) return raw.replace(/\\n/g, '\n');
  return Buffer.from(raw, 'base64').toString('utf8');
}

/** RS256 JWT identifying the app. iat is back-dated 60 s for clock drift; GitHub
 *  caps exp at 10 minutes. */
export function appJwt(now: number = Date.now(), c: AppCreds = creds()): string {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: iat - 60, exp: iat + 540, iss: c.appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKeyPem(c.privateKey)).toString('base64url')}`;
}

/** GitHub's structured error fields only — never the raw body. */
export function errorDetail(data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
  const d = data as { message?: unknown; errors?: unknown };
  const parts = [String(d.message ?? '')];
  if (Array.isArray(d.errors)) {
    for (const e of d.errors) {
      if (e && typeof e === 'object') {
        const err = e as { message?: unknown; code?: unknown };
        parts.push(String(err.message ?? err.code ?? ''));
      }
    }
  }
  return parts.filter(Boolean).join('; ').slice(0, 500);
}

async function request(
  method: string,
  path: string,
  auth: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...HEADERS, Authorization: auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new GitHubApiError(res.status, errorDetail(data));
  return (data ?? {}) as Record<string, unknown>;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function installationToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 5 * 60_000) return cachedToken.token;
  const data = await request(
    'POST',
    `/app/installations/${creds().installationId}/access_tokens`,
    `Bearer ${appJwt()}`,
  );
  // The token lives an hour; refresh with five minutes to spare.
  cachedToken = { token: String(data.token), expiresAt: Date.now() + 55 * 60_000 };
  return cachedToken.token;
}

async function api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  return request(method, path, `Bearer ${await installationToken()}`, body);
}

export async function createIssue(
  title: string,
  body: string,
  labels: string[],
): Promise<{ number: number; url: string }> {
  const data = await api('POST', `/repos/${issueRepo()}/issues`, { title, body, labels });
  return { number: Number(data.number), url: String(data.html_url ?? '') };
}

const STOPWORDS = new Set(
  (
    'the and for with when that this from marsclaw mars you your can not but was are have has ' +
    'would could should into about after before then them they what which while'
  ).split(' '),
);

/** Plain words only — no quotes, colons or qualifiers can reach the search query. */
export function searchKeywords(text: string, limit = 6): string[] {
  const out: string[] = [];
  for (const word of text.match(/[A-Za-z0-9][A-Za-z0-9_-]{2,}/g) ?? []) {
    const w = word.toLowerCase();
    if (!STOPWORDS.has(w) && !out.includes(w)) out.push(w);
    if (out.length >= limit) break;
  }
  return out;
}

/** Up to `limit` open issues sharing words with `text`. OR across keywords:
 *  GitHub ANDs bare terms, and an exact six-word AND rarely matches an issue
 *  worded differently. */
export async function searchOpenIssues(text: string, limit = 3): Promise<{ number: number; url: string }[]> {
  const words = searchKeywords(text);
  if (words.length === 0) return [];
  const q = `repo:${issueRepo()} is:issue is:open ${words.join(' OR ')}`;
  const data = await api('GET', `/search/issues?q=${encodeURIComponent(q)}&per_page=${limit}`);
  const items = Array.isArray(data.items) ? (data.items as Record<string, unknown>[]) : [];
  return items.slice(0, limit).map((i) => ({ number: Number(i.number), url: String(i.html_url ?? '') }));
}
