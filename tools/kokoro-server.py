"""Tiny FastAPI wrapper around kokoro-onnx with an OpenAI-compatible endpoint.

Exposes:
  GET  /health             → { ok, voice }
  POST /v1/audio/speech    { input, voice?, response_format?, speed? } → audio bytes

response_format: "wav" | "mp3" | "ogg" (default "ogg"). For "mp3" / "ogg" we
shell out to ffmpeg to transcode from PCM (mp3 = libmp3lame, ogg = libopus).

Env:
  KOKORO_MODEL    default tools/voice-env/kokoro/kokoro-v1.0.onnx
  KOKORO_VOICES   default tools/voice-env/kokoro/voices-v1.0.bin
  KOKORO_PORT     default 9001
  KOKORO_VOICE    default af_heart
"""

import io
import os
import subprocess
import sys
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel
import uvicorn
import soundfile as sf
from kokoro_onnx import Kokoro

MODEL_PATH = os.environ.get("KOKORO_MODEL", "tools/voice-env/kokoro/kokoro-v1.0.onnx")
VOICES_PATH = os.environ.get("KOKORO_VOICES", "tools/voice-env/kokoro/voices-v1.0.bin")
PORT = int(os.environ.get("KOKORO_PORT", "9001"))
DEFAULT_VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
DEFAULT_LANG = os.environ.get("KOKORO_LANG", "en-us")

kokoro: Optional[Kokoro] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global kokoro
    if not os.path.exists(MODEL_PATH) or not os.path.exists(VOICES_PATH):
        sys.stderr.write(f"[kokoro] missing model files. Run tools/setup-voice.sh.\n")
        sys.exit(1)
    sys.stderr.write(f"[kokoro] loading model={MODEL_PATH}\n")
    sys.stderr.flush()
    kokoro = Kokoro(MODEL_PATH, VOICES_PATH)
    sys.stderr.write(f"[kokoro] ready (default voice: {DEFAULT_VOICE})\n")
    sys.stderr.flush()
    yield


app = FastAPI(lifespan=lifespan)


class SpeechRequest(BaseModel):
    input: str
    voice: str = DEFAULT_VOICE
    response_format: str = "ogg"
    speed: float = 1.0
    lang: str = DEFAULT_LANG


@app.get("/health")
def health():
    return {"ok": kokoro is not None, "voice": DEFAULT_VOICE}


def transcode(wav_bytes: bytes, fmt: str) -> tuple[bytes, str]:
    if fmt == "wav":
        return wav_bytes, "audio/wav"

    if fmt == "mp3":
        codec = ["-c:a", "libmp3lame", "-b:a", "64k"]
        container = "mp3"
        mime = "audio/mpeg"
    elif fmt in ("ogg", "opus"):
        codec = ["-c:a", "libopus", "-b:a", "32k", "-application", "voip"]
        container = "ogg"
        mime = "audio/ogg"
    else:
        raise ValueError(f"unsupported response_format: {fmt}")

    proc = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "wav", "-i", "pipe:0",
            *codec,
            "-f", container, "pipe:1",
        ],
        input=wav_bytes,
        capture_output=True,
        check=True,
    )
    return proc.stdout, mime


@app.post("/v1/audio/speech")
async def speech(req: SpeechRequest):
    if kokoro is None:
        return JSONResponse({"error": "model not loaded"}, status_code=503)
    if not req.input.strip():
        return JSONResponse({"error": "input is required"}, status_code=400)

    samples, sample_rate = kokoro.create(req.input, voice=req.voice, speed=req.speed, lang=req.lang)

    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV", subtype="PCM_16")
    wav_bytes = buf.getvalue()

    try:
        audio_bytes, mime = transcode(wav_bytes, req.response_format)
    except subprocess.CalledProcessError as e:
        return JSONResponse({"error": "ffmpeg failed", "stderr": e.stderr.decode(errors="ignore")[-400:]}, status_code=500)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    return Response(content=audio_bytes, media_type=mime)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
