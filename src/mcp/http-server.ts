// HTTP MCP server — used by the container runtime. The agent container reaches
// it at http://host.docker.internal:<port>/mcp/<threadId>. Keeping this server
// on the HOST means the Google OAuth credentials and the SQLite outbox never
// enter the container; the agent can only act through these gated tools.
//
// Per-thread identity: one process serves ALL threads, so the thread id is
// taken from the URL path (/mcp/<threadId>) and bound via AsyncLocalStorage for
// the duration of each request (see thread-context.ts). The MCP tools read
// currentThreadId() instead of a process-global env var.
//
// Transport: WebStandardStreamableHTTPServerTransport in STATELESS mode — a
// fresh Server + transport per request (a Server assumes ownership of its
// transport, so reuse throws "Already connected"), with enableJsonResponse for
// plain request/response. This is the pattern validated in Phase 0.3.

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from './build-server.ts';
import { runWithThreadId } from './thread-context.ts';
import { log } from '../lib/log.ts';

const PORT = Number(process.env.MARSCLAW_MCP_HTTP_PORT ?? 8766);
// Bind to a container-reachable interface. The agent container reaches this via
// host.docker.internal, which does NOT resolve to host loopback — so default to
// 0.0.0.0. Auth/allowlist hardening is Phase 3; for now the host is trusted and
// the port is only meant for the local container bridge.
const HOST = process.env.MARSCLAW_MCP_HTTP_HOST ?? '0.0.0.0';
// Shared-secret auth. Because this server binds beyond loopback (so the
// container can reach it via host.docker.internal), require a bearer token when
// MARSCLAW_MCP_TOKEN is set. The agent-service sends it as an Authorization
// header on every MCP call (see container/agent-service mcpServers()). When
// unset, auth is disabled (back-compat / stdio mode never reaches here).
const AUTH_TOKEN = process.env.MARSCLAW_MCP_TOKEN ?? '';

function authorized(req: Request): boolean {
  if (!AUTH_TOKEN) return true; // auth disabled
  const presented = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? req.headers.get('x-marsclaw-mcp-token');
  return presented === AUTH_TOKEN;
}

// Extract <threadId> from /mcp/<threadId> (URL-encoded). Returns null for any
// other path shape so we can 404 cleanly.
function threadIdFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/mcp\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]!) : null;
}

Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0, // tool calls (e.g. an awaiting-approval mutation) can be long
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    }
    if (!authorized(req)) {
      return new Response('unauthorized', { status: 401 });
    }
    const threadId = threadIdFromPath(url.pathname);
    if (!threadId) {
      return new Response('not found', { status: 404 });
    }
    // Fresh Server + transport per request (stateless pattern); bind the thread
    // id so the tools resolve identity per-request.
    return runWithThreadId(threadId, async () => {
      const server = createMcpServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      return transport.handleRequest(req);
    });
  },
});

log.info('marsclaw HTTP MCP server listening', { host: HOST, port: PORT, path: '/mcp/<threadId>', auth: AUTH_TOKEN ? 'token' : 'none' });
console.error(`[marsclaw-mcp-http] listening on ${HOST}:${PORT}/mcp/<threadId> (auth: ${AUTH_TOKEN ? 'token' : 'none'})`);
