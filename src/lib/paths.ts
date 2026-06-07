// Filesystem layout for marsClaw — two roots, so the app can run either from a
// git checkout (everything in one directory) or from a packaged, code-signed
// macOS .app (read-only bundle + a separate writable home).
//
//   HOME   — writable user state: .env, data/ (DB, secrets, config.json,
//            whatsapp-auth, media), MEMORY.md, wiki/, logs/, crashes/.
//            Override with MARSCLAW_HOME.
//   ASSETS — read-only payload that ships with the app: CLAUDE.md, skills/,
//            migrations/, tools/ scripts, container/, launchd templates,
//            MEMORY.template.md. Override with MARSCLAW_ASSETS.
//
// Both default to the process cwd, so a bare `bun run start` from the repo is
// unchanged: HOME === ASSETS === the project root. In a packaged app they
// diverge — HOME points at ~/Library/Application Support/marsClaw and ASSETS
// at the bundle's Resources, which is read-only and signed.

import path from 'node:path';

/** Writable user-state root. */
export const HOME = process.env.MARSCLAW_HOME ? path.resolve(process.env.MARSCLAW_HOME) : process.cwd();

/** Read-only bundled-asset root. */
export const ASSETS = process.env.MARSCLAW_ASSETS ? path.resolve(process.env.MARSCLAW_ASSETS) : process.cwd();

/** Resolve a path under the writable HOME root. */
export function homePath(...segs: string[]): string {
  return path.join(HOME, ...segs);
}

/** Resolve a path under the read-only ASSETS root. */
export function assetPath(...segs: string[]): string {
  return path.join(ASSETS, ...segs);
}
