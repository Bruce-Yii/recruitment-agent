"""Dry run of the model fallback — with a **labelled test double**, never a model.

The real model is unavailable (quota), so this script exercises A -> B -> D -> E
with an injected callable and prints every intermediate result:

    python -m fallback.dry_run --pdf corpus\\synthetic\\image_only_1.pdf --page 1 --fake ok
    python -m fallback.dry_run --pdf ... --fake empty
    python -m fallback.dry_run --pdf ... --fake refusal
    python -m fallback.dry_run --pdf ... --fake unavailable
    python -m fallback.dry_run --synthetic --page 1 --fake unrelated

``--fake`` modes:

====  ==========  =========================================================
mode  returns     what it is for
====  ==========  =========================================================
ok    fixed text  happy path (text is invented, see ``SYNTHETIC_LINES``)
empty ``""``     must be rejected as ``EMPTY_TEXT``
refusal          "抱歉，我无法读取这张图片" -> ``META_DISCOURSE``
unrelated        text with no relation to the page -> overlap check
unavailable      raises ``RuntimeError("QUOTA: Insufficient Balance")``
====  ==========  =========================================================

Every record produced here carries ``model="test-double/fixed-text"`` and
``test_double=true`` so a dry-run artifact can never be mistaken for a model
reading.  No network, no provider, no credential.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

from . import page_image, pipeline

CONVERTER_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SYNTHETIC_TEXT = [
    "SYNTHETIC FALLBACK DEMO PAGE",
    "ALPHA BRAVO CHARLIE DELTA",
    "ECHO FOXTROT GOLF HOTEL",
    "INDIA JULIET KILO LIMA",
]
SYNTHETIC_LINES = DEFAULT_SYNTHETIC_TEXT


class FakeModel:
    """A test double.  It is deliberately not a model and says so."""

    test_double = True
    model_id = "test-double/fixed-text"

    def __init__(self, mode: str = "ok", text: str | None = None):
        if mode not in {"ok", "empty", "refusal", "unrelated", "unavailable"}:
            raise ValueError(f"unknown fake mode: {mode}")
        self.mode = mode
        self.text = "\n".join(SYNTHETIC_LINES) if text is None else text
        self.calls: list[tuple[str, str]] = []

    def __call__(self, prompt: str, image_path: str) -> str:
        self.calls.append((prompt, image_path))
        if self.mode == "unavailable":
            raise RuntimeError("QUOTA: Insufficient Balance")
        if self.mode == "empty":
            return ""
        if self.mode == "refusal":
            return "抱歉，我无法读取这张图片，请提供可复制的文本。"
        if self.mode == "unrelated":
            return "今天天气很好，适合出门散步；这段文字与本页内容完全无关。"
        return self.text


# ============================== input plumbing ==============================
def _read_with_converter(pdf: Path, out_json: Path) -> dict:
    """Run the real converter (`python -m src.cli`) — read-only, no isolation."""
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONPATH=str(CONVERTER_ROOT))
    proc = subprocess.run(
        [sys.executable, "-m", "src.cli", str(pdf), "--no-isolation",
         "--output", str(out_json)],
        cwd=str(CONVERTER_ROOT), capture_output=True, text=True,
        encoding="utf-8", errors="replace", env=env, timeout=300,
    )
    if proc.returncode != 0:
        raise SystemExit(f"converter failed (exit {proc.returncode}): {proc.stderr[:400]}")
    return json.loads(out_json.read_text(encoding="utf-8"))


def _make_synthetic_pdf(directory: Path) -> Path:
    """A one-page PDF with invented ASCII text (no real resume content)."""
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=595, height=842)  # A4 in points
    for index, line in enumerate(SYNTHETIC_LINES):
        page.insert_text((72, 96 + index * 28), line, fontsize=16)
    path = directory / "synthetic-fallback-page.pdf"
    doc.save(str(path))
    doc.close()
    return path


# ============================== printing ==============================
def _head(title: str) -> None:
    print(f"\n=== {title} ===")


def _dump(obj) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=1, default=str))


def _converter_summary(result: dict) -> dict:
    return {
        "completeness": result.get("completeness"),
        "needs_visual": result.get("needs_visual"),
        "chars": result.get("chars"),
        "blocks": len(result.get("blocks") or []),
        "pages": (result.get("meta") or {}).get("pages"),
        "source_sha256": (result.get("meta") or {}).get("source_sha256"),
        "issues": [{"code": i.get("code"),
                    "page": (i.get("location") or {}).get("page")}
                   for i in result.get("issues") or []],
    }


def _render_summary(record: dict) -> dict:
    keys = ("page", "dpi", "dpi_requested", "dpi_capped", "pixel_size", "page_size_pt",
            "page_size_in", "source_image_px", "source_dpi_hint", "oversampled",
            "png_bytes", "render_ms", "save_ms", "total_ms", "png_path", "png_sha256",
            "warnings")
    return {k: record.get(k) for k in keys}


def _verify_summary(verdict: dict) -> dict:
    return {"ok": verdict["ok"], "codes": verdict["codes"],
            "reasons": verdict["reasons"], "stats": verdict["stats"]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m fallback.dry_run",
        description="dry run the model fallback with a labelled test double")
    parser.add_argument("--pdf", default=None, help="PDF to read (read-only)")
    parser.add_argument("--result", default=None,
                        help="reuse an existing converter JSON instead of re-reading")
    parser.add_argument("--synthetic", action="store_true",
                        help="build a one-page PDF with invented text and use it")
    parser.add_argument("--page", action="append", type=int, default=None,
                        help="force this page (repeatable); default = pages from issues")
    parser.add_argument("--dpi", type=int, default=None,
                        help=f"render dpi (default {page_image.DEFAULT_DPI} or RESUME_FALLBACK_DPI)")
    parser.add_argument("--max-side", type=int, default=None,
                        help="cap the long side in pixels (lowers dpi explicitly)")
    parser.add_argument("--fake", default="ok",
                        choices=["ok", "empty", "refusal", "unrelated", "unavailable"])
    parser.add_argument("--render-only", action="store_true",
                        help="only run A (render + parameters), no model")
    parser.add_argument("--keep-images", action="store_true")
    parser.add_argument("--json", default=None, help="write the full JSON (report + result) here")
    args = parser.parse_args(argv)

    synth_dir = None
    if args.synthetic:
        synth_dir = page_image.make_temp_dir()
        pdf = _make_synthetic_pdf(synth_dir)
        if not args.page:
            args.page = [1]
        print(f"[synthetic] invented one-page PDF: {pdf}")
    elif args.pdf:
        pdf = Path(args.pdf)
    else:
        parser.error("--pdf or --synthetic is required")

    if not pdf.is_file():
        parser.error(f"PDF not found: {pdf}")

    work_dir = None
    try:
        if args.result:
            result = json.loads(Path(args.result).read_text(encoding="utf-8"))
            print(f"[result] reused converter JSON: {args.result}")
        else:
            work_dir = page_image.make_temp_dir()
            result = _read_with_converter(pdf, work_dir / "converter-result.json")

        _head("1. converter result (read-only)")
        print(f"path: {pdf}")
        _dump(_converter_summary(result))

        pages = args.page
        if args.render_only:
            plan = page_image.plan_pages(result, pages=pages)
            _head("2. page plan (A) — only these pages are rendered")
            _dump(plan)
            render_dir = page_image.make_temp_dir()
            _head("3. render (A)")
            outcome = page_image.render_pages(pdf, [e["page"] for e in plan["pages"]],
                                              dpi=args.dpi, out_dir=render_dir,
                                              max_side=args.max_side)
            for record in outcome["renders"]:
                _dump(_render_summary(record))
            for error in outcome["errors"]:
                _dump(error)
            print("\nrendered files:")
            for png in sorted(render_dir.glob("*.png")):
                print(f"  {png}  {png.stat().st_size} bytes")
            print(f"manifest: {outcome['manifest']}")
            if not args.keep_images:
                print(f"cleaned: {page_image.cleanup(render_dir)}")
            return 0

        fake = FakeModel(args.fake)
        print(f"\n*** TEST DOUBLE — fake={args.fake}, model_id={fake.model_id}. "
              "This is NOT a model reading. ***")
        outcome = pipeline.run_fallback(
            result, pdf, fake, pages=pages, dpi=args.dpi, max_side=args.max_side,
            retain_images=args.keep_images)
        merged, report = outcome["result"], outcome["report"]

        _head("2. page plan (A) — only these pages are rendered")
        _dump(report["plan"])

        _head("3. render (A)")
        for record in report["renders"]:
            _dump(_render_summary(record))
        for error in report["render_errors"]:
            _dump(error)

        _head("4. model read (B)")
        for read in report["reads"]:
            _dump(read)
        for item in report["unavailable"]:
            _dump({"unavailable": item})

        _head("5. verify (D) — mechanical checks")
        for item in report["verifications"]:
            _dump(_verify_summary(item))

        _head("6. merge (E)")
        before_blocks = len(result.get("blocks") or [])
        after_blocks = len(merged.get("blocks") or [])
        print(f"blocks: {before_blocks} -> {after_blocks}")
        print(f"text unchanged: {merged.get('text') == result.get('text')} "
              f"(sha {hashlib.sha256((result.get('text') or '').encode()).hexdigest()[:12]})")
        print(f"completeness: {result.get('completeness')} -> {merged.get('completeness')}")
        print(f"needs_visual: {result.get('needs_visual')} -> {merged.get('needs_visual')}")
        print(f"issues unchanged: "
              f"{[i.get('code') for i in result.get('issues') or []] == [i.get('code') for i in merged.get('issues') or []]}")
        appended = [b for b in (merged.get("blocks") or [])[before_blocks:]
                    if b.get("provenance") == "model_read"]
        if appended:
            print("\nappended block(s):")
            for block in appended:
                _dump(block)
        print("\nmodel_read_applied:")
        _dump(merged.get("model_read_applied"))
        if merged.get("model_read_rejected"):
            print("\nmodel_read_rejected (text is not stored, only reason codes):")
            _dump(merged.get("model_read_rejected"))
        if merged.get("model_read_skipped"):
            print("\nmodel_read_skipped:")
            _dump(merged.get("model_read_skipped"))
        print("\nmodel_read summary:")
        _dump(merged.get("model_read"))
        print("\nwarnings (tail):")
        for line in (merged.get("warnings") or [])[-6:]:
            print(f"  {line}")

        _head("7. verdict")
        print(pipeline.describe(report))
        print(f"test double used: {report['test_double']} "
              "(a real model reading must have model!=test-double and test_double=false)")
        print(f"images: kept={args.keep_images} cleaned={report['images_cleaned']} "
              f"dir={report['render_dir']}")

        if args.json:
            Path(args.json).write_text(json.dumps(
                {"converter_result": result, "merged": merged, "report": report},
                ensure_ascii=False, indent=1, default=str), encoding="utf-8")
            print(f"\n[json] {args.json}")
        return 0
    finally:
        for directory in (work_dir, synth_dir):
            if directory:
                page_image.cleanup(directory)


if __name__ == "__main__":
    sys.exit(main())
