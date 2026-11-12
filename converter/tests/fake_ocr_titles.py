#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Stand-in for ``src/ocr_titles.py`` used by tests.

It prints the same JSON shape as the real tool (titles only: text + visual height
+ PDF bbox).  The point of the test is the *contract* — OCR may add headings and
must never replace native body text — not the OCR engine itself.
"""
from __future__ import annotations

import json
import sys

PAGES = [{
    "page": 1,
    "lines": [
        {"text": "工作经历", "height": 20.0, "bbox_pdf": [40.0, 300.0, 140.0, 320.0]},
        {"text": "教育背景", "height": 20.0, "bbox_pdf": [40.0, 500.0, 140.0, 520.0]},
        {"text": "这是一段被识别出来的正文行，长度超过二十个字符，用来压低正文高度基准值",
         "height": 10.0, "bbox_pdf": [40.0, 340.0, 400.0, 350.0]},
        {"text": "这是第二段被识别出来的正文行，长度同样超过二十个字符，只是高度基准样本",
         "height": 10.0, "bbox_pdf": [40.0, 360.0, 400.0, 370.0]},
        {"text": "这是第三段被识别出来的正文行，长度同样超过二十个字符，用于稳定众数估计",
         "height": 10.0, "bbox_pdf": [40.0, 380.0, 400.0, 390.0]},
    ],
}]


def main() -> int:
    sys.stdout.write(json.dumps({"ok": True, "dpi": 200, "pages": PAGES},
                                ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
