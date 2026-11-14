"""PDF table extraction (doc1-B): top-level ``tables`` as a view of native text.

Every PDF here is **synthetic** and written to ``tmp_path``; no real resume is
read. The grid geometry matches the explicitly verified PyMuPDF 1.28.0 scene
(outer box 60,100,480,190; 3 rows x 3 columns; empty cells extract as ``""``).

Contract under test (shape frozen by the task book; the TS contract is not
touched here):

* top-level ``tables``: list of ``{page, bbox, row_count, col_count,
  header_external, cells, provenance, source}``
* ``meta.tables``: ``{count, pages, source, skipped_ocr_pages, notes}``
* ``meta.page_info[].tables``: number of tables on that page
* no table text is duplicated into ``blocks``/``text`` and no new block ``kind``
  appears (the native-text fidelity identity must keep holding).
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import re
import subprocess
import sys

import fitz
import pymupdf
import pytest

from conftest import ROOT, build_pdf, page_identity
from src import content, pdf_reader, pdf_tables

# 与 Owner 复核现场完全一致的 3x3 网格（外框坐标 + 单元格文本）。
GRID_BOX = (60.0, 100.0, 480.0, 190.0)
GRID_CELLS = [["姓名", "岗位", "年限"], ["张三", "", "5 年"], ["李四", "后端", "3 年"]]

TABLE_KEYS = {"page", "bbox", "row_count", "col_count", "header_external",
              "cells", "provenance", "source"}
META_KEYS = {"count", "pages", "source", "skipped_ocr_pages", "notes"}


def make_grid_pdf(path, cells=None, box=GRID_BOX):
    """Draw a ruled grid with text inside the cells (synthetic, CJK-safe)."""
    cells = GRID_CELLS if cells is None else cells
    x0, y0, x1, y1 = box
    rows = len(cells)
    cols = max(len(row) for row in cells)
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    shape = page.new_shape()
    for r in range(rows + 1):
        y = y0 + r * (y1 - y0) / rows
        shape.draw_line((x0, y), (x1, y))
    for c in range(cols + 1):
        x = x0 + c * (x1 - x0) / cols
        shape.draw_line((x, y0), (x, y1))
    shape.finish(color=(0, 0, 0), width=0.7)
    shape.commit()
    cell_w = (x1 - x0) / cols
    cell_h = (y1 - y0) / rows
    for r, row in enumerate(cells):
        for c, text in enumerate(row):
            if text:
                page.insert_text((x0 + c * cell_w + 8, y0 + r * cell_h + cell_h * 0.62),
                                 text, fontsize=11, fontname="china-s")
    doc.save(str(path))
    doc.close()
    return path


def _by_page(result, number):
    return [t for t in result["tables"] if t["page"] == number]


# ---------------------------------------------------------------- 1) 正例
def test_table_extracted_from_native_ruled_lines(tmp_path):
    """A ruled 3x3 grid is reported once: page/bbox/cells/row-col counts exact."""
    path = make_grid_pdf(tmp_path / "grid.pdf")
    result = pdf_reader.read_pdf(path)

    tables = result["tables"]
    assert isinstance(tables, list) and len(tables) == 1, tables
    table = tables[0]
    assert set(table) == TABLE_KEYS, sorted(table)
    assert table["page"] == 1
    assert (table["row_count"], table["col_count"]) == (3, 3)
    assert table["provenance"] == "native_text"
    assert table["source"] == "pymupdf.find_tables"
    assert isinstance(table["header_external"], bool)
    assert len(table["bbox"]) == 4 and all(isinstance(v, float) for v in table["bbox"])
    for got, want in zip(table["bbox"], GRID_BOX):
        assert abs(got - want) <= 1.0, (table["bbox"], want)  # 容差 1pt
    # cells 与原文逐字一致（空格也是原文的一部分），空单元格是 ""
    assert table["cells"] == GRID_CELLS, table["cells"]
    assert all(isinstance(value, str) for row in table["cells"] for value in row)

    meta = result["meta"]["tables"]
    assert set(meta) == META_KEYS, sorted(meta)
    assert meta["count"] == 1 and meta["pages"] == [1]
    assert meta["source"] == "pymupdf.find_tables"
    assert meta["skipped_ocr_pages"] == [] and meta["notes"] == []
    assert result["meta"]["page_info"][0]["tables"] == 1

    # 表格不进 blocks、不加 kind：正文的 kind 白名单原样成立
    assert result["blocks"], "native body must not be emptied by table extraction"
    assert {b["kind"] for b in result["blocks"]} <= {"paragraph", "link", "heading"}


# ---------------------------------------------------------------- 2) 无表负例
def test_pure_text_pdf_reports_no_table(tmp_path, monkeypatch):
    """No ruling lines -> find_tables is never called and nothing is invented."""
    path = build_pdf(tmp_path / "text_only.pdf", [
        (60, 100, "张三", 14),
        (60, 140, "后端工程师", 11),
        (60, 170, "五年以上分布式系统经验", 11),
    ])
    calls = []

    def fake_find_tables(page):
        calls.append(page.number)
        raise AssertionError("find_tables must not be called without vector graphics")

    monkeypatch.setattr(pdf_tables, "_find_tables", fake_find_tables)
    first = pdf_reader.read_pdf(path)
    second = pdf_reader.read_pdf(path)

    for result in (first, second):
        assert result["meta"]["page_info"][0]["drawings"] == 0
        assert result["tables"] == []
        meta = result["meta"]["tables"]
        assert meta["count"] == 0 and meta["pages"] == []
        assert meta["skipped_ocr_pages"] == [] and meta["notes"] == []
        assert result["meta"]["page_info"][0]["tables"] == 0
        assert result["blocks"], "body text must survive"
    assert calls == [], calls
    # 连续读两次：表格结论一致（确定性，无抖动）
    assert first["tables"] == second["tables"]
    assert first["meta"]["tables"] == second["meta"]["tables"]


# ---------------------------------------------------------------- 3) 空单元格
def test_empty_cell_is_empty_and_not_filled_from_neighbours(tmp_path):
    """An empty cell stays ""; no neighbour text is copied into it, no row dropped."""
    cells = [["甲", "乙"], ["", "丁"]]
    path = make_grid_pdf(tmp_path / "two_by_two.pdf", cells=cells, box=(60.0, 100.0, 260.0, 180.0))
    result = pdf_reader.read_pdf(path)

    tables = result["tables"]
    assert len(tables) == 1, (tables, result["meta"]["tables"])
    table = tables[0]
    assert (table["row_count"], table["col_count"]) == (2, 2)
    assert table["cells"] == cells, table["cells"]
    assert table["cells"][1][0] == ""
    assert "甲" not in table["cells"][1][0] and "丁" not in table["cells"][1][0]


# ---------------------------------------------------------------- 4) 失败 fail-closed
def test_detection_exception_is_fail_closed(tmp_path, monkeypatch):
    """A raising detector yields no table, one note with page+type, and a normal read."""
    path = make_grid_pdf(tmp_path / "grid.pdf")
    baseline = pdf_reader.read_pdf(path)
    assert baseline["meta"]["tables"]["count"] == 1  # 先证明这页确实有表

    def boom(page):
        raise RuntimeError("synthetic detector failure")

    monkeypatch.setattr(pdf_tables, "_find_tables", boom)
    result = pdf_reader.read_pdf(path)

    assert result["tables"] == [], result["tables"]
    assert result["meta"]["tables"]["count"] == 0
    assert result["meta"]["tables"]["pages"] == []
    assert result["meta"]["page_info"][0]["tables"] == 0
    notes = result["meta"]["tables"]["notes"]
    assert len(notes) == 1, notes
    assert "page 1" in notes[0]
    assert "RuntimeError" in notes[0]
    assert "synthetic detector failure" in notes[0]
    # 正文与读取结论不受影响（fail-closed 只丢表格，不丢正文）
    assert [b["text"] for b in result["blocks"]] == [b["text"] for b in baseline["blocks"]]
    assert result["completeness"] == baseline["completeness"]
    assert [i["code"] for i in result["issues"]] == [i["code"] for i in baseline["issues"]]


def test_hook_crash_never_fails_the_read(tmp_path, monkeypatch):
    """Even a buggy hook must not turn a readable PDF into a failed read."""

    def explode(*args, **kwargs):
        raise ValueError("hook bug")

    path = make_grid_pdf(tmp_path / "grid.pdf")
    monkeypatch.setattr(pdf_tables, "extract_page_tables", explode)
    result = pdf_reader.read_pdf(path)

    assert result["blocks"], "body must still be read"
    assert result["tables"] == []
    assert result["meta"]["tables"]["count"] == 0
    notes = result["meta"]["tables"]["notes"]
    assert len(notes) == 1 and "page 1" in notes[0] and "ValueError" in notes[0], notes
    assert "hook bug" in notes[0]


def test_unreadable_drawings_skips_scan_with_note(tmp_path, monkeypatch):
    """If vector graphics cannot even be counted, the scan is skipped and said so."""
    path = make_grid_pdf(tmp_path / "grid.pdf")
    baseline = pdf_reader.read_pdf(path)
    assert baseline["meta"]["tables"]["count"] == 1  # 先证明这页确实有表

    def broken(self):
        raise RuntimeError("synthetic drawings failure")

    monkeypatch.setattr(fitz.Page, "get_drawings", broken)
    result = pdf_reader.read_pdf(path)

    assert result["blocks"], "body must survive"
    assert result["tables"] == []
    assert result["meta"]["tables"]["count"] == 0
    assert result["meta"]["page_info"][0]["drawings"] == 0
    notes = result["meta"]["tables"]["notes"]
    assert len(notes) == 1, notes
    assert "page 1" in notes[0] and "RuntimeError" in notes[0], notes
    assert "synthetic drawings failure" in notes[0]


def test_table_hook_is_purely_additive(tmp_path, monkeypatch):
    """With the hook disabled, every other field is identical: tables only add data."""
    path = make_grid_pdf(tmp_path / "grid.pdf")
    with_tables = pdf_reader.read_pdf(path)
    assert with_tables["tables"], "precondition: this PDF has a table"

    monkeypatch.setattr(pdf_tables, "extract_page_tables", lambda *args, **kwargs: ([], []))
    without_tables = pdf_reader.read_pdf(path)
    assert without_tables["tables"] == []

    def strip_tables(result):
        clone = json.loads(json.dumps(result, ensure_ascii=False))
        clone.pop("tables", None)
        clone["meta"] = {key: value for key, value in clone["meta"].items()
                         if key != "tables"}
        for info in clone["meta"]["page_info"]:
            info.pop("tables", None)
        return clone

    assert strip_tables(with_tables) == strip_tables(without_tables)


# ---------------------------------------------------------------- 5) stdout 纯净
def test_find_tables_layout_hint_is_silenced(tmp_path, monkeypatch):
    """PyMuPDF's first-call hint must be swallowed, not left on stdout.

    PyMuPDF 1.28.0 prints "Consider using the pymupdf_layout package ..." to
    stdout on the first ``find_tables`` call of a process. The reader worker's
    stdout is its single JSON, so the module must silence it. The control below
    proves the hint still fires in this environment; forcing the global switch
    makes the assertion independent of test order.
    """
    path = make_grid_pdf(tmp_path / "grid.pdf")
    control = io.StringIO()
    monkeypatch.setattr(pymupdf, "_recommend_layout", True)
    with contextlib.redirect_stdout(control):
        pymupdf._warn_layout_once()
    if "pymupdf_layout" not in control.getvalue():
        pytest.skip("pymupdf_layout installed / hint disabled here: silencing path unexercisable")

    with fitz.open(str(path)) as doc:
        page = doc[0]
        monkeypatch.setattr(pymupdf, "_recommend_layout", True)
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            records, notes = pdf_tables.extract_page_tables(page, 1, has_vector_graphics=True)
        assert len(records) == 1, notes
        assert buffer.getvalue() == "", repr(buffer.getvalue())
        # hint 真的在本次调用里执行过（switch 被消耗）——空 stdout 不是"没发生"的假证据
        assert pymupdf._recommend_layout is False


def test_cli_and_worker_stdout_is_pure_json(tmp_path):
    """End to end: the reader worker's stdout stays exactly one JSON document."""
    path = make_grid_pdf(tmp_path / "grid.pdf")
    out = tmp_path / "out.json"
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONPATH=str(ROOT))

    proc = subprocess.run(
        [sys.executable, "-m", "src.cli", str(path), "--output", str(out), "--timeout", "60"],
        cwd=str(ROOT), capture_output=True, env=env, timeout=300)
    assert proc.returncode == 0, proc.stderr[-800:]
    assert not proc.stdout.strip(), proc.stdout[:300]
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["meta"]["tables"]["count"] == 1, payload["meta"]["tables"]
    assert len(payload["tables"]) == 1
    assert payload["tables"][0]["page"] == 1

    # 最直接的证据：worker 的 stdout 必须整体可 json.loads（hint 漏出即失败）
    runs = []
    for _ in range(2):
        worker = subprocess.run([sys.executable, "-m", "src.reader_worker", str(path)],
                                cwd=str(ROOT), capture_output=True, env=env, timeout=300)
        assert worker.returncode == 0, worker.stderr[-800:]
        runs.append(worker.stdout)
    raw = runs[0].decode("utf-8")
    assert raw.lstrip().startswith("{"), raw[:200]
    decoded = json.loads(raw)
    assert decoded["meta"]["tables"]["count"] == 1
    assert decoded["tables"][0]["row_count"] == 3
    assert decoded["tables"][0]["cells"] == GRID_CELLS
    # 确定性：两个独立进程的 JSON 逐字节一致（表格字段没有时间戳/随机顺序）
    assert runs[0] == runs[1]


# ---------------------------------------------------------------- 6) 正文保真不回归
def test_body_fidelity_is_unchanged_and_not_duplicated(tmp_path):
    """Table text stays in the native paragraph blocks exactly once (Counter identity)."""
    path = make_grid_pdf(tmp_path / "grid.pdf")
    result = pdf_reader.read_pdf(path)
    checks = page_identity(result, path)
    assert len(checks) == 1, checks
    check = checks[0]
    assert check["applicable"] is True, check
    assert check["equal"] is True, check
    assert check["native_chars"] > 0, check

    body = re.sub(r"\s", "", result["text"])
    for row in GRID_CELLS:
        for cell in row:
            if not cell:
                continue
            assert re.sub(r"\s", "", cell) in body, cell
    # 表格是同一批原生字符的结构化视图：正文里不许再出现第二遍
    for cell in ("姓名", "张三", "李四", "后端", "5年"):
        assert body.count(cell) == 1, (cell, body.count(cell))


# ---------------------------------------------------------------- 7) OCR 重读页不冒充 native
def test_ocr_recovered_page_is_not_mined_for_tables(tmp_path, monkeypatch):
    """A page re-read by OCR has no native cells: no table, page recorded as skipped."""
    base = make_grid_pdf(tmp_path / "grid_base.pdf")
    path = tmp_path / "ocr_grid.pdf"
    # (cid:N) 是 reader 自己的"解不出字形"判据（不是测试伪造的代码路径）：
    # 原生文本层含它 -> 走整页 OCR 兜底分支。
    with fitz.open(str(base)) as doc:
        doc[0].insert_text((60.0, 300.0), "坏字形 (cid:12) 标记", fontsize=11,
                           fontname="china-s")
        doc.save(str(path))
    ocr_block = content.block("paragraph", "OCR 识别的整页正文",
                              {"page": 1, "bbox": [40.0, 40.0, 500.0, 800.0]})
    ocr_block["provenance"] = "ocr"
    monkeypatch.setattr(pdf_reader, "_ocr_page_blocks",
                        lambda doc_path, pages: ([ocr_block], ""))

    result = pdf_reader.read_pdf(path)
    codes = [i["code"] for i in result["issues"]]
    assert "pdf_text_recovered_by_ocr" in codes, codes
    assert result["tables"] == [], result["tables"]
    meta = result["meta"]["tables"]
    assert meta["count"] == 0 and meta["skipped_ocr_pages"] == [1]
    assert result["meta"]["page_info"][0]["tables"] == 0
    # 该页正文块全部是 OCR provenance：没有任何原生文本可供"原生表格"使用
    assert {b["provenance"] for b in result["blocks"]} == {"ocr"}


# ---------------------------------------------------------------- 8) 逐页计数
def test_page_info_counts_tables_per_page(tmp_path):
    """meta.pages / page_info[].tables are per page, not a document-wide guess."""
    two_pages = tmp_path / "two_pages.pdf"
    doc = fitz.open()
    grid = fitz.open(str(make_grid_pdf(tmp_path / "grid_src.pdf")))
    doc.insert_pdf(grid)
    doc.new_page(width=595, height=842).insert_text(
        (60.0, 100.0), "第二页只有文字，没有表格线。", fontsize=12, fontname="china-s")
    doc.save(str(two_pages))
    grid.close()
    doc.close()

    result = pdf_reader.read_pdf(two_pages)
    assert result["meta"]["pages"] == 2
    assert result["meta"]["tables"]["pages"] == [1]
    assert result["meta"]["tables"]["count"] == 1
    assert [p["tables"] for p in result["meta"]["page_info"]] == [1, 0]
    assert _by_page(result, 1) and not _by_page(result, 2)
