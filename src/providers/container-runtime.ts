// On-demand lifecycle for the agent container (runtime='container').
//
// nanoclaw spawns a container per session on inbound message and an idle sweep
// kills it. marsClaw multiplexes all the owner's threads through ONE shared
// container, so we adapt that to: lazy-start the (heavy) container on the first
// message, keep it warm across turns, and stop it after IDLE_MS with no
// activity. The (cheap) host sidecars — LLM proxy, HTTP MCP, egress gateway —
// stay up the whole time the broker runs (like nanoclaw's always-on gateway);
// only the container goes up and down.
//
// The host broker calls startSidecars() once on boot, ensureContainerUp() before
// each turn (deduped), and recordActivity() after each turn to defer the idle
// stop. shutdownContainerRuntime() tears everything down on exit.

import { existsSync } from 'node:fs';
import { loadConfig } from '../lib/config.ts';
import { log } from '../lib/log.ts';
import { HOME, assetPath } from '../lib/paths.ts';

// Resolve the container CLI to an ABSOLUTE path. Under launchd the service PATH
// is minimal, so a bare 'docker' may not resolve; check the usual install
// locations. MARSCLAW_DOCKER_BIN overrides. Works for Colima/Docker/Podman.
function resolveDockerBin(): string {
  const override = process.env.MARSCLAW_DOCKER_BIN;
  if (override) return override;
  for (const p of ['/opt/homebrew/bin/docker', '/usr/local/bin/docker', '/usr/bin/docker']) {
    if (existsSync(p)) return p;
  }
  return 'docker'; // fall back to PATH lookup
}
const DOCKER = resolveDockerBin();
const IMAGE = process.env.MARSCLAW_AGENT_IMAGE ?? 'marsclaw-agent:latest';
const CONTAINER_NAME = process.env.MARSCLAW_AGENT_CONTAINER ?? 'marsclaw-agent';

const TURN_PORT = Number(process.env.MARSCLAW_TURN_PORT ?? 8770);
const PROXY_PORT = Number(process.env.LLM_PROXY_PORT ?? 8765);
const MCP_PORT = Number(process.env.MARSCLAW_MCP_HTTP_PORT ?? 8766);
const EGRESS_PORT = Number(process.env.EGRESS_GATEWAY_PORT ?? 8775);

// Idle window after which the container is stopped. Mirrors the in-container
// session idle so a thread that's done is fully released. Override with
// MARSCLAW_CONTAINER_IDLE_MS.
const IDLE_MS = Number(process.env.MARSCLAW_CONTAINER_IDLE_MS ?? 15 * 60_000);
const HEALTH_TIMEOUT_MS = 60_000;

// Writable root for media, agent-home, logs, and the selectively-mounted
// persona/memory surface (CLAUDE.md + skills are synced into HOME on boot — see
// bootstrap.ts — so HOME is the right source for all mounts). Read-only sidecar
// scripts live under ASSETS instead (assetPath below).
const ROOT = HOME;
const SHARED_MEDIA = process.env.MARSCLAW_SHARED_MEDIA ?? `${ROOT}/data/shared`;
const AGENT_HOME = process.env.MARSCLAW_AGENT_HOME ?? `${ROOT}/data/agent-home`;

function turnBase(): string {
  return loadConfig().container_turn_url.replace(/\/+$/, '');
}

async function isHealthy(): Promise<boolean> {
  try {
    const r = await fetch(`${turnBase()}/health`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}

// --- host sidecars (always-on while the broker runs) -----------------------
interface Sidecar {
  name: string;
  args: string[];
  env: Record<string, string>;
  port: number;
}

function sidecarSpecs(): Sidecar[] {
  return [
    {
      name: 'llm-proxy',
      args: ['run', assetPath('tools/llm-proxy/proxy.ts')],
      env: { LLM_PROXY_HOST: '0.0.0.0', LLM_PROXY_PORT: String(PROXY_PORT) },
      port: PROXY_PORT,
    },
    {
      name: 'mcp-http',
      args: ['run', assetPath('src/mcp/http-server.ts')],
      // Per-call Google-write approval (the user's chosen posture) — writes from
      // the container gate on the host even though allow_mutating_tools may be 1.
      env: {
        MARSCLAW_MCP_HTTP_HOST: '0.0.0.0',
        MARSCLAW_MCP_HTTP_PORT: String(MCP_PORT),
        MARSCLAW_MUTATION_APPROVAL: process.env.MARSCLAW_MUTATION_APPROVAL ?? 'all',
      },
      port: MCP_PORT,
    },
    {
      name: 'egress',
      args: ['run', assetPath('tools/egress-gateway/gateway.ts')],
      env: { EGRESS_GATEWAY_HOST: '0.0.0.0', EGRESS_GATEWAY_PORT: String(EGRESS_PORT) },
      port: EGRESS_PORT,
    },
  ];
}

const sidecarProcs: { name: string; proc: ReturnType<typeof Bun.spawn> }[] = [];

async function portListening(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    void r;
    return true;
  } catch (err) {
    // A refused connection means nothing is listening; any HTTP-level response
    // (even an error status, which doesn't throw) means something is there.
    return !/ECONNREFUSED|Unable to connect|fetch failed|refused/i.test(
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Start the host sidecars the container depends on (idempotent — skips any
 *  port already listening, e.g. from a manual run.sh). */
export async function startSidecars(): Promise<void> {
  for (const s of sidecarSpecs()) {
    if (await portListening(s.port)) {
      log.info('sidecar already listening — reusing', { name: s.name, port: s.port });
      continue;
    }
    // Use the SAME bun binary running the broker (process.execPath), not a bare
    // 'bun' — under launchd the service PATH won't include nvm/asdf bun dirs.
    const proc = Bun.spawn([process.execPath, ...s.args], {
      env: { ...process.env, ...s.env },
      stdout: Bun.file(`${ROOT}/logs/${s.name}.log`),
      stderr: Bun.file(`${ROOT}/logs/${s.name}.log`),
    });
    sidecarProcs.push({ name: s.name, proc });
    log.info('sidecar started', { name: s.name, port: s.port, pid: proc.pid });
  }
}

// Memory + persona mounts. The agent's cwd inside the box is /workspace, so the
// claude_code preset auto-loads CLAUDE.md (persona/rules + its @skills import)
// and the agent reads/writes MEMORY.md there. These are mounted SELECTIVELY —
// only the memory/persona surface, NEVER .env or data/ — so the box shares the
// bot's identity + long-term memory with the host WITHOUT gaining any secret.
// Host and container are then the SAME bot. RO for instructions/skills (the
// agent can't rewrite its own rules), RW for memory the agent legitimately
// updates. Each entry is added only if the host path exists, so a missing
// wiki/ etc. doesn't make docker create a stray empty dir.
function memoryMounts(): string[] {
  const specs: { host: string; container: string; ro: boolean }[] = [
    { host: `${ROOT}/CLAUDE.md`, container: '/workspace/CLAUDE.md', ro: true },
    { host: `${ROOT}/MEMORY.md`, container: '/workspace/MEMORY.md', ro: false },
    { host: `${ROOT}/skills`, container: '/workspace/skills', ro: true },
    { host: `${ROOT}/wiki`, container: '/workspace/wiki', ro: false },
  ];
  const args: string[] = [];
  for (const s of specs) {
    if (!existsSync(s.host)) continue;
    args.push('-v', `${s.host}:${s.container}${s.ro ? ':ro' : ''}`);
  }
  return args;
}

// --- container lifecycle ---------------------------------------------------
function runArgs(): string[] {
  // Egress proxy URL — carries the auth credential in the userinfo when
  // EGRESS_PROXY_TOKEN is set (proxy-aware clients then send Proxy-Authorization).
  const egressTok = process.env.EGRESS_PROXY_TOKEN;
  const egressUrl = egressTok
    ? `http://marsclaw:${egressTok}@host.docker.internal:${EGRESS_PORT}`
    : `http://host.docker.internal:${EGRESS_PORT}`;
  return [
    'run', '-d', '--rm', '--name', CONTAINER_NAME,
    '--user', 'bun',
    '-p', `127.0.0.1:${TURN_PORT}:${TURN_PORT}`,
    '-e', 'HOME=/home/bun',
    '-e', `AGENT_SERVICE_PORT=${TURN_PORT}`,
    '-e', 'AGENT_WORKDIR=/workspace',
    '-e', `ANTHROPIC_BASE_URL=http://host.docker.internal:${PROXY_PORT}`,
    '-e', `ANTHROPIC_API_KEY=${process.env.LLM_PROXY_SESSION_TOKEN ?? ''}`,
    '-e', `HTTPS_PROXY=${egressUrl}`,
    '-e', `HTTP_PROXY=${egressUrl}`,
    '-e', 'NO_PROXY=host.docker.internal,127.0.0.1,localhost',
    '-e', `MARSCLAW_MCP_BASE_URL=http://host.docker.internal:${MCP_PORT}/mcp`,
    '-e', `MARSCLAW_BOT_NAME=${process.env.MARSCLAW_BOT_NAME ?? 'Mars'}`,
    '-e', `MARSCLAW_OWNER_NAME=${process.env.MARSCLAW_OWNER_NAME ?? ''}`,
    // Shared media root, bind-mounted at the identical path below. Files the
    // agent wants to deliver via send_file must be written here so the
    // host-side MCP can stat them (path identity across the boundary).
    '-e', `MARSCLAW_SHARED_MEDIA=${SHARED_MEDIA}`,
    // Shared-secret for the host MCP server (the host MCP requires it when set).
    ...(process.env.MARSCLAW_MCP_TOKEN ? ['-e', `MARSCLAW_MCP_TOKEN=${process.env.MARSCLAW_MCP_TOKEN}`] : []),
    '-v', `${AGENT_HOME}/.claude:/home/bun/.claude`,
    '-v', `${SHARED_MEDIA}:${SHARED_MEDIA}`,
    ...memoryMounts(),
    IMAGE,
  ];
}

let upPromise: Promise<void> | null = null;
let lastActivity = 0;
let idleTimer: ReturnType<typeof setInterval> | null = null;

/** Ensure the container is running and healthy. Deduped: concurrent callers
 *  share one in-flight start. Throws if it can't become healthy. */
export async function ensureContainerUp(): Promise<void> {
  if (await isHealthy()) return;
  if (upPromise) return upPromise;
  upPromise = startContainer().finally(() => {
    upPromise = null;
  });
  return upPromise;
}

/**
 * Is the container daemon reachable? On macOS the daemon lives in a VM
 * (Colima/Docker Desktop) that must be started separately — under launchd at
 * boot it may not be up yet. Returns null if reachable, else a clear message.
 */
export async function dockerDaemonError(): Promise<string | null> {
  try {
    const proc = Bun.spawn([DOCKER, 'info', '--format', '{{.ServerVersion}}'], {
      stdout: 'ignore',
      stderr: 'pipe',
      env: process.env,
    });
    const code = await proc.exited;
    if (code === 0) return null;
    return (
      `container daemon not reachable via ${DOCKER}. On macOS start Colima first: ` +
      `\`brew services start colima\` (persists across reboots) or \`colima start\`.`
    );
  } catch (err) {
    return `cannot exec ${DOCKER}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function startContainer(): Promise<void> {
  log.info('cold-starting agent container', { name: CONTAINER_NAME });
  const daemonErr = await dockerDaemonError();
  if (daemonErr) throw new Error(daemonErr);
  // Remove any dead container with our name first (rm --rm leftovers).
  await Bun.spawn([DOCKER, 'rm', '-f', CONTAINER_NAME], { stdout: 'ignore', stderr: 'ignore' }).exited;
  const proc = Bun.spawn([DOCKER, ...runArgs()], { stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    const errText = await new Response(proc.stderr).text();
    throw new Error(`docker run failed (exit ${code}): ${errText.slice(0, 300)}`);
  }
  // Poll for health.
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isHealthy()) {
      log.info('agent container healthy', { name: CONTAINER_NAME });
      ensureIdleSweep();
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`agent container did not become healthy within ${HEALTH_TIMEOUT_MS}ms`);
}

/** Mark a turn as just happening so the idle sweep defers the stop. */
export function recordActivity(): void {
  lastActivity = Date.now();
  ensureIdleSweep();
}

function ensureIdleSweep(): void {
  if (idleTimer || IDLE_MS <= 0) return;
  idleTimer = setInterval(() => {
    void maybeStopIdle();
  }, Math.min(IDLE_MS, 60_000));
  idleTimer.unref?.();
}

async function maybeStopIdle(): Promise<void> {
  if (lastActivity === 0) return;
  if (Date.now() - lastActivity < IDLE_MS) return;
  if (upPromise) return; // a start is in flight
  if (!(await isHealthy())) return; // already down
  log.info('stopping idle agent container', { idleMs: Date.now() - lastActivity });
  await stopContainer();
  lastActivity = 0;
}

export async function stopContainer(): Promise<void> {
  try {
    await Bun.spawn([DOCKER, 'rm', '-f', CONTAINER_NAME], { stdout: 'ignore', stderr: 'ignore' }).exited;
  } catch (err) {
    log.warn('stopContainer failed', { err });
  }
}

/** Tear down container + sidecars on broker shutdown. */
export async function shutdownContainerRuntime(): Promise<void> {
  if (idleTimer) clearInterval(idleTimer);
  await stopContainer();
  for (const { name, proc } of sidecarProcs) {
    try {
      proc.kill();
      log.info('sidecar stopped', { name });
    } catch (err) {
      log.warn('sidecar stop failed', { name, err });
    }
  }
}
