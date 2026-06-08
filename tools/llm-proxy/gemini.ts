// Gemini Code Assist credential-isolation proxy — the Gemini counterpart to
// proxy.ts (Anthropic). Same role: keep the REAL Google credentials on the host,
// out of the sandboxed agent container.
//
//   ┌─────────────────────────┐  Authorization: Bearer <session-token>
//   │ agent (container)       │ ────────────────────────────────────────► 127.0.0.1:8765
//   │ CODE_ASSIST_ENDPOINT    │                                            │ swaps in a REAL
//   │  = http://host:8765     │                                            │ Google access token
//   │ placeholder oauth creds │                                            │ (minted/refreshed here
//   │  access_token=<session> │                                            ▼  from ~/.gemini creds)
//   └─────────────────────────┘                                cloudcode-pa.googleapis.com
//
// The box's gemini SDK is pointed at us via CODE_ASSIST_ENDPOINT and carries a
// PLACEHOLDER ~/.gemini/oauth_creds.json whose access_token IS the session
// token (see run.sh / Dockerfile). The SDK signs every Code Assist call with
// that bearer; we verify it, mint/refresh the real Google token host-side, swap
// it in, and forward. The refresh_token never leaves the host.
//
// Why a separate proxy from proxy.ts: Anthropic auth is a static key swap;
// Google Code Assist is OAuth — the token must be refreshed via google-auth-
// library using the host's refresh_token. Only one provider's proxy runs at a
// time (container-runtime picks per AGENT_PROVIDER), so both can share the port.

import { AuthType, Config, getOauthClient } from '@google/gemini-cli-core';
import type { OAuth2Client } from 'google-auth-library';
import { audit } from '../../src/lib/audit-log.ts';

const PORT = Number(process.env.LLM_PROXY_PORT ?? 8765);
const HOST = process.env.LLM_PROXY_HOST ?? '127.0.0.1';
const UPSTREAM = process.env.CODE_ASSIST_UPSTREAM ?? 'https://cloudcode-pa.googleapis.com';
const SESSION_TOKEN = process.env.LLM_PROXY_SESSION_TOKEN;

if (!SESSION_TOKEN) {
  console.error('gemini-proxy: LLM_PROXY_SESSION_TOKEN is required (presented by the box, swapped here)');
  process.exit(1);
}

// Get the real Google access token via @google/gemini-cli-core itself, which
// loads ~/.gemini/oauth_creds.json and refreshes using its OWN bundled OAuth
// client. We deliberately do NOT hold the gemini-cli client id/secret in this
// repo — delegating to gemini-cli-core keeps any credential out of our source
// (and works inside the compiled binary, where the package is bundled).
let clientPromise: Promise<OAuth2Client> | null = null;
function authedClient(): Promise<OAuth2Client> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const config = new Config({
      sessionId: 'gemini-proxy',
      targetDir: process.cwd(),
      cwd: process.cwd(),
      model: 'gemini-2.5-flash',
      debugMode: false,
    } as unknown as ConstructorParameters<typeof Config>[0]);
    await config.initialize();
    return (await getOauthClient(AuthType.LOGIN_WITH_GOOGLE, config)) as unknown as OAuth2Client;
  })().catch((err) => {
    clientPromise = null; // don't cache a failed init
    throw err;
  });
  return clientPromise;
}

async function realAccessToken(): Promise<string> {
  const client = await authedClient();
  // getAccessToken() returns the cached token, or transparently refreshes via
  // the refresh_token (gemini-cli-core persists refreshes to ~/.gemini).
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('could not obtain a Google access token (run a Gemini login on the host)');
  return token;
}

// Code Assist calls are POST {endpoint}/v1internal:<method> (and GET
// /v1internal/operations/… ). Forward only that surface.
function isAllowedPath(p: string): boolean {
  if (p.includes('..')) return false;
  return p === '/v1internal' || p.startsWith('/v1internal:') || p.startsWith('/v1internal/');
}

interface AuditLine {
  method: string;
  path: string;
  status: number;
  ms: number;
  bytesIn: number;
  bytesOut: number;
  reason?: string;
}
function record(line: AuditLine): void {
  const decision: 'allow' | 'deny' = line.status >= 400 && line.status < 500 ? 'deny' : 'allow';
  audit({
    tool: 'gemini-proxy',
    decision,
    layer: 'url-allowlist',
    subject: `${line.method} ${line.path} → ${line.status} (${line.ms}ms, ${line.bytesIn}B→${line.bytesOut}B)`,
    reason: line.reason,
  });
  console.log(JSON.stringify({ ts: new Date().toISOString(), proxy: 'gemini', ...line }));
}

Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0, // streamed turns can be long
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const startedAt = performance.now();
    const baseLog = { method: req.method, path: url.pathname };

    if (!isAllowedPath(url.pathname)) {
      record({ ...baseLog, status: 404, ms: 0, bytesIn: 0, bytesOut: 0, reason: 'path not allowed' });
      return new Response('not found', { status: 404 });
    }

    const presented = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (presented !== SESSION_TOKEN) {
      record({ ...baseLog, status: 401, ms: 0, bytesIn: 0, bytesOut: 0, reason: 'bad session token' });
      return new Response('unauthorized', { status: 401 });
    }

    let token: string;
    try {
      token = await realAccessToken();
    } catch (err) {
      record({ ...baseLog, status: 502, ms: 0, bytesIn: 0, bytesOut: 0, reason: 'token refresh failed' });
      return new Response(`upstream auth error: ${err instanceof Error ? err.message : err}`, { status: 502 });
    }

    const bodyText = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
    const upstreamHeaders = new Headers(req.headers);
    upstreamHeaders.delete('host');
    upstreamHeaders.delete('authorization');
    upstreamHeaders.set('authorization', `Bearer ${token}`);

    const resp = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
      method: req.method,
      headers: upstreamHeaders,
      body: bodyText.length > 0 ? bodyText : undefined,
    });

    // Bun's fetch auto-decompresses but leaves the now-wrong encoding/length
    // headers; strip them so the client reads the body as-is (SSE unaffected).
    const relayHeaders = new Headers(resp.headers);
    relayHeaders.delete('content-encoding');
    relayHeaders.delete('content-length');

    let bytesOut = 0;
    const teed = resp.body?.pipeThrough(
      new TransformStream({
        transform(chunk: Uint8Array, controller) {
          bytesOut += chunk.byteLength;
          controller.enqueue(chunk);
        },
        flush() {
          record({
            ...baseLog,
            status: resp.status,
            ms: Math.round(performance.now() - startedAt),
            bytesIn: bodyText.length,
            bytesOut,
          });
        },
      }),
    );
    if (!teed) {
      record({
        ...baseLog,
        status: resp.status,
        ms: Math.round(performance.now() - startedAt),
        bytesIn: bodyText.length,
        bytesOut: 0,
      });
      return new Response(null, { status: resp.status, headers: relayHeaders });
    }
    return new Response(teed, { status: resp.status, headers: relayHeaders });
  },
});

console.log(`gemini-proxy listening on http://${HOST}:${PORT} → ${UPSTREAM} (auth via gemini-cli-core)`);
