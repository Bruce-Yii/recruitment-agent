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

Provenance (must match the project's red line, doc 11 §9.7 / D-67)
-----------------------------------------------------------------
RTF is a *text* container: the characters live in the file as RTF control
words and escaped bytes.  Decoding them is the same work a PDF text layer does
(no OCR, no model output), so the extracted blocks are ``provenance =
"native_text"``.  This is **not** a claim that layout was reconstructed:

  * no page/bbox is invented — blocks carry paragraph order only, and
    ``location.page`` is emitted **only** when the RTF declares no hard page
    break (then every paragraph really is on page 1);
  * ``meta.order_verified`` stays ``False`` and ``meta.layout_backend`` stays
    ``None``: the RTF text stream order is preserved, but columns / frames /
    table geometry are not verified;
  * embedded images (``\\pict``) and objects are **not** read.  They are
    declared with ``unverified_rtf_embedded_image`` (an ``unverified_*`` SOFT
    code) instead of being silently dropped; the plugin quality layer treats an
    unverified image as a HARD layout-only blocker, exactly like
    ``unverified_pdf_image``;
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
from pathlib import Path

from . import __version__, content, resume_fields, structure as st

#: Stable backend id recorded in ``meta.backend`` (R4: who read the bytes).
BACKEND_PREFIX = "striprtf"

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
              "repaired": False, "failed": True},
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
    try:
        extracted = rtf_to_text(source, errors="replace")
    except Exception as exc:  # noqa: BLE001
        return _failed(path, sha, "reader_failed",
                       f"RTF could not be extracted: {type(exc).__name__}: {exc}")

    clean_text, encoding_removed = _strip_unreadable(extracted)

    page_breaks = len(_PAGE_RE.findall(source))
    images = len(_PICT_RE.findall(source))
    objects = len(_OBJECT_RE.findall(source))
    tables = len(_TROWD_RE.findall(source))
    headers_footers = len(_HEADER_FOOTER_RE.findall(source))
    single_page = page_breaks == 0
    pages = page_breaks + 1

    # ---- blocks：一个非空段落 = 一个 block（RTF 的 \par 就是段落边界）----
    blocks: list = []
    for line in clean_text.split("\n"):
        text = line.strip()
        if not text:
            continue
        location: dict = {"paragraph": len(blocks)}
        if single_page:
            # 没有硬分页符时，每个段落**确实**在第 1 页；这是格式等价事实，不是编造。
            location = {"page": 1, "paragraph": len(blocks)}
        block = content.block("paragraph", text, location)
        # 原生文本：字符来自 RTF 源文件本身（控制字/转义解码），不是 OCR/模型。
        block["provenance"] = "native_text"
        blocks.append(block)

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
    if objects or headers_footers:
        parts = []
        if objects:
            parts.append(f"{objects} embedded object(s)")
        if headers_footers:
            parts.append(f"{headers_footers} header/footer field(s)")
        issues.append({
            "code": "unverified_rtf_visual_content",
            "message": (", ".join(parts) + " exist outside the body text stream; they are not read. "
                        "The body text is complete for the paragraphs that were decoded, but "
                        "out-of-flow content is unverified."),
            "location": {"page": 1 if single_page else None},
        })
    if page_breaks:
        issues.append({
            "code": "unverified_rtf_pagination",
            "message": (f"RTF declares {page_breaks} hard page break(s). This reader does not "
                        "reconstruct per-page layout, so blocks are located by paragraph order "
                        "only (no page numbers are invented)."),
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
    if single_page:
        page_info.append({
            "page": 1,
            "chars": len(clean_text.strip()),
            "images": images,
            "drawings": 0,
            "readable": bool(blocks),
            "layout_order_applied": False,
            "image_coverage": None,
            "block_count": len(blocks),
            "encoding_removed": encoding_removed,
            "noise_removed": "".join(n.get("text") or "" for n in noise),
        })

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
            # RTF 没有版面后端：文本流顺序保留，但列/框/表几何未核 → 不声明 order_verified。
            "layout_backend": None,
            "order_verified": False,
            "repaired": False,
            "rtf": {
                "paragraphs": len(_PAR_RE.findall(source)),
                "page_breaks": page_breaks,
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
