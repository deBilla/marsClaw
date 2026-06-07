#!/usr/bin/env bun
// Build the marsClaw engine: a single self-contained Bun binary plus the
// read-only assets directory it reads at runtime via MARSCLAW_ASSETS. Output:
//
//   dist/engine/<arch>/marsclaw     ← the compiled binary (no Node/Bun needed)
//   dist/engine/<arch>/assets/      ← CLAUDE.md, skills/, migrations/, … (ro)
//
// The macOS packaging script drops each <arch> dir into
// marsClaw.app/Contents/Resources/engine. Writable user state (data/, .env,
// MEMORY.md, wiki/) is NOT shipped here — bootstrap.ts seeds it into
// MARSCLAW_HOME on first run.
//
//   bun run scripts/build-engine.ts          # host arch only
//   bun run scripts/build-engine.ts --all    # arm64 + x64 (for a universal app)
//
// Why a plugin: @google/gemini-cli-core imports tree-sitter `*.wasm?binary`
// modules. The default bundler can't resolve that package-subpath-plus-query,
// and `--external` is not an option (a compiled Bun binary resolves externals
// only from its embedded fs, never from disk). The plugin maps the specifier to
// the real wasm file so it embeds inline and Gemini works in the single binary.

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

const wasmBinaryPlugin: Bun.BunPlugin = {
  name: 'wasm-binary-query',
  setup(build) {
    build.onResolve({ filter: /\.wasm\?binary$/ }, (args) => {
      const bare = args.path.replace(/\?binary$/, '');
      const from = args.importer ? resolve(args.importer, '..') : ROOT;
      return { path: Bun.resolveSync(bare, from), namespace: 'file' };
    });
  },
};

// Read-only payload the in-process engine reads at runtime. (Optional-feature
// assets — tools/ voice + sidecars, container/ — are added with W4 once the
// sidecars move to compiled-in `_sidecar` subcommands, since their source can't
// run standalone from here.)
const ASSET_PATHS = ['CLAUDE.md', 'GEMINI.md', 'MEMORY.template.md', '.env.example', 'migrations', 'skills', 'wiki'];

type Arch = 'arm64' | 'x64';
const archs: Arch[] = process.argv.includes('--all') ? ['arm64', 'x64'] : [process.arch === 'x64' ? 'x64' : 'arm64'];

for (const arch of archs) {
  const out = resolve(ROOT, 'dist/engine', arch);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const result = await Bun.build({
    entrypoints: [resolve(ROOT, 'src/cli/index.ts')],
    plugins: [wasmBinaryPlugin],
    // @ts-expect-error `compile` is experimental in the JS build API (works on Bun 1.3.x)
    compile: { outfile: resolve(out, 'marsclaw'), target: `bun-darwin-${arch}` },
  });
  if (!result.success) {
    for (const l of result.logs) console.error(String(l));
    throw new Error(`engine build failed (${arch})`);
  }

  const assets = resolve(out, 'assets');
  mkdirSync(assets, { recursive: true });
  for (const p of ASSET_PATHS) cpSync(resolve(ROOT, p), resolve(assets, p), { recursive: true });

  console.log(`✓ ${arch} → ${resolve(out, 'marsclaw')} (+ assets/)`);
}
