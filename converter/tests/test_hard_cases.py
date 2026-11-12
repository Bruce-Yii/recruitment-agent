"""Honesty for hard carriers (doc 11 B1/B2, §3): scanned, encrypted, damaged, blank.

Items covered: 4 (scanned identified 100%), 5 (encrypted/corrupted -> code, no crash),
plus C3 (timeout is reported, never hangs).
"""
from __future__ import annotations

import json

import pytest

from conftest import field_states, hard_codes
from src import cli, pdf_reader

SCAN = ["synthetic-image_only"]


def _by_tag(rows, tag):
    return [row for row in rows if tag in (row.get("tags") or [])]


def test_scanned_detected(synthetic_rows):
    """B1: every image-only PDF is identified as image-only, with no fake body."""
    rows = _by_tag(synthetic_rows, "image_only")
    assert len(rows) == 3, rows
    for row in rows:
        result = pdf_reader.read_pdf(row["path"])
        codes = [i["code"] for i in result["issues"]]
        assert result["needs_visual"] is True, (row["path"], codes)
        assert "pdf_no_text" in codes, (row["path"], codes)
        assert "unread_visual_page" in codes, (row["path"], codes)
        assert result["blocks"] == [], row["path"]
        assert result["text"].strip() == "", row["path"]
        assert result["completeness"] == "partial"
        assert hard_codes(result), codes
        # 三态：图像型不允许出现 absent（"没读到"不等于"没有"）
        assert set(field_states(result).values()) == {"unreadable"}, field_states(result)
        for field in result["fields"].values():
            assert field["evidence"] == []


def test_zero_text_pdf(synthetic_rows):
    """A blank page is reported as no-text, not as an empty resume."""
    row = _by_tag(synthetic_rows, "zero_text")[0]
    result = pdf_reader.read_pdf(row["path"])
    codes = [i["code"] for i in result["issues"]]
    assert "pdf_no_text" in codes, codes
    assert result["needs_visual"] is True
    assert result["blocks"] == []
    assert set(field_states(result).values()) == {"unreadable"}


def test_encrypted_pdf(synthetic_rows):
    """B2: encrypted without password -> encrypted_pdf, no crash, nothing read."""
    row = _by_tag(synthetic_rows, "encrypted")[0]
    result = pdf_reader.read_pdf(row["path"])
    codes = [i["code"] for i in result["issues"]]
    assert codes == ["encrypted_pdf"], codes
    assert result["blocks"] == []
    assert result["completeness"] == "partial"
    assert set(field_states(result).values()) == {"unreadable"}
    assert result["meta"]["source_sha256"] == row["sha256"]


def test_corrupted_pdf(synthetic_rows):
    """§3 damaged carrier: report a code, never crash, never claim a full read."""
    row = _by_tag(synthetic_rows, "corrupted")[0]
    result = pdf_reader.read_pdf(row["path"])
    codes = [i["code"] for i in result["issues"]]
    assert "pdf_text_encoding_unread" in codes, codes
    assert "pdf_damaged_repaired" in codes, codes
    assert result["completeness"] == "partial"
    # 读到的部分保留（不是伪造），没读到的部分不许断言"没有"
    assert set(field_states(result).values()) <= {"present", "unreadable"}
    assert "absent" not in field_states(result).values()


def test_open_failure_reported(tmp_path):
    """A file that is not a PDF at all -> reader_failed, no exception."""
    bad = tmp_path / "not_a_pdf.pdf"
    bad.write_bytes(b"this is not a pdf at all")
    result = pdf_reader.read_pdf(bad)
    assert [i["code"] for i in result["issues"]] == ["reader_failed"]
    assert result["blocks"] == []
    assert set(field_states(result).values()) == {"unreadable"}


def test_missing_file_reported(tmp_path):
    result = pdf_reader.read_pdf(tmp_path / "nope.pdf")
    assert [i["code"] for i in result["issues"]] == ["reader_failed"]
    assert set(field_states(result).values()) == {"unreadable"}


def test_timeout_is_reported_not_hung(synthetic_rows):
    """C3: an expired budget yields reader_timeout with no partial body."""
    row = _by_tag(synthetic_rows, "image_only")[0]
    result = cli.read_isolated(row["path"], timeout=0.001)
    codes = [i["code"] for i in result["issues"]]
    assert codes == ["reader_timeout"], codes
    assert result["blocks"] == []
    assert result["text"] == ""
    assert result["completeness"] == "partial"
    assert set(field_states(result).values()) == {"unreadable"}
    assert result["meta"]["timed_out"] is True


def test_failure_shape_is_complete(tmp_path):
    """Every failure path still returns the full contract shape."""
    bad = tmp_path / "broken.pdf"
    bad.write_bytes(b"%PDF-1.4 broken")
    result = pdf_reader.read_pdf(bad)
    for key in ("text", "blocks", "completeness", "issues", "needs_visual",
                "warnings", "meta", "fields", "screening"):
        assert key in result, key
    assert set(result["fields"]) == {"name", "phone", "email",
                                     "work_experience", "education"}
    assert result["meta"]["backend"].startswith("pymupdf/")
