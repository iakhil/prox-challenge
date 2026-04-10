"""Load extracted manual text and run simple ranked search."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from backend.paths import data_dir, extracted_dir, repo_root


@dataclass
class PageRecord:
    doc_id: str
    page: int
    text: str


def _tokenize(q: str) -> list[str]:
    q = q.lower()
    return [t for t in re.split(r"[^\w]+", q) if len(t) > 1]


def load_all_pages() -> list[PageRecord]:
    records: list[PageRecord] = []
    base = extracted_dir()
    if not base.exists():
        return records
    for doc_dir in sorted(base.iterdir()):
        if not doc_dir.is_dir():
            continue
        doc_id = doc_dir.name
        for txt in sorted(doc_dir.glob("page_*.txt")):
            m = re.match(r"page_(\d+)\.txt$", txt.name)
            if not m:
                continue
            page = int(m.group(1))
            text = txt.read_text(encoding="utf-8", errors="replace")
            records.append(PageRecord(doc_id=doc_id, page=page, text=text))
    return records


def load_doc_meta() -> list[dict]:
    out: list[dict] = []
    d = data_dir()
    if not d.exists():
        return out
    for p in sorted(d.glob("*.meta.json")):
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError):
            continue
    return out


def search_pages(query: str, limit: int = 12) -> list[dict]:
    """Rank pages by term overlap + phrase bonus."""
    terms = _tokenize(query)
    if not terms:
        return []

    results: list[tuple[float, PageRecord]] = []
    q_lower = query.lower()

    for rec in load_all_pages():
        hay = rec.text.lower()
        score = 0.0
        for t in terms:
            if t in hay:
                score += hay.count(t) * 2.0 + 1.0
        if q_lower in hay:
            score += 15.0
        if score > 0:
            results.append((score, rec))

    results.sort(key=lambda x: -x[0])
    out: list[dict] = []
    for score, rec in results[:limit]:
        snippet = rec.text.strip().replace("\n", " ")
        if len(snippet) > 400:
            snippet = snippet[:400] + "…"
        out.append(
            {
                "doc_id": rec.doc_id,
                "page": rec.page,
                "score": round(score, 2),
                "snippet": snippet,
            }
        )
    return out


def read_page_text(doc_id: str, page: int) -> str | None:
    path = extracted_dir() / doc_id / f"page_{page}.txt"
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8", errors="replace")


def page_png_relative(doc_id: str, page: int) -> str | None:
    path = repo_root() / "data" / "pages" / doc_id / f"{page}.png"
    if path.is_file():
        return f"data/pages/{doc_id}/{page}.png"
    return None
