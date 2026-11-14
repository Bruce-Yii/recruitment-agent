"""Single-file reader worker: prints one JSON result to stdout.

Run as ``python -m src.reader_worker <document>``.  It exists so the CLI and the
batch runner can enforce doc 11 C3 (single file <= 50s) by killing a real process
instead of hoping a library call returns: a hung C-level parser cannot be
interrupted from the same thread.

The reader is chosen by content inside :func:`src.reader.read_document`
(PDF / OOXML DOCX -> PyMuPDF, RTF -> striprtf); the extension is not used.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        sys.stderr.write("usage: python -m src.reader_worker <document>\n")
        return 2
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from src.reader import read_document  # 延迟导入，避免启动开销落到父进程

    result = read_document(argv[1])
    payload = json.dumps(result, ensure_ascii=False)
    out = getattr(sys.stdout, "buffer", None)
    if out is not None:
        out.write(payload.encode("utf-8"))
        out.flush()
    else:  # 理论上不会发生；保留可测试性
        sys.stdout.write(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
