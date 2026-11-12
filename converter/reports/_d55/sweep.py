"""Batch sweep with the independent verifier (converter/verify/cli.py).

The verifier is treated as an external program: this script only calls
``python -m verify.cli <pdf> --indent 0`` and counts its verdicts.  It is the
same shape the L lane used for the 45-file sweep (each file converted twice so
V8 can be judged).

Usage (cwd = converter/):
    python reports/_d55/sweep.py --set batch2        # corpus/batch2-picked.json
    python reports/_d55/sweep.py --set corpus        # manifest.jsonl + synthetic
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ROOT_ENV = {
    "talent_pool": "CORPUS_ROOT_TALENT_POOL",
    "odoo_samples": "CORPUS_ROOT_ODOO_SAMPLES",
    "codex_converted": "CORPUS_ROOT_CODEX_CONVERTED",
    "synthetic": "CORPUS_ROOT_SYNTHETIC",
}


def _rows(kind: str) -> list[dict]:
    if kind == "batch2":
        picked = json.loads((ROOT / "corpus" / "batch2-picked.json")
                            .read_text(encoding="utf-8"))
        return [{"id": row["Name"], "path": row["Path"]} for row in picked]
    rows = [json.loads(line) for line in
            (ROOT / "corpus" / "manifest.jsonl").read_text(encoding="utf-8").splitlines()
            if line.strip()]
    rows += [json.loads(line) for line in
             (ROOT / "corpus" / "synthetic" / "synthetic-manifest.jsonl")
             .read_text(encoding="utf-8").splitlines() if line.strip()]
    out = []
    for row in rows:
        root = os.environ.get(ROOT_ENV.get(row.get("root", ""), ""), "").strip()
        path = Path(root) / row["rel"] if root else None
        out.append({"id": row["id"], "path": str(path) if path else None,
                    "row": row})
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--set", dest="kind", choices=("batch2", "corpus"),
                        default="batch2")
    parser.add_argument("--out", default=None)
    args = parser.parse_args(argv)

    rows = _rows(args.kind)
    total = passed = failed = 0
    check_skipped = 0
    results = []
    for index, row in enumerate(rows, 1):
        name = row["id"]
        path = row["path"]
        if not path or not Path(path).is_file():
            results.append({"id": name, "path": path, "error": "original missing"})
            failed += 1
            total += 1
            print(f"[{index:02d}/{len(rows)}] MISSING {name} {path}", flush=True)
            continue
        proc = subprocess.run([sys.executable, "-m", "verify.cli", path, "--indent", "0"],
                              cwd=str(ROOT), capture_output=True, timeout=900,
                              env=dict(os.environ, PYTHONIOENCODING="utf-8",
                                       PYTHONPATH=str(ROOT)))
        total += 1
        if proc.returncode not in (0, 1):
            failed += 1
            results.append({"id": name, "path": path, "error": "verifier exit %d" % proc.returncode,
                            "stderr": proc.stderr.decode("utf-8", "replace")[-800:]})
            print(f"[{index:02d}/{len(rows)}] ERROR {name} exit={proc.returncode}", flush=True)
            continue
        try:
            data = json.loads(proc.stdout.decode("utf-8"))
        except json.JSONDecodeError as exc:
            failed += 1
            results.append({"id": name, "path": path, "error": f"bad json: {exc}"})
            print(f"[{index:02d}/{len(rows)}] BADJSON {name}", flush=True)
            continue
        summary = data.get("summary") or {}
        check_skipped += int(summary.get("skipped") or 0)
        if data.get("passed"):
            passed += 1
        else:
            failed += 1
        results.append({"id": name, "path": path, "passed": bool(data.get("passed")),
                        "failed_checks": data.get("failed"),
                        "summary": summary,
                        "checks": [c for c in data.get("checks") or [] if not c.get("ok")]})
        mark = "PASS" if data.get("passed") else "FAIL"
        print(f"[{index:02d}/{len(rows)}] {mark} {name} "
              f"checks={summary.get('passed')}/{summary.get('failed')}/"
              f"{summary.get('skipped')}", flush=True)
    print(f"TOTAL {total}  passed={passed}  failed={failed}  "
          f"checks_skipped={check_skipped}", flush=True)
    if args.out:
        Path(args.out).write_text(
            "\n".join(json.dumps(r, ensure_ascii=False) for r in results) + "\n",
            encoding="utf-8")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
