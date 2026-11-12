# -*- coding: utf-8 -*-
"""Batch 2: run the converter over newly picked resumes (not in the acceptance corpus)."""
import json, subprocess, sys, time
from pathlib import Path

C = Path(r"D:\12412\dsh工作区\projects\recruitment-agent\converter")
PY = r"D:\Python3.12.9\python.exe"
picked = json.loads((C/"corpus"/"batch2-picked.json").read_text(encoding="utf-8"))
rows = []
for i, item in enumerate(picked, 1):
    path = item["Path"]
    t0 = time.time()
    try:
        p = subprocess.run([PY, "-m", "src.cli", path, "--no-isolation"], cwd=str(C),
                           capture_output=True, text=True, encoding="utf-8", timeout=120)
        out = p.stdout.strip()
        data = json.loads(out[out.index("{"):out.rindex("}")+1]) if "{" in out else None
        if data is None:
            rows.append({"file": item["Name"], "sha256": item["Sha"], "ok": False,
                         "error": f"no json (exit {p.returncode}): {p.stderr[:160]}"})
            continue
        fields = data.get("fields") or {}
        rows.append({
            "file": item["Name"], "sha256": item["Sha"], "ok": True,
            "pages": data.get("meta", {}).get("pages"),
            "chars": data.get("chars"),
            "blocks": len(data.get("blocks") or []),
            "completeness": data.get("completeness"),
            "needs_visual": data.get("needs_visual"),
            "issue_codes": sorted({i.get("code") for i in (data.get("issues") or []) if i.get("code")}),
            "field_states": {k: (v or {}).get("state") for k, v in fields.items()},
            "seconds": round(time.time()-t0, 1),
        })
    except Exception as exc:
        rows.append({"file": item["Name"], "sha256": item["Sha"], "ok": False, "error": str(exc)[:200]})
    if i % 10 == 0:
        print(f"  ...{i}/{len(picked)}", flush=True)

out_path = C/"reports"/"batch2-results.jsonl"
out_path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")
ok = [r for r in rows if r.get("ok")]
print(json.dumps({
    "total": len(rows), "ok": len(ok), "failed": len(rows)-len(ok),
    "completeness": {k: sum(1 for r in ok if r.get("completeness") == k) for k in ("complete","partial","unverified")},
    "needs_visual": sum(1 for r in ok if r.get("needs_visual")),
    "empty_blocks": sum(1 for r in ok if not r.get("blocks")),
    "hard_issue_files": sum(1 for r in ok if any(c.startswith(("pdf_no_text","encrypted","unread_visual","pdf_text_encoding","pdf_layout","reader_")) for c in (r.get("issue_codes") or []))),
    "errors": [r.get("error") for r in rows if not r.get("ok")][:5],
}, ensure_ascii=False, indent=1))
