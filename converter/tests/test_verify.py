"""校验器自己的单元测试（≥12 条）。

原则
----
* 正例用**真 PDF**（fitz 现场造，不是 mock），负例逐个注入 doc 11 的缺陷；
* 每个负例只破坏一件事，断言"该失败的那一项失败、别的项没被牵连"；
* 链接口径单独测（V2 的 label/href 规则 + URL-as-label 例外），因为这是
  最容易被写错、也最容易被"糊弄过去"的一条判据。

跑法：``python -m pytest tests/test_verify.py -q``（cwd 在 converter/）。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import fitz
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from verify.verify_output import (  # noqa: E402
    NativeDoc,
    VerifyInputError,
    _strip_link_markdown,
    verify,
)


# ============================ 造 PDF ============================
def _make_pdf(path: Path, pages: list[dict]) -> Path:
    """按描述造一份真 PDF。

    pages[i] 支持 ``text``（一段 ASCII 文本）、``graphics``（画一个矢量方块）、
    ``links``（[(Rect, uri)]）。
    """
    doc = fitz.open()
    for spec in pages:
        page = doc.new_page(width=595, height=842)
        text = spec.get("text") or ""
        if text:
            page.insert_text((72, 100), text, fontsize=11)
        if spec.get("graphics"):
            page.draw_rect(fitz.Rect(400, 400, 460, 460), color=(0, 0, 0), fill=(1, 0, 0))
        for rect, uri in spec.get("links") or []:
            page.insert_link({"kind": fitz.LINK_URI, "from": rect, "uri": uri})
    doc.save(str(path))
    doc.close()
    return path


def _native(pdf: Path) -> NativeDoc:
    from verify.verify_output import read_native
    return read_native(pdf)


def _good_output(pdf: Path) -> dict:
    """按原生文本造一份"合格的"输出（一页一个 block，字符逐页恒等）。"""
    native = _native(pdf)
    blocks = []
    for number, text in enumerate(native.pages, 1):
        if not text.strip():
            continue
        blocks.append({
            "kind": "paragraph",
            "text": text.strip(),
            "location": {"page": number, "bbox": [0.0, 0.0, 100.0, 100.0]},
            "links": [],
            "provenance": "native_text",
        })
    page_info = [{"page": n + 1, "chars": len(t.strip()), "images": 0, "drawings": 0,
                  "block_count": 1, "encoding_removed": "", "noise_removed": ""}
                 for n, t in enumerate(native.pages)]
    return {
        "text": "\n\n".join(b["text"] for b in blocks),
        "blocks": blocks,
        "title": "",
        "chars": sum(len(b["text"]) for b in blocks),
        "completeness": "complete",
        "issues": [],
        "needs_visual": False,
        "warnings": [],
        "links": [],
        "meta": {"pages": native.page_count, "source_sha256": "0" * 64,
                 "backend": "test", "page_info": page_info},
    }


def _checks(result: dict) -> dict:
    return {c["name"]: c for c in result["checks"]}


# ============================ 正例 ============================
def test_clean_output_passes(tmp_path):
    """对照组：一份对得上的输出必须全过，不得误报（doc 12 INJ-07）。"""
    pdf = _make_pdf(tmp_path / "clean.pdf",
                    [{"text": "Hello world"}, {"text": "Second page text"}])
    result = verify(_good_output(pdf), pdf)
    assert result["passed"], json.dumps(result, ensure_ascii=False, indent=1)
    assert result["failed"] == []
    assert result["summary"] == {"total": 8, "passed": 7, "failed": 0, "skipped": 1}
    assert _checks(result)["V1_page_coverage"]["detail"].startswith("meta.pages=2")


# ============================ V1 页覆盖 ============================
def test_v1_deleted_page_blocks(tmp_path):
    """删掉一页的 blocks（不加 issue）→ V1 必须失败：静默丢页。"""
    pdf = _make_pdf(tmp_path / "two.pdf",
                    [{"text": "Page one"}, {"text": "Page two"}])
    output = _good_output(pdf)
    output["blocks"] = [b for b in output["blocks"]
                        if b["location"]["page"] != 2]
    result = verify(output, pdf)
    assert not result["passed"]
    assert "V1_page_coverage" in result["failed"]
    assert "既无 block，也没有内容级 issue 声明" in _checks(result)["V1_page_coverage"]["detail"]
    assert "V2_char_identity" in result["failed"]  # 少了一页的字，也必须同时报


def test_v1_page_count_mismatch(tmp_path):
    """meta.pages 与原件页数不符 → V1 失败。"""
    pdf = _make_pdf(tmp_path / "one.pdf", [{"text": "Only page"}])
    output = _good_output(pdf)
    output["meta"]["pages"] = 7
    result = verify(output, pdf)
    assert "V1_page_coverage" in result["failed"]
    assert "meta.pages=7" in _checks(result)["V1_page_coverage"]["detail"]


def test_v1_soft_issue_does_not_excuse_missing_page(tmp_path):
    """页面上只剩一条无关软 issue，不能把"整页正文丢了"洗成"已声明"。

    这是 V1 最容易被糊弄的地方：A1 字面写"要么有 block，要么有 issue"，
    但 `unverified_pdf_image`（图片角色未核实）并不声明"这一页的正文读不到"。
    """
    pdf = _make_pdf(tmp_path / "soft.pdf",
                    [{"text": "Page one"}, {"text": "Page two"}])
    output = _good_output(pdf)
    output["blocks"] = [b for b in output["blocks"] if b["location"]["page"] != 2]
    output["issues"] = [{"code": "unverified_pdf_image", "message": "page 2 has 1 image",
                         "location": {"page": 2}}]
    output["completeness"] = "partial"
    result = verify(output, pdf)
    assert "V1_page_coverage" in result["failed"]
    detail = _checks(result)["V1_page_coverage"]["detail"]
    assert "没有内容级 issue 声明" in detail and "unverified_pdf_image" in detail


# ============================ V2 字符恒等 ============================
def test_v2_single_character_changed(tmp_path):
    """改一个字符 → V2 必须失败（doc 12 INJ-01）。"""
    pdf = _make_pdf(tmp_path / "char.pdf", [{"text": "Zhang Wei 13800000000"}])
    output = _good_output(pdf)
    output["blocks"][0]["text"] = output["blocks"][0]["text"].replace("Z", "X", 1)
    result = verify(output, pdf)
    assert "V2_char_identity" in result["failed"]
    detail = _checks(result)["V2_char_identity"]["detail"]
    assert "缺" in detail and "多" in detail


def test_v2_cannot_launder_deleted_text_as_encoding_removal(tmp_path):
    """删正文 + 把删掉的字谎报成 encoding_removed → V2 必须失败。

    只有坏字形/控制字符才允许以"剔除"名义离开正文；普通字母不行。
    """
    pdf = _make_pdf(tmp_path / "launder.pdf", [{"text": "Hello"}])
    output = _good_output(pdf)
    output["blocks"][0]["text"] = "Hell"
    output["meta"]["page_info"][0]["encoding_removed"] = "o"
    result = verify(output, pdf)
    assert "V2_char_identity" in result["failed"]
    assert "非坏字形" in _checks(result)["V2_char_identity"]["detail"]


def test_v2_declared_bad_glyph_removal_is_allowed():
    """坏字形被剔除并逐页声明 → 允许（doc 11 A6 要求它离开正文）。"""
    fake = NativeDoc(opened=True, readable=True, page_count=1,
                     pages=["Hello\ufffd"], graphics=[False], uris=set())
    output = {
        "blocks": [{"kind": "paragraph", "text": "Hello",
                    "location": {"page": 1, "bbox": [0, 0, 1, 1]}, "links": []}],
        "text": "Hello",
        "completeness": "partial",
        "issues": [{"code": "pdf_text_encoding_unread", "message": "bad glyph",
                    "location": {"page": 1}}],
        "needs_visual": True,
        "links": [],
        "meta": {"pages": 1, "page_info": [{"page": 1, "encoding_removed": "\ufffd",
                                            "noise_removed": ""}]},
    }
    result = verify(output, "unused.pdf", native=fake)
    assert _checks(result)["V2_char_identity"]["ok"], _checks(result)["V2_char_identity"]


# ============================ V2 的链接口径（关键）============================
def test_v2_link_label_is_text_href_is_not(tmp_path):
    """`[label](<href>)`：label 算文字、href 不算。

    原件页面上只有 "see github"；输出把它写成 Markdown 链接。若把 href 也当
    文字，V2 会凭空多出一串字符——这正是转换器的设计，校验器必须照此还原。
    """
    pdf = _make_pdf(tmp_path / "link.pdf",
                    [{"text": "see github",
                      "links": [(fitz.Rect(72, 90, 140, 105), "https://example.com/x")]}])
    native = _native(pdf)
    assert "https://example.com/x" in native.uris
    output = _good_output(pdf)
    output["blocks"][0]["text"] = "see [github](<https://example.com/x>)"
    output["blocks"][0]["links"] = [{"text": "github", "href": "https://example.com/x",
                                     "location": {"page": 1, "bbox": [0, 0, 1, 1]}}]
    output["links"] = list(output["blocks"][0]["links"])
    result = verify(output, pdf, native=native)
    assert result["passed"], json.dumps(result, ensure_ascii=False, indent=1)

    # 反证：label 本身是真的，但被写丢 → 必须失败（href 不等于文字）
    broken = _good_output(pdf)
    broken["blocks"][0]["text"] = "see [](<https://example.com/x>)"
    result2 = verify(broken, pdf, native=native)
    assert "V2_char_identity" in result2["failed"]


def test_v2_url_as_label_link_without_visible_text(tmp_path):
    """无可见文字的链接：label == href 且原件文本层没有它 → 豁免，但必须报条数。

    这是唯一被允许"不进字符恒等式"的链接形态：注解盖在图片/空白上，页面上没有
    任何词，转换器只能拿 URI 当 label 才能把这条链接表达出来。
    """
    pdf = _make_pdf(tmp_path / "img-link.pdf",
                    [{"text": "hello",
                      "links": [(fitz.Rect(400, 400, 460, 460), "https://example.com/x")]}])
    native = _native(pdf)
    assert "https://example.com/x" in native.uris
    output = _good_output(pdf)
    output["blocks"].append({
        "kind": "link", "text": "[https://example.com/x](<https://example.com/x>)",
        "location": {"page": 1, "bbox": [400, 400, 460, 460]},
        "links": [{"text": "https://example.com/x", "href": "https://example.com/x",
                   "location": {"page": 1, "bbox": [400, 400, 460, 460]}}],
    })
    output["links"] = list(output["blocks"][-1]["links"])
    result = verify(output, pdf, native=native)
    assert result["passed"], json.dumps(result, ensure_ascii=False, indent=1)
    detail = _checks(result)["V2_char_identity"]["detail"]
    assert "URL-as-label 豁免 1 条" in detail

    # 反证：把同一段 URL 当普通正文塞进正文（href 不是真实 URI）→ V2/V3 都要报
    bad = _good_output(pdf)
    bad["blocks"].append({
        "kind": "paragraph", "text": "[https://fake.example/y](<https://fake.example/y>)",
        "location": {"page": 1, "bbox": [0, 0, 1, 1]}, "links": []})
    result2 = verify(bad, pdf, native=native)
    assert "V2_char_identity" in result2["failed"]
    assert "V3_no_fabricated_uri" in result2["failed"]


def test_strip_link_markdown_unit():
    """`[label](<href>)` 还原规则（含转义 label）的单元级断言。"""
    text = r"见 [a\[b\]](<https://x/y>) 和 [知乎](<https://zhihu.com/z>)"
    out, exempt = _strip_link_markdown(text, "见 a[b] 和 知乎", set())
    assert out == "见 a[b] 和 知乎"
    assert exempt == []
    # 无可见文字 + 真实 URI + 原件没这串字 → 整条豁免
    out2, exempt2 = _strip_link_markdown("[https://x/y](<https://x/y>)", "", {"https://x/y"})
    assert out2 == "" and exempt2 == ["https://x/y"]
    # 同一形态但 URI 不在原件里 → 不豁免（按 label 算文字）
    out3, exempt3 = _strip_link_markdown("[https://x/y](<https://x/y>)", "", set())
    assert out3 == "https://x/y" and exempt3 == []


# ============================ V3 凭空 URI ============================
def test_v3_fabricated_uri_in_links(tmp_path):
    """塞一个假 URI 到 links[] → V3 必须失败（doc 12 INJ-03）。"""
    pdf = _make_pdf(tmp_path / "uri.pdf",
                    [{"text": "contact me",
                      "links": [(fitz.Rect(72, 90, 140, 105), "https://real.example/a")]}])
    output = _good_output(pdf)
    output["links"] = [{"text": "me", "href": "https://fake.example/evil",
                        "location": {"page": 1, "bbox": [0, 0, 1, 1]}}]
    result = verify(output, pdf)
    assert "V3_no_fabricated_uri" in result["failed"]
    assert "fake.example/evil" in _checks(result)["V3_no_fabricated_uri"]["detail"]


def test_v3_fabricated_uri_hidden_in_markdown_only(tmp_path):
    """假 URI 只藏在正文 Markdown 里（不进 links[]）→ 仍必须被抓到。"""
    pdf = _make_pdf(tmp_path / "uri2.pdf",
                    [{"text": "contact me",
                      "links": [(fitz.Rect(72, 90, 140, 105), "https://real.example/a")]}])
    output = _good_output(pdf)
    output["blocks"][0]["text"] = "contact [me](<https://evil.example/pwn>)"
    result = verify(output, pdf)
    assert "V3_no_fabricated_uri" in result["failed"]
    assert "block@1.text" in _checks(result)["V3_no_fabricated_uri"]["detail"]


# ============================ V4 坏字形 ============================
def test_v4_bad_glyph_in_body(tmp_path):
    """正文出现 U+FFFD / (cid:N) → V4 失败（两条都测）。"""
    pdf = _make_pdf(tmp_path / "glyph.pdf", [{"text": "Hello"}])
    for bad in ("Hel\ufffdlo", "Hel(cid:12)lo"):
        output = _good_output(pdf)
        output["blocks"][0]["text"] = bad
        result = verify(output, pdf)
        assert "V4_no_bad_glyph_in_body" in result["failed"], bad
        assert "坏字形" in _checks(result)["V4_no_bad_glyph_in_body"]["detail"]


# ============================ V5 无文本页必须标 visual ============================
def test_v5_low_text_page_with_graphics(tmp_path):
    """页字符 <80 且有图形却没声明 → V5 失败；声明后通过。"""
    pdf = _make_pdf(tmp_path / "visual.pdf", [{"text": "short", "graphics": True}])
    output = _good_output(pdf)
    result = verify(output, pdf)
    assert "V5_visual_page_declared" in result["failed"]
    assert "第 [1] 页字符 <80" in _checks(result)["V5_visual_page_declared"]["detail"]

    fixed = _good_output(pdf)
    fixed["issues"] = [{"code": "unread_visual_page", "message": "low-text page",
                        "location": {"page": 1}}]
    fixed["needs_visual"] = True
    fixed["completeness"] = "partial"
    result2 = verify(fixed, pdf)
    assert _checks(result2)["V5_visual_page_declared"]["ok"]
    assert result2["passed"], json.dumps(result2, ensure_ascii=False, indent=1)


# ============================ V6 加密 ============================
def _encrypted_pdf(path: Path, text: str = "secret resume") -> Path:
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 100), text, fontsize=11)
    doc.save(str(path), encryption=fitz.PDF_ENCRYPT_AES_256,
             owner_pw="owner", user_pw="user")
    doc.close()
    return path


def test_v6_encrypted_must_report_code(tmp_path):
    """加密 PDF 未报 encrypted_pdf（还标 complete）→ V6 失败；报了才通过。"""
    pdf = _encrypted_pdf(tmp_path / "enc.pdf")
    native = _native(pdf)
    assert native.encrypted and not native.readable

    silent = {"blocks": [], "text": "", "completeness": "complete", "issues": [],
              "needs_visual": False, "links": [], "meta": {"pages": 1, "page_info": []}}
    result = verify(silent, pdf, native=native)
    assert "V6_encrypted_or_damaged_reported" in result["failed"]

    declared = {"blocks": [], "text": "", "completeness": "partial",
                "issues": [{"code": "encrypted_pdf", "message": "needs password"}],
                "needs_visual": True, "links": [], "meta": {"pages": 1, "page_info": []}}
    result2 = verify(declared, pdf, native=native)
    assert _checks(result2)["V6_encrypted_or_damaged_reported"]["ok"]
    # 基准读不到 → V2/V5 记为 skipped，不冒充 pass
    assert "V2_char_identity" in result2["skipped"]
    assert "V5_visual_page_declared" in result2["skipped"]


# ============================ V7 声明一致性 ============================
def test_v7_hard_issue_marked_complete(tmp_path):
    """有 HARD issue 却标 complete → V7 失败（doc 12 INJ-04）。"""
    pdf = _make_pdf(tmp_path / "v7.pdf", [{"text": "Hello"}])
    output = _good_output(pdf)
    output["issues"] = [{"code": "pdf_text_encoding_unread", "message": "x",
                         "location": {"page": 1}}]
    output["completeness"] = "complete"
    result = verify(output, pdf)
    assert "V7_completeness_consistency" in result["failed"]
    assert "HARD issue" in _checks(result)["V7_completeness_consistency"]["detail"]


def test_v7_unknown_code_treated_as_hard(tmp_path):
    """未知 code 一律按 HARD（doc 11 §1）；不许靠起个新名字降级。"""
    pdf = _make_pdf(tmp_path / "v7b.pdf", [{"text": "Hello"}])
    output = _good_output(pdf)
    output["issues"] = [{"code": "totally_new_code", "message": "x"}]
    output["completeness"] = "complete"
    result = verify(output, pdf)
    assert "V7_completeness_consistency" in result["failed"]
    assert "totally_new_code" in _checks(result)["V7_completeness_consistency"]["detail"]


def test_v7_needs_visual_marked_complete(tmp_path):
    """needs_visual=true 却标 complete → V7 失败。"""
    pdf = _make_pdf(tmp_path / "v7c.pdf", [{"text": "Hello"}])
    output = _good_output(pdf)
    output["needs_visual"] = True
    output["completeness"] = "complete"
    result = verify(output, pdf)
    assert "V7_completeness_consistency" in result["failed"]


# ============================ V8 幂等 ============================
def test_v8_timestamp_and_path_are_ignored(tmp_path):
    """两次输出只差时间戳/绝对路径 → 判为幂等。"""
    pdf = _make_pdf(tmp_path / "idem.pdf", [{"text": "Hello"}])
    first = _good_output(pdf)
    second = _good_output(pdf)
    second["meta"]["timestamp"] = "2026-11-13T00:00:00"
    second["meta"]["path"] = r"D:\some\other\place.pdf"
    result = verify(first, pdf, second_output=second)
    assert _checks(result)["V8_idempotent"]["ok"]


def test_v8_detects_real_difference(tmp_path):
    """两次输出正文差一个字符 → V8 失败（doc 12 红线 4）。"""
    pdf = _make_pdf(tmp_path / "idem2.pdf", [{"text": "Hello"}])
    first = _good_output(pdf)
    second = json.loads(json.dumps(first))
    second["blocks"][0]["text"] = "Hellp"
    result = verify(first, pdf, second_output=second)
    assert "V8_idempotent" in result["failed"]
    assert "两次输出不同" in _checks(result)["V8_idempotent"]["detail"]


def test_v8_skipped_without_second_run(tmp_path):
    """没给第二次输出 → V8 记 skipped，不冒充通过、也不算失败。"""
    pdf = _make_pdf(tmp_path / "idem3.pdf", [{"text": "Hello"}])
    result = verify(_good_output(pdf), pdf)
    assert "V8_idempotent" in result["skipped"]
    assert result["summary"]["skipped"] == 1
    assert result["passed"]


# ============================ 噪声剔除的声明 ============================
def test_noise_removal_counts_when_declared(tmp_path):
    """把平台噪声移出正文但**逐块记录** → V2 允许（doc 11 §9.5 要求排除有记录）。"""
    pdf = _make_pdf(tmp_path / "noise.pdf", [{"text": "Hello BOSSZHIPIN"}])
    native = _native(pdf)
    fake_pages = ["Hello BOSSZHIPIN"]
    fake = NativeDoc(opened=True, readable=True, page_count=1, pages=fake_pages,
                     graphics=[False], uris=set())
    output = {
        "blocks": [{"kind": "paragraph", "text": "Hello",
                    "location": {"page": 1, "bbox": [0, 0, 1, 1]}, "links": []}],
        "text": "Hello", "completeness": "partial",
        "issues": [{"code": "platform_noise_excluded", "message": "1 block removed",
                    "location": {"page": 1, "bbox": [0, 0, 1, 1]}}],
        "needs_visual": False, "links": [],
        "noise": [{"page": 1, "bbox": [0, 0, 1, 1], "text": "BOSSZHIPIN"}],
        "meta": {"pages": 1, "page_info": [{"page": 1, "encoding_removed": "",
                                            "noise_removed": "BOSSZHIPIN"}]},
    }
    result = verify(output, pdf, native=fake)
    assert _checks(result)["V2_char_identity"]["ok"], _checks(result)["V2_char_identity"]
    assert "噪声 10 字" in _checks(result)["V2_char_identity"]["detail"]
    assert native.page_count == 1


def test_noise_removal_without_record_fails():
    """声明剔除了噪声，却没有 noise[] 记录 → V2 失败（剔除必须留痕）。"""
    fake = NativeDoc(opened=True, readable=True, page_count=1, pages=["Hello BOSS"],
                     graphics=[False], uris=set())
    output = {
        "blocks": [{"kind": "paragraph", "text": "Hello",
                    "location": {"page": 1, "bbox": [0, 0, 1, 1]}, "links": []}],
        "text": "Hello", "completeness": "partial",
        "issues": [{"code": "platform_noise_excluded", "message": "removed"}],
        "needs_visual": False, "links": [], "noise": [],
        "meta": {"pages": 1, "page_info": [{"page": 1, "noise_removed": " BOSS"}]},
    }
    result = verify(output, "unused.pdf", native=fake)
    assert "V2_char_identity" in result["failed"]
    assert "剔除无记录" in _checks(result)["V2_char_identity"]["detail"]


# ============================ 输入校验 ============================
def test_verify_rejects_non_json_payload(tmp_path):
    """输出不是 JSON 对象 → 抛 VerifyInputError（不能悄悄判通过）。"""
    with pytest.raises(VerifyInputError):
        verify(["not", "an", "output"], "any.pdf")
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    with pytest.raises(VerifyInputError):
        verify(bad, "any.pdf")
