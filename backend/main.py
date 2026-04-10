"""FastAPI app: health, manual page images, SSE chat."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from backend.chat import SessionStore, sse_json
from backend.elevenlabs_voice import MAX_SPEAK_CHARS, text_to_speech_bytes, transcribe_audio
from backend.ensure_data import needs_extraction, run_extraction
from backend.manual_mcp import manual_remote_mcp
from backend.paths import pages_dir, repo_root

load_dotenv(repo_root() / ".env")

logger = logging.getLogger(__name__)
sessions = SessionStore()


@asynccontextmanager
async def lifespan(app: FastAPI):
    if needs_extraction():
        logger.info("Extracting manuals into data/ (first run)...")
        try:
            run_extraction()
        except Exception as e:
            logger.exception("Manual extraction failed: %s", e)
    yield
    await sessions.close_all()


app = FastAPI(title="OmniPro 220 Agent", lifespan=lifespan)

_origins = os.environ.get("CORS_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _origins if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_REMOTE_MCP_PATH = "/api/mcp/manual"
_REMOTE_MCP_TOKEN = (os.environ.get("VOICE_MANUAL_MCP_TOKEN") or "").strip()


@app.middleware("http")
async def mcp_token_guard(request: Request, call_next):
    if request.url.path.startswith(_REMOTE_MCP_PATH) and _REMOTE_MCP_TOKEN:
        auth = request.headers.get("authorization", "")
        token = request.headers.get("x-mcp-auth-token", "")
        expected = f"Bearer {_REMOTE_MCP_TOKEN}"
        if auth != expected and token != _REMOTE_MCP_TOKEN:
            return JSONResponse({"detail": "Unauthorized MCP request"}, status_code=401)
    return await call_next(request)


app.mount(_REMOTE_MCP_PATH, manual_remote_mcp.streamable_http_app())


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/pages/{doc_id}/{page}.png")
def get_page_png(doc_id: str, page: int):
    path = pages_dir() / doc_id / f"{page}.png"
    if not path.is_file():
        raise HTTPException(404, "Page image not found — run extraction")
    return FileResponse(path, media_type="image/png")


class ChatBody(BaseModel):
    message: str = Field(..., min_length=1)
    session_id: str | None = None


class ResetBody(BaseModel):
    session_id: str


class SpeakBody(BaseModel):
    text: str = Field(..., min_length=1, max_length=MAX_SPEAK_CHARS)


@app.post("/api/voice/transcribe")
async def voice_transcribe(audio: UploadFile = File(...)):
    if not os.environ.get("ELEVENLABS_API_KEY"):
        raise HTTPException(503, "Set ELEVENLABS_API_KEY in .env for voice input")
    raw = await audio.read()
    if len(raw) < 100:
        raise HTTPException(400, "Audio too short (need at least ~100 bytes)")
    try:
        text = await transcribe_audio(raw, audio.filename or "recording.webm", audio.content_type)
    except RuntimeError as e:
        raise HTTPException(503, str(e)) from e
    except ValueError as e:
        raise HTTPException(502, str(e)) from e
    except httpx.HTTPStatusError as e:
        detail = e.response.text[:300] if e.response else str(e)
        logger.warning("ElevenLabs STT HTTP error: %s", detail)
        raise HTTPException(502, f"ElevenLabs STT failed: {detail}") from e
    except httpx.RequestError as e:
        raise HTTPException(502, f"ElevenLabs STT request failed: {e}") from e
    return {"text": text}


@app.post("/api/voice/speak")
async def voice_speak(body: SpeakBody):
    if not os.environ.get("ELEVENLABS_API_KEY"):
        raise HTTPException(503, "Set ELEVENLABS_API_KEY in .env for voice output")
    try:
        data, media = await text_to_speech_bytes(body.text)
    except RuntimeError as e:
        raise HTTPException(503, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except httpx.HTTPStatusError as e:
        detail = e.response.text[:300] if e.response else str(e)
        logger.warning("ElevenLabs TTS HTTP error: %s", detail)
        raise HTTPException(502, f"ElevenLabs TTS failed: {detail}") from e
    except httpx.RequestError as e:
        raise HTTPException(502, f"ElevenLabs TTS request failed: {e}") from e
    return Response(content=data, media_type=media)


@app.post("/api/chat/stream")
async def chat_stream(body: ChatBody, request: Request):
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise HTTPException(503, "Set ANTHROPIC_API_KEY in .env")

    sid, session = sessions.get_or_create(body.session_id)

    async def gen():
        yield sse_json({"event": "session", "data": {"session_id": sid}})
        try:
            async for evt in session.send(body.message):
                if await request.is_disconnected():
                    break
                yield sse_json(evt)
        except Exception as e:
            logger.exception("Chat error")
            yield sse_json({"event": "error", "data": {"message": str(e)}})
        yield sse_json({"event": "end", "data": {}})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/session/reset")
async def reset_session(body: ResetBody):
    await sessions.reset(body.session_id)
    return {"ok": True}


# Optional: serve `web/dist` after `npm run build` so one process can host API + UI.
_dist = repo_root() / "web" / "dist"


@app.get("/{full_path:path}")
async def spa_fallback(full_path: str):
    if not _dist.is_dir():
        raise HTTPException(404, "Build the frontend: cd web && npm run build")
    if not full_path:
        return FileResponse(_dist / "index.html")
    candidate = _dist / full_path
    if candidate.is_file():
        return FileResponse(candidate)
    index = _dist / "index.html"
    if index.is_file():
        return FileResponse(index)
    raise HTTPException(404)
