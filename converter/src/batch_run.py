"""Batch runner: read every manifest entry, write one summary row per PDF.

Usage
-----
    python -m src.batch_run --out reports/corpus-results.jsonl

Output is **metadata only**: no resume text, no names, no phone numbers.  The
original PDFs are opened read-only and are never copied or modified; only the
paths listed in ``corpus/manifest.jsonl`` and
``corpus/synthetic/synthetic-manifest.jsonl`` are touched.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .cli import read_any
from .issues import hard_codes, issue_severity

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFESTS = (ROOT / "corpus" / "manifest.jsonl",
                     ROOT / "corpus" / "synthetic" / "synthetic-manifest.jsonl")


def _rows(manifests) -> list[dict]:
    rows = []
    for manifest in manifests:
        path = Path(manifest)
        if not path.is_file():
            raise SystemExit(f"manifest not found: {path}")
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                row["_manifest"] = path.name
                rows.append(row)
    return rows


def summarize(row: dict, result: dict) -> dict:
    issues = result.get("issues") or []
    hard, soft = issue_severity(issues)
    fields = result.get("fields") or {}
    meta = result.get("meta") or {}
    protected = result.get("protected_attributes") or {}
    return {
        "id": row.get("id"),
        "manifest": row.get("_manifest"),
        "source": row.get("source"),
        "tags": row.get("tags") or [],
        "sha256": row.get("sha256"),
        "bytes": row.get("bytes"),
        "pages_manifest": row.get("pages"),
        "pages": meta.get("pages"),
        "chars": result.get("chars"),
        "blocks": len(result.get("blocks") or []),
        "completeness": result.get("completeness"),
        "needs_visual": result.get("needs_visual"),
        "repaired": meta.get("repaired"),
        "layout_backend": meta.get("layout_backend"),
        "order_verified": meta.get("order_verified"),
        "ocr": meta.get("ocr"),
        "issue_codes": [i.get("code") for i in issues],
        "hard": hard,
        "hard_codes": hard_codes(issues),
        "soft_codes": soft,
        "field_states": {k: v.get("state") for k, v in fields.items()},
        "field_rules": {k: v.get("match_rule") for k, v in fields.items()
                        if v.get("match_rule")},
        "noise_blocks": len(result.get("noise") or []),
        "protected_present": sorted(k for k, v in protected.items()
                                    if v.get("state") == "present"),
        "timeline": result.get("timeline") or {},
        "source_sha256": meta.get("source_sha256"),
        "error": None,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m src.batch_run")
    parser.add_argument("--manifest", action="append", default=None,
                        help="manifest.jsonl (repeatable); defaults to corpus + synthetic")
    parser.add_argument("--out", default=str(ROOT / "reports" / "corpus-results.jsonl"))
    parser.add_argument("--timeout", type=float, default=50.0)
    parser.add_argument("--no-isolation", action="store_true")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--ids", default=None, help="comma separated ids to include")
    args = parser.parse_args(argv)

    manifests = args.manifest or DEFAULT_MANIFESTS
    rows = _rows(manifests)
    wanted = set(args.ids.split(",")) if args.ids else None
    if wanted:
        rows = [r for r in rows if r.get("id") in wanted]
    if args.limit:
        rows = rows[: args.limit]

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    summaries = []
    for index, row in enumerate(rows, 1):
        path = Path(row["path"])
        if not path.is_file():
            summary = {"id": row.get("id"), "manifest": row.get("_manifest"),
                       "source": row.get("source"), "tags": row.get("tags") or [],
                       "sha256": row.get("sha256"), "bytes": row.get("bytes"),
                       "error": "missing_file", "completeness": "partial",
                       "hard": True, "hard_codes": ["reader_failed"],
                       "issue_codes": ["reader_failed"],
                       "field_states": {}, "needs_visual": None}
        else:
            try:
                result = read_any(path, timeout=args.timeout,
                                  isolated=not args.no_isolation)
                summary = summarize(row, result)
            except Exception as exc:  # noqa: BLE001 —— 单份失败不污染整批（doc 11 §9.10）
                summary = {"id": row.get("id"), "manifest": row.get("_manifest"),
                           "source": row.get("source"), "tags": row.get("tags") or [],
                           "sha256": row.get("sha256"), "bytes": row.get("bytes"),
                           "error": f"{type(exc).__name__}: {exc}",
                           "completeness": "partial", "hard": True,
                           "hard_codes": ["reader_failed"],
                           "issue_codes": ["reader_failed"],
                           "field_states": {}, "needs_visual": None}
        summaries.append(summary)
        print(f"[{index}/{len(rows)}] {row.get('id')} {summary.get('completeness')} "
              f"hard={summary.get('hard')} codes={','.join(summary.get('issue_codes') or [])}",
              file=sys.stderr)

    with out_path.open("w", encoding="utf-8") as fh:
        for summary in summaries:
            fh.write(json.dumps(summary, ensure_ascii=False) + "\n")
    print(json.dumps({"rows": len(summaries), "out": str(out_path),
                      "hard": sum(1 for s in summaries if s.get("hard")),
                      "errors": sum(1 for s in summaries if s.get("error"))},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
