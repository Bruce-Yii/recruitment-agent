"""Tests for steps E and the A->B->D->E pipeline."""
from __future__ import annotations

from pathlib import Path

import pytest

from fallback import page_image, pipeline
from fallback.merge import merge_model_reads
from helpers import StubModel, native_block, read_stub, result_stub

NATIVE = ("alpha bravo charlie delta echo foxtrot golf hotel india juliet "
          "kilo lima mike november papa")
FIXED_NOW = "2026-01-01T00:00:00+00:00"


def _image_result(sha=None):
    return result_stub(
        blocks=[native_block(NATIVE)],
        issues=[{"code": "unread_visual_page", "location": {"page": 1}}],
        sha=sha,
        needs_visual=True)


def test_merge_appends_a_model_block_and_keeps_everything_else():
    result = _image_result(sha="a" * 64)
    read = read_stub(NATIVE, 1, source_sha256="a" * 64)
    merged = merge_model_reads(result, [read], run_id="run-1", now=FIXED_NOW)

    assert len(merged["blocks"]) == 2
    block = merged["blocks"][-1]
    assert block["provenance"] == "model_read"
    assert block["source_class"] == "agent_read"
    assert block["location"] == {"page": 1, "bbox": None}
    assert block["text"] == NATIVE
    assert block["evidence"]["source"] == "MODEL"
    assert block["evidence"]["bbox_available"] is False

    # native block untouched, body text untouched, honesty flags untouched
    assert merged["blocks"][0] == result["blocks"][0]
    assert merged["text"] == result["text"]
    assert merged["text_native_only"] is True
    assert merged["text_with_model_read"] == NATIVE + "\n\n" + NATIVE
    assert merged["issues"] == result["issues"]
    assert merged["completeness"] == result["completeness"]
    assert merged["needs_visual"] is True

    record = merged["model_read_applied"][0]
    assert record["page"] == 1
    assert record["location"] == {"page": 1, "bbox": None}
    assert record["applied_at"] == FIXED_NOW
    assert record["chars"] == len(NATIVE)
    assert merged["model_read"]["applied"] == 1
    assert merged["model_read"]["needs_visual_unchanged"] is True
    assert any(line.startswith("model_read_applied: page 1")
               for line in merged["warnings"])
    # the input dict is not mutated
    assert len(result["blocks"]) == 1 and "model_read_applied" not in result


def test_merge_rejects_meta_discourse_and_stores_no_text():
    result = _image_result(sha="a" * 64)
    read = read_stub("抱歉，我无法读取这张图片。", 1, source_sha256="a" * 64)
    merged = merge_model_reads(result, [read], now=FIXED_NOW)

    assert len(merged["blocks"]) == 1
    assert merged["model_read_applied"] == []
    rejected = merged["model_read_rejected"][0]
    assert "META_DISCOURSE" in rejected["codes"]
    assert "text" not in rejected, "rejected text must not be stored"
    assert len(rejected["text_sha256"]) == 64
    assert merged["needs_visual"] is True
    assert merged["completeness"] == "partial"
    assert any("model_read_rejected: page 1" in w for w in merged["warnings"])


def test_merge_re_verifies_and_ignores_a_caller_verdict():
    result = _image_result(sha="a" * 64)
    read = read_stub("", 1, source_sha256="a" * 64, verify={"ok": True, "codes": []})
    merged = merge_model_reads(result, [read], now=FIXED_NOW)
    assert merged["model_read_applied"] == []
    assert "EMPTY_TEXT" in merged["model_read_rejected"][0]["codes"]


def test_merge_refuses_a_reading_from_another_source_file():
    result = _image_result(sha="a" * 64)
    read = read_stub(NATIVE, 1, source_sha256="b" * 64)
    merged = merge_model_reads(result, [read], now=FIXED_NOW)
    assert merged["model_read_rejected"][0]["codes"] == ["SOURCE_SHA_MISMATCH"]
    assert len(merged["blocks"]) == 1


def test_merge_is_idempotent():
    result = _image_result(sha="a" * 64)
    read = read_stub(NATIVE, 1, source_sha256="a" * 64)
    once = merge_model_reads(result, [read], now=FIXED_NOW)
    twice = merge_model_reads(once, [read], now=FIXED_NOW)
    assert len(twice["blocks"]) == len(once["blocks"])
    assert twice["model_read"]["applied"] == 0
    assert twice["model_read_skipped"][0]["reason"] == "ALREADY_APPLIED"


def test_merge_rejects_pages_outside_the_plan():
    result = _image_result(sha="a" * 64)
    merged = merge_model_reads(result, [read_stub(NATIVE, 1, source_sha256="a" * 64)],
                               planned_pages=[2], now=FIXED_NOW)
    assert merged["model_read_rejected"][0]["codes"] == ["PAGE_NOT_PLANNED"]


def test_merge_keeps_only_one_reading_per_page():
    result = _image_result(sha="a" * 64)
    read = read_stub(NATIVE, 1, source_sha256="a" * 64)
    merged = merge_model_reads(result, [read, dict(read)], now=FIXED_NOW)
    assert merged["model_read"]["applied"] == 1
    assert merged["model_read_rejected"][0]["codes"] == ["DUPLICATE_PAGE"]
    assert len(merged["blocks"]) == 2


def test_merge_without_reads_changes_nothing():
    result = _image_result()
    merged = merge_model_reads(result, [], now=FIXED_NOW)
    assert merged["blocks"] == result["blocks"]
    assert merged["text"] == result["text"]
    assert merged["model_read"]["reads"] == 0
    assert merged["warnings"] == []


# ------------------------------ pipeline ------------------------------
def _pdf_result(pdf_path: Path, text: str, sha: str | None = None):
    return result_stub(
        blocks=[native_block(text)],
        issues=[{"code": "unread_visual_page", "location": {"page": 1}}],
        sha=page_image.sha256_of(pdf_path) if sha is None else sha,
        needs_visual=True)


def test_pipeline_end_to_end_with_a_test_double(ascii_pdf):
    pdf, text = ascii_pdf
    result = _pdf_result(pdf, text)
    stub = StubModel(text, model_id="stub/reader")
    outcome = pipeline.run_fallback(result, pdf, stub, dpi=72)
    report, merged = outcome["report"], outcome["result"]

    assert report["status"] == "APPLIED"
    assert report["plan"]["pages"][0]["reasons"] == ["image_page"]
    assert report["renders"][0]["dpi"] == 72
    assert report["renders"][0]["pixel_size"][0] > 0
    assert report["verifications"][0]["ok"] is True
    assert report["applied"][0]["page"] == 1
    assert len(merged["blocks"]) == len(result["blocks"]) + 1
    assert merged["blocks"][-1]["provenance"] == "model_read"
    assert merged["text"] == result["text"]
    assert report["images_cleaned"] is True
    assert not Path(report["render_dir"]).exists()
    assert len(stub.calls) == 1


def test_pipeline_degrades_when_the_model_is_unavailable(ascii_pdf):
    pdf, text = ascii_pdf
    result = _pdf_result(pdf, text)
    stub = StubModel(raises=RuntimeError("QUOTA: Insufficient Balance"))
    outcome = pipeline.run_fallback(result, pdf, stub, dpi=72)
    report, merged = outcome["report"], outcome["result"]

    assert report["status"] == "UNAVAILABLE"
    assert report["unavailable"][0]["code"] == "model_quota"
    assert merged["blocks"] == result["blocks"]
    assert merged["needs_visual"] is True
    assert merged["completeness"] == "partial"
    assert merged["model_read"]["unavailable"][0]["code"] == "model_quota"
    assert any("model_read_unavailable" in w for w in merged["warnings"])
    assert report["images_cleaned"] is True


def test_pipeline_records_render_failure(tmp_path):
    result = result_stub(blocks=[native_block(NATIVE)],
                         issues=[{"code": "unread_visual_page",
                                  "location": {"page": 1}}],
                         sha="a" * 64)
    stub = StubModel(NATIVE)
    outcome = pipeline.run_fallback(result, tmp_path / "missing.pdf", stub, dpi=72)
    report = outcome["report"]
    assert report["status"] == "RENDER_FAILED"
    assert report["render_errors"][0]["code"] == "pdf_missing"
    assert stub.calls == []


def test_pipeline_refuses_a_stale_converter_result(ascii_pdf):
    pdf, text = ascii_pdf
    result = _pdf_result(pdf, text, sha="c" * 64)
    stub = StubModel(text)
    outcome = pipeline.run_fallback(result, pdf, stub, dpi=72)
    report = outcome["report"]
    assert report["status"] == "RENDER_FAILED"
    assert report["render_errors"][0]["code"] == "SOURCE_SHA_MISMATCH"
    assert stub.calls == [], "a stale page must not be sent to the model"


def test_pipeline_does_nothing_without_a_trigger():
    result = result_stub(blocks=[native_block(NATIVE)],
                         issues=[{"code": "pdf_page_empty", "location": {"page": 1}}],
                         needs_visual=True)
    stub = StubModel(NATIVE)
    outcome = pipeline.run_fallback(result, "unused.pdf", stub)
    assert outcome["report"]["status"] == "NO_TRIGGER"
    assert outcome["report"]["render_dir"] is None
    assert stub.calls == []
    assert outcome["result"]["blocks"] == result["blocks"]


def test_pipeline_can_keep_images_for_inspection(ascii_pdf):
    pdf, text = ascii_pdf
    result = _pdf_result(pdf, text)
    outcome = pipeline.run_fallback(result, pdf, StubModel(text), dpi=72,
                                   retain_images=True)
    report = outcome["report"]
    assert report["images_cleaned"] is False
    render_dir = Path(report["render_dir"])
    try:
        assert render_dir.is_dir()
        assert list(render_dir.glob("*.png"))
    finally:
        page_image.cleanup(render_dir)


def test_pipeline_renders_only_the_planned_pages(three_page_pdf):
    text = "PAGE ONE ALPHA BRAVO"
    result = result_stub(
        blocks=[native_block(text)],
        issues=[{"code": "unread_visual_page", "location": {"page": 1}},
                {"code": "pdf_reading_order_unverified", "location": {"page": 3}}],
        sha=page_image.sha256_of(three_page_pdf), needs_visual=True)
    stub = StubModel(text)
    outcome = pipeline.run_fallback(result, three_page_pdf, stub, dpi=72)
    report = outcome["report"]
    assert [r["page"] for r in report["renders"]] == [1, 3]
    assert len(stub.calls) == 2
    # page 2 was never rendered
    assert all(r["page"] != 2 for r in report["renders"])
    assert report["plan"]["pages"][1]["reasons"] == ["order_unverified"]


def test_pipeline_stops_asking_after_the_model_is_unavailable(three_page_pdf):
    text = "PAGE ONE ALPHA BRAVO"
    result = result_stub(
        blocks=[native_block(text)],
        issues=[{"code": "unread_visual_page", "location": {"page": 1}},
                {"code": "unread_visual_page", "location": {"page": 3}}],
        sha=page_image.sha256_of(three_page_pdf), needs_visual=True)
    stub = StubModel(raises=RuntimeError("QUOTA: Insufficient Balance"))
    outcome = pipeline.run_fallback(result, three_page_pdf, stub, dpi=72)
    report = outcome["report"]
    assert len(stub.calls) == 1, "quota errors must not be retried per page"
    assert report["unavailable"][0]["page"] == 1
    assert report["pages_skipped"][0]["page"] == 3
    assert report["status"] == "UNAVAILABLE"
    assert outcome["result"]["model_read"]["pages_skipped"][0]["page"] == 3


def test_real_image_only_page_is_rendered_from_the_corpus():
    pdf = page_image.PACKAGE_ROOT / "corpus" / "synthetic" / "image_only_1.pdf"
    if not pdf.is_file():
        pytest.skip("synthetic corpus PDF not present")
    result = result_stub(
        issues=[{"code": "unread_visual_page", "location": {"page": 1}}],
        pages=1, page_info=[{"page": 1, "chars": 0, "images": 1, "drawings": 0}],
        sha=page_image.sha256_of(pdf))
    assert [p["page"] for p in page_image.plan_pages(result)["pages"]] == [1]
    record = page_image.render_page(pdf, 1, dpi=72)
    try:
        assert record["page_size_pt"] == [2480.0, 3507.0]
        assert record["page_size_in"] == [34.44, 48.71]
        assert record["source_image_px"] == [2480, 3507]
        assert record["source_dpi_hint"] == 72.0
        assert record["pixel_size"] == [2480, 3507]
        assert record["png_bytes"] > 0
    finally:
        page_image.cleanup(record["out_dir"])
