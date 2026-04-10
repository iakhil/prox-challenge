"""In-process MCP tools for owner manual search and page images."""

from __future__ import annotations

import json
import os
from typing import Any

from claude_agent_sdk import ToolAnnotations, create_sdk_mcp_server, tool
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from backend.manual_index import load_doc_meta, page_png_relative, read_page_text, search_pages


def _image_url(doc_id: str, page: int) -> str:
    """Prefer relative `/api/...` so the Vite proxy and same-origin deploys work."""
    base = (os.environ.get("OMNIPRO_PUBLIC_BASE") or "").rstrip("/")
    path = f"/api/pages/{doc_id}/{page}.png"
    return f"{base}{path}" if base else path


def _tool_text(s: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": s}]}


_ro = ToolAnnotations(readOnlyHint=True, openWorldHint=False)


def _manual_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for meta in load_doc_meta():
        rows.append(
            {
                "doc_id": meta.get("doc_id"),
                "source": meta.get("source_pdf"),
                "page_count": meta.get("page_count"),
            }
        )
    return rows


def _search_hits(query: str, limit: int) -> list[dict[str, Any]]:
    return search_pages(query, limit=limit)


@tool(
    "list_manual_docs",
    "List Vulcan OmniPro 220 PDF manuals that were extracted (doc id, title, page count).",
    {},
    annotations=_ro,
)
async def list_manual_docs(_args: dict[str, Any]) -> dict[str, Any]:
    rows = _manual_rows()
    if not rows:
        return _tool_text(
            "No manuals found. Run `uv run python scripts/extract_manuals.py` once so data/ is populated."
        )
    return _tool_text(json.dumps({"manuals": rows}, indent=2))


@tool(
    "search_manual",
    "Search all extracted manual pages for keywords or phrases. Returns ranked snippets with doc_id and page numbers — use read_manual_page_text or get_manual_page_image next.",
    {"query": str, "limit": int},
    annotations=_ro,
)
async def search_manual(args: dict[str, Any]) -> dict[str, Any]:
    q = (args.get("query") or "").strip()
    limit = int(args.get("limit") or 12)
    limit = max(1, min(limit, 30))
    if not q:
        return _tool_text("Provide a non-empty query string.")
    hits = _search_hits(q, limit=limit)
    if not hits:
        return _tool_text(f"No matches for {q!r}. Try broader keywords or different terms.")
    return _tool_text(json.dumps({"query": q, "results": hits}, indent=2))


@tool(
    "read_manual_page_text",
    "Read the full extracted text of one manual page (use after search_manual).",
    {"doc_id": str, "page": int},
    annotations=_ro,
)
async def read_manual_page_text(args: dict[str, Any]) -> dict[str, Any]:
    doc_id = (args.get("doc_id") or "").strip()
    page = int(args.get("page") or 0)
    if not doc_id or page < 1:
        return _tool_text("Need doc_id and a positive page number.")
    text = read_page_text(doc_id, page)
    if text is None:
        return _tool_text(f"No extracted page {doc_id} page {page}.")
    header = f"--- {doc_id} page {page} ---\n\n"
    return _tool_text(header + text)


@tool(
    "get_manual_page_image",
    "Get a permanent URL to the rendered manual page PNG (diagrams, tables, photos). Show this image to the user for visual answers.",
    {"doc_id": str, "page": int},
    annotations=_ro,
)
async def get_manual_page_image(args: dict[str, Any]) -> dict[str, Any]:
    doc_id = (args.get("doc_id") or "").strip()
    page = int(args.get("page") or 0)
    if not doc_id or page < 1:
        return _tool_text("Need doc_id and a positive page number.")
    rel = page_png_relative(doc_id, page)
    if not rel:
        return _tool_text(f"No PNG for {doc_id} page {page}. Re-run extraction.")
    url = _image_url(doc_id, page)
    return _tool_text(
        json.dumps(
            {
                "doc_id": doc_id,
                "page": page,
                "image_url": url,
                "markdown_for_chat": f"![{doc_id} p.{page}]({url})",
            },
            indent=2,
        )
    )


# Remote MCP server for external integrations (e.g., ElevenLabs MCP integrations).
# We keep the same tool names/semantics as the in-process Claude SDK server.
manual_remote_mcp = FastMCP(
    name="manual-remote",
    instructions="Read-only manual search and page image lookup for the Vulcan OmniPro 220.",
    streamable_http_path="/",
    # This FastMCP instance is mounted under the main FastAPI app on Render.
    # FastMCP auto-enables DNS rebinding protection for localhost hosts, which
    # rejects non-local Host headers (e.g. <service>.onrender.com) with 421.
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)


@manual_remote_mcp.tool(
    name="list_manual_docs",
    description="List Vulcan OmniPro 220 PDF manuals that were extracted (doc id, title, page count).",
)
def remote_list_manual_docs() -> str:
    rows = _manual_rows()
    if not rows:
        return (
            "No manuals found. Run `uv run python scripts/extract_manuals.py` once so data/ is populated."
        )
    return json.dumps({"manuals": rows}, indent=2)


@manual_remote_mcp.tool(
    name="search_manual",
    description=(
        "Search all extracted manual pages for keywords or phrases. Returns ranked snippets with doc_id and page numbers."
    ),
)
def remote_search_manual(query: str, limit: int = 12) -> str:
    q = (query or "").strip()
    limit = max(1, min(int(limit or 12), 30))
    if not q:
        return "Provide a non-empty query string."
    hits = _search_hits(q, limit=limit)
    if not hits:
        return f"No matches for {q!r}. Try broader keywords or different terms."
    return json.dumps({"query": q, "results": hits}, indent=2)


@manual_remote_mcp.tool(
    name="read_manual_page_text",
    description="Read the full extracted text of one manual page (use after search_manual).",
)
def remote_read_manual_page_text(doc_id: str, page: int) -> str:
    doc_id = (doc_id or "").strip()
    page = int(page or 0)
    if not doc_id or page < 1:
        return "Need doc_id and a positive page number."
    text = read_page_text(doc_id, page)
    if text is None:
        return f"No extracted page {doc_id} page {page}."
    return f"--- {doc_id} page {page} ---\n\n{text}"


@manual_remote_mcp.tool(
    name="get_manual_page_image",
    description="Get a permanent URL to the rendered manual page PNG (diagrams, tables, photos).",
)
def remote_get_manual_page_image(doc_id: str, page: int) -> str:
    doc_id = (doc_id or "").strip()
    page = int(page or 0)
    if not doc_id or page < 1:
        return "Need doc_id and a positive page number."
    rel = page_png_relative(doc_id, page)
    if not rel:
        return f"No PNG for {doc_id} page {page}. Re-run extraction."
    url = _image_url(doc_id, page)
    return json.dumps(
        {
            "doc_id": doc_id,
            "page": page,
            "image_url": url,
            "markdown_for_chat": f"![{doc_id} p.{page}]({url})",
        },
        indent=2,
    )


manual_mcp_server = create_sdk_mcp_server(
    name="manual",
    version="1.0.0",
    tools=[list_manual_docs, search_manual, read_manual_page_text, get_manual_page_image],
)

MANUAL_TOOL_NAMES = [
    "mcp__manual__list_manual_docs",
    "mcp__manual__search_manual",
    "mcp__manual__read_manual_page_text",
    "mcp__manual__get_manual_page_image",
]
