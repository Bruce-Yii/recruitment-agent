"""Synthetic document fixtures for the unified document contract (U0).

Why this file exists
--------------------
The contract layer (``src/document/contracts``) must be proven against **material it is
allowed to look at**.  Real resumes are off-limits (repository rule R7), and the existing
``converter/corpus/synthetic/platform_noise.pdf`` is *not* usable either: its body text is
a real resume with a platform watermark stamped on it.  So every sample here is authored
from scratch inside this file.

Hard rules baked into this generator
------------------------------------
1. **No real personal data.**  Every address is ``@example.invalid`` (reserved TLD), every
   number is in the ``555-01xx`` fiction range, every name is a placeholder such as
   ``TEST CANDIDATE ALPHA``.  ``self_check_no_real_data()`` fails the run if that stops
   being true.
2. **Expectations are constants, not observations.**  ``EXPECTED`` was written by hand;
   the generator asserts the produced file matches it.  The reader is never asked "what did
   I just make?" and treated as the answer.
3. **Self-contained.**  Only PyMuPDF / python-docx / Pillow, all already used by this
   repository.  No network, no downloads, no OS fonts.
4. **Output is throw-away.**  The default destination is a directory under the OS temp
   directory; PDFs and images are never committed.

Usage
-----
    python generate.py [DEST_DIR]

``DEST_DIR`` defaults to ``$DOCUMENT_FIXTURES_DIR`` or
``<tempdir>/recruitment-document-fixtures``.  The script writes ``manifest.json`` there and
prints one JSON line ``{"dir": ..., "files": N, "manifest": ...}`` on stdout.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import sys
import tempfile
from pathlib import Path

# ---------------------------------------------------------------------------
# 人工写死的预期（不是从解析器回读的观察值）
# ---------------------------------------------------------------------------

TEXT_PAGE_1 = [
    "SYNTHETIC DOCUMENT - NOT A REAL PERSON",
    "NAME: TEST CANDIDATE ALPHA",
    "EMAIL: alpha@example.invalid",
    "PHONE: 555-0100",
]

TEXT_PAGE_2 = [
    "WORK EXPERIENCE",
    "EXAMPLE CORP / TEST ROLE / 2020 - 2021",
    "SKILLS",
    "EXAMPLE SKILL ONE, EXAMPLE SKILL TWO",
    "PORTFOLIO: https://example.invalid/sample",
]

LEFT_COLUMN = [
    "LEFT COLUMN HEADING",
    "LEFT LINE ALPHA",
    "LEFT LINE BETA",
]

RIGHT_COLUMN = [
    "RIGHT COLUMN HEADING",
    "RIGHT LINE GAMMA",
    "RIGHT LINE DELTA",
]

SCAN_LINES = [
    "SCANNED PAGE SYNTHETIC",
    "NAME: TEST CANDIDATE BETA",
    "EMAIL: beta@example.invalid",
]

CONFUSABLE_LINES = [
    "OCR CONFUSION SAMPLE",
    "NAME: TE5T CAND1DATE GAMMA",
    "EMAIL: gamma@examp1e.invalid",
    "ID: O0 Il1 rn m",
]

DOCX_PARAGRAPHS = [
    "SYNTHETIC DOCX - NOT A REAL PERSON",
    "NAME: TEST CANDIDATE DELTA",
    "EMAIL: delta@example.invalid",
    "SUMMARY: EXAMPLE SUMMARY TEXT FOR CONTRACT TESTS",
]

DOCX_TABLE_INTRO = ["SYNTHETIC TABLE DOCX", "NAME: TEST CANDIDATE EPSILON"]
DOCX_TABLE_ROWS = [
    ["YEAR", "ROLE"],
    ["2020", "TEST ROLE ONE"],
    ["2021", "TEST ROLE TWO"],
]
DOCX_LINK_URL = "https://example.invalid/docx-link"
DOCX_LINK_TEXT = "EXAMPLE LINK"

IMAGE_LINES = [
    "SYNTHETIC IMAGE",
    "NAME: TEST CANDIDATE ZETA",
    "EMAIL: zeta@example.invalid",
]

IMAGE_WIDTH = 800
IMAGE_HEIGHT = 1000
SCAN_WIDTH = 900
SCAN_HEIGHT = 1200

#: 允许出现的邮箱域名（全部是保留 TLD；``examp1e`` 是 OCR 易混样本，故意用数字 1）。
ALLOWED_EMAIL_DOMAINS = ("@example.invalid", "@examp1e.invalid")

EXPECTED = {
    "text_simple.pdf": {
        "kind": "pdf_text",
        "media_type": "application/pdf",
        "pages": 2,
        "text_contains": TEXT_PAGE_1 + TEXT_PAGE_2,
        "native_text": True,
    },
    "text_two_column.pdf": {
        "kind": "pdf_two_column",
        "media_type": "application/pdf",
        "pages": 1,
        "text_contains": LEFT_COLUMN + RIGHT_COLUMN,
        "native_text": True,
    },
    "scan_image_only.pdf": {
        "kind": "pdf_scanned",
        "media_type": "application/pdf",
        "pages": 1,
        "text_contains": [],
        "native_text": False,
        "images": 1,
    },
    "ocr_confusable.pdf": {
        "kind": "pdf_ocr_confusable",
        "media_type": "application/pdf",
        "pages": 1,
        "text_contains": CONFUSABLE_LINES,
        "native_text": True,
    },
    "text_variant_same_content.pdf": {
        "kind": "pdf_text_variant",
        "media_type": "application/pdf",
        "pages": 2,
        "text_contains": TEXT_PAGE_1 + TEXT_PAGE_2,
        "native_text": True,
        "same_text_as": "text_simple.pdf",
    },
    "docx_normal.docx": {
        "kind": "docx_text",
        "media_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "paragraphs": DOCX_PARAGRAPHS,
        "tables": 0,
        "hyperlinks": 0,
    },
    "docx_table.docx": {
        "kind": "docx_table",
        "media_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "tables": 1,
        "table_rows": 3,
        "table_cols": 2,
        "table_cell_texts": [cell for row in DOCX_TABLE_ROWS for cell in row],
        "hyperlinks": 1,
        "hyperlink_text": DOCX_LINK_TEXT,
        "hyperlink_url": DOCX_LINK_URL,
    },
    "image.png": {
        "kind": "image_png",
        "media_type": "image/png",
        "width": IMAGE_WIDTH,
        "height": IMAGE_HEIGHT,
        "text": IMAGE_LINES,
    },
    "image.jpg": {
        "kind": "image_jpeg",
        "media_type": "image/jpeg",
        "width": IMAGE_WIDTH,
        "height": IMAGE_HEIGHT,
        "text": IMAGE_LINES,
    },
    "corrupted_truncated.pdf": {
        "kind": "pdf_truncated",
        "media_type": "application/pdf",
        "truncated_from": "text_simple.pdf",
        "keep_ratio": 0.45,
    },
    "masquerade_not_a_pdf.pdf": {
        "kind": "format_masquerade",
        "media_type": "application/pdf",
        "payload": "zip",
    },
    "zero_byte.pdf": {
        "kind": "empty_file",
        "media_type": "application/pdf",
        "bytes": 0,
    },
}

#: 生成顺序（也是 manifest 里的顺序）；测试按这个顺序逐项核对。
MANIFEST_ORDER = list(EXPECTED.keys())

#: kind → 用什么方式验证（显式派发表，不靠字符串前缀猜）。
VERIFIER_BY_KIND = {
    "pdf_text": "pdf",
    "pdf_two_column": "pdf",
    "pdf_scanned": "pdf",
    "pdf_ocr_confusable": "pdf",
    "pdf_text_variant": "pdf",
    "docx_text": "docx",
    "docx_table": "docx",
    "image_png": "image",
    "image_jpeg": "image",
    "pdf_truncated": "truncated",
    "format_masquerade": "masquerade",
    "empty_file": "empty",
}

# ---------------------------------------------------------------------------
# 通用工具
# ---------------------------------------------------------------------------


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _pdf_pages(pages: list[list[str]], *, title: str, author: str, producer: str) -> bytes:
    """Render each list of lines into one page; return the PDF bytes."""
    import fitz

    doc = fitz.open()
    for lines in pages:
        page = doc.new_page()
        y = 90
        for line in lines:
            page.insert_text((72, y), line, fontname="helv", fontsize=11)
            y += 20
    doc.set_metadata({"title": title, "author": author, "producer": producer, "creator": "u0-fixture-generator"})
    data = doc.tobytes()
    doc.close()
    return data


def _two_column_pdf_bytes() -> bytes:
    """One page, two independent columns (left x=60, right x=320)."""
    import fitz

    doc = fitz.open()
    page = doc.new_page()
    for index, line in enumerate(LEFT_COLUMN):
        page.insert_text((60, 90 + index * 20), line, fontname="helv", fontsize=11)
    for index, line in enumerate(RIGHT_COLUMN):
        page.insert_text((320, 90 + index * 20), line, fontname="helv", fontsize=11)
    doc.set_metadata(
        {"title": "synthetic two column", "author": "u0-fixture-generator", "producer": "u0-fixture-generator"}
    )
    data = doc.tobytes()
    doc.close()
    return data


def _text_image_bytes(lines: list[str], *, width: int, height: int, fmt: str) -> bytes:
    """Draw text onto a white canvas and encode it as PNG or JPEG."""
    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.load_default(size=32)
    except TypeError:  # Pillow < 10 has no size argument
        font = ImageFont.load_default()
    for index, line in enumerate(lines):
        draw.text((50, 60 + index * 60), line, fill="black", font=font)
    buffer = io.BytesIO()
    if fmt == "JPEG":
        image.save(buffer, format="JPEG", quality=88)
    else:
        image.save(buffer, format="PNG")
    return buffer.getvalue()


def _scan_pdf_bytes(lines: list[str]) -> bytes:
    """One page whose only content is a full-page raster image (no text layer)."""
    import fitz

    # JPEG 而不是 PNG：3 MB 的 PNG 会让每次测试都多花时间，画面质量对契约测试无影响。
    jpeg = _text_image_bytes(lines, width=SCAN_WIDTH, height=SCAN_HEIGHT, fmt="JPEG")
    doc = fitz.open()
    page = doc.new_page(width=SCAN_WIDTH * 0.75, height=SCAN_HEIGHT * 0.75)
    page.insert_image(fitz.Rect(0, 0, page.rect.width, page.rect.height), stream=jpeg)
    doc.set_metadata({"title": "synthetic scan", "author": "u0-fixture-generator", "producer": "u0-fixture-generator"})
    data = doc.tobytes()
    doc.close()
    return data


# ---------------------------------------------------------------------------
# DOCX
# ---------------------------------------------------------------------------


def _write_docx_normal(path: Path) -> None:
    from docx import Document

    doc = Document()
    doc.add_heading(DOCX_PARAGRAPHS[0], level=1)
    for line in DOCX_PARAGRAPHS[1:]:
        doc.add_paragraph().add_run(line).bold = True
    doc.save(str(path))


def _add_hyperlink(paragraph, url: str, text: str) -> None:
    """python-docx has no hyperlink API; build the w:hyperlink element by hand."""
    from docx.opc.constants import RELATIONSHIP_TYPE as RT
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    r_id = paragraph.part.relate_to(url, RT.HYPERLINK, is_external=True)
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("r:id"), r_id)
    run = OxmlElement("w:r")
    props = OxmlElement("w:rPr")
    color = OxmlElement("w:color")
    color.set(qn("w:val"), "0563C1")
    props.append(color)
    underline = OxmlElement("w:u")
    underline.set(qn("w:val"), "single")
    props.append(underline)
    run.append(props)
    node = OxmlElement("w:t")
    node.text = text
    run.append(node)
    hyperlink.append(run)
    paragraph._p.append(hyperlink)


def _write_docx_table(path: Path) -> None:
    from docx import Document

    doc = Document()
    for line in DOCX_TABLE_INTRO:
        doc.add_paragraph(line)
    table = doc.add_table(rows=len(DOCX_TABLE_ROWS), cols=len(DOCX_TABLE_ROWS[0]))
    table.style = "Table Grid"
    for row_index, row in enumerate(DOCX_TABLE_ROWS):
        for column_index, value in enumerate(row):
            table.cell(row_index, column_index).text = value
    _add_hyperlink(doc.add_paragraph("PORTFOLIO: "), DOCX_LINK_URL, DOCX_LINK_TEXT)
    doc.save(str(path))


# ---------------------------------------------------------------------------
# 自检（R7 + 期望核对）
# ---------------------------------------------------------------------------


def self_check_no_real_data(texts: list[str]) -> None:
    """Fail loudly if a fixture ever starts looking like real personal data."""
    joined = "\n".join(texts)
    for email in re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+", joined):
        _require(
            any(email.endswith(domain) for domain in ALLOWED_EMAIL_DOMAINS),
            f"fixture email is not in a reserved TLD: {email!r}",
        )
    for phone in re.findall(r"\b\d{3}-\d{4}\b", joined):
        _require(phone.startswith("555-01"), f"fixture phone is outside the 555-01xx fiction range: {phone!r}")
    for forbidden in ("@gmail.", "@qq.", "@163.", "@outlook.", "13800", "18900", "身份证"):
        _require(forbidden not in joined, f"fixture text contains a real-looking token: {forbidden!r}")
    _require("SYNTHETIC" in joined.upper() or "OCR" in joined.upper(), "fixtures lost their synthetic marker")


def _pdf_page_count(path: Path) -> int:
    """Count page objects straight from the bytes (deliberately not via a PDF parser)."""
    return len(re.findall(rb"/Type\s*/Page[^s]", path.read_bytes()))


def _verify_pdf(path: Path, expected: dict) -> dict:
    import fitz

    doc = fitz.open(str(path))
    try:
        pages = doc.page_count
        texts = [doc.load_page(i).get_text() for i in range(pages)]
        image_counts = [len(doc.load_page(i).get_images(full=True)) for i in range(pages)]
    finally:
        doc.close()
    joined = "\n".join(texts)
    observed = {
        "pages": pages,
        "native_chars": sum(len(text.strip()) for text in texts),
        "images_per_page": image_counts,
    }
    _require(pages == expected["pages"], f"{path.name}: expected {expected['pages']} page(s), generated {pages}")
    for needle in expected.get("text_contains", []):
        _require(needle in joined, f"{path.name}: missing expected text {needle!r}")
    if expected.get("native_text"):
        _require(observed["native_chars"] > 0, f"{path.name}: expected native text, found none")
    else:
        _require(
            observed["native_chars"] == 0,
            f"{path.name}: expected no native text layer, found {observed['native_chars']} chars",
        )
    if "images" in expected:
        _require(
            sum(image_counts) >= expected["images"],
            f"{path.name}: expected at least {expected['images']} image(s), found {image_counts}",
        )
    raw_pages = _pdf_page_count(path)
    _require(raw_pages == pages, f"{path.name}: raw page objects {raw_pages} != parsed pages {pages}")
    return observed


def _verify_docx(path: Path, expected: dict) -> dict:
    from docx import Document
    from docx.opc.constants import RELATIONSHIP_TYPE as RT

    doc = Document(str(path))
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    tables = doc.tables
    hyperlinks = [r for r in doc.part.rels.values() if r.reltype == RT.HYPERLINK]
    observed = {
        "paragraphs": paragraphs,
        "tables": len(tables),
        "table_rows": len(tables[0].rows) if tables else 0,
        "table_cols": len(tables[0].columns) if tables else 0,
        "table_cell_texts": [cell.text for row in tables[0].rows for cell in row.cells] if tables else [],
        "hyperlinks": len(hyperlinks),
        "hyperlink_targets": [r.target_ref for r in hyperlinks],
    }
    if "paragraphs" in expected:
        _require(paragraphs == expected["paragraphs"], f"{path.name}: paragraphs {paragraphs!r} != expected")
    _require(observed["tables"] == expected.get("tables", 0), f"{path.name}: table count mismatch")
    if expected.get("tables"):
        _require(observed["table_rows"] == expected["table_rows"], f"{path.name}: table row count mismatch")
        _require(observed["table_cols"] == expected["table_cols"], f"{path.name}: table column count mismatch")
        _require(
            observed["table_cell_texts"] == expected["table_cell_texts"],
            f"{path.name}: table cell text mismatch",
        )
    _require(observed["hyperlinks"] == expected.get("hyperlinks", 0), f"{path.name}: hyperlink count mismatch")
    if expected.get("hyperlinks"):
        _require(expected["hyperlink_url"] in observed["hyperlink_targets"], f"{path.name}: hyperlink target missing")
        _require(expected["hyperlink_text"] in "\n".join(paragraphs), f"{path.name}: hyperlink text missing")
    return observed


def _verify_image(path: Path, expected: dict) -> dict:
    from PIL import Image

    with Image.open(str(path)) as image:
        observed = {"width": image.width, "height": image.height, "format": image.format}
    _require(observed["width"] == expected["width"], f"{path.name}: width {observed['width']} != expected")
    _require(observed["height"] == expected["height"], f"{path.name}: height {observed['height']} != expected")
    expected_format = "PNG" if expected["kind"] == "image_png" else "JPEG"
    _require(
        (observed["format"] or "").upper() == expected_format,
        f"{path.name}: format {observed['format']} != expected {expected_format}",
    )
    return observed


# ---------------------------------------------------------------------------
# 生成
# ---------------------------------------------------------------------------

#: 伪装件负载：一个 ZIP 头 + 垃圾正文，顶着 .pdf 名字（不是 PDF，也不是 PDF 扩展名的真身）。
MASQUERADE_PAYLOAD = b"PK\x03\x04" + b"synthetic-not-a-pdf-payload" * 8


def generate(dest: Path) -> dict:
    dest.mkdir(parents=True, exist_ok=True)

    # 只清理本脚本自己产出的文件（目录里的别的文件不碰）。
    for name in MANIFEST_ORDER:
        stale = dest / name
        if stale.is_file():
            stale.unlink()

    text_simple = _pdf_pages(
        [TEXT_PAGE_1, TEXT_PAGE_2],
        title="synthetic text document",
        author="u0-fixture-generator",
        producer="u0-fixture-generator",
    )
    variant = _pdf_pages(
        [TEXT_PAGE_1, TEXT_PAGE_2],
        title="synthetic text document (variant)",
        author="another-author",
        producer="u0-fixture-generator-variant",
    )
    _require(
        text_simple != variant,
        "variant fixture must differ in bytes from the original (metadata change was lost)",
    )

    payloads: dict[str, bytes] = {
        "text_simple.pdf": text_simple,
        "text_two_column.pdf": _two_column_pdf_bytes(),
        "scan_image_only.pdf": _scan_pdf_bytes(SCAN_LINES),
        "ocr_confusable.pdf": _pdf_pages(
            [CONFUSABLE_LINES],
            title="synthetic ocr confusion",
            author="u0-fixture-generator",
            producer="u0-fixture-generator",
        ),
        "text_variant_same_content.pdf": variant,
        "image.png": _text_image_bytes(IMAGE_LINES, width=IMAGE_WIDTH, height=IMAGE_HEIGHT, fmt="PNG"),
        "image.jpg": _text_image_bytes(IMAGE_LINES, width=IMAGE_WIDTH, height=IMAGE_HEIGHT, fmt="JPEG"),
        "corrupted_truncated.pdf": text_simple[
            : int(len(text_simple) * EXPECTED["corrupted_truncated.pdf"]["keep_ratio"])
        ],
        "masquerade_not_a_pdf.pdf": MASQUERADE_PAYLOAD,
        "zero_byte.pdf": b"",
    }
    for name, payload in payloads.items():
        (dest / name).write_bytes(payload)
    _write_docx_normal(dest / "docx_normal.docx")
    _write_docx_table(dest / "docx_table.docx")

    files: list[dict] = []
    for name in MANIFEST_ORDER:
        path = dest / name
        expected = EXPECTED[name]
        _require(path.is_file(), f"{name}: file was not generated")
        payload = path.read_bytes()
        kind = expected["kind"]
        verifier = VERIFIER_BY_KIND[kind]
        observed: dict
        if verifier == "pdf":
            observed = _verify_pdf(path, expected)
        elif verifier == "docx":
            observed = _verify_docx(path, expected)
        elif verifier == "image":
            observed = _verify_image(path, expected)
        elif verifier == "truncated":
            _require(0 < len(payload) < len(text_simple), f"{name}: truncated fixture is not smaller than the original")
            observed = {"bytes": len(payload), "original_bytes": len(text_simple)}
        elif verifier == "masquerade":
            _require(payload.startswith(b"PK\x03\x04"), f"{name}: masquerade payload must be a ZIP header")
            _require(not payload.startswith(b"%PDF-"), f"{name}: masquerade fixture must not start with %PDF-")
            observed = {"head_hex": payload[:4].hex()}
        elif verifier == "empty":
            _require(len(payload) == 0, f"{name}: zero byte fixture is not empty")
            observed = {"bytes": 0}
        else:  # pragma: no cover - 派发表是封闭的
            raise AssertionError(f"{name}: no verifier for kind {kind!r}")
        files.append(
            {
                "name": name,
                "kind": kind,
                "media_type": expected["media_type"],
                "bytes": len(payload),
                "sha256": _sha256(payload),
                "expected": {k: v for k, v in expected.items() if k not in ("kind", "media_type")},
                "observed": observed,
            }
        )

    # 同内容不同 bytes 的交叉核对
    by_name = {entry["name"]: entry for entry in files}
    _require(
        by_name["text_simple.pdf"]["sha256"] != by_name["text_variant_same_content.pdf"]["sha256"],
        "variant fixture must differ in sha256 from the original",
    )
    _require(
        by_name["text_simple.pdf"]["observed"]["native_chars"]
        == by_name["text_variant_same_content.pdf"]["observed"]["native_chars"],
        "variant fixture must keep the same native text length",
    )

    self_check_no_real_data(
        TEXT_PAGE_1
        + TEXT_PAGE_2
        + LEFT_COLUMN
        + RIGHT_COLUMN
        + SCAN_LINES
        + CONFUSABLE_LINES
        + DOCX_PARAGRAPHS
        + DOCX_TABLE_INTRO
        + IMAGE_LINES
    )

    manifest = {
        "version": 1,
        "generator": Path(__file__).name,
        "purpose": "synthetic fixtures for the unified document contract (U0); no real personal data",
        "dir": str(dest),
        "ordering": MANIFEST_ORDER,
        "files": files,
        "self_check": {
            "no_real_personal_data": True,
            "emails_use_reserved_tlds": list(ALLOWED_EMAIL_DOMAINS),
            "phones_in_555_01xx_range": True,
            "expectations_are_hand_written": True,
        },
    }
    (dest / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def main(argv: list[str]) -> int:
    if len(argv) > 2:
        print("usage: python generate.py [DEST_DIR]", file=sys.stderr)
        return 2
    dest = (
        Path(argv[1])
        if len(argv) == 2
        else Path(
            os.environ.get("DOCUMENT_FIXTURES_DIR")
            or os.path.join(tempfile.gettempdir(), "recruitment-document-fixtures")
        )
    )
    dest = dest.resolve()
    manifest = generate(dest)
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps({"dir": manifest["dir"], "files": len(manifest["files"]), "manifest": str(dest / "manifest.json")}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
