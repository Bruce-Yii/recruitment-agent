"""Fidelity (doc 11 A1/A2/A5/A6, C1/C2) and traceability (D1, §9.9).

Items covered: 1 (page coverage + Counter), 2 (no invented URI), 3 (no bad glyphs
in body), 6 (idempotency), 12 (page+bbox+sha256), plus the contract shape.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from collections import Counter

import fitz
import pytest

from conftest import (MANIFEST, ROOT, all_evidence, field_states, hard_codes,
                      page_identity, sha256)
from src import content, pdf_reader

BAD_GLYPHS = re.compile(r"\ufffd|\(cid:\d+\)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def test_page_coverage(corpus_results):
    """A1: output page set == native page set; every page has a block or an issue.

    Encrypted carriers are exempt from the per-page rule (nothing is readable by
    design) but must still enumerate their pages and carry ``encrypted_pdf``.
    """
    problems = []
    for row, result in corpus_results:
        meta = result["meta"]
        if meta.get("pages") != row.get("pages") and row.get("pages") is not None:
            problems.append((row["id"], "pages", meta.get("pages"), row.get("pages")))
            continue
        info = {p["page"]: p for p in meta.get("page_info") or []}
        encrypted = any(i.get("code") == "encrypted_pdf" for i in result["issues"])
        for page_no in range(1, (meta.get("pages") or 0) + 1):
            if page_no not in info:
                problems.append((row["id"], "page_info missing", page_no, ""))
            if encrypted:
                continue
            has_block = any((b.get("location") or {}).get("page") == page_no
                            for b in result["blocks"])
            has_issue = any((i.get("location") or {}).get("page") == page_no
                            for i in result["issues"])
            if not (has_block or has_issue):
                problems.append((row["id"], "page", page_no, "neither block nor issue"))
    assert not problems, problems[:10]


def test_counter_identity(corpus_results):
    """A2: native == native blocks + declared removals, per page, all 84 files."""
    problems = []
    checked = 0
    for row, result in corpus_results:
        if result["meta"].get("failed") or (result["meta"].get("pages") or 0) == 0:
            continue
        if any(i.get("code") == "encrypted_pdf" for i in result["issues"]):
            continue  # 空密码打不开：没有可比对的原生文本
        for check in page_identity(result, row["path"]):
            checked += 1
            if not check["equal"]:
                problems.append((row["id"], check))
    assert checked > 150, f"only {checked} pages checked"
    assert not problems, problems[:10]


def test_no_invented_uri(real_results, synthetic_rows):
    """A5: every real URI appears; no URI appears that the PDF does not have."""
    problems = []
    for row, result in real_results:
        if (result["meta"].get("pages") or 0) == 0:
            continue
        try:
            with fitz.open(row["path"]) as doc:
                real = set()
                for page in doc:
                    for link in page.get_links():
                        if link.get("uri"):
                            real.add(link["uri"])
        except Exception:  # noqa: BLE001
            continue
        emitted = set()
        for block in result["blocks"]:
            for link in block.get("links") or []:
                emitted.add(link.get("href"))
        invented = emitted - real
        missing = real - emitted
        if invented or missing:
            problems.append((row["id"], "invented", sorted(invented)[:3],
                             "missing", sorted(missing)[:3]))
    assert not problems, problems[:5]


def test_no_bad_glyphs_in_body(corpus_results):
    """A6: undecodable glyph markers never survive into the body."""
    problems = []
    for row, result in corpus_results:
        hits = []
        for block in result["blocks"]:
            if block.get("provenance") != "native_text":
                continue
            m = BAD_GLYPHS.search(block.get("text") or "")
            if m:
                hits.append(m.group(0))
        m = BAD_GLYPHS.search(result.get("text") or "")
        if m:
            hits.append("top-level:" + m.group(0))
        if hits:
            problems.append((row["id"], hits[:3]))
    assert not problems, problems[:5]


def test_encoding_issue_recorded_when_glyphs_removed(corpus_results):
    """A6/B3: undecodable glyphs are removed, declared, and reported.

    A NUL is format noise (the reference's ``content.normalize`` replaces it with a
    space), so it is removed and declared but does not by itself make a page
    unreadable.  U+FFFD / ``(cid:N)`` / other control characters must raise
    ``pdf_text_encoding_unread``.
    """
    undecodable = re.compile(r"\ufffd|\(cid:\d+\)|[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]")
    problems = []
    for row, result in corpus_results:
        removed = "".join(p.get("encoding_removed") or ""
                          for p in result["meta"].get("page_info") or [])
        has_issue = any(i.get("code") == "pdf_text_encoding_unread"
                        for i in result["issues"])
        if undecodable.search(removed) and not has_issue:
            problems.append((row["id"], "undecodable removed without issue"))
        if has_issue and not undecodable.search(removed):
            problems.append((row["id"], "issue without undecodable removal"))
    assert not problems, problems[:5]


def test_block_shape_and_provenance(corpus_results):
    """Contract §2 + D2: every block has kind/text/location/links/provenance."""
    problems = []
    allowed = {"paragraph", "link", "heading"}
    for row, result in corpus_results:
        for index, block in enumerate(result["blocks"]):
            if set(block) < {"kind", "text", "location", "links", "provenance"}:
                problems.append((row["id"], index, "missing keys", sorted(block)))
                continue
            if block["kind"] not in allowed:
                problems.append((row["id"], index, "kind", block["kind"]))
            if block["provenance"] not in {"native_text", "ocr_title", "agent_read"}:
                problems.append((row["id"], index, "provenance", block["provenance"]))
            bbox = block["location"].get("bbox")
            if not (isinstance(bbox, list) and len(bbox) == 4):
                problems.append((row["id"], index, "bbox", bbox))
            if not isinstance(block["location"].get("page"), int):
                problems.append((row["id"], index, "page", block["location"].get("page")))
    assert not problems, problems[:10]


def test_completeness_downgrade(corpus_results):
    """Contract §1: any issue or needs_visual forces completeness=partial."""
    problems = []
    for row, result in corpus_results:
        if (result["issues"] or result["needs_visual"]) and result["completeness"] == "complete":
            problems.append((row["id"], "complete with issues"))
        if result["completeness"] not in {"complete", "partial", "unverified"}:
            problems.append((row["id"], "bad completeness", result["completeness"]))
    assert not problems, problems[:5]


def test_traceability(corpus_results):
    """Item 12 / §9.9: every structured fact carries page + bbox + source sha256."""
    problems = []
    total = 0
    for row, result in corpus_results:
        sha = result["meta"].get("source_sha256")
        assert sha == row["sha256"], (row["id"], "sha mismatch")
        for ev in all_evidence(result):
            total += 1
            name = ev.get("field") or ev.get("protected")
            if not isinstance(ev.get("page"), int) or ev.get("page") < 1:
                problems.append((row["id"], name, "page", ev.get("page")))
            bbox = ev.get("bbox")
            if bbox is not None and not (isinstance(bbox, list) and len(bbox) == 4):
                problems.append((row["id"], name, "bbox", bbox))
            if ev.get("source_sha256") != sha:
                problems.append((row["id"], name, "sha", ev.get("source_sha256")))
        for block in result["blocks"]:
            location = block["location"]
            if not isinstance(location.get("page"), int):
                problems.append((row["id"], "block", "page", location.get("page")))
    assert total > 50, f"only {total} evidence records"
    assert not problems, problems[:10]


IDEMPOTENT_SAMPLE = ("talent_pool-01", "talent_pool-06", "odoo_samples-01",
                     "codex_converted-01", "synthetic-image_only",
                     "synthetic-platform_noise", "synthetic-corrupted")


def test_idempotent_two_processes(corpus_rows, tmp_path):
    """C1: two *separate processes* produce byte-identical JSON (no timestamps)."""
    rows = [r for r in corpus_rows if r["id"] in IDEMPOTENT_SAMPLE]
    assert len(rows) >= 5, [r["id"] for r in rows]
    env = {"PYTHONIOENCODING": "utf-8", "PYTHONPATH": str(ROOT),
           "PYTHONHASHSEED": "random"}
    import os
    env = dict(os.environ, **env)
    problems = []
    for row in rows:
        outputs = []
        for run in range(2):
            proc = subprocess.run([sys.executable, "-m", "src.reader_worker", row["path"]],
                                  cwd=str(ROOT), capture_output=True, env=env, timeout=180)
            assert proc.returncode == 0, proc.stderr[-500:]
            outputs.append(proc.stdout)
        if outputs[0] != outputs[1]:
            problems.append((row["id"], len(outputs[0]), len(outputs[1])))
    assert not problems, problems


def test_original_unchanged(real_rows, corpus_results):
    """C2: reading never modifies the original (SHA256 before == after)."""
    before = {row["id"]: row["sha256"] for row in real_rows}
    for row, result in corpus_results:
        if row["id"] not in before:
            continue
        assert sha256(row["path"]) == before[row["id"]], row["id"]


def test_top_level_text_is_block_join(corpus_results):
    """The published text is exactly the block texts joined (no rewriting)."""
    problems = []
    for row, result in corpus_results:
        expected = content.normalize("\n\n".join(
            b["text"] for b in result["blocks"] if b["text"].strip()))
        if result["text"] != expected:
            problems.append(row["id"])
    assert not problems, problems[:5]


COMPAT = "ﬁﬂ①②㈠㎏ⅣⅧ"


def test_no_blanket_nfkc(corpus_results):
    """A3: no Unicode normalisation — compatibility characters survive as-is."""
    problems = []
    checked = 0
    for row, result in corpus_results:
        if any(i.get("code") == "encrypted_pdf" for i in result["issues"]):
            continue
        try:
            native = "".join(pdf_reader.native_page_text(row["path"]))
        except Exception:  # noqa: BLE001 —— 打不开的原件由 hard_cases 覆盖
            continue
        body = result.get("text") or ""
        for char in COMPAT:
            if char in native:
                checked += 1
                if char not in body:
                    problems.append((row["id"], char))
    assert checked > 0, "no compatibility character found in the corpus; test is vacuous"
    assert not problems, problems[:10]
