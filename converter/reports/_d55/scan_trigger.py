"""Read-only scan: which corpus files would lose a fallback `link` block under D-55?

For every page, a fallback block (kind == "link") means: a real URI annotation
whose visible words could not be bound to a block.  The D-55 fix skips such a
block when the URI's literal text already appears in another block of that page.
This script lists those cases so the A5 ("every real URI appears") impact is
known before/after the change.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from src import pdf_reader  # noqa: E402

NS = re.compile(r"\s")


def scan(path: str) -> list[dict]:
    result = pdf_reader.read_pdf(path)
    out = []
    by_page: dict[int, list[dict]] = {}
    for block in result.get("blocks") or []:
        page = (block.get("location") or {}).get("page")
        by_page.setdefault(page, []).append(block)
    for page, blocks in by_page.items():
        # text of the *other* blocks on the page (whitespace-insensitive)
        for block in blocks:
            if block.get("kind") != "link":
                continue
            hrefs = [link.get("href") for link in block.get("links") or [] if link.get("href")]
            for href in hrefs:
                others = "".join(NS.sub("", b.get("text") or "") for b in blocks
                                 if b is not block)
                out.append({"page": page, "href": href,
                            "already_visible": NS.sub("", href) in others,
                            "label": (block.get("links") or [{}])[0].get("text")})
    return out


def main() -> int:
    rows = [json.loads(line) for line in
            (ROOT / "corpus" / "manifest.jsonl").read_text(encoding="utf-8").splitlines()
            if line.strip()]
    rows += [json.loads(line) for line in
             (ROOT / "corpus" / "synthetic" / "synthetic-manifest.jsonl")
             .read_text(encoding="utf-8").splitlines() if line.strip()]
    env = {
        "talent_pool": "CORPUS_ROOT_TALENT_POOL",
        "odoo_samples": "CORPUS_ROOT_ODOO_SAMPLES",
        "codex_converted": "CORPUS_ROOT_CODEX_CONVERTED",
        "synthetic": "CORPUS_ROOT_SYNTHETIC",
    }
    import os
    report = {"manifest": [], "batch2": []}
    for row in rows:
        root = os.environ.get(env.get(row["root"], ""), "")
        path = Path(root) / row["rel"] if root else None
        if path is None or not path.is_file():
            report["manifest"].append({"id": row["id"], "error": "original missing"})
            continue
        hits = [h for h in scan(str(path)) if h["already_visible"]]
        if hits:
            report["manifest"].append({"id": row["id"], "path": str(path), "hits": hits})
    picked = json.loads((ROOT / "corpus" / "batch2-picked.json").read_text(encoding="utf-8"))
    for row in picked:
        hits = [h for h in scan(row["Path"]) if h["already_visible"]]
        if hits:
            report["batch2"].append({"name": row["Name"], "hits": hits})
    (ROOT / "reports" / "_d55" / "trigger-scan.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
