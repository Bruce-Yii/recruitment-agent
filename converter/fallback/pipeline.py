"""End-to-end fallback: plan -> render -> model -> verify -> merge.

One function, no hidden steps:

    run_fallback(result, pdf_path, model_call)
        plan pages from the converter's issues     (page_image.plan_pages)
        render only those pages                    (page_image.render_page)
        ask the injected model                     (model_reader.read_page)
        verify the answer                          (verify_model_text.verify)
        append what passed, record the rest        (merge.merge_model_reads)

Failure policy
--------------
* model unavailable (quota / auth / timeout / crash): stop asking, record
  ``model_unavailable``, keep ``needs_visual`` and return the untouched result.
  Nothing is fabricated, nothing crashes.
* render failed: record the code and continue with the other pages.
* verification failed: the reading is rejected and the page stays
  ``needs_visual`` — the only allowed outcome.
* the merged result keeps ``issues`` / ``completeness`` / ``needs_visual`` and
  ``text`` exactly as the converter produced them (see merge.py).
"""
from __future__ import annotations

import copy
import hashlib
import json
import time

from . import model_reader, page_image
from . import verify_model_text as vmt
from .merge import merge_model_reads


def _status(applied: int, rejected: int, unavailable: int, rendered: int,
            render_errors: int) -> str:
    if applied and (rejected or unavailable):
        return "PARTIAL"
    if applied:
        return "APPLIED"
    if unavailable:
        return "UNAVAILABLE"
    if rejected:
        return "REJECTED"
    if render_errors and not rendered:
        return "RENDER_FAILED"
    return "NO_READS"


def run_fallback(result, pdf_path, model_call, *, pages=None, dpi=None,
                 max_side=None, out_dir=None, run_id=None, retain_images=False,
                 now=None, stop_on_unavailable=True) -> dict:
    """Run the whole fallback chain and return ``{"result": ..., "report": ...}``.

    ``model_call`` is injected; passing a stub is the supported dry-run mode.
    ``retain_images=False`` deletes the temp render directory afterwards.
    """
    started = time.perf_counter()
    plan = page_image.plan_pages(result, pages=pages)
    seed = json.dumps({"sha": (result.get("meta") or {}).get("source_sha256"),
                       "pages": plan["pages"]}, sort_keys=True, default=str)
    run_id = run_id or f"fallback-{hashlib.sha256(seed.encode('utf-8')).hexdigest()[:12]}"

    report = {
        "run_id": run_id,
        "status": "NO_TRIGGER",
        "pdf_path": str(pdf_path),
        "plan": plan,
        "dpi": page_image.resolve_dpi(dpi),
        "renders": [],
        "render_errors": [],
        "reads": [],
        "verifications": [],
        "unavailable": [],
        "pages_skipped": [],
        "applied": [],
        "rejected": [],
        "test_double": False,
        "render_dir": None,
        "images_cleaned": None,
        "needs_visual_before": bool(result.get("needs_visual")),
        "needs_visual_after": bool(result.get("needs_visual")),
        "elapsed_ms": None,
    }

    if not plan["pages"]:
        # Nothing to do: do not render, do not call the model, do not mutate.
        report["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 2)
        return {"result": copy.deepcopy(result), "report": report}

    render_dir = page_image.make_temp_dir() if out_dir is None else out_dir
    report["render_dir"] = str(render_dir)
    result_sha = (result.get("meta") or {}).get("source_sha256")

    renders: list[dict] = []
    for entry in plan["pages"]:
        page_no = entry["page"]
        try:
            render = page_image.render_page(pdf_path, page_no, dpi=dpi,
                                            out_dir=render_dir, max_side=max_side)
        except page_image.RenderError as exc:
            report["render_errors"].append({"page": page_no, **exc.as_dict()})
            continue
        if result_sha and render["source_sha256"] != result_sha:
            report["render_errors"].append({
                "page": page_no,
                "code": "SOURCE_SHA_MISMATCH",
                "message": ("the PDF on disk is not the file that was read "
                            f"({render['source_sha256'][:12]}… != {str(result_sha)[:12]}…); "
                            "refusing to read a stale page"),
            })
            continue
        render["reasons"] = entry["reasons"]
        renders.append(render)
        report["renders"].append(render)

    native_by_page = vmt.page_text_by_page(result)
    image_pages = page_image.image_pages(result)
    reads: list[dict] = []
    stop = False
    for render in renders:
        page_no = render["page"]
        if stop:
            report["pages_skipped"].append({"page": page_no,
                                            "reason": "model_unavailable"})
            continue
        try:
            read = model_reader.read_page(render["png_path"], page_no,
                                          model_call=model_call)
        except model_reader.ModelUnavailable as exc:
            report["unavailable"].append({"page": page_no, **exc.as_dict()})
            if stop_on_unavailable:
                stop = True
            continue
        except model_reader.InputError as exc:
            report["render_errors"].append({"page": page_no, **exc.as_dict()})
            continue
        read["source_sha256"] = render["source_sha256"]
        read["dpi"] = render["dpi"]
        reads.append(read)
        entry = {k: v for k, v in read.items() if k != "text"}
        entry["text_chars"] = len(read["text"])
        entry["text_preview"] = ("[test double: text omitted from report]"
                                 if read.get("test_double") else read["text"][:80])
        report["reads"].append(entry)
        if read.get("test_double"):
            report["test_double"] = True
        verdict = vmt.verify(read,
                             native_text=native_by_page.get(page_no),
                             page=page_no,
                             is_image_page=page_no in image_pages)
        report["verifications"].append({
            "page": page_no, "ok": verdict["ok"], "codes": verdict["codes"],
            "reasons": verdict["reasons"], "stats": verdict["stats"],
        })

    merged = merge_model_reads(
        result, reads, run_id=run_id, planned_pages=[p["page"] for p in plan["pages"]],
        now=now, prompt_sha256=(reads[0].get("prompt_sha256") if reads else None))

    if report["unavailable"]:
        merged.setdefault("model_read", {})["unavailable"] = report["unavailable"]
        for item in report["unavailable"]:
            merged.setdefault("warnings", []).append(
                f"model_read_unavailable: page {item['page']} [{item['code']}] "
                f"{item['message'][:160]}")
        if report["pages_skipped"]:
            merged["model_read"]["pages_skipped"] = report["pages_skipped"]
        merged["model_read"]["needs_visual_unchanged"] = merged.get("needs_visual")

    report["applied"] = list(merged.get("model_read_applied") or [])
    report["rejected"] = list(merged.get("model_read_rejected") or [])
    report["status"] = _status(len(report["applied"]), len(report["rejected"]),
                               len(report["unavailable"]), len(renders),
                               len(report["render_errors"]))

    if not retain_images:
        report["images_cleaned"] = page_image.cleanup(render_dir)
    else:
        report["images_cleaned"] = False
    report["needs_visual_after"] = bool(merged.get("needs_visual"))
    report["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 2)
    return {"result": merged, "report": report}


def describe(report: dict) -> str:
    """One-line human summary for dry runs and logs (no model text)."""
    parts = [f"status={report['status']}",
             f"planned={len(report['plan']['pages'])}",
             f"rendered={len(report['renders'])}",
             f"reads={len(report['reads'])}",
             f"applied={len(report['applied'])}",
             f"rejected={len(report['rejected'])}",
             f"unavailable={len(report['unavailable'])}",
             f"elapsed_ms={report['elapsed_ms']}"]
    return " ".join(parts)
