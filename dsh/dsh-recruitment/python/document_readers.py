#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Unified document readers for DOCX and raster images (U1).

Only libraries that are already installed on this machine are used:

  * python-docx 1.2.0  -> DOCX paragraphs / tables / order / hyperlinks
  * Pillow 12.3.0      -> PNG / JPEG dimensions, EXIF orientation

No OCR engine is installed and none is faked here.  An image produces exactly
one ``other`` block with **empty** text, ``needs_visual = True`` and an
``image_requires_vision`` HARD issue.  Pixels never become text.

This adapter is plumbing, not a second contract: output field names and enums
come from docs/19 §2.1 (TS side: ``src/document/readers/types.ts``).

Protocol (stdin -> stdout, one UTF-8 JSON object in, one out)::

    {"op": "docx",  "path": "<absolute path>"}
    {"op": "image", "path": "<absolute path>"}

    {"ok": true,  "content": {schema_version, media_type, reader_id, ...}}
    {"ok": false, "code": "<stable code>", "message": "<redacted, no body text>"}

Why a subprocess: identical to ``fallback_bridge.py`` — the DSH plugin stays a
thin TS layer and this reader has its own tests.  Requests go through stdin (not
argv) so a path is not world-visible on the command line.

Fail-closed rules:
  * path must be absolute, a regular file, inside the caller's allowed roots
    (the TS side checks roots; this side re-checks absolute/exists/is_file);
  * a corrupt package / image raises a stable code, never a half-read result;
  * only ``error`` messages leave this process; document text never does.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

SCHEMA_VERSION = "1.0.0"

MEDIA_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
MEDIA_PNG = "image/png"
MEDIA_JPEG = "image/jpeg"

MAX_FILE_BYTES = 64 * 1024 * 1024

HARD = "HARD"
SOFT = "SOFT"

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

_QUOTED_RE = re.compile(r"'[^']*'|\"[^\"]*\"")
MAX_MESSAGE = 600

_HEADING_STYLE_RE = re.compile(r"^(heading|标题)\s*\d*$", re.IGNORECASE)
_LIST_STYLE_HINTS = ("list", "列表", "项目符号", "编号")

_HARD_ACTIONS = {
    "docx_textbox_unread": "human_review",
    "docx_nested_table_unread": "human_review",
    "docx_no_text": "human_review",
}


class ReaderError(ValueError):
    """A failure with a stable code (mapped to a plugin error code on the TS side)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _issue(code, message, severity, action, retryable=False, locator=None):
    item = {
        "code": code,
        "message": message,
        "severity": severity,
        "retryable": bool(retryable),
        "suggested_action": action,
    }
    if locator is not None:
        item["locator"] = locator
    return item


def _hard(code, message, locator=None, action=None):
    return _issue(code, message, HARD, action or _HARD_ACTIONS.get(code, "human_review"),
                  retryable=False, locator=locator)


def _soft(code, message, locator=None):
    return _issue(code, message, SOFT, "none", retryable=False, locator=locator)


def _normalize(text: str) -> str:
    """Format decoding only (NUL / CRLF / NBSP / trailing spaces); no fact rewrite."""
    text = (text or "").replace("\x00", " ").replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\u00a0", " ")
    lines = [line.rstrip() for line in text.split("\n")]
    out = "\n".join(lines)
    while "\n\n\n" in out:
        out = out.replace("\n\n\n", "\n\n")
    return out.strip("\n")


def _redact(message, path=None) -> str:
    """Never echo document text; strip quoted fragments and the request path."""
    text = str(message or "")
    if path:
        text = text.replace(str(path), "<path>")
    text = _QUOTED_RE.sub("<redacted>", text)
    return text.replace("\r", " ").replace("\n", " ")[:MAX_MESSAGE]


def _fail(code, message, path=None):
    return {"ok": False, "code": str(code), "message": _redact(message, path)}


def _require_path(request):
    path = request.get("path")
    if not isinstance(path, str) or path.strip() == "":
        raise ReaderError("invalid_request", "path must be a non-empty string")
    candidate = Path(path)
    if not candidate.is_absolute():
        raise ReaderError("invalid_request", "path must be absolute")
    if not candidate.is_file():
        raise ReaderError("not_found", "path is not a regular file")
    size = candidate.stat().st_size
    if size > MAX_FILE_BYTES:
        raise ReaderError("too_large", "file is larger than the reader limit")
    return candidate


def _w(tag: str) -> str:
    return "{%s}%s" % (W_NS, tag)


def _docx_version() -> str:
    try:
        import docx
        return str(getattr(docx, "__version__", "unknown"))
    except Exception:  # noqa: BLE001 - reported as reader_version "unavailable"
        return "unavailable"


def _paragraph_kind(paragraph, text: str):
    style_name = ""
    try:
        if paragraph.style is not None and paragraph.style.name is not None:
            style_name = str(paragraph.style.name)
    except Exception:  # noqa: BLE001 - a missing style must not abort the read
        style_name = ""
    lowered = style_name.lower()
    if _HEADING_STYLE_RE.match(style_name.strip()):
        return "heading", style_name
    if any(hint in lowered or hint in style_name for hint in _LIST_STYLE_HINTS):
        return "list", style_name
    p_pr = getattr(paragraph._p, "pPr", None)
    if p_pr is not None and getattr(p_pr, "numPr", None) is not None:
        return "list", style_name
    hyperlinks = list(getattr(paragraph, "hyperlinks", []) or [])
    if hyperlinks and text.strip() != "":
        joined = "".join((link.text or "") for link in hyperlinks).strip()
        if joined != "" and joined == text.strip():
            return "link", style_name
    return "paragraph", style_name


def _paragraph_links(paragraph, locator):
    links = []
    for hyperlink in getattr(paragraph, "hyperlinks", []) or []:
        href = getattr(hyperlink, "address", None) or ""
        if not isinstance(href, str) or href.strip() == "":
            continue
        label = (hyperlink.text or href) or href
        links.append({"text": label, "href": href, "locator": dict(locator)})
    return links


def read_docx(path: Path) -> dict:
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    document = Document(str(path))
    part_name = str(document.part.partname).lstrip("/")

    blocks = []
    issues = []
    paragraph_count = 0
    table_count = 0
    textbox_texts = []
    header_footer_parts = set()

    def add_block(kind, text, locator, links=None):
        text = _normalize(text)
        if text.strip() == "":
            return
        block = {
            "block_id": locator.get("_block_id"),
            "kind": kind,
            "text": text,
            "order": len(blocks),
            "locator": {key: value for key, value in locator.items() if not key.startswith("_")},
            "provenance": "native_text",
        }
        if links:
            block["links"] = links
        blocks.append(block)

    for child in document.element.body.iterchildren():
        if child.tag == _w("p"):
            paragraph = Paragraph(child, document)
            paragraph_id = "p%d" % paragraph_count
            paragraph_count += 1
            locator = {"kind": "docx", "part": part_name, "paragraph_id": paragraph_id,
                       "_block_id": "docx:%s:%s" % (part_name, paragraph_id)}
            text = paragraph.text or ""
            kind, _style = _paragraph_kind(paragraph, text)
            add_block(kind, text, locator, _paragraph_links(paragraph, {
                "kind": "docx", "part": part_name, "paragraph_id": paragraph_id,
            }))
        elif child.tag == _w("tbl"):
            table = Table(child, document)
            table_id = "t%d" % table_count
            table_count += 1
            for row_index, row in enumerate(table.rows):
                seen = set()
                for cell_index, cell in enumerate(row.cells):
                    key = id(cell._tc)
                    if key in seen:
                        continue
                    seen.add(key)
                    cell_locator = {"kind": "docx", "part": part_name,
                                    "table_id": table_id, "row": row_index,
                                    "cell": cell_index}
                    nested = getattr(cell, "tables", []) or []
                    if nested:
                        issues.append(_hard(
                            "docx_nested_table_unread",
                            "nested table inside a cell is not read; its text is missing from the blocks",
                            cell_locator,
                        ))
                    add_block("table", cell.text or "", {
                        **cell_locator,
                        "_block_id": "docx:%s:%s:r%d:c%d" % (
                            part_name, table_id, row_index, cell_index),
                    })

    # Text boxes: python-docx does not expose them through Paragraph.text,
    # 但 Word 里用文本框排版简历是常态 —— 所以**必须把里面的文字读出来**，
    # 而不是只报一句"读不了"（2026-11-14 实测：中文简历-新.docx 的正文全在 28 个文本框里，
    # 旧实现把文字收集起来又扔掉，导致整份被判成"没有正文"）。
    #
    # 读法：w:txbxContent 里的 w:t 逐段拼接。文本框在视觉上可能浮在页面任意位置，
    # 与正文的相对顺序**不可知**，所以：
    #   * 文字照样进 blocks（结构化只需要文字，D-97 第一批口径）；
    #   * 顺序问题降级成 SOFT（doc_docx_textbox_order_unknown），不再阻断结构化；
    #   * 保留 docx_textbox_unread 这个 code 只用于"确实一个 w:t 都没读到"的情况。
    for textbox_index, textbox in enumerate(document.element.body.iter(_w("txbxContent"))):
        joined = "".join((node.text or "") for node in textbox.iter(_w("t"))).strip()
        if not joined:
            continue
        textbox_texts.append(joined)
        add_block("paragraph", joined, {
            "kind": "docx",
            "part": part_name,
            "_block_id": "docx:%s:textbox:%d" % (part_name, textbox_index),
        })
    if textbox_texts:
        issues.append(_soft(
            "doc_docx_textbox_order_unknown",
            "%d text box(es) were read into blocks, but their visual position relative to the "
            "body flow is unknown; text is usable, reading order is not verified"
            % len(textbox_texts),
            {"kind": "docx", "part": part_name},
        ))

    # Headers / footers are outside the body flow; record them rather than
    # silently dropping the fact that they exist.
    try:
        for part in document.part.package.parts:
            name = str(part.partname).lstrip("/")
            if not (name.startswith("word/header") or name.startswith("word/footer")):
                continue
            element = getattr(part, "element", None)
            if element is None:
                continue
            text = "".join(node.text or "" for node in element.iter(_w("t"))).strip()
            if text:
                header_footer_parts.add(name)
    except Exception:  # noqa: BLE001 - headers are advisory, not a read failure
        header_footer_parts = set()

    for part_name_hf in sorted(header_footer_parts):
        issues.append(_soft(
            "docx_header_footer_present",
            "the part contains text outside the body flow; it is not part of the block order",
            {"kind": "docx", "part": part_name_hf},
        ))

    if not blocks:
        issues.append(_hard(
            "docx_no_text",
            "no paragraph or table cell produced text; an empty read is not a proof of absence",
            {"kind": "docx", "part": part_name},
        ))

    hard = any(issue["severity"] == HARD for issue in issues)
    completeness = "partial" if hard or not blocks else "complete"
    text = "\n\n".join(block["text"] for block in blocks)
    return {
        # canonical DocumentContent 的键集是封闭的（U0 contracts/types.ts）：
        # 读取器附加证据放在 source_meta，不塞进 content。
        "content": {
            "schema_version": SCHEMA_VERSION,
            "media_type": MEDIA_DOCX,
            "reader_id": "python-docx",
            "reader_version": _docx_version(),
            "reader_profile": "python-docx/body-order",
            "text": text,
            "blocks": blocks,
            "completeness": completeness,
            "needs_visual": False,
            "issues": issues,
        },
        "source_meta": {
            "part": part_name,
            "paragraphs": paragraph_count,
            "tables": table_count,
            "blocks": len(blocks),
            "textboxes": len(textbox_texts),
            "header_footer_parts": sorted(header_footer_parts),
            "document_bytes": path.stat().st_size,
        },
    }


def read_image(path: Path) -> dict:
    from PIL import Image, UnidentifiedImageError

    try:
        image = Image.open(str(path))
    except (UnidentifiedImageError, OSError):
        raise ReaderError("image_open_failed",
                          "the image bytes could not be decoded as PNG/JPEG") from None

    try:
        image.load()
        image_format = (image.format or "").upper()
        if image_format == "MPO":
            image_format = "JPEG"
        if image_format == "PNG":
            media_type = MEDIA_PNG
        elif image_format == "JPEG":
            media_type = MEDIA_JPEG
        else:
            raise ReaderError("image_format_mismatch",
                              "the image bytes are not PNG or JPEG")

        width, height = image.size
        mode = image.mode
        frames = int(getattr(image, "n_frames", 1) or 1)

        has_exif = False
        orientation = 0
        exif_issue = None
        try:
            exif = image.getexif()
            has_exif = bool(exif)
            orientation = int(exif.get(274, 0) or 0)
        except Exception:  # noqa: BLE001 - malformed EXIF is recorded, not fatal
            exif_issue = _soft("image_exif_unread", "EXIF metadata could not be decoded")

        display_width, display_height = width, height
        if orientation in (5, 6, 7, 8):
            display_width, display_height = height, width

        dpi = image.info.get("dpi") if isinstance(image.info, dict) else None
        dpi_out = None
        if isinstance(dpi, (tuple, list)) and len(dpi) == 2:
            try:
                dpi_out = [float(dpi[0]), float(dpi[1])]
            except (TypeError, ValueError):
                dpi_out = None
    finally:
        image.close()

    issues = [_issue(
        "image_requires_vision",
        "the image has pixels only; no OCR engine is installed, so no text was transcribed. "
        "Reading the pixels requires a vision-capable reader",
        HARD,
        "vision_read",
        retryable=True,
    )]
    if exif_issue is not None:
        issues.append(exif_issue)

    block = {
        "block_id": "image:frame0",
        "kind": "other",
        "text": "",
        "order": 0,
        "locator": {"kind": "image", "frame": 0},
        # No text was inferred; the block only records that an image exists.
        # native_text = "came from the original bytes", not "native text found".
        "provenance": "native_text",
    }
    return {
        "content": {
            "schema_version": SCHEMA_VERSION,
            "media_type": media_type,
            "reader_id": "Pillow",
            "reader_version": _pillow_version(),
            "reader_profile": "pillow/metadata-only",
            "text": "",
            "blocks": [block],
            "completeness": "partial",
            "needs_visual": True,
            "issues": issues,
        },
        "source_meta": {
            "format": image_format,
            "width": width,
            "height": height,
            "display_width": display_width,
            "display_height": display_height,
            "mode": mode,
            "frames": frames,
            "has_exif": has_exif,
            "exif_orientation": orientation,
            "dpi": dpi_out,
            "file_bytes": path.stat().st_size,
        },
    }


def _pillow_version() -> str:
    try:
        import PIL
        return str(getattr(PIL, "__version__", "unknown"))
    except Exception:  # noqa: BLE001
        return "unavailable"


def handle(request: dict) -> dict:
    op = request.get("op")
    if op not in ("docx", "image"):
        raise ReaderError("invalid_request", "op must be 'docx' or 'image'")
    path = _require_path(request)
    payload = read_docx(path) if op == "docx" else read_image(path)
    return {"ok": True, **payload}


def main(argv=None) -> int:
    del argv
    sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    sys.stdout.reconfigure(encoding="utf-8")

    request = {}
    try:
        raw = sys.stdin.read()
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ReaderError("invalid_request", "request must be a JSON object")
        response = handle(request)
    except ReaderError as exc:
        request_path = request.get("path") if isinstance(request, dict) else None
        response = _fail(exc.code, str(exc), request_path)
    except ValueError as exc:
        request_path = request.get("path") if isinstance(request, dict) else None
        response = _fail("invalid_request", str(exc), request_path)
    except Exception as exc:  # noqa: BLE001 - mapped to a stable code by the caller
        op = request.get("op") if isinstance(request, dict) else None
        if op == "docx":
            response = _fail(
                "docx_unreadable",
                "the DOCX package could not be read (corrupt, encrypted, or missing a required part)",
                request.get("path"),
            )
        elif op == "image":
            response = _fail("image_unreadable", "the image could not be read", request.get("path"))
        else:
            response = _fail("adapter_failed", type(exc).__name__)

    sys.stdout.write(json.dumps(response, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
