#!/usr/bin/env bash
# Install voice support: Python venv with faster-whisper + a tiny FastAPI server.
# Idempotent — safe to re-run.

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VENV_DIR="tools/voice-env"
WHISPER_MODEL="${WHISPER_MODEL:-base}"   # tiny | base | small | medium | large(.en variants too)

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "\033[32m✓\033[0m %s\n" "$1"; }
err()  { printf "\033[31m✗\033[0m %s\n" "$1" >&2; }

bold "nothingClaw voice — Whisper installer"
echo

# Python — faster-whisper + kokoro-onnx (onnxruntime) only ship wheels for
# 3.11 and 3.12. 3.13+ and ≤3.10 fail to install, so we require an exact match.
py_ver() { "$1" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null; }
is_supported() { case "$1" in 3.11|3.12) return 0 ;; *) return 1 ;; esac; }

PYTHON_BIN=""
for cand in python3.12 python3.11 python3; do
  command -v "$cand" >/dev/null 2>&1 || continue
  v="$(py_ver "$cand")"
  if is_supported "$v"; then PYTHON_BIN="$cand"; PY_VER="$v"; break; fi
done

if [ -z "$PYTHON_BIN" ]; then
  err "Voice needs Python 3.11 or 3.12 (faster-whisper/kokoro-onnx don't support 3.13+ or ≤3.10)."
  err "Install one and re-run:"
  err "  macOS:         brew install python@3.12"
  err "  Debian/Ubuntu: sudo apt install python3.12 python3.12-venv"
  found="$(command -v python3 >/dev/null 2>&1 && py_ver python3 || echo none)"
  err "Detected default python3: ${found}"
  exit 1
fi
ok "python: $PYTHON_BIN ($PY_VER)"

# ffmpeg (needed by faster-whisper to decode opus/ogg from WhatsApp)
if ! command -v ffmpeg >/dev/null 2>&1; then
  err "ffmpeg not found. Install it: brew install ffmpeg  (or  apt install ffmpeg)"
  exit 1
fi
ok "ffmpeg: $(ffmpeg -version | head -1 | awk '{print $3}')"

# venv
if [ -d "$VENV_DIR" ]; then
  EXISTING_VER="$(py_ver "$VENV_DIR/bin/python")"
  if ! is_supported "$EXISTING_VER"; then
    err "Existing venv at $VENV_DIR uses Python ${EXISTING_VER:-unknown}, which is unsupported."
    err "Delete it and re-run:  rm -rf $VENV_DIR && bun run voice install"
    exit 1
  fi
else
  bold "Creating Python venv at $VENV_DIR (using $PYTHON_BIN)"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi
ok "venv: $VENV_DIR"

# pip install
bold "Installing Python deps (faster-whisper, kokoro-onnx, fastapi, uvicorn)…"
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet faster-whisper kokoro-onnx soundfile fastapi 'uvicorn[standard]' python-multipart
ok "pip deps installed"

# Download Kokoro model (~325MB) + voices file
KOKORO_DIR="$VENV_DIR/kokoro"
mkdir -p "$KOKORO_DIR"
if [ ! -f "$KOKORO_DIR/kokoro-v1.0.onnx" ]; then
  bold "Downloading Kokoro model (kokoro-v1.0.onnx, ~325MB)…"
  curl -L --fail --progress-bar -o "$KOKORO_DIR/kokoro-v1.0.onnx" \
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
fi
if [ ! -f "$KOKORO_DIR/voices-v1.0.bin" ]; then
  bold "Downloading Kokoro voices (voices-v1.0.bin)…"
  curl -L --fail --progress-bar -o "$KOKORO_DIR/voices-v1.0.bin" \
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"
fi
ok "Kokoro model files at $KOKORO_DIR"

# Pre-download the model so the first request isn't 30s of model fetch.
bold "Pre-downloading Whisper model: $WHISPER_MODEL"
"$VENV_DIR/bin/python" - <<PY
from faster_whisper import WhisperModel
WhisperModel("$WHISPER_MODEL", device="cpu", compute_type="int8")
print("[setup-voice] model '$WHISPER_MODEL' loaded and cached")
PY
ok "model cached"

echo
bold "Done."
echo "  Start both servers:   bun run voice start"
echo "  Check status:         bun run voice status"
echo "  Tail Whisper logs:    tail -f data/voice-whisper.log"
echo "  Tail Kokoro logs:     tail -f data/voice-kokoro.log"
echo
echo "Voice support is OFF in nothingclaw until you set NOTHINGCLAW_VOICE=1 in .env."
