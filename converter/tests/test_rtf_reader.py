"""RTF reader tests (pure Python backend: striprtf).

All samples are **synthetic** (fake names / example.invalid / 138 0000 xxxx);
the real corpus is never read here (R7).  No corpus originals are required, so
these tests run under ``--no-corpus`` (the CI mode).

What is pinned (this is the acceptance contract for the RTF gap):

1. dispatch is by **content**, not extension (RTF renamed .pdf still reads as RTF;
   PDF renamed .rtf still reads as PDF);
2. extracted characters are real RTF native text: ``provenance = native_text`` and
   the field layer propagates it per block (no OCR / model claim);
3. **no fabricated layout**: blocks carry paragraph order; ``page`` is emitted only
   when the RTF declares no hard page break; never a bbox; ``order_verified`` stays
   False and ``layout_backend`` stays None;
4. ``\\ansicpg`` / ``\\fcharset`` / ``\\uN`` decoding works (the real corpus RTF is
   ``\\ansicpg936`` with 8897 hex escapes, so this path is not optional);
5. honest failure paths: empty RTF -> HARD ``rtf_no_text``; undecodable bytes ->
   HARD ``rtf_text_encoding_unread`` and the markers are stripped from the body;
   embedded images -> declared, never OCR'd or silently dropped.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from src import content, issues, pdf_reader, reader, rtf_reader  # noqa: E402


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _assert_legal_failure(result: dict) -> None:
    """失败必须是合法内容：0 块 + HARD + partial，绝不当 complete。"""
    assert result["blocks"] == []
    assert result["completeness"] == "partial"
    assert issues.issue_severity(result.get("issues"))[0] is True


def _hard_codes(result: dict) -> list[str]:
    return issues.hard_codes(result.get("issues"))


def _has_page(result: dict) -> bool:
    return any((block.get("location") or {}).get("page") is not None
               for block in result.get("blocks") or [])


def test_rtf_extracts_native_text_and_propagates_field_provenance(tmp_path):
    """RTF 正文是原生文本：block/field provenance 不得冒充 OCR，也不得凭空是 native。"""
    rtf = tmp_path / "synthetic-resume.rtf"
    rtf.write_text(
        r"{\rtf1\ansi\ansicpg1252{\fonttbl{\f0\fnil Arial;}}\f0"
        r"\pard SYNTHETIC SAMPLE - NOT A REAL RESUME\par"
        r"\pard Candidate Example Rtf\par"
        r"\pard Phone: 138 0000 0000   Email: demo.candidate@example.invalid\par"
        r"\pard Work experience\par"
        r"\pard 2021.07 - 2024.06  Example Technology Ltd  Backend Engineer\par"
        r"\pard Education\par"
        r"\pard 2015.09 - 2019.06  Example University  Computer Science\par"
        r"}",
        encoding="utf-8",
    )
    result = rtf_reader.read_rtf(str(rtf))

    assert result["meta"]["source_sha256"] == _sha256(rtf.read_bytes())
    assert result["meta"]["backend"].startswith("striprtf/")
    assert result["meta"]["pages"] == 1
    assert result["meta"]["order_verified"] is False, "RTF 不重建版面，不许声明 order_verified"
    assert result["meta"]["layout_backend"] is None, "RTF 没有版面后端，不许编一个"
    assert result["meta"]["page_info"][0]["page"] == 1

    blocks = result["blocks"]
    assert len(blocks) >= 6
    assert {block["provenance"] for block in blocks} == {"native_text"}
    # 原文逐字保留（不归一化掉电话号码里的空格、不重排表格列）
    joined = "\n".join(block["text"] for block in blocks)
    assert "138 0000 0000" in joined
    assert "demo.candidate@example.invalid" in joined

    # 没有编造 bbox；单页文件里 page=1 是格式等价事实（RTF 无分页符）
    for block in blocks:
        location = block["location"]
        assert "bbox" not in location
        assert location["page"] == 1
        assert isinstance(location["paragraph"], int)
    assert [block["location"]["paragraph"] for block in blocks] == list(range(len(blocks)))

    # 字段层复用 resume_fields：来源逐块传播，字段值来自原生文本
    fields = result["fields"]
    assert fields["phone"]["state"] == "present"
    assert fields["phone"]["provenance"] == "native_text"
    assert fields["email"]["state"] == "present"
    assert fields["email"]["provenance"] == "native_text"
    assert "phone" in result["screening"]["identity_merge_eligible"]
    assert "email" in result["screening"]["identity_merge_eligible"]
    # 没有宏观 issue 时 completeness 才能是 complete（有 issue 时 result() 统一降级）
    assert result["completeness"] == "complete", result["issues"]


def test_rtf_ansicpg_and_unicode_escapes_decode(tmp_path):
    """真实语料 RTF 是 \\ansicpg936 + \\'hh + \\uN；这条路径必须通。"""
    # 中文 = GBK bytes d6 d0 ce c4；另一个字符用 \uN 形式（\u20013? = 中）
    rtf = tmp_path / "cjk.rtf"
    rtf.write_text(
        r"{\rtf1\ansi\ansicpg936{\fonttbl{\f0\fnil\fcharset134 SimSun;}}\f0"
        r" \'d6\'d0\'ce\'c4\par"
        r" \u20013?\u25991?\par"
        r"}",
        encoding="ascii",
    )
    result = rtf_reader.read_rtf(str(rtf))
    joined = "\n".join(block["text"] for block in result["blocks"])
    assert joined.count("中文") == 2, "两行都必须是解码后的中文"
    assert result["meta"]["rtf"]["ansicpg"] == "cp936"
    assert result["meta"]["rtf"]["fcharsets"] == ["134"]
    assert result["meta"]["rtf"]["hex_escapes"] == 4
    assert result["meta"]["rtf"]["unicode_escapes"] == 2


def test_rtf_embedded_image_is_declared_not_read(tmp_path):
    """RTF 内嵌图片不读，但必须**声明**（不许静默丢弃，也不许冒充已读）。"""
    rtf = tmp_path / "with-image.rtf"
    rtf.write_text(
        r"{\rtf1\ansi\ansicpg1252 \pard Text before image\par"
        r"{\pict\pngblip\picw1\pich1 89504e470d0a1a0a}\par"
        r" Text after image\par}",
        encoding="ascii",
    )
    result = rtf_reader.read_rtf(str(rtf))

    codes = [issue["code"] for issue in result["issues"]]
    assert "unverified_rtf_embedded_image" in codes
    image_issue = next(i for i in result["issues"] if i["code"] == "unverified_rtf_embedded_image")
    assert issues.issue_severity([image_issue])[0] is False, "只有文本没读才算 HARD；图片是未核而不是读崩"
    assert result["meta"]["rtf"]["images"] == 1
    assert result["completeness"] == "partial"
    # 文字仍然读出来了；图片的十六进制载荷没有混进正文
    joined = "\n".join(block["text"] for block in result["blocks"])
    assert "Text before image" in joined
    assert "Text after image" in joined
    assert "89504e47" not in joined


def test_rtf_empty_text_is_hard_failure(tmp_path):
    """空 RTF 不能冒充'读完了但内容为空'：block 为空 + HARD rtf_no_text。"""
    rtf = tmp_path / "empty.rtf"
    rtf.write_text(r"{\rtf1\ansi \par \par}", encoding="ascii")
    result = rtf_reader.read_rtf(str(rtf))

    assert result["blocks"] == []
    assert "rtf_no_text" in _hard_codes(result)
    assert result["completeness"] == "partial"
    assert issues.issue_severity(result["issues"])[0] is True


def test_rtf_undecodable_bytes_are_stripped_and_declared(tmp_path):
    """解不出的字节：从正文剔除 + HARD 声明（与 PDF 的 encoding_unread 同口径）。"""
    rtf = tmp_path / "bad-encoding.rtf"
    rtf.write_text(
        r"{\rtf1\ansi\ansicpg936 \'ff\'fe invalid\par\pard legacy ok\par}",
        encoding="ascii",
    )
    result = rtf_reader.read_rtf(str(rtf))

    assert "rtf_text_encoding_unread" in _hard_codes(result)
    for block in result["blocks"]:
        assert "\ufffd" not in block["text"], "坏字形不得进入正文"
    assert result["needs_visual"] is True
    assert result["completeness"] == "partial"


def test_rtf_page_breaks_are_not_attributed_to_blocks(tmp_path):
    """有硬分页符时不编页码：meta.pages 如实，block 不挂 page，另发 SOFT 声明。"""
    rtf = tmp_path / "two-pages.rtf"
    rtf.write_text(
        r"{\rtf1\ansi\ansicpg1252 Page one line\par\page Page two line\par}",
        encoding="ascii",
    )
    result = rtf_reader.read_rtf(str(rtf))

    assert result["meta"]["pages"] == 2
    assert result["meta"]["rtf"]["page_breaks"] == 1
    assert _has_page(result) is False, "不能把'未知属于哪页'伪造成第 1 页"
    codes = [issue["code"] for issue in result["issues"]]
    assert "unverified_rtf_pagination" in codes
    assert result["meta"]["page_info"] == [], "没有逐页证据就不产出 page_info 行"


def test_read_document_dispatches_by_content_not_extension(tmp_path):
    """同一份字节改成什么后缀都按内容选 reader（R1 的嗅探口径）。"""
    rtf_bytes = (r"{\rtf1\ansi\ansicpg1252 DISPATCH RTF MARKER\par}").encode("ascii")
    rtf_named_pdf = tmp_path / "actually-rtf.pdf"
    rtf_named_pdf.write_bytes(rtf_bytes)

    result = reader.read_document(str(rtf_named_pdf))
    assert result["meta"]["backend"].startswith("striprtf/")
    assert reader.sniff_format(str(rtf_named_pdf)) == reader.FORMAT_RTF

    # PDF 字节改成 .rtf：仍然走 PyMuPDF
    import fitz

    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "DISPATCH PDF MARKER", fontname="helv")
    pdf_named_rtf = tmp_path / "actually-pdf.rtf"
    doc.save(str(pdf_named_rtf))
    doc.close()

    result = reader.read_document(str(pdf_named_rtf))
    assert result["meta"]["backend"] == pdf_reader.BACKEND
    assert any("DISPATCH PDF MARKER" in block["text"] for block in result["blocks"])


def test_read_document_unknown_bytes_fail_closed(tmp_path):
    """未知字节不猜 reader：合法失败（0 块 + HARD reader_failed）。"""
    junk = tmp_path / "not-a-document.bin"
    junk.write_bytes(bytes(range(10)))
    result = reader.read_document(str(junk))
    _assert_legal_failure(result)
    assert "reader_failed" in _hard_codes(result)


def test_read_rtf_missing_file_is_a_legal_failure(tmp_path):
    """文件不存在：合法失败结果，不是异常也不是空成功。"""
    result = rtf_reader.read_rtf(str(tmp_path / "does-not-exist.rtf"))
    _assert_legal_failure(result)
    assert "reader_failed" in _hard_codes(result)


def test_rtf_issue_codes_registered_with_expected_severity():
    """新增 code 必须登记（未登记按 HARD 兜底，不允许漂移成'看起来不要紧'）。"""
    assert "rtf_no_text" in issues.ADDED_CODES
    assert issues.ADDED_CODES["rtf_no_text"][0] == "hard"
    assert "rtf_text_encoding_unread" in issues.ADDED_CODES
    assert issues.ADDED_CODES["rtf_text_encoding_unread"][0] == "hard"
    # 两个 unverified_* RTF code 走既有 SOFT 前缀规则，不另立分级
    for code in ("unverified_rtf_embedded_image", "unverified_rtf_visual_content",
                 "unverified_rtf_pagination"):
        assert issues.issue_severity([{"code": code}])[0] is False


def test_striprtf_dependency_is_declared():
    """部署面：requirements.txt 必须声明 striprtf（CI 直接 pip install 这个文件）。"""
    requirements = (Path(__file__).resolve().parents[1] / "requirements.txt").read_text(encoding="utf-8")
    assert "striprtf" in requirements
    assert rtf_reader._rtf_version() != "unavailable", "本机 Python 必须能 import striprtf"


def test_rtf_result_shape_matches_converter_contract(tmp_path):
    """形状与 content.result() 一致：下游 map-converter 才能无损搬运。"""
    rtf = tmp_path / "shape.rtf"
    rtf.write_text(r"{\rtf1\ansi\ansicpg1252 One paragraph\par}", encoding="ascii")
    result = rtf_reader.read_rtf(str(rtf))
    for key in ("text", "blocks", "title", "chars", "completeness", "issues",
                "needs_visual", "warnings", "meta", "links", "fields", "noise",
                "protected_attributes", "screening", "timeline"):
        assert key in result, f"缺少 content.result() 的键 {key}"
    assert isinstance(result["blocks"], list)
    block = result["blocks"][0]
    assert set(block) >= {"kind", "text", "location", "links", "provenance"}
    assert content.normalize(block["text"]) == block["text"]
