// Stdio MCP server — used by the in-process runtime, where the SDK spawns one
// MCP child per thread with MARSCLAW_THREAD_ID in its env. The tool list and
// handlers live in build-server.ts (shared with the HTTP transport).

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './build-server.ts';

const server = createMcpServer();
await server.connect(new StdioServerTransport());
console.error('[marsclaw-mcp] ready');
