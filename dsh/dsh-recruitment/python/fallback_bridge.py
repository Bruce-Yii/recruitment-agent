"""Subprocess bridge between the DSH plugin and ``converter/fallback`` (D-81).

Why this file exists
--------------------
D-81 splits the fallback path by *who is the model*:

* the **reading** is done by the calling agent (it is a model, it has vision,
  and it is already in the session) — the plugin must not call a model;
* the **render** (step A), the **verification** (step D) and the **merge**
  (step E) stay here, because they are deterministic and already implemented.

So this bridge is only plumbing: it maps one JSON request on stdin to one call
into ``converter/fallback`` and prints one JSON response.  It deliberately does
**not** re-implement any rendering, any verification rule, or any merge
semantics — those live in ``page_image.py`` / ``verify_model_text.py`` /
``merge.py`` and are imported as-is.

Requests (stdin, UTF-8 JSON)::

    {"op": "page-image", "pdf": "<abs path>", "page": 2, "dpi": 200}
    {"op": "merge", "pdf": "<abs path>", "page": 2, "text": "...", "model": "beam-free"}

Responses (stdout, UTF-8 JSON)::

    {"ok": true, "render": {image_path, page, dpi, pixel_size, page_size_pt,
                            source_sha256, oversampled}}
    {"ok": true, "merge": {accepted, rejections[], blocks_before, blocks_after}}
    {"ok": false, "code": "<stable code>", "message": "<one line>"}

R7 (never leak candidate text)
------------------------------
The transcription is **never** echoed: not on success, not in a rejection, not
in an exception message.  A rejection carries a stable code plus a message that
is either purely numeric or redacted; the two messages that embed a fragment of
the reading are replaced with fixed text (see ``_FIXED_MESSAGES``).

stdin is used instead of argv on purpose: a transcription on a command line is
visible to every process on the box.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import uuid
from pathlib import Path

# py3.12 on Windows defaults stdio to the ANSI code page; the request and the
# response are both UTF-8 JSON and contain CJK text.
STDIN_ENCODING = "utf-8"
MAX_MESSAGE = 600

# Codes whose default message embeds a slice of the reading ("preamble line
# '张三 138…'") or the model's own words.  Replaced by fixed text: a rejection
# must never carry candidate text out of this process (R7).  The code itself
# still tells the caller exactly which check failed.
_FIXED_MESSAGES = {
    "OUTPUT_WRAPPED": (
        "the reading is wrapped in a code fence / JSON / a preamble line; "
        "the fixed transcription prompt forbids it (the wrapper text is redacted)"
    ),
    "META_DISCOURSE": (
        "the reading talks about the model (refusal / apology / AI self-reference) "
        "instead of transcribing the page (the matched fragment is redacted)"
    ),
}

# Quoted fragments that leaked into an otherwise numeric message (Python's !r
# uses single quotes; JSON-ish debug text uses double quotes).  Belt and braces
# for codes added later: a new message that embeds text is redacted even if it
# is not listed in _FIXED_MESSAGES.
_QUOTED_RE = re.compile(r"'[^']*'|\"[^\"]*\"")

# Issues that mean "the converter could not read this file at all".  Merging a
# model reading onto a result with no baseline would create a block for a file
# we never actually opened; fail closed instead.
_FATAL_READER_CODES = {"reader_failed", "reader_timeout"}

# Converter issue code -> the module error it degrades to in the plugin.
_READER_ERROR_CODES = {
    "pdf_missing": "pdf_missing",
    "page_invalid": "page_invalid",
    "page_out_of_range": "page_out_of_range",
    "dpi_invalid": "dpi_invalid",
    "dpi_out_of_range": "dpi_out_of_range",
    "render_path_in_repo": "render_path_in_repo",
    "pdf_open_failed": "pdf_open_failed",
    "encrypted_pdf": "encrypted_pdf",
    "render_failed": "render_failed",
    "png_write_failed": "png_write_failed",
}


def _redact(message) -> str:
    """Strip any quoted fragment from a message and bound its length."""
    text = _QUOTED_RE.sub("<redacted>", str(message))
    return text.replace("\r", " ").replace("\n", " ")[:MAX_MESSAGE]


def _fail(code: str, message) -> dict:
    return {"ok": False, "code": str(code), "message": _redact(message)}


def _require_str(request: dict, key: str) -> str:
    value = request.get(key)
    if not isinstance(value, str):
        raise ValueError(f"{key} must be a string")
    return value


def _require_page(request: dict) -> int:
    value = request.get("page")
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("page must be a positive integer (1-based)")
    return value


def _load_modules(converter_dir: str):
    """Import the existing fallback modules from ``converter_dir``.

    The modules are used exactly as they are: ``fallback.merge`` pulls in
    ``fallback.page_image`` and ``fallback.verify_model_text`` itself, so the
    bridge cannot accidentally run a different verification path than the one
    the package's own tests cover.
    """
    root = str(Path(converter_dir).resolve())
    if root not in sys.path:
        sys.path.insert(0, root)
    from fallback import merge as merge_module
    from fallback import page_image as page_image_module
    from src import cli as cli_module

    return page_image_module, merge_module, cli_module


def _op_page_image(page_image_module, request: dict) -> dict:
    pdf = _require_str(request, "pdf")
    page = _require_page(request)
    dpi = request.get("dpi")
    if dpi is not None and (isinstance(dpi, bool) or not isinstance(dpi, int)):
        return _fail("dpi_invalid", "dpi must be an integer when given")
    try:
        record = page_image_module.render_page(pdf, page, dpi=dpi)
    except page_image_module.RenderError as exc:
        return _fail(_READER_ERROR_CODES.get(exc.code, "render_failed"), exc.message)
    return {
        "ok": True,
        "render": {
            # Absolute path of the PNG under the OS temp dir.  The file is left
            # in place: the agent still has to read it (D-81).
            "image_path": record["png_path"],
            "page": record["page"],
            "dpi": record["dpi"],
            "pixel_size": list(record["pixel_size"]),
            "page_size_pt": list(record["page_size_pt"]),
            "source_sha256": record["source_sha256"],
            "oversampled": bool(record["oversampled"]),
        },
    }


def _op_merge(page_image_module, merge_module, cli_module, request: dict) -> dict:
    pdf = _require_str(request, "pdf")
    page = _require_page(request)
    text = _require_str(request, "text")
    model = request.get("model")
    if not isinstance(model, str):
        model = ""
    try:
        read_timeout = float(request.get("read_timeout") or 45.0)
    except (TypeError, ValueError):
        read_timeout = 45.0
    read_timeout = max(5.0, min(120.0, read_timeout))

    # The native baseline comes from the converter's own read path (same entry
    # the plugin's resume_read tool uses), never from a second PDF parser here.
    result = cli_module.read_any(pdf, timeout=read_timeout, isolated=True)
    issues = [i for i in (result.get("issues") or []) if isinstance(i, dict)]
    fatal = sorted({i.get("code") for i in issues if i.get("code") in _FATAL_READER_CODES})
    if fatal:
        return _fail(
            "reader_failed",
            "the converter could not read this PDF, so nothing was merged (issues: "
            + ", ".join(str(code) for code in fatal)
            + ")",
        )
    pages = (result.get("meta") or {}).get("pages")
    if isinstance(pages, int) and not isinstance(pages, bool) and pages >= 1 and page > pages:
        return _fail("page_out_of_range", f"page {page} is beyond the page count {pages}")

    read = {"page": page, "text": text, "source": "MODEL", "model": model}
    source_sha = (result.get("meta") or {}).get("source_sha256")
    if isinstance(source_sha, str) and source_sha:
        read["source_sha256"] = source_sha

    merged = merge_module.merge_model_reads(result, [read], run_id=uuid.uuid4().hex)
    applied = merged.get("model_read_applied") or []
    rejected = merged.get("model_read_rejected") or []
    skipped = merged.get("model_read_skipped") or []

    rejections: list[dict] = []
    for record in rejected:
        for reason in record.get("reasons") or []:
            code = str(reason.get("code") or "UNKNOWN")
            message = _FIXED_MESSAGES.get(code)
            if message is None:
                message = _redact(reason.get("message") or "")
            rejections.append({"code": code, "message": message})
    for record in skipped:
        rejections.append({
            "code": str(record.get("reason") or "SKIPPED"),
            "message": (f"page {record.get('page')} already carries a model_read block "
                        "from an earlier merge; nothing was appended"),
        })
    if not applied and not rejections:
        rejections.append({
            "code": "NOT_APPLIED",
            "message": "merge returned neither an applied nor a rejected record; treated as rejected",
        })

    return {
        "ok": True,
        "merge": {
            "accepted": bool(applied),
            "rejections": rejections,
            "blocks_before": len(result.get("blocks") or []),
            "blocks_after": len(merged.get("blocks") or []),
        },
    }


def handle(request: dict, converter_dir: str) -> dict:
    op = request.get("op")
    if op not in ("page-image", "merge"):
        return _fail("invalid_request", "op must be 'page-image' or 'merge'")
    page_image_module, merge_module, cli_module = _load_modules(converter_dir)
    if op == "page-image":
        return _op_page_image(page_image_module, request)
    return _op_merge(page_image_module, merge_module, cli_module, request)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="fallback_bridge",
        description="render one PDF page or merge one verified model reading",
    )
    parser.add_argument("--converter-dir", required=True,
                        help="absolute path of the converter/ tree (contains fallback/ and src/)")
    args = parser.parse_args(argv)

    sys.stdin.reconfigure(encoding=STDIN_ENCODING, errors="strict")
    sys.stdout.reconfigure(encoding="utf-8")

    try:
        request = json.loads(sys.stdin.read())
        if not isinstance(request, dict):
            raise ValueError("request must be a JSON object")
        response = handle(request, args.converter_dir)
    except ValueError as exc:
        response = _fail("invalid_request", exc)
    except Exception as exc:  # noqa: BLE001 - the caller maps the code
        response = _fail("bridge_failed", f"{type(exc).__name__}: {exc}")

    sys.stdout.write(json.dumps(response, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
