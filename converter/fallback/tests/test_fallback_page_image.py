"""Tests for step A: render only the pages an issue asks for, into temp."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from fallback import page_image
from helpers import result_stub

REPO_TMP = page_image.PACKAGE_ROOT / "fallback" / "_must_not_exist"


def test_default_dpi_is_200_and_parameters_are_recorded(ascii_pdf):
    pdf, _ = ascii_pdf
    record = page_image.render_page(pdf, 1)
    try:
        assert page_image.DEFAULT_DPI == 200
        assert record["dpi"] == 200
        assert record["dpi_requested"] == 200
        assert record["dpi_capped"] is False
        assert record["page"] == 1
        assert record["page_count"] == 1
        assert record["page_size_pt"] == [595.0, 842.0]
        # 595pt @200dpi = 1652.8px; the pixmap size must follow from the dpi
        assert abs(record["pixel_size"][0] - 595 * 200 / 72) <= 2
        assert abs(record["pixel_size"][1] - 842 * 200 / 72) <= 2
        assert Path(record["png_path"]).is_file()
        assert record["png_bytes"] > 0
        assert record["render_ms"] >= 0
        assert re.fullmatch(r"[0-9a-f]{64}", record["source_sha256"])
        assert record["png_sha256"] == page_image.sha256_of(record["png_path"])
        # temporary directory, not the repository
        assert "dsh-fallback-render-" in record["out_dir"]
        assert page_image.PACKAGE_ROOT not in Path(record["out_dir"]).parents
    finally:
        page_image.cleanup(record["out_dir"])


def test_dpi_is_configurable(ascii_pdf):
    pdf, _ = ascii_pdf
    small = page_image.render_page(pdf, 1, dpi=96)
    big = page_image.render_page(pdf, 1, dpi=200)
    try:
        assert small["dpi"] == 96 and big["dpi"] == 200
        assert small["pixel_size"][0] < big["pixel_size"][0]
        assert small["png_bytes"] < big["png_bytes"]
        assert small["dpi_requested"] == 96
    finally:
        page_image.cleanup(small["out_dir"])
        page_image.cleanup(big["out_dir"])


def test_dpi_env_override(ascii_pdf, monkeypatch):
    pdf, _ = ascii_pdf
    monkeypatch.setenv("RESUME_FALLBACK_DPI", "120")
    record = page_image.render_page(pdf, 1)
    try:
        assert record["dpi"] == 120
    finally:
        page_image.cleanup(record["out_dir"])


def test_dpi_out_of_range_is_rejected(ascii_pdf):
    pdf, _ = ascii_pdf
    with pytest.raises(page_image.RenderError) as excinfo:
        page_image.render_page(pdf, 1, dpi=5000)
    assert excinfo.value.code == "dpi_out_of_range"


def test_render_only_requested_pages(three_page_pdf):
    out = page_image.render_pages(three_page_pdf, [1, 3], dpi=72)
    try:
        assert out["count"] == 2
        names = sorted(p.name for p in Path(out["out_dir"]).glob("*.png"))
        assert names == ["page-0001@72dpi.png", "page-0003@72dpi.png"]
        manifest = json.loads(Path(out["manifest"]).read_text(encoding="utf-8"))
        assert manifest["requested_pages"] == [1, 3]
        assert [r["page"] for r in manifest["renders"]] == [1, 3]
        assert manifest["dpi"] == 72
        assert all(r["dpi"] == 72 for r in manifest["renders"])
        # G-14: the total page count is native, not probed with a sentinel page.
        assert out["page_count"] == 3
        assert manifest["page_count"] == 3
        assert all(r["page_count"] == 3 for r in manifest["renders"])
    finally:
        page_image.cleanup(out["out_dir"])


def test_page_count_is_native_for_every_requested_page(three_page_pdf):
    """render_page() reports doc.page_count without a second render."""
    out = page_image.render_pages(three_page_pdf, [1, 2, 3], dpi=72)
    try:
        assert out["page_count"] == 3
        for record in out["renders"]:
            assert record["page_count"] == 3
            assert isinstance(record["page_count"], int)
            assert not isinstance(record["page_count"], bool)
            assert record["page_count"] >= record["page"]
    finally:
        page_image.cleanup(out["out_dir"])


def test_page_count_survives_all_pages_failing(three_page_pdf):
    """A manifest with zero renders still carries the document page count."""
    out = page_image.render_pages(three_page_pdf, [99], dpi=72)
    try:
        assert out["count"] == 0
        assert [error["code"] for error in out["errors"]] == ["page_out_of_range"]
        assert out["page_count"] == 3
        manifest = json.loads(Path(out["manifest"]).read_text(encoding="utf-8"))
        assert manifest["page_count"] == 3
        assert manifest["renders"] == []
    finally:
        page_image.cleanup(out["out_dir"])


def test_bridge_passes_page_count_through(three_page_pdf):
    """fallback_bridge.py must forward render.page_count to the HTTP caller."""
    import importlib.util
    from pathlib import Path as _Path

    bridge_path = (_Path(__file__).resolve().parents[3]
                   / "dsh" / "dsh-recruitment" / "python" / "fallback_bridge.py")
    assert bridge_path.is_file()
    spec = importlib.util.spec_from_file_location("dsh_fallback_bridge", bridge_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    response = module.handle(
        {"op": "page-image", "pdf": str(three_page_pdf), "page": 3, "dpi": 72},
        str(page_image.PACKAGE_ROOT),
    )
    assert response["ok"] is True
    assert response["render"]["page"] == 3
    assert response["render"]["page_count"] == 3
    assert Path(response["render"]["image_path"]).is_file()
    assert page_image.cleanup(Path(response["render"]["image_path"]).parent) is True


def test_page_out_of_range(three_page_pdf):
    with pytest.raises(page_image.RenderError) as excinfo:
        page_image.render_page(three_page_pdf, 4)
    assert excinfo.value.code == "page_out_of_range"


def test_missing_pdf(tmp_path):
    with pytest.raises(page_image.RenderError) as excinfo:
        page_image.render_page(tmp_path / "nope.pdf", 1)
    assert excinfo.value.code == "pdf_missing"


def test_encrypted_pdf_cannot_be_rendered(encrypted_pdf):
    with pytest.raises(page_image.RenderError) as excinfo:
        page_image.render_page(encrypted_pdf, 1)
    assert excinfo.value.code == "encrypted_pdf"


def test_rejected_render_does_not_create_a_temp_dir(three_page_pdf, encrypted_pdf, monkeypatch):
    created = []
    real_make = page_image.make_temp_dir

    def spy(*args, **kwargs):
        directory = real_make(*args, **kwargs)
        created.append(directory)
        return directory

    monkeypatch.setattr(page_image, "make_temp_dir", spy)
    with pytest.raises(page_image.RenderError):
        page_image.render_page(three_page_pdf, 99)
    with pytest.raises(page_image.RenderError):
        page_image.render_page(encrypted_pdf, 1)
    assert created == [], "a page that cannot be rendered must not leave a temp dir"


def test_refuses_to_render_inside_the_repository(ascii_pdf):
    pdf, _ = ascii_pdf
    with pytest.raises(page_image.RenderError) as excinfo:
        page_image.render_page(pdf, 1, out_dir=REPO_TMP)
    assert excinfo.value.code == "render_path_in_repo"
    assert not REPO_TMP.exists(), "the guard must run before mkdir"


def test_cleanup_refuses_foreign_directories(tmp_path):
    keep = tmp_path / "keep-me"
    keep.mkdir()
    (keep / "important.txt").write_text("do not delete", encoding="utf-8")
    assert page_image.cleanup(keep) is False
    assert (keep / "important.txt").is_file()


def test_cleanup_removes_its_own_temp_directory():
    directory = page_image.make_temp_dir()
    (directory / "x.png").write_bytes(b"png")
    assert page_image.cleanup(directory) is True
    assert not directory.exists()


def test_max_side_caps_dpi_explicitly(ascii_pdf):
    pdf, _ = ascii_pdf
    record = page_image.render_page(pdf, 1, max_side=800)
    try:
        assert record["dpi_capped"] is True
        assert record["dpi_requested"] == 200
        assert record["dpi"] < 200
        assert max(record["pixel_size"]) <= 800
    finally:
        page_image.cleanup(record["out_dir"])


def test_plan_pages_uses_page_scoped_issues():
    result = result_stub(issues=[
        {"code": "unread_visual_page", "location": {"page": 2}},
        {"code": "pdf_text_encoding_unread", "location": {"page": 2}},
        {"code": "pdf_reading_order_unverified", "location": {"page": 5}},
        {"code": "pdf_no_text"},
        {"code": "resume_field_unreadable"},
    ])
    plan = page_image.plan_pages(result)
    assert [p["page"] for p in plan["pages"]] == [2, 5]
    assert plan["pages"][0]["reasons"] == ["image_page", "encoding_unread"]
    assert set(plan["issue_codes"]) == {"unread_visual_page", "pdf_text_encoding_unread",
                                        "pdf_reading_order_unverified"}
    assert plan["has_pdf_no_text"] is True
    assert plan["explicit"] is False


def test_plan_pages_explicit_pages_are_sorted_and_deduped():
    result = result_stub(issues=[{"code": "unread_visual_page", "location": {"page": 1}}])
    plan = page_image.plan_pages(result, pages=[3, 1])
    assert [p["page"] for p in plan["pages"]] == [1, 3]
    assert plan["pages"][1]["reasons"] == ["explicit"]
    assert plan["explicit"] is True


def test_plan_pages_rejects_bad_page_numbers():
    with pytest.raises(ValueError):
        page_image.plan_pages(result_stub(), pages=[0])


def test_plan_pages_ignores_unknown_issues():
    plan = page_image.plan_pages(result_stub(issues=[{"code": "pdf_page_empty",
                                                      "location": {"page": 1}}]))
    assert plan["pages"] == []


def test_image_pages_reads_geometry_and_issues():
    result = result_stub(page_info=[
        {"page": 1, "chars": 0, "images": 1, "drawings": 0},
        {"page": 2, "chars": 1200, "images": 1, "drawings": 3},
    ])
    assert page_image.image_pages(result) == {1}
    result2 = result_stub(issues=[{"code": "unread_visual_page",
                                   "location": {"page": 7}}])
    assert page_image.image_pages(result2) == {7}
