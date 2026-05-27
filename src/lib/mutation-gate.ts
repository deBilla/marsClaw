// Default-deny gate for MCP tools that take outbound or mutating actions
// (send email, write Sheets, create calendar events, write-style raw API
// calls). marsClaw ingests untrusted content — email bodies, web pages — so a
// hijacked or mistaken turn must not be able to act as the owner unless the
// operator opts in with `allow_mutating_tools: true` in data/config.json
// (or MARSCLAW_ALLOW_MUTATING_TOOLS=1).
//
// Enforced inside each tool handler (the MCP server's own code), per the
// canUseTool convention that dangerous MCP tools gate themselves rather than
// leaning on the built-in-tool permission layer.

import { loadConfig } from './config.ts';
import { audit } from './audit-log.ts';

export interface ToolRefusal {
  content: { type: 'text'; text: string }[];
  isError: true;
}

function refusal(tool: string): ToolRefusal {
  audit({ tool, decision: 'blocked', layer: 'mutation-gate', reason: 'allow_mutating_tools=false' });
  return {
    content: [
      {
        type: 'text',
        text:
          `Refused: "${tool}" performs an outbound or mutating action, which is disabled by default. ` +
          `marsClaw blocks these so a hijacked or mistaken turn can't act as the user ` +
          `(send mail, edit or delete their files). ` +
          `Tell the user that to enable it they must set "allow_mutating_tools": true in data/config.json ` +
          `(or MARSCLAW_ALLOW_MUTATING_TOOLS=1) and restart — do not try to edit that file yourself.`,
      },
    ],
    isError: true,
  };
}

/**
 * Gate a tool that is *always* mutating (gmail_send, sheets_write,
 * calendar_create_event). Returns a ready-to-return MCP refusal when mutations
 * are disabled, or null when the action is permitted.
 */
export function blockIfMutationsDisabled(tool: string): ToolRefusal | null {
  return loadConfig().allow_mutating_tools ? null : refusal(tool);
}

// Leaf-segment verbs that change server-side state. Used to gate the generic
// `*_raw` escape-hatch tools without blocking read-only raw calls — list/get/
// export/query/watch stay allowed even when mutations are off.
const MUTATING_VERB =
  /^(create|insert|update|patch|delete|batchUpdate|append|copy|trash|untrash|move|clear|write|remove|replace|add|set|import|empty|duplicate)/i;

/** True when a dotted googleapis method path (e.g. "events.patch") mutates state. */
export function isMutatingMethod(method: string): boolean {
  const leaf = method.trim().split('.').pop() ?? '';
  return MUTATING_VERB.test(leaf);
}

/**
 * Gate a `*_raw` tool by its method path: blocks only when the method mutates
 * state AND mutations are disabled. Read-only methods always pass.
 */
export function blockIfMutatingMethodDisabled(tool: string, method: string): ToolRefusal | null {
  if (!isMutatingMethod(method)) return null;
  return blockIfMutationsDisabled(`${tool} (${method})`);
}
