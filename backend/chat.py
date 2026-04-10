"""Chat sessions wrapping ClaudeSDKClient and SSE-friendly serializers."""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import AsyncIterator
from dataclasses import asdict, is_dataclass
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeSDKClient,
    RateLimitEvent,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from backend.agent_options import build_agent_options


def _apply_model_env(opts: Any) -> Any:
    model = os.environ.get("ANTHROPIC_MODEL") or os.environ.get("CLAUDE_MODEL")
    if model:
        opts.model = model
    return opts


class ChatSession:
    """One long-lived Claude SDK client per browser/session id."""

    def __init__(self) -> None:
        self.id = str(uuid.uuid4())
        opts = _apply_model_env(build_agent_options())
        self._client = ClaudeSDKClient(options=opts)
        self._started = False

    async def start(self) -> None:
        if not self._started:
            await self._client.__aenter__()
            self._started = True

    async def close(self) -> None:
        if self._started:
            await self._client.__aexit__(None, None, None)
            self._started = False

    async def send(self, text: str) -> AsyncIterator[dict[str, Any]]:
        await self.start()
        await self._client.query(text.strip())
        async for message in self._client.receive_response():
            for event in serialize_message(message):
                yield event


def serialize_message(message: Any) -> list[dict[str, Any]]:
    """Turn SDK messages into JSON-serializable dicts for SSE."""
    out: list[dict[str, Any]] = []

    if isinstance(message, AssistantMessage):
        block_dicts: list[dict[str, Any]] = []
        for block in message.content:
            if isinstance(block, TextBlock):
                block_dicts.append({"type": "text", "text": block.text})
            elif isinstance(block, ThinkingBlock):
                block_dicts.append({"type": "thinking", "thinking": block.thinking})
            elif isinstance(block, ToolUseBlock):
                block_dicts.append(
                    {
                        "type": "tool_use",
                        "id": block.id,
                        "name": block.name,
                        "input": block.input,
                    }
                )
            elif isinstance(block, ToolResultBlock):
                block_dicts.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.tool_use_id,
                        "content": block.content,
                        "is_error": block.is_error,
                    }
                )
            else:
                block_dicts.append({"type": "unknown", "repr": repr(block)})
        payload = {
            "kind": "assistant",
            "model": message.model,
            "error": message.error,
            "content": block_dicts,
        }
        out.append({"event": "message", "data": payload})

    elif isinstance(message, ResultMessage):
        out.append(
            {
                "event": "result",
                "data": {
                    "kind": "result",
                    "subtype": message.subtype,
                    "is_error": message.is_error,
                    "session_id": message.session_id,
                    "num_turns": message.num_turns,
                    "errors": message.errors,
                },
            }
        )

    elif isinstance(message, SystemMessage):
        out.append(
            {
                "event": "system",
                "data": {"subtype": message.subtype, "data": message.data},
            }
        )

    elif isinstance(message, UserMessage):
        # Usually echoed user content — skip or forward lightly
        out.append({"event": "user_echo", "data": {"repr": repr(message)}})

    elif isinstance(message, StreamEvent):
        out.append(
            {
                "event": "stream",
                "data": {
                    "uuid": message.uuid,
                    "session_id": message.session_id,
                    "stream_event": message.event,
                },
            }
        )

    elif isinstance(message, RateLimitEvent):
        out.append({"event": "rate_limit", "data": asdict(message)})

    else:
        if is_dataclass(message):
            try:
                out.append({"event": "other", "data": asdict(message)})
            except TypeError:
                out.append({"event": "other", "data": {"repr": repr(message)}})
        else:
            out.append({"event": "other", "data": {"repr": repr(message)}})

    return out


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, ChatSession] = {}

    def get_or_create(self, session_id: str | None) -> tuple[str, ChatSession]:
        if session_id and session_id in self._sessions:
            return session_id, self._sessions[session_id]
        sess = ChatSession()
        self._sessions[sess.id] = sess
        return sess.id, sess

    def get(self, session_id: str) -> ChatSession | None:
        return self._sessions.get(session_id)

    async def reset(self, session_id: str) -> None:
        old = self._sessions.pop(session_id, None)
        if old:
            await old.close()

    async def close_all(self) -> None:
        for sid in list(self._sessions.keys()):
            await self.reset(sid)


def sse_json(obj: dict[str, Any]) -> str:
    return f"data: {json.dumps(obj, default=str)}\n\n"
