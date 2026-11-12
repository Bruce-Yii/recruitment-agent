# -*- coding: utf-8 -*-
"""Replace machine-absolute corpus paths with a portable root key + relative path.

Identity is the sha256, not the path. `root` names a corpus root that an operator
declares through an environment variable; `rel` is the path inside that root.
Nothing else in the manifest changes.
"""
import json, os, sys
from pathlib import Path

ROOTS = {
    "talent_pool": r"D:\12412\dsh工作区\projects\resume-talent-pool\.snap-cache\research\content",
    "odoo_samples": r"D:\12412\dsh工作区\orchestration\recruitment-os\work\r2\proof\A\src\odoo-20.0\addons\hr_recruitment\static\applicant_cvs",
    "codex_converted": r"D:\12412\CodexWorkspace\10-projects\resume-md-results\work\urgent-zh-20261028\docx-src",
    "synthetic": r"D:\12412\dsh工作区\projects\recruitment-os\converter\corpus\synthetic",
}

def portable(row):
    path = row.pop("path", None)
    if path is None:
        return row
    source = row.get("source", "")
    root = ROOTS.get(source)
    rel = None
    if root:
        try:
            rel = str(Path(path).resolve().relative_to(Path(root).resolve())).replace("\\", "/")
        except ValueError:
            rel = None
    if rel is None:
        # Synthetic rows live beside the manifest; keep only the file name.
        rel = Path(path).name
        root = "synthetic"
    row["root"] = source if source in ROOTS else "synthetic"
    row["rel"] = rel
    return row

for target in sys.argv[1:]:
    p = Path(target)
    rows = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
    out = [portable(dict(r)) for r in rows]
    p.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in out) + "\n", encoding="utf-8")
    print(f"{p.name}: {len(out)} rows rewritten")
