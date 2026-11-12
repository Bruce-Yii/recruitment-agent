# -*- coding: utf-8 -*-
"""Build synthetic hard cases the real corpus does not contain."""
import hashlib, json, sys
from pathlib import Path
import fitz

OUT = Path(sys.argv[1])
SRC_MANIFEST = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)

rows = [json.loads(l) for l in SRC_MANIFEST.read_text(encoding="utf-8").splitlines() if l.strip()]
rich = [r for r in rows if "text_rich" in r["tags"] and "error" not in r][:6]

made = []

def add(path, layer, note):
    data = path.read_bytes()
    made.append({"id": f"synthetic-{layer}", "source": "synthetic", "path": str(path),
                 "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                 "pages": None, "native_chars": None, "images": None,
                 "tags": [layer], "synthetic": True, "note": note})

# 1) image_only: render first 2 pages of a rich resume to images, rebuild as image-only PDF
for index, row in enumerate(rich[:3], 1):
    src = fitz.open(row["path"])
    out = fitz.open()
    for page in list(src)[:2]:
        pix = page.get_pixmap(dpi=150)
        target = out.new_page(width=pix.width, height=pix.height)
        img = OUT / f"_tmp_{index}.png"
        pix.save(img)
        target.insert_image(fitz.Rect(0, 0, pix.width, pix.height), filename=str(img))
        img.unlink()
    path = OUT / f"image_only_{index}.pdf"
    out.save(path); out.close(); src.close()
    add(path, "image_only", "rendered text pages as images; no text layer")

# 2) encrypted: password-protected copy
src = fitz.open(rich[0]["path"])
path = OUT / "encrypted.pdf"
src.save(path, encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="secret")
src.close()
add(path, "encrypted", "AES-256, user password set")

# 3) corrupted: truncated bytes
data = Path(rich[1]["path"]).read_bytes()
path = OUT / "corrupted.pdf"
path.write_bytes(data[: len(data) // 3])
add(path, "corrupted", "truncated to one third of original bytes")

# 4) platform_noise: stamp a recruiting-site watermark into every page
src = fitz.open(rich[2]["path"])
for page in src:
    rect = page.rect
    page.insert_text((rect.width * 0.3, 20), "BOSS直聘  www.zhipin.com", fontsize=9, color=(0.6, 0.6, 0.6))
src.save(OUT / "platform_noise.pdf"); src.close()
add(OUT / "platform_noise.pdf", "platform_noise", "BOSS直聘 watermark stamped on every page")

# 5) zero_text: a PDF with no text and no images at all
doc = fitz.open(); doc.new_page(); doc.save(OUT / "zero_text.pdf"); doc.close()
add(OUT / "zero_text.pdf", "zero_text", "blank page; no text, no images")

with (OUT / "synthetic-manifest.jsonl").open("w", encoding="utf-8") as fh:
    for row in made:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")
print(json.dumps({"created": len(made), "layers": [r["tags"][0] for r in made]}, ensure_ascii=False))
