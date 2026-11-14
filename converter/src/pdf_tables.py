"""PDF tables: a structured view of the native text layer (top-level ``tables``).

What this module does
---------------------
For each PDF page that carries vector line graphics, ask PyMuPDF's
``page.find_tables()`` (``lines`` strategy: tables need ruling lines) and copy the
detected grid out **as data**: page, bbox, row/column counts, external-header
flag and the cell matrix exactly as extracted. The cells are text that is
**already** in the page's native text layer; this module never adds, guesses,
merges or re-reads a character.

Why a top-level ``tables`` field, not blocks
-------------------------------------------
``DocumentContent`` has a frozen block contract: ``kind`` is a closed whitelist
(``paragraph`` / ``link`` / ``heading``), and the fidelity identity is
``native == native_text blocks + declared removals`` per page (doc 11 A2).
Putting table text into blocks would either

* duplicate characters that the native paragraph blocks already contain —
  breaking the per-page ``Counter`` identity, or
* require a new block ``kind`` — widening a whitelist other readers/tests rely on.

So ``tables`` is a *view* of the same native text: ``text`` / ``blocks`` stay
byte-identical to a read without table extraction, and the table text is **not**
repeated into the body. Consumers that do not know the field can ignore it.

Honesty rules (fail-closed)
---------------------------
* No vector graphics -> no ``find_tables`` call at all: the ``lines`` strategy
  cannot see a table without ruling lines, and scanning every page of the corpus
  would only cost time. Absence of a call is not evidence of no table.
* Any detection/extraction error is caught **per page**: that page contributes
  no table records and one human-readable ``notes`` entry with the page number
  and exception type. ``read_pdf`` must never fail because of table extraction.
* Nothing is fabricated: no table is emitted unless PyMuPDF returned it; empty
  cells stay ``""`` (no neighbour filling), rows are not dropped, no header row
  is synthesised.
* A page whose native text layer was already replaced by the page-level OCR
  recovery path (``pdf_text_recovered_by_ocr``) is skipped by the caller: its
  characters are machine-recognised, and cells would then pretend to be
  ``native_text``. The page number is recorded in ``meta.tables.skipped_ocr_pages``.

stdout must stay clean
----------------------
On the first ``find_tables`` call in a process PyMuPDF 1.28.0 prints
``"Consider using the pymupdf_layout package ..."`` to **stdout** from Python
(``pymupdf._warn_layout_once``). ``src.reader_worker`` writes its single JSON
result to stdout, so a leaked line makes the parent's ``json.loads`` fail and
turns the read into ``reader_failed``. Every PyMuPDF call in this module
therefore runs inside ``contextlib.redirect_stdout``; nothing here may print.

License note (unchanged)
------------------------
This uses the same PyMuPDF backend the reader already uses. PyMuPDF is
AGPL-3.0 (or Artifex commercial); the product-level license decision (D-113,
PDF backend licensing) is still open and this module introduces **no new
third-party dependency**.
"""
from __future__ import annotations

import contextlib
import io

#: Provenance string for every emitted table. The cells come from the page's
#: native text layer, never from OCR / vision / an agent retype.
SOURCE = "pymupdf.find_tables"


# ============================ fail-closed helpers ============================
def _note(page_number: int, what: str, exc: BaseException, consequence: str) -> str:
    """One honest note line: which page, what failed, why, what was not emitted."""
    return f"page {page_number}: {what} ({type(exc).__name__}: {exc}); {consequence}"


def _find_tables(page):
    """Test seam: call PyMuPDF's ``find_tables`` with its stdout hint silenced.

    ``page.find_tables()`` is the public Page method; the hint is printed by
    ``pymupdf._warn_layout_once()`` on the first call in the process. Wrapping the
    call (not the module import) keeps the work lazy and makes the silencing a
    property of the only place we touch the API.
    """
    with contextlib.redirect_stdout(io.StringIO()):
        return page.find_tables()


def _extract_cells(table) -> list[list[str]]:
    """Cell matrix exactly as extracted; only ``None`` is written as ``""``."""
    with contextlib.redirect_stdout(io.StringIO()):
        raw_rows = table.extract()
    rows: list[list[str]] = []
    for raw_row in raw_rows or []:
        cells: list[str] = []
        for value in raw_row or []:
            if value is None:
                cells.append("")           # 空单元格就是空字符串，不从邻居补
            elif isinstance(value, str):
                cells.append(value)        # 抽取原样：不去空格、不合并、不改写
            else:
                cells.append(str(value))   # 非 str 只在异常实现下出现，保持可 JSON 序列化
        rows.append(cells)
    return rows


def _table_bbox(table, page_number: int) -> list[float]:
    raw = getattr(table, "bbox", None)
    if raw is None:
        raise ValueError(f"page {page_number}: detected table has no bbox")
    try:
        bbox = [float(value) for value in raw]
    except (TypeError, ValueError) as exc:
        raise ValueError(f"page {page_number}: table bbox is not four numbers: {raw!r}") from exc
    if len(bbox) != 4:
        raise ValueError(f"page {page_number}: table bbox is not four numbers: {raw!r}")
    return bbox


def _row_count(table, cells: list[list[str]]) -> int:
    value = getattr(table, "row_count", None)
    return value if isinstance(value, int) and value >= 0 else len(cells)


def _col_count(table, cells: list[list[str]]) -> int:
    value = getattr(table, "col_count", None)
    return value if isinstance(value, int) and value >= 0 else max(
        (len(row) for row in cells), default=0)


def _header_external(table) -> bool:
    """PyMuPDF's own flag: the detected header row lies outside the table body.

    Recorded as-is (never re-inferred). Missing/odd implementations fall back to
    ``False`` ("no external header declared") rather than inventing one.
    """
    try:
        return bool(getattr(getattr(table, "header", None), "external", False))
    except Exception:  # noqa: BLE001 —— 头标记拿不到只是少一个证据，不是读取失败
        return False


def _table_record(table, page_number: int) -> dict:
    """One JSON-safe record; raises if the table object is unusable (caller notes it)."""
    cells = _extract_cells(table)
    bbox = _table_bbox(table, page_number)
    return {
        "page": int(page_number),
        "bbox": bbox,
        "row_count": int(_row_count(table, cells)),
        "col_count": int(_col_count(table, cells)),
        "header_external": _header_external(table),
        "cells": cells,
        "provenance": "native_text",
        "source": SOURCE,
    }


def extract_page_tables(page, page_number: int, *, has_vector_graphics: bool
                        ) -> tuple[list[dict], list[str]]:
    """Extract the tables of one page: ``(records, notes)``, never raises.

    ``has_vector_graphics`` is the caller's measurement of
    ``page.get_drawings()`` truthiness (computed once per page by the reader).
    Pages without any vector graphic are not scanned: the ``lines`` strategy
    only finds tables drawn with ruling lines, and scanning them would cost time
    on every page of every document without being able to find a table.

    A failure is confined to its page: the page returns no records plus one
    note line, and the rest of the document is unaffected.
    """
    notes: list[str] = []
    if not has_vector_graphics:
        return [], notes
    try:
        finder = _find_tables(page)
        found = list(getattr(finder, "tables", None) or [])
    except Exception as exc:  # noqa: BLE001 —— 表格抽取绝不能让读取失败
        notes.append(_note(page_number, "table detection failed", exc,
                           "no table was emitted for that page"))
        return [], notes
    records: list[dict] = []
    for index, table in enumerate(found, 1):
        try:
            records.append(_table_record(table, page_number))
        except Exception as exc:  # noqa: BLE001 —— 单张表坏掉不牵连同页其它表
            notes.append(_note(page_number, f"table {index} could not be read", exc,
                               "that table was not emitted"))
    return records, notes


def summary(records: list[dict], notes: list[str], skipped_ocr_pages: list[int]) -> dict:
    """``meta.tables``: counts and declared decisions, in the frozen contract shape."""
    return {
        "count": len(records),
        "pages": sorted({int(record["page"]) for record in records}),
        "source": SOURCE,
        "skipped_ocr_pages": sorted({int(page) for page in skipped_ocr_pages}),
        "notes": [str(note) for note in notes],
    }
