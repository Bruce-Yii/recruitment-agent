"""RTF reader tests (pure Python backend: striprtf).

All samples are **synthetic** (fake names / example.invalid / 138 0000 xxxx);
the real corpus is never read here (R7).  No corpus originals are required, so
these tests run under ``--no-corpus`` (the CI mode).

What is pinned (this is the acceptance contract for the RTF gap):

1. dispatch is by **content**, not extension (RTF renamed .pdf still reads as RTF;
   PDF renamed .rtf still reads as PDF);
2. extracted characters are real RTF native text: ``provenance = native_text`` and
   the field layer propagates it per block (no OCR / model claim);
3. **provable reading order** (doc1-A, 2026-11-15): RTF is a linear text stream
   plus declared hard page breaks (``\\page``).  Body-level ``\\page`` is mapped
   onto paragraphs with a random sentinel, so a single-page RTF and a multi-page
   RTF with plain ``\\page`` breaks get ``order_verified=True``, a per-block
   ``location = {page, paragraph}``, one ``page_info`` row per page and a
   ``meta.order_basis`` proof record.  ``layout_backend`` stays ``None`` and no
   ``bbox`` is ever invented;
4. **fail closed** when the page map cannot be proven: a ``\\page`` inside a
   non-body destination (``\\header`` / ``{\\* ...}``) makes the declared count
   differ from the mappable body count -> no block carries a page,
   ``page_info=[]``, ``unverified_rtf_pagination``, ``order_verified=False``; a
   section break (``\\sect`` / ``\\sbkpage``) also blocks page attribution
   because section page setup is not reconstructed;
5. **unprovable 2-D constructs** keep ``order_verified=False`` while the text is
   still extracted: tables (``\\trowd`` -> ``unverified_rtf_table``),
   multi-column (``\\cols N>1`` -> ``unverified_rtf_multicolumn``), frames
   (``-> unverified_rtf_frame``), text boxes/shapes (-> the existing
   ``unverified_rtf_visual_content``); cell/frame text is kept verbatim and no
   cell bbox is invented;
6. ``\\ansicpg`` / ``\\fcharset`` / ``\\uN`` decoding works (the real corpus RTF is
   ``\\ansicpg936`` with 8897 hex escapes, so this path is not optional);
7. honest failure paths: empty RTF -> HARD ``rtf_no_text``; undecodable bytes ->
   HARD ``rtf_text_encoding_unread`` and the markers are stripped from the body;
   embedded images -> declared, never OCR'd or silently dropped.

Notes on assertion changes (2026-11-15): the two old assertions
``meta.order_verified is False`` and "page breaks are never attributed to blocks"
were **replaced by the stricter 2026-11-15 contract above** (verified order must
also have a complete ``order_basis`` and every failure mode is pinned separately)
— this is a re-scoped contract, not a relaxed assertion.  No block ``kind`` or
``provenance`` whitelist of ``test_fidelity`` is reused here (RTF blocks are
``paragraph`` + ``native_text``; that whitelist is corpus-PDF specific).
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


def _codes(result: dict) -> list[str]:
    return [issue["code"] for issue in result.get("issues") or []]


def _has_page(result: dict) -> bool:
    return any((block.get("location") or {}).get("page") is not None
               for block in result.get("blocks") or [])


def _pages(result: dict) -> list[int]:
    return [(block.get("location") or {}).get("page") for block in result.get("blocks") or []]


def _paragraph_indices(result: dict) -> list[int]:
    return [(block.get("location") or {}).get("paragraph")
            for block in result.get("blocks") or []]


def _assert_no_bbox(result: dict) -> None:
    """RTF 是文本流：任何 block 都不许编 bbox。"""
    for block in result.get("blocks") or []:
        assert "bbox" not in (block.get("location") or {}), block["location"]


def _assert_pagination_failed_closed(result: dict) -> dict:
    """分页映射失败的统一判据：无页、无 page_info、声明为未核。"""
    meta = result["meta"]
    assert meta["order_verified"] is False
    assert "unverified_rtf_pagination" in _codes(result)
    assert _has_page(result) is False, "不能把'未知属于哪页'伪造成任何页号"
    assert meta["page_info"] == [], "没有逐页证据就不产出 page_info 行"
    basis = meta["order_basis"]
    assert basis["page_mapping"]["status"] == "failed"
    assert basis["pages_mapped"] == 0
    assert basis["page_mapping"]["reason"], "失败必须写原因，不能只有一个 false"
    return basis


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
    # 2026-11-15 契约：单页 RTF 的线性顺序 + 无硬分页是可证的，不再恒 false。
    assert result["meta"]["order_verified"] is True, "单页线性文本顺序可证，必须能声明"
    assert result["meta"]["layout_backend"] is None, "RTF 没有几何版面后端，不许编一个"
    assert len(result["meta"]["page_info"]) == 1
    assert result["meta"]["page_info"][0]["page"] == 1
    assert result["meta"]["page_info"][0]["readable"] is True

    basis = result["meta"]["order_basis"]
    assert basis["method"] == rtf_reader.ORDER_METHOD
    assert basis["page_mapping"]["status"] == "ok"
    assert basis["page_mapping"]["sentinels_expected"] == 0
    assert basis["page_mapping"]["sentinels_found"] == 0
    assert basis["source_page_breaks"] == 0
    assert basis["pages_mapped"] == 1
    assert basis["unprovable_constructs"] == []
    assert basis["page_sequence_monotonic"] is True
    assert basis["paragraph_indices_contiguous"] is True
    assert set(basis["constructs_checked"]) >= {
        "trowd", "cols", "frames", "frame", "shp", "shptxt", "txbxContent",
        "sect", "sbkpage"}

    blocks = result["blocks"]
    assert len(blocks) >= 6
    assert basis["paragraphs"] == len(blocks)
    assert {block["provenance"] for block in blocks} == {"native_text"}
    assert {block["kind"] for block in blocks} == {"paragraph"}, "RTF 不新增 block kind"
    # 原文逐字保留（不归一化掉电话号码里的空格、不重排表格列）
    joined = "\n".join(block["text"] for block in blocks)
    assert "138 0000 0000" in joined
    assert "demo.candidate@example.invalid" in joined

    # 没有编造 bbox；页 1 由硬分页映射证明（无分页符 = 全部确实在第 1 页）
    _assert_no_bbox(result)
    assert _pages(result) == [1] * len(blocks)
    assert _paragraph_indices(result) == list(range(len(blocks)))
    assert [row["page"] for row in result["meta"]["page_info"]] == [1]

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


def test_rtf_hard_page_breaks_are_mapped_to_blocks(tmp_path):
    """A\\par\\page B\\par\\page C：硬分页映射成功 → 页序 1,2,3，每页文本正确。"""
    rtf = tmp_path / "three-pages.rtf"
    rtf.write_text(
        r"{\rtf1\ansi\ansicpg1252 Page one line\par\page Page two line\par\page Page three line\par}",
        encoding="ascii",
    )
    result = rtf_reader.read_rtf(str(rtf))
    meta = result["meta"]

    assert meta["pages"] == 3
    assert meta["rtf"]["page_breaks"] == 2
    assert meta["order_verified"] is True
    assert meta["layout_backend"] is None
    assert "unverified_rtf_pagination" not in _codes(result), "映射成功时不再发分页未核"
    assert result["completeness"] == "complete", result["issues"]

    blocks = result["blocks"]
    assert [block["text"] for block in blocks] == ["Page one line", "Page two line", "Page three line"]
    assert _pages(result) == [1, 2, 3]
    assert _paragraph_indices(result) == [0, 1, 2]
    _assert_no_bbox(result)

    basis = meta["order_basis"]
    assert basis["source_page_breaks"] == 2
    assert basis["pages_mapped"] == 3
    assert basis["paragraphs"] == 3
    assert basis["page_mapping"]["status"] == "ok"
    assert basis["page_mapping"]["sentinels_expected"] == 2
    assert basis["page_mapping"]["sentinels_found"] == 2
    assert basis["page_mapping"]["sentinel_isolated"] is True
    assert basis["unprovable_constructs"] == []
    assert basis["page_sequence_monotonic"] is True
    assert basis["paragraph_indices_contiguous"] is True

    page_info = meta["page_info"]
    assert len(page_info) == meta["pages"] == 3
    assert [row["page"] for row in page_info] == [1, 2, 3]
    assert [row["block_count"] for row in page_info] == [1, 1, 1]
    assert [row["chars"] for row in page_info] == [
        len("Page one line"), len("Page two line"), len("Page three line")]
    assert all(row["readable"] is True for row in page_info)


def test_rtf_multi_page_page_info_stays_one_row_per_declared_page(tmp_path):
    """空页也必须有一行 page_info（len(page_info) == meta.pages），readable=False。"""
    rtf = tmp_path / "empty-middle-page.rtf"
    rtf.write_text(
        r"{\rtf1\ansi Only page one text\par\page\page Page three text\par}",
        encoding="ascii",
    )
    result = rtf_reader.read_rtf(str(rtf))
    meta = result["meta"]

    assert meta["pages"] == 3
    assert meta["order_verified"] is True
    assert len(meta["page_info"]) == 3
    assert [row["page"] for row in meta["page_info"]] == [1, 2, 3]
    assert [row["readable"] for row in meta["page_info"]] == [True, False, True]
    assert [row["block_count"] for row in meta["page_info"]] == [1, 0, 1]
    assert meta["page_info"][1]["chars"] == 0
    assert _pages(result) == [1, 3]


@pytest.mark.parametrize("body", [
    # \page 在 header 组内：声明了分页但不是正文分页 → 映射不成立
    pytest.param(r"{\rtf1\ansi{\header Header text\page}\pard Only body paragraph\par}",
                 id="header-page"),
    # \page 在 {\* ...} 可忽略目标组内：同上
    pytest.param(r"{\rtf1\ansi{\*\unknowndest ignored text\page}\pard Only body paragraph\par}",
                 id="ignorable-destination-page"),
])
def test_rtf_unmappable_page_breaks_fail_closed(tmp_path, body):
    """source 分页计数 != 可映射 body 分页：不许挂页、不许造 page_info。"""
    rtf = tmp_path / "unmappable.rtf"
    rtf.write_text(body, encoding="ascii")
    result = rtf_reader.read_rtf(str(rtf))

    assert [block["text"] for block in result["blocks"]] == ["Only body paragraph"]
    basis = _assert_pagination_failed_closed(result)
    assert basis["source_page_breaks"] == 1
    # meta.pages 只是「声明的 \page 数 + 1」，不是已证明页数；page_info 为空即证据
    assert result["meta"]["pages"] == basis["source_page_breaks"] + 1
    assert _pages(result) == [None]
    assert _paragraph_indices(result) == [0]
    _assert_no_bbox(result)


def test_rtf_multicolumn_is_declared_and_keeps_text(tmp_path):
    """\\cols2：正文仍抽出，但列内阅读顺序不可证 → order_verified=False + SOFT 声明。"""
    rtf = tmp_path / "two-columns.rtf"
    rtf.write_text(
        r"{\rtf1\ansi\ansicpg1252\cols2 Left column text\par Right column text\par}",
        encoding="ascii",
    )
    result = rtf_reader.read_rtf(str(rtf))

    assert "unverified_rtf_multicolumn" in _codes(result)
    assert issues.issue_severity(
        [i for i in result["issues"] if i["code"] == "unverified_rtf_multicolumn"])[0] is False
    assert result["meta"]["order_verified"] is False
    # 线性文本流仍然完整：两列的文字都读出来了
    assert [block["text"] for block in result["blocks"]] == [
        "Left column text", "Right column text"]
    # 单页无硬分页 → 页 1 仍是可证事实（只有页内 2-D 顺序不可证）
    assert _pages(result) == [1, 1]
    assert result["meta"]["page_info"][0]["page"] == 1
    assert result["meta"]["page_info"][0]["readable"] is True
    _assert_no_bbox(result)
    unprovable = result["meta"]["order_basis"]["unprovable_constructs"]
    assert any(item["construct"] == "multicolumn" for item in unprovable), unprovable


def test_rtf_table_is_declared_and_cells_kept_without_bbox(tmp_path):
    """\\trowd：单元格文本仍抽出（'A1|B1|'），不伪造 bbox，order_verified=False。"""
    rtf = tmp_path / "table.rtf"
    rtf.write_text(
        r"{\rtf1\ansi\ansicpg1252\trowd\cellx1000\trowd\cellx2000 A1\cell B1\cell\row}",
        encoding="ascii",
    )
    result = rtf_reader.read_rtf(str(rtf))

    assert "unverified_rtf_table" in _codes(result)
    assert issues.issue_severity(
        [i for i in result["issues"] if i["code"] == "unverified_rtf_table"])[0] is False
    assert result["meta"]["order_verified"] is False
    joined = "\n".join(block["text"] for block in result["blocks"])
    assert "A1" in joined and "B1" in joined
    assert joined == "A1|B1|", "表格行保持 striprtf 的线性输出，不重排"
    _assert_no_bbox(result)
    assert result["meta"]["rtf"]["table_rows"] == 2
    unprovable = result["meta"]["order_basis"]["unprovable_constructs"]
    assert any(item["control_word"] == "\\trowd" for item in unprovable), unprovable


def test_rtf_frame_is_declared_and_keeps_text(tmp_path):
    """\\frames/\\frame：框架文本在正文流里，但框架几何/顺序不可证。"""
    rtf = tmp_path / "frames.rtf"
    rtf.write_text(
        r"{\rtf1\ansi\ansicpg1252\frames{\frame Frame one text\par}{\frame Frame two text\par}}",
        encoding="ascii",
    )
    result = rtf_reader.read_rtf(str(rtf))

    assert "unverified_rtf_frame" in _codes(result)
    assert result["meta"]["order_verified"] is False
    assert [block["text"] for block in result["blocks"]] == ["Frame one text", "Frame two text"]
    _assert_no_bbox(result)
    unprovable = result["meta"]["order_basis"]["unprovable_constructs"]
    assert any(item["construct"] == "frame" for item in unprovable), unprovable


def test_rtf_text_box_text_loss_is_declared(tmp_path):
    """\\shp/\\shptxt：文本框里的文字 striprtf 不输出 → 必须按已声明丢失处理。"""
    rtf = tmp_path / "textbox.rtf"
    rtf.write_text(
        r"{\rtf1\ansi\ansicpg1252 Body text\par{\shp{\shptxt Shape only text\par}}}",
        encoding="ascii",
    )
    result = rtf_reader.read_rtf(str(rtf))

    assert "unverified_rtf_visual_content" in _codes(result)
    assert result["meta"]["order_verified"] is False
    joined = "\n".join(block["text"] for block in result["blocks"])
    assert "Body text" in joined
    assert "Shape only text" not in joined, "被丢弃就必须声明，绝不能当读到了"
    unprovable = result["meta"]["order_basis"]["unprovable_constructs"]
    assert any(item["construct"] == "text_box" for item in unprovable), unprovable


@pytest.mark.parametrize("control_word", ["sect", "sbkpage"])
def test_rtf_section_breaks_block_page_attribution(tmp_path, control_word):
    """\\sect/\\sbkpage：节的分页/版式未重建 → 页归属不可证，fail-closed。"""
    rtf = tmp_path / f"section-{control_word}.rtf"
    rtf.write_text(
        r"{\rtf1\ansi\ansicpg1252 Section one\par\%s Section two\par}" % control_word,
        encoding="ascii",
    )
    result = rtf_reader.read_rtf(str(rtf))

    basis = _assert_pagination_failed_closed(result)
    assert basis["unprovable_constructs"], "不可证构造必须写进 order_basis"
    assert [block["text"] for block in result["blocks"]] == ["Section one", "Section two"]
    _assert_no_bbox(result)


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
    # 解码路径同样要能用新契约声明顺序（单页线性流）
    assert result["meta"]["order_verified"] is True


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
    # 图片不阻塞单页线性顺序的证明：页归属仍是可证事实
    assert result["meta"]["order_verified"] is True


def test_rtf_empty_text_is_hard_failure(tmp_path):
    """空 RTF 不能冒充'读完了但内容为空'：block 为空 + HARD rtf_no_text。"""
    rtf = tmp_path / "empty.rtf"
    rtf.write_text(r"{\rtf1\ansi \par \par}", encoding="ascii")
    result = rtf_reader.read_rtf(str(rtf))

    assert result["blocks"] == []
    assert "rtf_no_text" in _hard_codes(result)
    assert result["completeness"] == "partial"
    assert issues.issue_severity(result["issues"])[0] is True
    # 没有块就没有顺序可证：不许因为「没有 issue 分页」就声明 order_verified
    assert result["meta"]["order_verified"] is False


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
    # 坏字形被剔除是**已声明**的移除：页序列仍然可证
    assert result["meta"]["order_verified"] is True
    assert result["meta"]["page_info"][0]["encoding_removed"] != ""


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
    assert result["meta"]["order_verified"] is False
    assert result["meta"]["order_basis"]["page_mapping"]["status"] == "not_attempted"


def test_rtf_issue_codes_registered_with_expected_severity():
    """新增 code 必须登记（未登记按 HARD 兜底，不允许漂移成'看起来不要紧'）。"""
    assert "rtf_no_text" in issues.ADDED_CODES
    assert issues.ADDED_CODES["rtf_no_text"][0] == "hard"
    assert "rtf_text_encoding_unread" in issues.ADDED_CODES
    assert issues.ADDED_CODES["rtf_text_encoding_unread"][0] == "hard"
    # 走得通的 unverified_* RTF code 全部按既有 SOFT 前缀规则，不另立分级
    for code in ("unverified_rtf_embedded_image", "unverified_rtf_visual_content",
                 "unverified_rtf_pagination", "unverified_rtf_table",
                 "unverified_rtf_multicolumn", "unverified_rtf_frame"):
        assert issues.issue_severity([{"code": code}])[0] is False, code
    # 新增的三个 code 是前缀 SOFT，不需要（也不许）另登记成 HARD
    for code in ("unverified_rtf_table", "unverified_rtf_multicolumn", "unverified_rtf_frame"):
        assert code not in issues.ADDED_CODES, f"{code} 已由前缀规则定级，不要再登记第二套"


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
    # meta 的顺序依据必须始终存在（失败也算 not_attempted，不留空假设）
    assert "order_basis" in result["meta"]
    for key in ("method", "page_mapping", "source_page_breaks", "pages_mapped",
                "paragraphs", "constructs_checked", "unprovable_constructs",
                "page_sequence_monotonic", "paragraph_indices_contiguous"):
        assert key in result["meta"]["order_basis"], f"order_basis 缺少 {key}"
