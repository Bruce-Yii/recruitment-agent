# -*- coding: utf-8 -*-
"""Replace machine-absolute corpus paths with a portable root key + relative path.

Identity is the sha256, not the path. `root` names a corpus root that an operator
declares through an environment variable; `rel` is the path inside that root.
Nothing else in the manifest changes.
"""
import json, os, sys
from pathlib import Path

ROOTS = {
    # 一次性迁移工具的输入根：**不在仓库里写死盘符**（R7：机器路径不入库）。
    # 换机器时用环境变量声明，例如
    #   $env:CORPUS_ROOT_TALENT_POOL='D:\...\content'
    #   $env:CORPUS_ROOT_ODOO_SAMPLES='D:\...\applicant_cvs'
    #   $env:CORPUS_ROOT_CODEX_CONVERTED='D:\...\docx-src'
    #   $env:CORPUS_ROOT_SYNTHETIC='<repo>\converter\corpus\synthetic'
    # 未声明的根不会静默兜底：该行的 path 原样保留，由调用方发现并补配置。
    "talent_pool": os.environ.get("CORPUS_ROOT_TALENT_POOL", ""),
    "odoo_samples": os.environ.get("CORPUS_ROOT_ODOO_SAMPLES", ""),
    "codex_converted": os.environ.get("CORPUS_ROOT_CODEX_CONVERTED", ""),
    "synthetic": os.environ.get("CORPUS_ROOT_SYNTHETIC", ""),
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
