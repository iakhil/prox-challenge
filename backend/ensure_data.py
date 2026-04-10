"""Ensure extracted manual data exists (run extraction once if missing)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from backend.paths import extracted_dir, files_dir, repo_root


def needs_extraction() -> bool:
    if not files_dir().exists() or not list(files_dir().glob("*.pdf")):
        return False
    ext = extracted_dir()
    if not ext.exists() or not any(ext.iterdir()):
        return True
    # If any doc dir is empty, re-run
    for sub in ext.iterdir():
        if sub.is_dir() and not any(sub.glob("page_*.txt")):
            return True
    return False


def run_extraction() -> None:
    script = repo_root() / "scripts" / "extract_manuals.py"
    subprocess.run(
        [sys.executable, str(script)],
        cwd=str(repo_root()),
        check=True,
    )
