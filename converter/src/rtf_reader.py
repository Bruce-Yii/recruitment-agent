"""RTF reader: native text extraction with **striprtf** (pure Python, no binary).

Why this module exists (2026-11-14 real corpus): the corpus contains one real
RTF resume.  MuPDF (the PDF/DOCX backend of :mod:`src.pdf_reader`) opens PDF and
OOXML but *not* RTF, so the file came back as
``READER_FAILED(UNSUPPORTED_MEDIA)`` and could never enter S6.

R1 (reuse first): three candidates were evaluated —

  * **striprtf** (chosen): pure Python, no external binary, already the
    de-facto extractor for ``\\ansicpg`` / ``\\fcharset`` / ``\\uN`` RTF text;
  * ``rtf2html`` + HTML parse: one more dependency (two libraries) and the HTML
    hop buys nothing for text extraction;
  * LibreOffice ``--convert-to docx``: best formatting fidelity, but ~500 MB
    external binary, a second process per file, and a licence/deployment
    surface that a v1.0 read-path must not take on.  Rejected.

Reading order (2026-11-15, doc1-A / D-110)
-----------------------------------------
RTF is a **linear text stream**: characters are stored in reading order and
``\\par`` separates paragraphs, so "which paragraph comes first" is a property of
the bytes, not a layout guess.  The only page structure an RTF *declares* is the
hard page break ``\\page``.  This reader now maps that declaration:

  * every **body-level** ``\\page`` is replaced, in a copy of the source and in
    one single decoding pass, with a per-process random hex sentinel; striprtf
    decodes ``\\par <sentinel>\\par`` as its own paragraph, so splitting the
    decoded text on the sentinel yields the page of every paragraph;
  * ``\\page`` inside a *non-body destination* (``\\header``/``\\footer``,
    ``\\pict``, ``\\object``, ``\\fonttbl``, ``\\stylesheet``, ``\\info``,
    ``{\\* ...}`` ...) is not a body page break and is not replaced.  If the
    declared ``\\page`` count does not equal the body-level count, the mapping
    is **unproven** and the reader fails closed: no block carries a page,
    ``page_info=[]``, ``unverified_rtf_pagination`` is declared and
    ``order_verified=False``.  A page number is never invented.
  * ``order_verified=True`` requires **all** of: proven page mapping (pages
    1..N, non-decreasing block pages), contiguous paragraph indices, and none of
    the constructs whose 2-D order a linear stream cannot prove — tables
    (``\\trowd``), multi-column layouts (``\\cols N`` with N>1), frames
    (``\\frames``/``\\frame``), text boxes/shapes (``\\shp``/``\\shptxt``/
    ``\\txbxContent``), sections/section page breaks (``\\sect``/``\\sbkpage``).
    Each such construct is declared with a SOFT ``unverified_rtf_*`` code and
    keeps ``order_verified=False``;
  * ``meta.order_basis`` records the proof itself: method, page-mapping counts,
    paragraphs, checked/unprovable constructs, page monotonicity and paragraph
    contiguity.  ``meta.layout_backend`` stays ``None``: the evidence is the
    linear stream plus the hard page-break map, not a geometric layout backend.
    No ``bbox`` is ever written on RTF blocks.

Provenance (must match the project's red line, doc 11 §9.7 / D-67)
-----------------------------------------------------------------
RTF is a *text* container: the characters live in the file as RTF control words
and escaped bytes.  Decoding them is the same work a PDF text layer does (no
OCR, no model output), so the extracted blocks are ``provenance = "native_text"``.
This is **not** a claim that layout was reconstructed: only the linear order and
declared page breaks are used; columns / frames / table geometry stay unverified.

  * embedded images (``\\pict``) and objects are **not** read.  They are
    declared with ``unverified_rtf_embedded_image`` / ``unverified_rtf_visual_content``
    (``unverified_*`` SOFT codes) instead of being silently dropped; the plugin
    quality layer treats an unverified image as a HARD layout-only blocker,
    exactly like ``unverified_pdf_image``;
  * bytes that cannot be decoded become U+FFFD; they are stripped from the body
    and declared with ``rtf_text_encoding_unread`` (HARD, the same contract as
    ``pdf_text_encoding_unread``).

The recruitment field layer (``resume_fields.analyze``) is reused unchanged, so
phone/email extraction, tri-state fields, protected attributes and timeline
follow the same rules as PDF/DOCX.  Field provenance is propagated per block by
``resume_fields._provenance_of`` — this module never overwrites it.
"""
from __future__ import annotations

import hashlib
import re
import secrets
from pathlib import Path

from . import __version__, content, resume_fields, structure as st

#: Stable backend id recorded in ``meta.backend`` (R4: who read the bytes).
BACKEND_PREFIX = "striprtf"

#: ``meta.order_basis.method``: the proof is the linear text stream plus the map
#: of declared hard page breaks — explicitly **not** a layout backend.
ORDER_METHOD = "linear-text-flow+hard-page-break-map"

_PICT_RE = re.compile(r"\\pict(?![a-zA-Z])")
_OBJECT_RE = re.compile(r"\\object(?![a-zA-Z])")
_PAGE_RE = re.compile(r"\\page(?![a-zA-Z])")
_PAR_RE = re.compile(r"\\par(?![a-zA-Z])")
_TROWD_RE = re.compile(r"\\trowd(?![a-zA-Z])")
_ANSICPG_RE = re.compile(r"\\ansicpg(\d+)")
_FCHARSET_RE = re.compile(r"\\fcharset(\d+)")
_HEX_ESCAPE_RE = re.compile(r"\\'[0-9a-fA-F]{2}")
_HEADER_FOOTER_RE = re.compile(r"\\(?:header|footer)[a-z]?(?![a-zA-Z])")
# C0 控制字符（保留 \t \n \r）：它们是合法排版空白，其它控制字符是解码残渣。
_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

#: RTF 的 ``\uN`` 是 16 位有符号整数：负值表示 N + 65536。
_U_ESCAPE_RE = re.compile(r"\\u(-?\d+)")

#: RTF 控制词：``\`` + 字母 + 可选数值参数（``\page`` 无参数；参数一起吃掉更稳）。
_CONTROL_WORD_RE = re.compile(r"\\([a-zA-Z]+)(-?\d+)?")

#: 不输出正文的目标组（destination）。组内 ``\page`` 不是**正文**分页，组内
#: 文字也不进正文流；striprtf 对这些组同样不输出，所以「哨兵数 == body 分页数」
#: 只有在两边的判定口径一致时才成立。
_NON_BODY_DESTINATIONS = frozenset({
    "pict", "object", "objdata", "objclass", "objname", "objectdata", "nonshppict",
    "fonttbl", "filetbl", "stylesheet", "info", "colortbl", "revtbl", "rsidtbl",
    "generator", "xmlnstbl", "datastore", "themedata", "colorschememapping",
    "latentstyles", "panose", "falt", "pgptbl", "blipuid", "private",
    "listtable", "listoverridetable", "listname", "listlevel",
    "footnote", "annotation", "upr", "nonesttables", "wgrffmtfilter",
})

#: 线性文本流**无法证明** 2-D 顺序的构造（出现即 order_verified=False）。
_CONSTRUCT_NAMES = ("trowd", "cols", "frames", "frame", "shp", "shptxt",
                    "txbxContent", "sect", "sbkpage")

#: 每种不可证构造 → 声明的 SOFT code（``unverified_`` 前缀自动 SOFT）。
_CONSTRUCT_CODE = {
    "trowd": ("table", "unverified_rtf_table"),
    "cols": ("multicolumn", "unverified_rtf_multicolumn"),
    "frames": ("frame", "unverified_rtf_frame"),
    "frame": ("frame", "unverified_rtf_frame"),
    "shp": ("text_box", "unverified_rtf_visual_content"),
    "shptxt": ("text_box", "unverified_rtf_visual_content"),
    "txbxContent": ("text_box", "unverified_rtf_visual_content"),
    "sect": ("section", "unverified_rtf_pagination"),
    "sbkpage": ("section_page_break", "unverified_rtf_pagination"),
}

#: 一个转义控制符号（`\|` 等）的字节长度。
_SENTINEL_ATTEMPTS = 8


def _rtf_version() -> str:
    """striprtf 版本；拿不到就如实写 ``unavailable``（不猜）。"""
    try:
        import striprtf
        return str(getattr(striprtf, "__version__", "unknown"))
    except Exception:  # noqa: BLE001 - 缺失由调用方按 reader_failed 处理
        return "unavailable"


def _failed(path: Path, sha: str | None, code: str, message: str, *,
            needs_visual: bool = False) -> dict:
    """读取失败的合法结果：0 块 + HARD issue + partial（绝不冒充 complete）。"""
    return content.result(
        blocks=[], completeness="partial", needs_visual=needs_visual,
        issues=[{"code": code, "message": message}],
        meta={"pages": 0, "source_sha256": sha, "source_name": path.name,
              "backend": f"{BACKEND_PREFIX}/{_rtf_version()}", "reader_version": __version__,
              "page_info": [], "layout_backend": None, "order_verified": False,
              "repaired": False, "failed": True,
              # 读失败了就没有阅读顺序可证明：如实写 not_attempted，不留空 provider 假设。
              "order_basis": {"method": ORDER_METHOD,
                              "page_mapping": {"status": "not_attempted",
                                               "method": "sentinel-split",
                                               "source_page_breaks": 0,
                                               "body_page_breaks": 0,
                                               "sentinels_expected": 0,
                                               "sentinels_found": 0,
                                               "sentinel_isolated": None,
                                               "reason": "read_failed"},
                              "source_page_breaks": 0, "pages_mapped": 0,
                              "paragraphs": 0, "constructs_checked": [],
                              "unprovable_constructs": [],
                              "page_sequence_monotonic": False,
                              "paragraph_indices_contiguous": False}},
        extra={"fields": resume_fields.empty_fields(code),
               "noise": [],
               "protected_attributes": resume_fields.empty_protected(code),
               "screening": resume_fields.empty_screening(code),
               "timeline": {}})


def _strip_unreadable(text: str) -> tuple[str, str]:
    """剔除无法解码的字节标记，返回 (干净文本, 被剔除的字符)。

    RTF 的 ``\\'hh`` 序列按 ``\\ansicpg`` / ``\\fcharset`` 解码；解不出来的字节
    会变成 U+FFFD。它们不是原文内容，而是「这一层没解出来」的标记，因此
    从正文剔除并**逐份声明**（``rtf_text_encoding_unread``），与 PDF 的
    ``strip_unreadable`` 同一口径。
    """
    removed: list[str] = []

    def _drop(match):
        removed.append(match.group(0))
        return ""

    clean = _CTRL_RE.sub(_drop, text or "")
    if "\ufffd" in clean:
        removed.append("\ufffd" * clean.count("\ufffd"))
        clean = clean.replace("\ufffd", "")
    return clean, "".join(removed)


def _ansicpg(text: str) -> str | None:
    match = _ANSICPG_RE.search(text)
    return f"cp{match.group(1)}" if match else None


# ============================ 阅读顺序的依据 ============================
def _group_destination(source: str, brace_index: int) -> str | None:
    """返回 ``{`` 之后的目标组名（destination）；没有目标词返回 ``None``。

    ``{\\* ...}`` 是「可忽略目标组」，返回 ``"*"``。
    """
    index = brace_index + 1
    if index >= len(source) or source[index] != "\\":
        return None
    if index + 1 < len(source) and source[index + 1] == "*":
        return "*"
    match = _CONTROL_WORD_RE.match(source, index)
    return match.group(1) if match else None


def _is_non_body_destination(word: str) -> bool:
    """该目标组的文字是否**不**进正文流（striprtf 同样不输出）。"""
    if word.startswith("header") or word.startswith("footer"):
        return True
    return word in _NON_BODY_DESTINATIONS


def _scan_rtf(source: str) -> dict:
    """单次线性扫描：body 级 ``\\page`` 位置 + 不可证构造计数。

    只统计**正文层**（emit=True）的控制词：``\\page`` 在 header/footer/pict/
    object/fonttbl/stylesheet/info/``\\*`` 等目标组里不算正文分页；``\\trowd``
    等构造也只在正文层影响阅读顺序。
    """
    page_positions: list[int] = []
    constructs = {name: 0 for name in _CONSTRUCT_NAMES}
    emit_stack = [True]  # 每层组是否输出正文（根组 = True）
    index = 0
    length = len(source)
    while index < length:
        char = source[index]
        if char == "{":
            destination = _group_destination(source, index)
            ignored = destination == "*" or (
                destination is not None and _is_non_body_destination(destination))
            emit_stack.append(emit_stack[-1] and not ignored)
            index += 1
            continue
        if char == "}":
            if len(emit_stack) > 1:
                emit_stack.pop()
            index += 1
            continue
        if char != "\\":
            index += 1
            continue
        following = source[index + 1] if index + 1 < length else ""
        if following in ("\\", "{", "}"):
            index += 2  # 转义的字面字符，不是控制词
            continue
        if following == "'":
            index += 4  # \'hh 十六进制字节
            continue
        match = _CONTROL_WORD_RE.match(source, index)
        if match is None:
            index += 2 if following else 1  # 控制符号（\~ \- \_ / 行尾反斜杠）
            continue
        word, parameter = match.group(1), match.group(2)
        if emit_stack[-1]:
            if word == "page":
                page_positions.append(index)
            elif word == "trowd":
                constructs["trowd"] += 1
            elif word == "cols":
                value = int(parameter) if parameter and parameter.lstrip("-").isdigit() else 1
                if value > 1:
                    constructs["cols"] += 1
            elif word in constructs:
                constructs[word] += 1
        if word == "bin":
            size = int(parameter) if parameter and parameter.isdigit() else 0
            end = match.end()
            if end < length and source[end] == " ":
                end += 1
            index = end + size  # 二进制载荷可能含 { } \，必须整段跳过
            continue
        index = match.end()
        if index < length and source[index] == " ":
            index += 1  # 控制词后的单个分隔空格属于控制词
    return {"page_positions": page_positions, "constructs": constructs}


def _make_sentinel(source: str) -> str:
    """生成一个在源文件里不存在的随机 hex 哨兵（避免与正文撞车）。"""
    for _ in range(_SENTINEL_ATTEMPTS):
        token = secrets.token_hex(16)
        if token not in source:
            return token
    return ""  # 极端情况：宁可让分页映射失败，也不复用可能撞车的哨兵


def _replace_page_breaks(source: str, positions: list[int], sentinel: str) -> str:
    """把 body 级 ``\\page`` 替换成 ``\\par <sentinel>\\par``（只改副本，不改原字节）。"""
    if not sentinel or not positions:
        return source
    parts: list[str] = []
    cursor = 0
    for position in positions:
        parts.append(source[cursor:position])
        end = position + len("\\page")
        while end < len(source) and source[end].isdigit():
            end += 1  # \page 不该有参数；有也一起吃掉落个干净
        if end < len(source) and source[end] == " ":
            end += 1
        parts.append(f"\\par {sentinel}\\par ")
        cursor = end
    parts.append(source[cursor:])
    return "".join(parts)


def _sentinel_isolated(extracted: str, sentinel: str) -> bool:
    """哨兵是否独占一行（striprtf 把 ``\\par`` 解码成换行；粘在正文上则分页边界可疑）。"""
    if not sentinel:
        return True
    for line in extracted.splitlines():
        if sentinel in line and line.strip() != sentinel:
            return False
    return True


def read_rtf(path) -> dict:
    """读一份 RTF，返回 ``content.result()`` 形状 + 招聘字段层。

    参数是路径（Path 或 str）；只读打开。任何异常都转成合法失败结果或
    ``reader_failed``，不返回半成品。
    """
    path = Path(path)
    try:
        raw = path.read_bytes()
    except OSError as exc:
        return _failed(path, None, "reader_failed",
                       f"cannot read file: {type(exc).__name__}: {exc}")
    sha = hashlib.sha256(raw).hexdigest()

    # 解码到 str（latin-1 是 1:1 的字节映射，striprtf 自己按 \ansicpg/\fcharset
    # 解 \'hh；用 utf-8 解会把真正的 8-bit 转义提前破坏掉）。
    try:
        source = raw.decode("latin-1")
    except Exception as exc:  # noqa: BLE001 - 理论上 latin-1 不会失败，保留可诊断
        return _failed(path, sha, "reader_failed",
                       f"RTF bytes could not be decoded: {type(exc).__name__}: {exc}")
    try:
        from striprtf.striprtf import rtf_to_text
    except Exception as exc:  # noqa: BLE001 - 依赖缺失必须如实报，不能静默跳过
        return _failed(path, sha, "reader_failed",
                       "striprtf is not installed; the RTF reader has no backend "
                       f"({type(exc).__name__}: {exc})")

    # ---- 分页映射：body 级 \page → 哨兵 → 一次解码 → 按哨兵切页 ----
    scan = _scan_rtf(source)
    constructs = scan["constructs"]
    body_page_breaks = len(scan["page_positions"])
    source_page_breaks = len(_PAGE_RE.findall(source))
    sentinel = _make_sentinel(source)
    marked_source = _replace_page_breaks(source, scan["page_positions"], sentinel)
    try:
        extracted = rtf_to_text(marked_source, errors="replace")
    except Exception as exc:  # noqa: BLE001
        return _failed(path, sha, "reader_failed",
                       f"RTF could not be extracted: {type(exc).__name__}: {exc}")
    sentinels_found = extracted.count(sentinel) if sentinel else 0
    page_chunks = extracted.split(sentinel) if (sentinel and sentinels_found) else [extracted]
    sentinel_isolated = _sentinel_isolated(extracted, sentinel)

    mapping_reasons: list[str] = []
    if source_page_breaks != body_page_breaks:
        mapping_reasons.append(
            f"source declares {source_page_breaks} \\page but only {body_page_breaks} "
            "are body-level (some are inside a non-body destination)")
    if sentinels_found != body_page_breaks:
        mapping_reasons.append(
            f"{body_page_breaks} body-level \\page replaced but {sentinels_found} "
            "sentinel(s) came back from the decoder")
    if not sentinel_isolated:
        mapping_reasons.append("sentinel is not isolated on its own paragraph line")
    if constructs["sect"]:
        mapping_reasons.append(
            f"{constructs['sect']} \\sect section break(s); per-section page setup and "
            "page numbering are not reconstructed, so page attribution is unproven")
    if constructs["sbkpage"]:
        mapping_reasons.append(
            f"{constructs['sbkpage']} \\sbkpage section page break(s); those hard page "
            "breaks are not mapped, so page attribution is unproven")

    pagination_ok = not mapping_reasons
    if pagination_ok:
        pages = len(page_chunks)
        pages_mapped = pages
        page_texts = list(page_chunks)
    else:
        # fail-closed：不挂页、不产出 page_info 行、页数只按 \page 声明计数（不编造页）。
        pages = source_page_breaks + 1
        pages_mapped = 0
        page_texts = ["\n".join(page_chunks)]

    # ---- 逐页切段落：一个非空段落 = 一个 block（RTF 的 \par 就是段落边界）----
    page_paragraphs: list[tuple[int | None, str]] = []
    page_chars: list[int] = []
    page_encoding_removed: list[str] = []
    for page_number, chunk in enumerate(page_texts, 1):
        clean_chunk, removed_chunk = _strip_unreadable(chunk)
        page_chars.append(len(clean_chunk.strip()))
        page_encoding_removed.append(removed_chunk)
        located_page = page_number if pagination_ok else None
        for line in clean_chunk.split("\n"):
            text = line.strip()
            if text:
                page_paragraphs.append((located_page, text))

    blocks: list = []
    for paragraph_index, (paragraph_page, text) in enumerate(page_paragraphs):
        location: dict = {"paragraph": paragraph_index}
        if paragraph_page is not None:
            location = {"page": paragraph_page, "paragraph": paragraph_index}
        block = content.block("paragraph", text, location)
        # 原生文本：字符来自 RTF 源文件本身（控制字/转义解码），不是 OCR/模型。
        block["provenance"] = "native_text"
        blocks.append(block)

    paragraph_count = len(blocks)
    encoding_removed = "".join(page_encoding_removed)
    images = len(_PICT_RE.findall(source))
    objects = len(_OBJECT_RE.findall(source))
    tables = len(_TROWD_RE.findall(source))
    headers_footers = len(_HEADER_FOOTER_RE.findall(source))
    shape_groups = constructs["shp"] + constructs["shptxt"] + constructs["txbxContent"]
    single_page = pagination_ok and pages == 1

    issues: list = []
    warnings: list = []

    if encoding_removed:
        issues.append({
            "code": "rtf_text_encoding_unread",
            "message": ("native RTF text contained byte sequences that could not be decoded with the "
                        "document's declared charset; those markers were removed from the body "
                        "(the rest of the text is kept as native_text). Verify identity fields "
                        "against the original before using them."),
            "location": {"page": 1 if single_page else None},
        })
    if images:
        issues.append({
            "code": "unverified_rtf_embedded_image",
            "message": (f"RTF embeds {images} image(s); images are not read by this text reader. "
                        "Any text or identity information inside them is unread, so the text content "
                        "alone is not proof that nothing is missing."),
            "location": {"page": 1 if single_page else None},
        })
    if objects or headers_footers or shape_groups:
        parts = []
        if objects:
            parts.append(f"{objects} embedded object(s)")
        if headers_footers:
            parts.append(f"{headers_footers} header/footer field(s)")
        if shape_groups:
            parts.append(f"{shape_groups} text box/shape field(s)")
        issues.append({
            "code": "unverified_rtf_visual_content",
            "message": (", ".join(parts) + " exist outside the body text stream; they are not read. "
                        "The body text is complete for the paragraphs that were decoded, but "
                        "out-of-flow content is unverified."),
            "location": {"page": 1 if single_page else None},
        })
    if constructs["trowd"]:
        issues.append({
            "code": "unverified_rtf_table",
            "message": (f"RTF declares a table ({constructs['trowd']} \\trowd row definition(s)). "
                        "Table cell text is kept in the linear stream (cells are separated by '|'), "
                        "but the 2-D reading order of a table cannot be proven from a text stream, "
                        "so order_verified stays false. No bbox is invented for cells."),
            "location": {"page": 1 if single_page else None},
        })
    if constructs["cols"]:
        issues.append({
            "code": "unverified_rtf_multicolumn",
            "message": (f"RTF declares a multi-column layout ({constructs['cols']} \\cols with "
                        "more than one column). The linear text stream is preserved, but column "
                        "reading order cannot be proven, so order_verified stays false."),
            "location": {"page": 1 if single_page else None},
        })
    if constructs["frames"] or constructs["frame"]:
        issues.append({
            "code": "unverified_rtf_frame",
            "message": (f"RTF declares frames ({constructs['frames'] + constructs['frame']} "
                        "\\frames/\\frame). Frame text is in the body stream, but frame "
                        "geometry/order cannot be proven, so order_verified stays false."),
            "location": {"page": 1 if single_page else None},
        })
    if not pagination_ok:
        issues.append({
            "code": "unverified_rtf_pagination",
            "message": ("hard page/section structure could not be mapped onto the body text "
                        f"stream ({'; '.join(mapping_reasons)}). No page is attached to any "
                        "block and no page_info is produced: page numbers are never guessed."),
        })
    if not blocks:
        issues.append({"code": "rtf_no_text",
                       "message": "RTF has no decodable body text (no paragraph produced content)"})

    # ---- 平台噪声：与 PDF 同一口径（整块移出正文并记录）----
    blocks, noise = resume_fields.split_noise(blocks)
    if noise:
        issues.append({"code": "platform_noise_excluded",
                       "message": f"{len(noise)} block(s) of platform branding removed from body",
                       "location": {"page": noise[0].get("page"),
                                    "paragraph": noise[0].get("block")}})
    for block in blocks:
        hit, _marker = resume_fields.is_noise_block(block)
        if hit:
            continue
        text = block.get("text") or ""
        low = text.lower()
        if any(marker in low for marker in resume_fields._PLATFORM_MARKERS):
            issues.append({
                "code": "platform_noise_inline_unresolved",
                "message": ("platform branding shares a text block with body content and was kept; "
                            "confirm it is not a company name"),
                "location": block.get("location") or {},
            })

    # ---- 结构层：只提供证据，不判断正文 ----
    if blocks:
        page_of = {id(block): (block.get("location") or {}).get("page") or 1
                   for block in blocks}
        st.infer_structure(blocks, page_of=page_of)
        st.mark_headings(blocks)

    page_info = []
    if pagination_ok:
        for page_number in range(1, pages + 1):
            page_blocks = [block for block in blocks
                           if (block.get("location") or {}).get("page") == page_number]
            page_info.append({
                "page": page_number,
                "chars": page_chars[page_number - 1],
                # 多页时图片落不到具体页（RTF 的 \pict 不参与页映射）：写 None 而不是 0。
                "images": images if pages == 1 else None,
                "drawings": 0,
                "readable": bool(page_blocks),
                "layout_order_applied": False,
                "image_coverage": None,
                "block_count": len(page_blocks),
                "encoding_removed": page_encoding_removed[page_number - 1],
                "noise_removed": "".join(
                    item.get("text") or "" for item in noise
                    if item.get("page") == page_number),
            })

    # ---- 阅读顺序证明（meta.order_basis）----
    unprovable = []
    if constructs["trowd"]:
        construct, code = _CONSTRUCT_CODE["trowd"]
        unprovable.append({"construct": construct, "control_word": "\\trowd",
                           "occurrences": constructs["trowd"], "code": code})
    if constructs["cols"]:
        construct, code = _CONSTRUCT_CODE["cols"]
        unprovable.append({"construct": construct, "control_word": "\\cols",
                           "occurrences": constructs["cols"], "code": code})
    if constructs["frames"] or constructs["frame"]:
        construct, code = _CONSTRUCT_CODE["frames"]
        unprovable.append({"construct": construct, "control_word": "\\frames/\\frame",
                           "occurrences": constructs["frames"] + constructs["frame"],
                           "code": code})
    if shape_groups:
        construct, code = _CONSTRUCT_CODE["shp"]
        unprovable.append({"construct": construct, "control_word": "\\shp/\\shptxt/\\txbxContent",
                           "occurrences": shape_groups, "code": code})
    if constructs["sect"] or constructs["sbkpage"]:
        occurrences = constructs["sect"] + constructs["sbkpage"]
        unprovable.append({"construct": "section_break" if constructs["sect"] else "section_page_break",
                           "control_word": "\\sect/\\sbkpage",
                           "occurrences": occurrences,
                           "code": "unverified_rtf_pagination"})

    located_pages = [(block.get("location") or {}).get("page") for block in blocks]
    located_pages = [page for page in located_pages if page is not None]
    page_sequence_monotonic = bool(
        pagination_ok and all(
            located_pages[index] <= located_pages[index + 1]
            for index in range(len(located_pages) - 1)))
    paragraph_indices = ([block["location"]["paragraph"] for block in blocks]
                         + [item.get("block") for item in noise])
    paragraph_indices_contiguous = bool(
        len(paragraph_indices) == paragraph_count
        and sorted(paragraph_indices) == list(range(paragraph_count)))
    order_verified = bool(
        blocks and pagination_ok and not unprovable
        and page_sequence_monotonic and paragraph_indices_contiguous
        and pages_mapped == pages)

    page_mapping = {
        "status": "ok" if pagination_ok else "failed",
        "method": "sentinel-split",
        "source_page_breaks": source_page_breaks,
        "body_page_breaks": body_page_breaks,
        "sentinels_expected": body_page_breaks,
        "sentinels_found": sentinels_found,
        "sentinel_isolated": sentinel_isolated,
        "reason": None if pagination_ok else "; ".join(mapping_reasons),
    }
    order_basis = {
        "method": ORDER_METHOD,
        "page_mapping": page_mapping,
        "source_page_breaks": source_page_breaks,
        "pages_mapped": pages_mapped,
        "paragraphs": paragraph_count,
        "constructs_checked": list(_CONSTRUCT_NAMES),
        "unprovable_constructs": unprovable,
        "page_sequence_monotonic": page_sequence_monotonic,
        "paragraph_indices_contiguous": paragraph_indices_contiguous,
    }

    # ---- 招聘字段层（与 PDF/DOCX 同一实现，字段 provenance 逐块传播）----
    analysis = resume_fields.analyze(
        blocks, page_info=page_info, page_count=pages, source_sha256=sha,
        issues_before=list(issues), order_unverified_pages=[])
    issues.extend(analysis["issues"])
    warnings.extend(analysis["warnings"])

    # needs_visual 与 PDF 同口径：整份没文字 / 编码坏；单张图不升级（图片已由
    # unverified_rtf_embedded_image 声明，质量层把它当版式类 HARD）。
    needs_visual = (not blocks
                    or any(issue.get("code") == "rtf_text_encoding_unread" for issue in issues))

    ansicpg = _ansicpg(source)
    return content.result(
        blocks=blocks,
        title="",
        # 正文段落读全了就是 complete；只要有任何 issue / needs_visual，content.result()
        # 会统一降成 partial（唯一口径），这里不手写第二套判定。
        completeness="complete",
        issues=issues,
        warnings=warnings,
        needs_visual=needs_visual,
        meta={
            "pages": pages,
            "source_sha256": sha,
            "source_name": path.name,
            "backend": f"{BACKEND_PREFIX}/{_rtf_version()}",
            "reader_version": __version__,
            "page_info": page_info,
            # RTF 没有几何版面后端：顺序依据是线性文本流 + 硬分页映射（见 order_basis），
            # 不冒充 layout backend；只有 order_basis 全部条件成立时才声明 order_verified。
            "layout_backend": None,
            "order_verified": order_verified,
            "order_basis": order_basis,
            "repaired": False,
            "rtf": {
                "paragraphs": len(_PAR_RE.findall(source)),
                "page_breaks": source_page_breaks,
                "images": images,
                "objects": objects,
                "table_rows": tables,
                "header_footer_fields": headers_footers,
                "hex_escapes": len(_HEX_ESCAPE_RE.findall(source)),
                "unicode_escapes": len(_U_ESCAPE_RE.findall(source)),
                "ansicpg": ansicpg,
                "fcharsets": sorted({match for match in _FCHARSET_RE.findall(source)}),
            },
        },
        extra={"fields": analysis["fields"],
               "noise": noise,
               "protected_attributes": analysis["protected_attributes"],
               "screening": analysis["screening"],
               "timeline": analysis["timeline"]},
    )
