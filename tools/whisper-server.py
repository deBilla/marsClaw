"""Tiny FastAPI wrapper around faster-whisper.

Exposes:
  GET  /health      → { ok, model }
  POST /transcribe  (multipart: file=<audio>) → { text, language }

Env:
  WHISPER_MODEL    default "base"  (tiny/base/small/medium/large + .en variants)
  WHISPER_DEVICE   default "cpu"
  WHISPER_COMPUTE  default "int8"
  WHISPER_PORT     default 9000
"""

import os
import sys
import tempfile
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse
import uvicorn
from faster_whisper import WhisperModel

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
PORT = int(os.environ.get("WHISPER_PORT", "9000"))

model: WhisperModel | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model
    sys.stderr.write(
        f"[whisper] loading model={MODEL_SIZE} device={DEVICE} compute={COMPUTE}\n"
    )
    sys.stderr.flush()
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE)
    sys.stderr.write("[whisper] ready\n")
    sys.stderr.flush()
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health():
    return {"ok": model is not None, "model": MODEL_SIZE}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    if model is None:
        return JSONResponse({"error": "model not loaded"}, status_code=503)

    suffix = os.path.splitext(file.filename or "")[1] or ".ogg"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(await file.read())
        path = f.name
    try:
        segments, info = model.transcribe(path, beam_size=5, vad_filter=True)
        text = " ".join(s.text.strip() for s in segments).strip()
        return {"text": text, "language": info.language}
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
