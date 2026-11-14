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

依赖（fail-closed，2026-11-15 doc1-A）
------------------------------------
两个依赖**分开** import、分开报缺：
  * ``pymupdf``             （导入名 ``fitz``）：把页面渲染成图片；
  * ``rapidocr_onnxruntime``（导入名同）：离线 OCR 引擎，``converter/requirements.txt``
    已声明 ``rapidocr_onnxruntime>=1.4.4``。

缺任一依赖时 stdout **只输出一行 JSON** 并 ``return 3``：
    {"ok": false, "error": "...(含缺哪个包 / 解释器路径 / 安装提示)...",
     "missing": ["rapidocr_onnxruntime"], "detail": "ImportError: ..."}
调用方（``pdf_reader._ocr_page_blocks`` / ``_ocr_heading_inserts``）据此区分
"OCR 后端不可用"和"OCR 跑了但没字"，绝不把缺包静默当成"没有需要补的文字"。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

_PDF_UNITS_PER_INCH = 72.0

#: 缺包时的安装提示（与 ``converter/requirements.txt`` 的声明保持一致）。
_INSTALL_HINTS = {
    "pymupdf": "pip install pymupdf",
    "rapidocr_onnxruntime": "pip install 'rapidocr_onnxruntime>=1.4.4'",
}


def _dependency_error(missing: list[tuple[str, str]]) -> dict:
    """把「缺哪个依赖」写成可诊断的一行 JSON（含解释器路径与安装提示）。"""
    names = [name for name, _error in missing]
    hints = " / ".join(_INSTALL_HINTS.get(name, f"pip install {name}") for name in names)
    return {
        "ok": False,
        "error": ("OCR backend unavailable: missing " + ", ".join(names)
                  + f" for interpreter {sys.executable}; install with {hints} "
                  "(both are declared in converter/requirements.txt)"),
        "missing": names,
        "detail": "; ".join(f"{name}: {error}" for name, error in missing),
    }


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

    # 两个依赖分开 import：缺哪个就报哪个（不要把 rapidocr 缺包伪装成「没有标题」）。
    missing: list[tuple[str, str]] = []
    try:
        import fitz  # noqa: F401 - 渲染后端
    except Exception as exc:  # noqa: BLE001
        missing.append(("pymupdf", f"{type(exc).__name__}: {exc}"))
    RapidOCR = None
    try:
        from rapidocr_onnxruntime import RapidOCR as _RapidOCR  # noqa: F401 - OCR 引擎
        RapidOCR = _RapidOCR
    except Exception as exc:  # noqa: BLE001
        missing.append(("rapidocr_onnxruntime", f"{type(exc).__name__}: {exc}"))
    if missing:
        # stdout 只许有 JSON：缺包是 fail-closed 的可机读结果，不是崩溃。
        print(json.dumps(_dependency_error(missing), ensure_ascii=False))
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
