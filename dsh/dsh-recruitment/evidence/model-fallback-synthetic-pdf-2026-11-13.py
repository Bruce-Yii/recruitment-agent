"""Build an R7-safe synthetic resume page for the model-fallback evidence run.

Why it exists
-------------
The evidence run needs a page the converter genuinely cannot read (no text
layer), so the only way to get the text is the agent looking at a rendered
image.  Using ``platform_noise.pdf`` / ``image_only_*.pdf`` is forbidden: one of
them is a real resume (see evidence/r2-tool-reachability-2026-11-13.md §4.3).

How
---
1. draw the *self-authored, obviously fictional* text on an A4 page with a real
   CJK font (simhei.ttf) -- this intermediate page still has a text layer;
2. rasterise that page at 300 dpi and encode the raster as JPEG (a lossless PNG
   of a text page is ~26 MB; 200-dpi legibility is what matters here);
3. put the raster into a fresh A4 PDF, full page -> the result carries one image
   and **no text layer at all**, which is exactly the fallback condition.

Everything lands in %TEMP%; nothing is copied into the repository.
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import fitz

FONT = r"C:\Windows\Fonts\simhei.ttf"
OUT_DIR = Path(tempfile.gettempdir()) / "recruitment-r7-synthetic"

# R7: every value below is invented.  The phone number is the reserved
# documentation range (0000), the e-mail uses .invalid (RFC 2606), the names and
# employers are "示例…" (example…).
LINES = [
    ("【合成样例 · 非真实简历】", 11.0),
    ("示例 候选人甲", 20.0),
    ("求职意向：后端工程师（演示数据）", 11.5),
    ("电话：138-0000-0000    邮箱：demo.candidate@example.invalid", 11.5),
    ("城市：示例市    工作年限：5 年", 11.5),
    ("", 6.0),
    ("工作经历", 14.0),
    ("2021.07 - 2024.06    示例科技有限公司    后端工程师", 11.5),
    ("· 负责订单服务拆分，接口 P99 从 480ms 降到 120ms", 11.5),
    ("· 主导对账任务从单体迁移到消息队列，日处理 200 万单", 11.5),
    ("2019.07 - 2021.06    示例数据服务中心    开发工程师", 11.5),
    ("· 维护报表导出服务，覆盖 12 个业务线", 11.5),
    ("", 6.0),
    ("教育背景", 14.0),
    ("2015.09 - 2019.06    示例大学    计算机科学与技术    本科", 11.5),
    ("", 6.0),
    ("技能", 14.0),
    ("Python / TypeScript / PostgreSQL / 消息队列 / 单元测试", 11.5),
    ("", 6.0),
    ("自我评价", 14.0),
    ("习惯先写失败用例再改代码；对数据一致性有洁癖。", 11.5),
]


def draw_source(path: Path) -> None:
    """Lay the text out as real text on an A4 page (an intermediate file only)."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)  # A4, points
    y = 70.0
    for text, size in LINES:
        if text:
            page.insert_text((50, y), text, fontsize=size, fontname="cjk", fontfile=FONT)
        y += size * 1.55 + 2.0
    doc.save(str(path))
    doc.close()


def rasterise_jpeg(source: Path, dpi: int = 300, quality: int = 88) -> tuple[bytes, tuple[int, int]]:
    doc = fitz.open(str(source))
    pix = doc[0].get_pixmap(dpi=dpi, alpha=False)
    data = pix.tobytes("jpg", jpg_quality=quality)
    size = (pix.width, pix.height)
    doc.close()
    return data, size


def embed(jpeg: bytes, out: Path) -> None:
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_image(page.rect, stream=jpeg)
    doc.save(str(out), deflate=True, garbage=4)
    doc.close()


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    source = OUT_DIR / "source-text.pdf"
    out = OUT_DIR / "synthetic-resume-r7.pdf"

    draw_source(source)
    jpeg, size = rasterise_jpeg(source)
    assert size[0] > 2000 and size[1] > 3000, f"raster too small: {size}"
    embed(jpeg, out)

    # Prove the precondition: the final PDF has no readable text layer, and the
    # page really carries a raster big enough to read.
    doc = fitz.open(str(out))
    text = doc[0].get_text() or ""
    chars = len(text.strip())
    pages = doc.page_count
    images = doc[0].get_images(full=True)
    image_px = max((info[2], info[3]) for info in images) if images else (0, 0)
    doc.close()
    source_chars = len(fitz.open(str(source))[0].get_text().strip())
    print(f"pdf={out}")
    print(f"pages={pages} text_layer_chars={chars} embedded_px={image_px} raster={size[0]}x{size[1]}")
    print(f"source_text_layer_chars={source_chars}")
    print(f"exists={out.is_file()} bytes={out.stat().st_size}")
    return 0 if chars == 0 and pages == 1 and source_chars > 100 else 1


if __name__ == "__main__":
    sys.exit(main())
