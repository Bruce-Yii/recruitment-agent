"""Differential run: old reader (HEAD) vs new reader over the whole corpus.

The old package is a copy of ``converter/src`` with ``pdf_reader.py`` restored
from ``git show HEAD:converter/src/pdf_reader.py``; it is passed with
``--old-package``.  Both readers are invoked as external CLIs, exactly like the
converter is used, and their JSON is compared byte-for-byte.

Purpose: prove that the D-55 change alters **only** the files it is meant to
alter (the two URL-duplication cases), so a failure elsewhere cannot be blamed
on this change.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]          # converter/
ROOT_ENV = {
    "talent_pool": "CORPUS_ROOT_TALENT_POOL",
    "odoo_samples": "CORPUS_ROOT_ODOO_SAMPLES",
    "codex_converted": "CORPUS_ROOT_CODEX_CONVERTED",
    "synthetic": "CORPUS_ROOT_SYNTHETIC",
}


def _rows(kind: str = "corpus") -> list[dict]:
    if kind == "batch2":
        picked = json.loads((ROOT / "corpus" / "batch2-picked.json")
                            .read_text(encoding="utf-8"))
        return [{"id": row["Name"], "path": Path(row["Path"])} for row in picked]
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
        out.append({"id": row["id"], "path": path})
    return out


def _run(cwd: Path, pdf: Path) -> bytes:
    proc = subprocess.run([sys.executable, "-m", "src.cli", str(pdf), "--no-isolation",
                           "--indent", "0"],
                          cwd=str(cwd), capture_output=True, timeout=300,
                          env=dict(os.environ, PYTHONIOENCODING="utf-8",
                                   PYTHONPATH=str(cwd)))
    if proc.returncode:
        raise RuntimeError(f"{cwd} exit {proc.returncode}: "
                           f"{proc.stderr.decode('utf-8', 'replace')[-400:]}")
    return proc.stdout


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--old-package", required=True,
                        help="directory that contains src/ (old reader)")
    parser.add_argument("--set", dest="kind", choices=("batch2", "corpus"),
                        default="corpus")
    parser.add_argument("--out", default=None)
    args = parser.parse_args(argv)
    old_root = Path(args.old_package)

    total = changed = errors = 0
    details = []
    for row in _rows(args.kind):
        path = row["path"]
        if path is None or not path.is_file():
            errors += 1
            details.append({"id": row["id"], "error": "original missing"})
            print(f"MISSING {row['id']}", flush=True)
            continue
        total += 1
        try:
            before = _run(old_root, path)
            after = _run(ROOT, path)
        except Exception as exc:  # noqa: BLE001
            errors += 1
            details.append({"id": row["id"], "error": str(exc)})
            print(f"ERROR {row['id']}: {exc}", flush=True)
            continue
        same = before == after
        if not same:
            changed += 1
            print(f"CHANGED {row['id']}", flush=True)
        details.append({"id": row["id"], "identical": same,
                        "old_bytes": len(before), "new_bytes": len(after)})
    print(f"TOTAL {total}  identical={total - changed}  changed={changed}  errors={errors}",
          flush=True)
    if args.out:
        Path(args.out).write_text(
            "\n".join(json.dumps(d, ensure_ascii=False) for d in details) + "\n",
            encoding="utf-8")
    return 0 if errors == 0 else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
