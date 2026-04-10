#!/usr/bin/env python3
"""Extract per-page text and PNG renders from PDFs in files/."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import fitz  # PyMuPDF

# Allow running as script without package install
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from backend.paths import data_dir, extracted_dir, files_dir, pages_dir, repo_root


def doc_id_from_pdf(path: Path) -> str:
    return path.stem


def extract_one(pdf_path: Path, dpi: int = 150) -> dict:
    doc_id = doc_id_from_pdf(pdf_path)
    out_text = extracted_dir() / doc_id
    out_pages = pages_dir() / doc_id
    out_text.mkdir(parents=True, exist_ok=True)
    out_pages.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(pdf_path)
    index: list[dict] = []
    zoom = dpi / 72
    mat = fitz.Matrix(zoom, zoom)

    for i in range(len(doc)):
        page_num = i + 1
        page = doc[i]
        text = page.get_text("text") or ""
        tpath = out_text / f"page_{page_num}.txt"
        tpath.write_text(text, encoding="utf-8")

        pix = page.get_pixmap(matrix=mat, alpha=False)
        png_path = out_pages / f"{page_num}.png"
        pix.save(png_path.as_posix())

        index.append(
            {
                "doc_id": doc_id,
                "page": page_num,
                "text_file": str(tpath.relative_to(repo_root())),
                "png_file": str(png_path.relative_to(repo_root())),
                "preview": text[:500].replace("\n", " ").strip(),
            }
        )

    doc.close()
    meta = {
        "doc_id": doc_id,
        "source_pdf": str(pdf_path.relative_to(repo_root())),
        "page_count": len(index),
        "pages": index,
    }
    meta_path = data_dir() / f"{doc_id}.meta.json"
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract manuals to data/")
    parser.add_argument(
        "--dpi",
        type=int,
        default=150,
        help="Rasterization DPI for page PNGs",
    )
    args = parser.parse_args()

    pdfs = sorted(files_dir().glob("*.pdf"))
    if not pdfs:
        print(f"No PDFs in {files_dir()}", file=sys.stderr)
        sys.exit(1)

    data_dir().mkdir(parents=True, exist_ok=True)
    for pdf in pdfs:
        print(f"Extracting {pdf.name}...")
        meta = extract_one(pdf, dpi=args.dpi)
        print(f"  -> {meta['page_count']} pages")

    print("Done.")


if __name__ == "__main__":
    main()
