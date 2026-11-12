# -*- coding: utf-8 -*-
"""按 doc 11 的标准独立复核 batch2 的 45 份：页覆盖 / 逐页字符恒等 / 凭空URI / 坏字形。"""
import json, subprocess, sys
from collections import Counter
from pathlib import Path
import fitz

C = Path(r"D:\12412\dsh工作区\projects\recruitment-agent\converter")
PY = r"D:\Python3.12.9\python.exe"
picked = json.loads((C/"corpus"/"batch2-picked.json").read_text(encoding="utf-8"))
by_sha = {p["Sha"]: p["Path"] for p in picked}
rows = [json.loads(l) for l in (C/"reports"/"batch2-results.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]

import re as _re
_LINK_MD = _re.compile(r"\[((?:\\.|[^\]])*)\]\(<[^>]*>\)")

def strip_links(s):
    """把 [label](<url>) 还原成 label：链接是证据不是新文字。"""
    return _LINK_MD.sub(lambda m: m.group(1).replace("\\[", "[").replace("\\]", "]"), s or "")

def nonspace(s): return Counter("".join(strip_links(s).split()))

report = []
for r in rows:
    if not r.get("ok"): continue
    path = by_sha[r["sha256"]]
    p = subprocess.run([PY, "-m", "src.cli", path, "--no-isolation"], cwd=str(C),
                       capture_output=True, text=True, encoding="utf-8", timeout=120)
    d = json.loads(p.stdout[p.stdout.index("{"):p.stdout.rindex("}")+1])
    with fitz.open(path) as doc:
        native_pages = doc.page_count
        native_text = {i+1: pg.get_text() for i, pg in enumerate(doc)}
        native_uris = set()
        for pg in doc:
            for l in pg.get_links():
                if l.get("uri"): native_uris.add(l["uri"])
    out_pages = d.get("meta", {}).get("pages")
    blocks = d.get("blocks") or []
    by_page = {}
    for b in blocks:
        pg = (b.get("location") or {}).get("page")
        by_page.setdefault(pg, []).append(b.get("text") or "")
    page_info = {pi.get("page"): pi for pi in (d.get("meta", {}).get("page_info") or [])}
    bad_pages = []
    for pg in range(1, native_pages + 1):
        nat = nonspace(native_text.get(pg, ""))
        got = nonspace("".join(by_page.get(pg, [])))
        removed = nonspace((page_info.get(pg, {}).get("encoding_removed") or "") + (page_info.get(pg, {}).get("noise_removed") or ""))
        if nat != got + removed:
            diff_missing = sum((nat - (got + removed)).values())
            diff_extra = sum(((got + removed) - nat).values())
            bad_pages.append({"page": pg, "missing": diff_missing, "extra": diff_extra})
    out_uris = set()
    for b in blocks:
        for l in (b.get("links") or []):
            if l.get("href"): out_uris.add(l["href"])
    invented = sorted(out_uris - native_uris)
    body = "".join(b.get("text") or "" for b in blocks)
    badglyph = sum(body.count(ch) for ch in ("\ufffd",)) + len(__import__("re").findall(r"\(cid:\d+\)", body))
    report.append({
        "file": r["file"], "sha256": r["sha256"],
        "pages_native": native_pages, "pages_report": out_pages,
        "page_coverage_ok": native_pages == out_pages,
        "counter_ok": len(bad_pages) == 0,
        "bad_pages": bad_pages[:3],
        "invented_uri": invented[:3], "invented_uri_count": len(invented),
        "bad_glyph_in_body": badglyph,
    })

out = {
    "files": len(report),
    "page_coverage_fail": [r["file"] for r in report if not r["page_coverage_ok"]],
    "counter_fail": [{"file": r["file"], "pages": r["bad_pages"]} for r in report if not r["counter_ok"]],
    "invented_uri_files": [{"file": r["file"], "uris": r["invented_uri"]} for r in report if r["invented_uri_count"] > 0],
    "bad_glyph_files": [{"file": r["file"], "n": r["bad_glyph_in_body"]} for r in report if r["bad_glyph_in_body"] > 0],
}
(C/"reports"/"batch2-fidelity.json").write_text(json.dumps({"summary": out, "per_file": report}, ensure_ascii=False, indent=1), encoding="utf-8")
print(json.dumps(out, ensure_ascii=False, indent=1)[:3000])

