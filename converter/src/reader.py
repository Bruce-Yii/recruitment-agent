"""Content sniffing + reader dispatch for the converter CLI.

The single decision point for "which reader reads this file" is the **bytes**,
never the extension (same rule as the plugin's ``src/document/readers/sniff.ts``):

  * ``%PDF-``            -> :func:`src.pdf_reader.read_pdf` (PyMuPDF)
  * ZIP local/EOCD magic -> :func:`src.pdf_reader.read_pdf` (MuPDF opens OOXML DOCX)
  * ``{\\rtf``           -> :func:`src.rtf_reader.read_rtf` (striprtf, pure Python)
  * anything else        -> a legal failure result (``reader_failed``), never a guess

Why dispatch here instead of inside ``read_pdf``: ``read_pdf`` stays the PDF
(and MuPDF-OOXML) implementation with its own tests; the CLI / worker / batch
entry points all go through :func:`read_document`, so a new format only has to
be registered in one place.
"""
from __future__ import annotations

from pathlib import Path

#: 嗅探只需要文件头几个字节；读更多没有意义。
HEAD_BYTES = 64

PDF_MAGIC = b"%PDF-"
RTF_MAGIC = b"{\\rtf"
ZIP_MAGICS = (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")

FORMAT_PDF = "pdf"
FORMAT_ZIP = "zip"
FORMAT_RTF = "rtf"
FORMAT_UNKNOWN = "unknown"


def sniff_format(path) -> str:
    """只看字节判断容器；读不到文件时返回 ``unknown``（由调用方报失败）。"""
    try:
        with open(path, "rb") as handle:
            head = handle.read(HEAD_BYTES)
    except OSError:
        return FORMAT_UNKNOWN
    if head.startswith(PDF_MAGIC):
        return FORMAT_PDF
    if any(head.startswith(magic) for magic in ZIP_MAGICS):
        return FORMAT_ZIP
    if head.startswith(RTF_MAGIC):
        return FORMAT_RTF
    return FORMAT_UNKNOWN


def backend_name(path) -> str:
    """读取器身份（失败/超时结果也要写真实的 backend，不写死 PyMuPDF）。"""
    fmt = sniff_format(path)
    if fmt == FORMAT_RTF:
        from .rtf_reader import BACKEND_PREFIX, _rtf_version
        return f"{BACKEND_PREFIX}/{_rtf_version()}"
    from .pdf_reader import BACKEND
    return BACKEND


def read_document(path) -> dict:
    """按内容分派读取器；返回 ``content.result()`` 形状的 JSON 安全 dict。"""
    fmt = sniff_format(path)
    if fmt == FORMAT_RTF:
        from .rtf_reader import read_rtf
        return read_rtf(path)
    if fmt in (FORMAT_PDF, FORMAT_ZIP):
        from .pdf_reader import read_pdf
        return read_pdf(path)
    # 未识别的容器：合法失败结果（0 块 + HARD），不拿扩展名猜一个 reader 去读。
    # 但仍然对**实际字节**算 SHA-256：失败结果也要能指向原件（与 read_pdf 的失败口径一致）。
    import hashlib

    from pathlib import Path as _Path

    from . import __version__, content, resume_fields
    from .pdf_reader import BACKEND

    path = _Path(path)
    try:
        sha = hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        sha = None
    return content.result(
        blocks=[], completeness="partial", needs_visual=False,
        issues=[{"code": "reader_failed",
                 "message": ("unsupported document container: the bytes are not PDF, "
                             "DOCX/OOXML (ZIP) or RTF; a reader was not guessed from the "
                             "extension")}],
        meta={"pages": 0, "source_sha256": sha, "source_name": path.name,
              "backend": BACKEND, "reader_version": __version__,
              "page_info": [], "layout_backend": None, "order_verified": False,
              "repaired": False, "failed": True},
        extra={"fields": resume_fields.empty_fields("reader_failed"),
               "noise": [],
               "protected_attributes": resume_fields.empty_protected("reader_failed"),
               "screening": resume_fields.empty_screening("reader_failed"),
               "timeline": {}},
    )
