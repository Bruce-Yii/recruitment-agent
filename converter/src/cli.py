"""CLI: ``python -m src.cli <document>`` -> JSON to stdout.

The reader is selected by **content** (see :mod:`src.reader`): PDF and OOXML
DOCX go through PyMuPDF, RTF goes through the pure-Python striprtf reader.
The extension is never used to decide.

Timeout policy (doc 11 C3): the read runs in an isolated child process and the
parent kills it after ``--timeout`` seconds.  A timeout is reported as an issue
(``reader_timeout``) with no body — never as a half-read success.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _timeout_result(path: Path, seconds: float, backend: str | None = None) -> dict:
    from . import __version__, content
    from .resume_fields import empty_fields, empty_protected, empty_screening

    if backend is None:
        from .reader import backend_name
        backend = backend_name(path)
    return content.result(
        blocks=[], completeness="partial", needs_visual=False,
        issues=[{"code": "reader_timeout",
                 "message": f"reading exceeded {seconds:g}s; process was killed, no partial body kept"}],
        meta={"pages": 0, "source_sha256": None, "source_name": path.name,
              "backend": backend, "reader_version": __version__, "page_info": [],
              "layout_backend": None, "order_verified": False, "repaired": False,
              "timed_out": True},
        extra={"fields": empty_fields("reader_timeout"),
               "noise": [],
               "protected_attributes": empty_protected("reader_timeout"),
               "screening": empty_screening("reader_timeout"),
               "timeline": {}},
    )


def _failure_result(path: Path, message: str, backend: str | None = None) -> dict:
    from . import __version__, content
    from .resume_fields import empty_fields, empty_protected, empty_screening

    if backend is None:
        from .reader import backend_name
        backend = backend_name(path)
    return content.result(
        blocks=[], completeness="partial", needs_visual=False,
        issues=[{"code": "reader_failed", "message": message}],
        meta={"pages": 0, "source_sha256": None, "source_name": path.name,
              "backend": backend, "reader_version": __version__, "page_info": [],
              "layout_backend": None, "order_verified": False, "repaired": False,
              "failed": True},
        extra={"fields": empty_fields("reader_failed"),
               "noise": [],
               "protected_attributes": empty_protected("reader_failed"),
               "screening": empty_screening("reader_failed"),
               "timeline": {}},
    )


def read_isolated(path, timeout: float = 50.0) -> dict:
    """Read ``path`` in a child process; kill it after ``timeout`` seconds."""
    path = Path(path)
    if not path.is_file():
        return _failure_result(path, f"file not found: {path}")
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONPATH=str(ROOT))
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    proc = subprocess.Popen([sys.executable, "-m", "src.reader_worker", str(path)],
                            cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=env, creationflags=flags)
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        return _timeout_result(path, timeout)
    if proc.returncode != 0:
        return _failure_result(path, "reader process failed: "
                               + err.decode("utf-8", "replace")[:400])
    try:
        return json.loads(out.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        return _failure_result(path, f"reader produced invalid JSON: {exc}")


def read_any(path, timeout: float = 50.0, isolated: bool = True) -> dict:
    if not isolated or not timeout or timeout <= 0:
        from .reader import read_document
        return read_document(path)
    return read_isolated(path, timeout)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m src.cli",
                                     description="read one document (PDF / DOCX / RTF) and print the JSON result")
    parser.add_argument("document", help="path to the original document (read-only)")
    parser.add_argument("--timeout", type=float, default=50.0,
                        help="kill the reader after N seconds (0 disables isolation)")
    parser.add_argument("--no-isolation", action="store_true",
                        help="read in-process (debugging; no timeout protection)")
    parser.add_argument("--indent", type=int, default=None)
    parser.add_argument("--output", default=None, help="write JSON here instead of stdout")
    parser.add_argument("--summary", action="store_true",
                        help="print a compact summary instead of the full JSON")
    args = parser.parse_args(argv)

    result = read_any(args.document, timeout=args.timeout, isolated=not args.no_isolation)
    if args.summary:
        from .issues import issue_severity
        hard, soft = issue_severity(result.get("issues"))
        payload = json.dumps({
            "path": str(args.document),
            "completeness": result.get("completeness"),
            "needs_visual": result.get("needs_visual"),
            "pages": (result.get("meta") or {}).get("pages"),
            "blocks": len(result.get("blocks") or []),
            "chars": result.get("chars"),
            "issue_codes": [i.get("code") for i in result.get("issues") or []],
            "hard": hard, "soft": soft,
            "fields": {k: v.get("state") for k, v in (result.get("fields") or {}).items()},
        }, ensure_ascii=False, indent=args.indent)
    else:
        payload = json.dumps(result, ensure_ascii=False, indent=args.indent)
    if args.output:
        Path(args.output).write_text(payload, encoding="utf-8")
    else:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdout.write(payload + ("\n" if args.indent is None else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
