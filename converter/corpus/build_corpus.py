# -*- coding: utf-8 -*-
"""Build the layered PDF acceptance corpus (manifest only; originals stay in place)."""
import hashlib, json, re, sys
from pathlib import Path
import fitz

ROOTS = [
    ("talent_pool", Path(r"D:\12412\dsh工作区\projects\resume-talent-pool\.snap-cache\research\content")),
    ("odoo_samples", Path(r"D:\12412\dsh工作区\orchestration\recruitment-os\work\r2\proof\A\src\odoo-20.0\addons\hr_recruitment\static\applicant_cvs")),
    ("codex_converted", Path(r"D:\12412\CodexWorkspace\10-projects\resume-md-results\work\urgent-zh-20261028\docx-src")),
]
PLATFORM = re.compile(r"BOSS直聘|猎聘|智联|拉勾|51job|前程无忧|脉脉|实习僧")
MAX_PER_ROOT = 30
OUT = Path(sys.argv[1])

def classify(chars, pages, text, images):
    per_page = chars / max(pages, 1)
    tags = []
    if per_page < 80: tags.append("image_only")
    elif per_page < 300: tags.append("text_sparse")
    else: tags.append("text_rich")
    if pages >= 5: tags.append("multi_page")
    if PLATFORM.search(text): tags.append("platform_noise")
    if images and per_page < 300: tags.append("has_images")
    return tags

rows = []
for label, root in ROOTS:
    if not root.is_dir():
        print("missing root", root); continue
    picked = 0
    for path in sorted(root.rglob("*.pdf")):
        if picked >= MAX_PER_ROOT: break
        try:
            data = path.read_bytes()
            with fitz.open(path) as doc:
                pages = doc.page_count
                text = "".join(p.get_text() for p in doc)
                images = sum(len(p.get_images(full=True)) for p in doc)
            chars = len(text.strip())
            rows.append({
                "id": f"{label}-{picked+1:02d}",
                "source": label,
                "path": str(path),
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "pages": pages,
                "native_chars": chars,
                "images": images,
                "tags": classify(chars, pages, text, images),
            })
            picked += 1
        except Exception as exc:
            rows.append({"id": f"{label}-ERR-{picked+1}", "source": label, "path": str(path),
                         "error": str(exc)[:160]})
            picked += 1

OUT.parent.mkdir(parents=True, exist_ok=True)
with OUT.open("w", encoding="utf-8") as fh:
    for row in rows:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")

ok = [r for r in rows if "error" not in r]
summary = {
    "total": len(rows), "readable": len(ok), "errors": len(rows) - len(ok),
    "by_tag": {},
    "by_source": {},
}
for row in ok:
    summary["by_source"][row["source"]] = summary["by_source"].get(row["source"], 0) + 1
    for tag in row["tags"]:
        summary["by_tag"][tag] = summary["by_tag"].get(tag, 0) + 1
print(json.dumps(summary, ensure_ascii=False, indent=1))
