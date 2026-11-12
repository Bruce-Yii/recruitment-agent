#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""OCR 标题识别工具（独立进程，供 pdf_reader.read_pdf 的「区域补读」调用）

Provenance
----------
Copied from ``resume-conversion-build/tools/conversion/ocr_titles.py``
(read-only reference, 2026-11).  Behaviour is unchanged.

遵守历史决定（docs/OWNER-SCOPE-HTML-2026-10-22.md:54）：
    RapidOCR / ONNX Runtime / PP-OCR 离线识别可用，但
    「把结果原样替换整页会丢掉原本正确的正文，因此不采用整页覆盖」。
    因此只做**区域补读与原生正确文字保护**，只对少数困难部分定向补救。

因此本工具：
    * 只输出「标题候选」——文字 + 视觉高度 + PDF 坐标，**不输出正文**；
    * 正文永远来自原生文本层；
    * 调用方按 y 坐标把标题插回原生流，实现"补标题而不换正文"。

用法：
    <ocr_python> ocr_titles.py <pdf路径> [--max-pages N] [--dpi 200]
输出（stdout，UTF-8 JSON）：
    {"ok": true, "dpi": 200, "pages": [
        {"page": 1, "lines": [{"text": "...", "height": 22.0,
                               "bbox_pdf": [x0,y0,x1,y1]}]}]}
bbox_pdf 已按 dpi→72pt 换算，可直接与 PyMuPDF block bbox 比较。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

_PDF_UNITS_PER_INCH = 72.0


def _quad_to_rect(box, scale: float):
    """四点多边形 → PDF 坐标 [x0,y0,x1,y1]（已除以渲染缩放）。"""
    try:
        xs = [float(p[0]) / scale for p in box]
        ys = [float(p[1]) / scale for p in box]
        return [min(xs), min(ys), max(xs), max(ys)]
    except (TypeError, ValueError, IndexError):
        return []


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--max-pages", type=int, default=3)
    ap.add_argument("--dpi", type=int, default=200)
    args = ap.parse_args()

    pdf = Path(args.pdf)
    if not pdf.is_file():
        print(json.dumps({"ok": False, "error": "file not found"}, ensure_ascii=False))
        return 2

    try:
        import fitz
        from rapidocr_onnxruntime import RapidOCR
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"import failed: {exc}"}, ensure_ascii=False))
        return 3

    scale = float(args.dpi) / _PDF_UNITS_PER_INCH
    engine = RapidOCR()
    pages = []
    # 沙箱下系统 temp 不可写（tempfile.gettempdir() 会抛 FileNotFoundError）。
    tmp_root = os.environ.get("RESUME_CONVERSION_OCR_TMPDIR", "").strip() or os.getcwd()
    Path(tmp_root).mkdir(parents=True, exist_ok=True)
    tmpdir = tempfile.mkdtemp(prefix="ocr_titles_", dir=tmp_root)
    try:
        doc = fitz.open(str(pdf))
        try:
            for index, page in enumerate(doc, 1):
                if index > args.max_pages:
                    break
                pix = page.get_pixmap(dpi=args.dpi)
                img = Path(tmpdir) / f"p{index}.png"
                img.write_bytes(pix.tobytes("png"))
                res, _ = engine(str(img))
                lines = []
                for item in res or []:
                    try:
                        box, text = item[0], item[1]
                    except (IndexError, TypeError):
                        continue
                    text = (text or "").strip()
                    if not text:
                        continue
                    rect = _quad_to_rect(box, scale)
                    height = (rect[3] - rect[1]) if len(rect) == 4 else 0.0
                    lines.append({"text": text, "height": round(height, 1), "bbox_pdf": rect})
                pages.append({"page": index, "lines": lines})
        finally:
            doc.close()
    finally:
        try:
            for leftover in Path(tmpdir).glob("*.png"):
                leftover.unlink()
            Path(tmpdir).rmdir()
        except OSError:
            pass

    print(json.dumps({"ok": True, "dpi": args.dpi, "pages": pages}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
