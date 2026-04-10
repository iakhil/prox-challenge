"""Repository and data paths."""

from pathlib import Path


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def files_dir() -> Path:
    return repo_root() / "files"


def data_dir() -> Path:
    return repo_root() / "data"


def extracted_dir() -> Path:
    return data_dir() / "extracted"


def pages_dir() -> Path:
    return data_dir() / "pages"
