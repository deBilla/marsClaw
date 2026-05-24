#!/usr/bin/env bash
# nothingClaw bootstrap installer.
#
# Detects OS, installs Bun if missing, installs deps, then hands off to the
# interactive setup CLI.

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "\033[32m✓\033[0m %s\n" "$1"; }
err()  { printf "\033[31merror:\033[0m %s\n" "$1" >&2; }

bold "nothingClaw setup"
echo

OS="$(uname -s)"
case "$OS" in
  Darwin) ok "OS: macOS" ;;
  Linux)  ok "OS: Linux" ;;
  *) err "Unsupported OS: $OS. Use macOS, Linux, or WSL."; exit 1 ;;
esac

# Install Bun if missing
if ! command -v bun >/dev/null 2>&1; then
  bold "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    err "Bun install finished but \`bun\` is not on PATH. Reopen your shell and re-run setup.sh."
    exit 1
  fi
fi
ok "Bun: $(bun --version)"

# Ensure node + npm (needed to globally install the provider CLI)
if ! command -v npm >/dev/null 2>&1; then
  err "npm not found. Install Node.js (https://nodejs.org) and re-run setup.sh."
  exit 1
fi
ok "npm: $(npm --version)"

# Seed local-only files from templates if missing
if [ ! -f MEMORY.md ] && [ -f MEMORY.template.md ]; then
  cp MEMORY.template.md MEMORY.md
  ok "Created MEMORY.md from template"
fi
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  ok "Created .env from template"
fi

# Install JS deps
bold "Installing JavaScript dependencies..."
bun install --silent

# Hand off to interactive TS setup
echo
exec bun run src/cli/index.ts setup
