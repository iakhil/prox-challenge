"""ElevenLabs Speech-to-Text and Text-to-Speech (server-side only)."""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

ELEVEN_BASE = os.environ.get("ELEVENLABS_API_BASE", "https://api.elevenlabs.io").rstrip("/")

MAX_SPEAK_CHARS = 8000
DEFAULT_STT_MODEL = "scribe_v2"
DEFAULT_TTS_MODEL = "eleven_multilingual_v2"
DEFAULT_TTS_FORMAT = "mp3_44100_128"


def _api_key() -> str | None:
    return os.environ.get("ELEVENLABS_API_KEY") or None


def extract_transcript(payload: dict[str, Any]) -> str:
    if "message" in payload and "request_id" in payload and "text" not in payload:
        raise ValueError("ElevenLabs returned async webhook mode; keep webhook=false for this app")
    if "text" in payload and isinstance(payload["text"], str):
        return payload["text"].strip()
    if "transcripts" in payload and isinstance(payload["transcripts"], list):
        parts: list[str] = []
        for item in payload["transcripts"]:
            if isinstance(item, dict) and item.get("text"):
                parts.append(str(item["text"]).strip())
        return " ".join(parts).strip()
    raise ValueError("Unexpected speech-to-text response shape")


async def transcribe_audio(
    file_bytes: bytes,
    filename: str,
    content_type: str | None,
) -> str:
    key = _api_key()
    if not key:
        raise RuntimeError("ELEVENLABS_API_KEY is not set")

    model_id = os.environ.get("ELEVENLABS_STT_MODEL_ID", DEFAULT_STT_MODEL)
    mime = content_type or "application/octet-stream"

    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
        files = {"file": (filename or "audio.webm", file_bytes, mime)}
        data = {"model_id": model_id}
        r = await client.post(
            f"{ELEVEN_BASE}/v1/speech-to-text",
            headers={"xi-api-key": key},
            files=files,
            data=data,
        )

    try:
        r.raise_for_status()
    except httpx.HTTPStatusError:
        logger.warning("ElevenLabs STT error %s: %s", r.status_code, r.text[:500])
        raise

    payload = r.json()
    return extract_transcript(payload)


async def text_to_speech_bytes(text: str) -> tuple[bytes, str]:
    key = _api_key()
    if not key:
        raise RuntimeError("ELEVENLABS_API_KEY is not set")

    voice_id = os.environ.get("ELEVENLABS_VOICE_ID", "").strip()
    if not voice_id:
        raise RuntimeError("ELEVENLABS_VOICE_ID is not set")

    trimmed = text.strip()
    if not trimmed:
        raise ValueError("Empty text")
    if len(trimmed) > MAX_SPEAK_CHARS:
        trimmed = trimmed[:MAX_SPEAK_CHARS]

    model_id = os.environ.get("ELEVENLABS_TTS_MODEL_ID", DEFAULT_TTS_MODEL)
    output_format = os.environ.get("ELEVENLABS_TTS_OUTPUT_FORMAT", DEFAULT_TTS_FORMAT)

    url = f"{ELEVEN_BASE}/v1/text-to-speech/{voice_id}"
    params = {"output_format": output_format}
    body = {"text": trimmed, "model_id": model_id}

    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
        r = await client.post(
            url,
            headers={"xi-api-key": key, "Content-Type": "application/json"},
            params=params,
            json=body,
        )

    try:
        r.raise_for_status()
    except httpx.HTTPStatusError:
        logger.warning("ElevenLabs TTS error %s: %s", r.status_code, r.text[:500])
        raise

    # API returns binary audio; default is MP3 for mp3_* formats
    media = r.headers.get("content-type", "audio/mpeg")
    if "octet-stream" in media or not media.startswith("audio"):
        media = "audio/mpeg"
    return r.content, media
