// First-run + relocation bootstrap.
//
// In a packaged app MARSCLAW_HOME points at a writable user dir (e.g.
// ~/Library/Application Support/marsClaw) distinct from the read-only,
// code-signed bundle (MARSCLAW_ASSETS). We chdir into HOME so that the ~40
// `data/...`-relative paths spread across the codebase — and the agent SDK's
// own working directory — resolve under writable state. Then we sync the
// read-only persona surface (which the Claude SDK auto-loads from cwd) out of
// the bundle into HOME, and seed the user's own files on first run.
//
// In a git checkout MARSCLAW_HOME is unset, so HOME === ASSETS === cwd and this
// is a near no-op: it just seeds MEMORY.md, preserving the old src/index.ts
// behaviour. Idempotent — safe to call from every entrypoint.

import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { ASSETS, HOME, assetPath, homePath } from './paths.ts';

let done = false;

export function bootstrapHome(): void {
  if (done) return;
  done = true;

  // Relocated == running from a packaged app: writable HOME differs from the
  // read-only ASSETS bundle. Only then do we chdir + sync persona out of it.
  if (HOME !== ASSETS) {
    mkdirSync(homePath('data'), { recursive: true });
    process.chdir(HOME);

    // Persona surface the agent SDK auto-loads from cwd. Re-copied every boot so
    // an app update ships new rules/skills without the user re-running setup.
    for (const f of ['CLAUDE.md', 'GEMINI.md']) {
      if (existsSync(assetPath(f))) copyFileSync(assetPath(f), homePath(f));
    }
    if (existsSync(assetPath('skills'))) {
      cpSync(assetPath('skills'), homePath('skills'), { recursive: true });
    }

    // Seed-once files — never clobber the user's own copy.
    if (!existsSync(homePath('wiki')) && existsSync(assetPath('wiki'))) {
      cpSync(assetPath('wiki'), homePath('wiki'), { recursive: true });
    }
    if (!existsSync(homePath('.env')) && existsSync(assetPath('.env.example'))) {
      copyFileSync(assetPath('.env.example'), homePath('.env'));
    }
  }

  // MEMORY.md is the agent's own notebook — seed from the template if absent.
  // Applies in both modes (replaces the inline seed that lived in src/index.ts).
  if (!existsSync(homePath('MEMORY.md')) && existsSync(assetPath('MEMORY.template.md'))) {
    copyFileSync(assetPath('MEMORY.template.md'), homePath('MEMORY.md'));
  }
}
