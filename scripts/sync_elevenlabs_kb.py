#!/usr/bin/env python3
"""Upload PDF manuals from files/ to the ElevenLabs ConvAI knowledge base via API.

Requires ELEVENLABS_API_KEY in the environment (load from repo-root .env).

After upload, attach the new documents to your ConvAI agent in the ElevenLabs dashboard
(Agent → Knowledge base). Re-uploads create additional documents; remove old copies in
the dashboard if you need a clean slate.

Usage:
  uv run python scripts/sync_elevenlabs_kb.py
  uv run python scripts/sync_elevenlabs_kb.py --dry-run
  uv run python scripts/sync_elevenlabs_kb.py files/owner-manual.pdf
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

_REPO_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(_REPO_ROOT / ".env")


def _default_pdf_paths() -> list[Path]:
    files_dir = _REPO_ROOT / "files"
    if not files_dir.is_dir():
        return []
    return sorted(files_dir.glob("*.pdf"))


def upload_file(
    client: httpx.Client,
    api_base: str,
    api_key: str,
    pdf: Path,
    name: str | None,
) -> dict:
    url = f"{api_base.rstrip('/')}/v1/convai/knowledge-base/file"
    display_name = name or pdf.stem.replace("-", " ").title()
    with pdf.open("rb") as f:
        files = {"file": (pdf.name, f, "application/pdf")}
        data = {"name": display_name}
        r = client.post(url, headers={"xi-api-key": api_key}, files=files, data=data, timeout=120.0)
    r.raise_for_status()
    return r.json()


def main() -> int:
    parser = argparse.ArgumentParser(description="Upload manuals to ElevenLabs knowledge base")
    parser.add_argument(
        "paths",
        nargs="*",
        type=Path,
        help="PDF files to upload (default: all files/*.pdf)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print actions without calling the API")
    args = parser.parse_args()

    import os

    api_key = (os.environ.get("ELEVENLABS_API_KEY") or "").strip()
    if not api_key and not args.dry_run:
        print("Set ELEVENLABS_API_KEY in .env (or the environment).", file=sys.stderr)
        return 1

    api_base = (os.environ.get("ELEVENLABS_API_BASE") or "https://api.elevenlabs.io").rstrip("/")

    paths = [p.resolve() for p in args.paths] if args.paths else _default_pdf_paths()
    paths = [p for p in paths if p.suffix.lower() == ".pdf"]
    if not paths:
        print("No PDF files found. Add manuals under files/*.pdf or pass paths on the command line.", file=sys.stderr)
        return 1

    for p in paths:
        if not p.is_file():
            print(f"Missing file: {p}", file=sys.stderr)
            return 1

    if args.dry_run:
        print("Dry run — would upload:")
        for p in paths:
            print(f"  {p}")
        return 0

    print(f"Uploading {len(paths)} file(s) to {api_base}/v1/convai/knowledge-base/file ...")
    with httpx.Client() as client:
        for p in paths:
            try:
                out = upload_file(client, api_base, api_key, p, name=None)
                doc_id = out.get("id", "?")
                doc_name = out.get("name", "?")
                print(f"  OK  {p.name} → id={doc_id!r} name={doc_name!r}")
            except httpx.HTTPStatusError as e:
                detail = e.response.text[:400] if e.response else str(e)
                print(f"  FAIL {p.name}: HTTP {e.response.status_code if e.response else '?'} {detail}", file=sys.stderr)
                return 1
            except httpx.RequestError as e:
                print(f"  FAIL {p.name}: {e}", file=sys.stderr)
                return 1

    print("\nNext: ElevenLabs dashboard → your ConvAI agent → Knowledge base → attach these documents.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
