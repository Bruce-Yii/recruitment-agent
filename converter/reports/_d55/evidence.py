"""D-55 before/after evidence: count the URI once vs twice in the converter output.

"printed" here means the text the verifier would compare against the original:
Markdown links are reduced to their label (the href is not printed text).  The
verifier itself is imported read-only, only for that same reduction rule.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT))

from verify.verify_output import _strip_link_markdown  # noqa: E402

CASES = [
    ("tang", "唐乐-简历.pdf", "https://zhitu.kralai.tech/"),
    ("tangle", "tangle-resume.pdf", "https://tl66666.github.io/ztai/static/showcase.html"),
]


def _printed(data: dict) -> str:
    return "\n".join(_strip_link_markdown(b.get("text") or "", "", ())[0]
                     for b in data.get("blocks") or [])


def main() -> int:
    lines = []
    for slug, name, uri in CASES:
        row = [f"== {name}  uri={uri}"]
        for tag in ("before", "after"):
            path = HERE / f"{slug}-{tag}.json"
            if not path.is_file():
                row.append(f"  [{tag}] missing {path.name}")
                continue
            data = json.loads(path.read_text(encoding="utf-8"))
            blocks = data.get("blocks") or []
            printed = _printed(data)
            hits = [b for b in blocks if uri in _strip_link_markdown(
                b.get("text") or "", "", ())[0]]
            row.append(
                f"  [{tag}] blocks={len(blocks)} printed_occurrences={printed.count(uri)}")
            for block in hits:
                kind = block.get("kind")
                text = _strip_link_markdown(block.get("text") or "", "", ())[0]
                row.append(f"      - {kind}: {text[:170]!r}")
        lines.extend(row)
    output = HERE / "d55-before-after.txt"
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
