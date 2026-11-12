"""Test setup for the fallback layer.

Adds the converter root to ``sys.path`` so ``import fallback`` works no matter
how pytest is invoked, and keeps every artifact in pytest's own temp dir
(``%TEMP%\\pytest-*``), never in the repository.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

CONVERTER_ROOT = Path(__file__).resolve().parents[2]  # .../converter
if str(CONVERTER_ROOT) not in sys.path:
    sys.path.insert(0, str(CONVERTER_ROOT))

CORPUS = CONVERTER_ROOT / "corpus" / "synthetic"

ASCII_LINES = [
    "SYNTHETIC FALLBACK DEMO PAGE",
    "ALPHA BRAVO CHARLIE DELTA",
    "ECHO FOXTROT GOLF HOTEL",
    "INDIA JULIET KILO LIMA",
]
THREE_PAGE_LINES = ["PAGE ONE ALPHA BRAVO",
                    "PAGE TWO CHARLIE DELTA",
                    "PAGE THREE ECHO FOXTROT"]


def _build_pdf(path: Path, lines_per_page: list[list[str]], **save_kwargs) -> Path:
    import fitz

    doc = fitz.open()
    for lines in lines_per_page:
        page = doc.new_page(width=595, height=842)  # A4 in points
        for index, line in enumerate(lines):
            page.insert_text((72, 100 + index * 28), line, fontsize=16)
    doc.save(str(path), **save_kwargs)
    doc.close()
    return path


@pytest.fixture()
def ascii_pdf(tmp_path) -> tuple[Path, str]:
    """One A4 page with invented ASCII text. Returns (path, text)."""
    path = _build_pdf(tmp_path / "synthetic-ascii.pdf", [ASCII_LINES])
    return path, "\n".join(ASCII_LINES)


@pytest.fixture()
def three_page_pdf(tmp_path) -> Path:
    return _build_pdf(tmp_path / "synthetic-three.pdf", [[line] for line in THREE_PAGE_LINES])


@pytest.fixture()
def encrypted_pdf(tmp_path) -> Path:
    import fitz

    return _build_pdf(tmp_path / "synthetic-encrypted.pdf", [["SECRET"]],
                      encryption=fitz.PDF_ENCRYPT_AES_256,
                      owner_pw="owner-pw", user_pw="user-pw")


@pytest.fixture()
def png_file(tmp_path) -> Path:
    """A real PNG produced by the renderer (72 dpi keeps it small)."""
    from fallback import page_image

    pdf = _build_pdf(tmp_path / "png-source.pdf", [ASCII_LINES])
    record = page_image.render_page(pdf, 1, dpi=72, out_dir=tmp_path / "render")
    return Path(record["png_path"])
