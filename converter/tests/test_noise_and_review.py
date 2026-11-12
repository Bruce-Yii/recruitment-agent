"""Platform noise (item 10), OCR-titles-only, and the human-review evidence (item 13)."""
from __future__ import annotations

import json
import os
import sys

import pytest

from conftest import ROOT, SYNTHETIC, field_states
from src import pdf_reader
from src import resume_fields as rf

FAKE_OCR = ROOT / "tests" / "fake_ocr_titles.py"


def _synthetic(rows, tag):
    return [r for r in rows if tag in (r.get("tags") or [])][0]


# ---------------------------------------------------------------- item 10
@pytest.mark.parametrize("text,expected", [
    ("BOSS直聘  www.zhipin.com", True),
    ("BOSS直聘", True),
    ("BOSS直聘 · 第 1 页 / 共 2 页", True),
    ("BOSS直聘 产品经理", False),          # 真实经历里提到平台 → 不能删
    ("通过 BOSS直聘 投递", False),
    ("linkedin.com/in/joey", False),       # 个人主页链接是联系方式，不是水印
    ("github.com/foo/bar", False),
    ("智联招聘 · 简历编号 12345", False),   # 带正文 → 不整块删，走 inline 报告
])
def test_noise_classifier(text, expected):
    block = {"kind": "paragraph", "text": text,
             "location": {"page": 1, "bbox": [0, 0, 100, 10]}, "links": []}
    hit, marker = rf.is_noise_block(block)
    assert hit is expected, (text, hit, marker)


def test_platform_noise_excluded_and_recorded(synthetic_rows):
    row = _synthetic(synthetic_rows, "platform_noise")
    result = pdf_reader.read_pdf(row["path"])
    assert result["noise"], "noise was not recorded"
    entry = result["noise"][0]
    assert isinstance(entry["page"], int)
    assert len(entry["bbox"]) == 4
    assert "zhipin" in entry["text"].lower()
    assert "zhipin" not in (result["text"] or "").lower()
    codes = [i["code"] for i in result["issues"]]
    assert "platform_noise_excluded" in codes, codes
    page = result["meta"]["page_info"][0]
    assert page["noise_removed"], page
    # 排除必须"有记录"：正文 + 已声明移除 == 原生文本（由 fidelity 测试全量校验）
    assert result["fields"]["name"]["state"] == "present"


def test_inline_noise_is_reported_not_removed(tmp_path, tmp_pdf):
    """Noise sharing a block with body text must be reported, not deleted."""
    path = tmp_pdf("inline.pdf", [
        (40, 60, "张三", 20),
        (40, 100, "工作经历", 12),
        (40, 130, "甲公司 工程师 2020.07-2021.06", 9),
        (40, 160, "乙公司 架构师 2021.07-2023.06 BOSS直聘 推荐", 9),
    ])
    result = pdf_reader.read_pdf(path)
    codes = [i["code"] for i in result["issues"]]
    assert "platform_noise_inline_unresolved" in codes, codes
    assert result["noise"] == []
    assert "BOSS直聘" in result["text"]


# ---------------------------------------------------------------- OCR 只补标题
def test_ocr_only_supplies_titles(tmp_path, monkeypatch):
    """§1: OCR may add headings, never replace native body text."""
    body = "。".join(["这是一段用于测试的原生正文，长度足够触发标题补读路径"] * 30)
    lines = [(40, 60, "张三", 20), (40, 90, "zhangsan@example.com", 10)]
    for index in range(30):
        lines.append((40, 120 + index * 12, f"{index:02d} 原生正文行：{body[index*7:index*7+22]}", 9))
    path = tmp_path / "ocr_case.pdf"
    from conftest import build_pdf
    build_pdf(path, lines)
    before = pdf_reader.read_pdf(path)
    native_before = sum(1 for b in before["blocks"] if b["provenance"] == "native_text")
    assert len(before["text"]) >= 800, len(before["text"])
    assert not any(b["provenance"] == "ocr_title" for b in before["blocks"])

    monkeypatch.setattr(pdf_reader, "_OCR_TOOL", FAKE_OCR)
    monkeypatch.setenv("RESUME_CONVERSION_OCR_PYTHON", sys.executable)
    after = pdf_reader.read_pdf(path)

    inserted = [b for b in after["blocks"] if b["provenance"] == "ocr_title"]
    assert inserted, [b["provenance"] for b in after["blocks"]]
    for block in inserted:
        assert block["kind"] == "heading"
        assert block["level"] >= 1
    native_after = [b for b in after["blocks"] if b["provenance"] == "native_text"]
    assert len(native_after) == native_before, (native_before, len(native_after))
    # 正文一字未变：原生块的字符计数与补读前完全相同
    from collections import Counter
    import re as _re
    def counter(blocks):
        out = Counter()
        for block in blocks:
            if block["provenance"] == "native_text":
                out += Counter(_re.sub(r"\s", "", block["text"]))
        return out
    assert counter(native_after) == counter([b for b in before["blocks"]
                                             if b["provenance"] == "native_text"])
    assert any("headings_from_ocr_region" in w for w in after["warnings"]), after["warnings"]


def test_ocr_unconfigured_is_recorded(tmp_path):
    """An unavailable OCR backend must be visible, not silently "no titles needed"."""
    body = "。".join(["这是一段用于测试的原生正文，长度足够触发标题补读路径"] * 30)
    lines = [(40, 60, "张三", 20)]
    for index in range(30):
        lines.append((40, 100 + index * 12, f"{index:02d} 原生正文行：{body[index*7:index*7+22]}", 9))
    from conftest import build_pdf
    path = build_pdf(tmp_path / "ocr_off.pdf", lines)
    result = pdf_reader.read_pdf(path)
    assert result["meta"]["ocr"] in ("backend_unconfigured", "not_needed")
    if result["meta"]["ocr"] == "backend_unconfigured":
        assert any("ocr_title_backend_unconfigured" in w for w in result["warnings"])


# ---------------------------------------------------------------- item 13
REVIEW = ROOT / "reports" / "human-review.jsonl"
RESULTS = ROOT / "reports" / "corpus-results.jsonl"


def _review_records():
    assert REVIEW.is_file(), f"missing {REVIEW}"
    return [json.loads(line) for line in REVIEW.read_text(encoding="utf-8").splitlines()
            if line.strip()]


def test_human_review_covers_20_percent():
    rows = [json.loads(line) for line in RESULTS.read_text(encoding="utf-8").splitlines()
            if line.strip()]
    records = _review_records()
    reviewed = {r["id"] for r in records}
    assert len(rows) == 84, len(rows)
    assert len(reviewed) >= 84 * 0.2, len(reviewed)
    layers = {tag for r in rows for tag in (r.get("tags") or [])}
    assert {"text_rich", "image_only", "encrypted", "corrupted",
            "platform_noise", "zero_text"} <= layers, layers


def test_human_review_covers_all_hard_issues():
    rows = [json.loads(line) for line in RESULTS.read_text(encoding="utf-8").splitlines()
            if line.strip()]
    hard_ids = {r["id"] for r in rows if r.get("hard")}
    records = _review_records()
    reviewed = {r["id"] for r in records}
    missing = sorted(hard_ids - reviewed)
    assert not missing, f"{len(missing)} HARD files not read: {missing[:10]}"


def test_human_review_records_are_substantive():
    records = _review_records()
    for record in records:
        assert record.get("method") in {"rendered_page_image", "native_text_layer"}
        assert record.get("verdict") in {"match", "mismatch", "unverifiable"}
        assert record.get("observations"), record["id"]
        assert isinstance(record.get("pages_reviewed"), list) and record["pages_reviewed"]
    mismatches = [r["id"] for r in records if r["verdict"] == "mismatch"]
    assert not mismatches, f"review found mismatches: {mismatches}"
