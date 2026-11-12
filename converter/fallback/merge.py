"""Merge **verified** model readings into the converter result (fallback step E).

Rules (fallback/README.md §E)
-----------------------------
* A verified reading becomes a **new block** appended to ``blocks`` with
  ``provenance="model_read"`` and ``location={"page": n, "bbox": None}``.
  Existing blocks are never modified, reordered or replaced — doc 11 §5 red
  line 6 forbids replacing native text.
* ``text`` is **not** touched.  The converter's body text stays exactly the
  native read, so a fidelity check (doc 11 A2, ``Counter`` equality) still
  holds on the merged artifact.  Model text is only reachable through
  explicitly labelled fields: ``blocks[provenance=model_read]``,
  ``model_read_applied`` and ``text_with_model_read``.
* ``issues`` / ``completeness`` / ``needs_visual`` are **not** changed.  A
  model reading is evidence, not absolution: clearing ``needs_visual`` is a
  human decision (layer ④), not something this layer may do for itself.
* Each page gets one record in ``model_read_applied`` or
  ``model_read_rejected`` (plus ``model_read_skipped`` for pages that were
  already merged).  Rejected text is **not** stored — only its length, hash and
  reason codes.
* Verification is re-run here.  A caller passing ``{"ok": True}`` next to a
  refused reading changes nothing: merge only trusts its own verdict.
"""
from __future__ import annotations

import copy
import hashlib
from datetime import datetime, timezone

from . import page_image
from . import verify_model_text as vmt

BLOCK_PROVENANCE = "model_read"
# doc 11 D2 names three provenances (native_text / ocr_title / agent_read).  The
# task requires a fourth, more precise value.  Both are written: ``provenance``
# says *how* the text was obtained, ``source_class`` keeps the doc 11 triad so
# downstream rules that key on "agent_read" cannot mistake it for native text.
BLOCK_SOURCE_CLASS = "agent_read"


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _now(now=None) -> str:
    if isinstance(now, str) and now.strip():
        return now
    if isinstance(now, datetime):
        return now.astimezone(timezone.utc).isoformat(timespec="seconds")
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _applied_pages(blocks) -> set[int]:
    pages = set()
    for block in blocks or []:
        if isinstance(block, dict) and block.get("provenance") == BLOCK_PROVENANCE:
            page = (block.get("location") or {}).get("page")
            if isinstance(page, int) and not isinstance(page, bool):
                pages.add(page)
    return pages


def _reject(page, reasons, read, *, extra=None) -> dict:
    record = {
        "page": page,
        "rejected": True,
        "codes": [r["code"] for r in reasons],
        "reasons": reasons,
        "chars": len(read.get("text") or "") if isinstance(read.get("text"), str) else 0,
        "text_sha256": _sha256(read.get("text") or "") if isinstance(read.get("text"), str) else None,
        "model": read.get("model"),
    }
    if extra:
        record.update(extra)
    return record


def _applied_record(page, read, verdict, *, run_id, applied_at) -> dict:
    text = read.get("text") or ""
    return {
        "page": page,
        "applied": True,
        "chars": len(text),
        "text_sha256": _sha256(text),
        "location": {"page": page, "bbox": None},
        "provenance": BLOCK_PROVENANCE,
        "source_class": BLOCK_SOURCE_CLASS,
        "model": read.get("model"),
        "dpi": read.get("dpi"),
        "png_sha256": read.get("png_sha256"),
        "prompt_sha256": read.get("prompt_sha256"),
        "verify": {"overlap": verdict["stats"]["overlap"],
                   "token_overlap": verdict["stats"]["token_overlap"],
                   "codes": []},
        "test_double": bool(read.get("test_double")),
        "run_id": run_id,
        "applied_at": applied_at,
    }


def _block(page, read, record) -> dict:
    text = read.get("text") or ""
    return {
        "kind": "paragraph",
        "text": text,
        "location": {"page": page, "bbox": None},
        "links": [],
        "provenance": BLOCK_PROVENANCE,
        "source_class": BLOCK_SOURCE_CLASS,
        "model_read": {
            "applied": True,
            "page": page,
            "model": read.get("model"),
            "dpi": read.get("dpi"),
            "png_sha256": read.get("png_sha256"),
            "prompt_sha256": read.get("prompt_sha256"),
            "run_id": record.get("run_id"),
            "test_double": bool(read.get("test_double")),
        },
        "evidence": {
            "source": "MODEL",
            "page": page,
            "bbox": None,
            "bbox_available": False,
            "text_sha256": _sha256(text),
            "model": read.get("model"),
            "dpi": read.get("dpi"),
            "png_sha256": read.get("png_sha256"),
            "note": ("model transcription of a rendered page; there is no bbox, so this "
                     "text cannot satisfy doc 11 D1 and identity fields taken from it "
                     "must go to human review (doc 11 D3)"),
        },
    }


def merge_model_reads(result, reads, *, run_id: str | None = None,
                      planned_pages=None, now=None, prompt_sha256: str | None = None) -> dict:
    """Append verified readings and record every decision.

    ``planned_pages`` (optional) is the set of pages the fallback decided to
    look at; a reading for any other page is rejected (``PAGE_NOT_PLANNED``)
    instead of quietly widening the scope.
    """
    merged = copy.deepcopy(result)
    merged.setdefault("blocks", [])
    merged.setdefault("issues", [])
    merged.setdefault("warnings", [])

    planned = None
    if planned_pages is not None:
        planned = set()
        for item in planned_pages:
            page = item.get("page") if isinstance(item, dict) else item
            if isinstance(page, int) and not isinstance(page, bool):
                planned.add(page)

    native_by_page = vmt.page_text_by_page(result)
    image_pages = page_image.image_pages(result)
    already = _applied_pages(merged.get("blocks"))
    result_sha = (result.get("meta") or {}).get("source_sha256")

    applied, rejected, skipped = [], [], []
    accepted_pages: set[int] = set()
    applied_at = _now(now)
    new_blocks: list[dict] = []

    for read in reads or []:
        if not isinstance(read, dict):
            rejected.append({"page": None, "rejected": True,
                             "codes": ["READ_NOT_A_DICT"],
                             "reasons": [{"code": "READ_NOT_A_DICT",
                                          "message": f"reading is {type(read).__name__}",
                                          "severity": "hard"}],
                             "chars": 0, "text_sha256": None, "model": None})
            continue
        page = read.get("page")
        page_ok = isinstance(page, int) and not isinstance(page, bool) and page >= 1

        # --- structural gates before the content checks -------------------
        if page_ok and page in already:
            skipped.append({"page": page, "skipped": True, "reason": "ALREADY_APPLIED",
                            "chars": len(read.get("text") or ""),
                            "text_sha256": _sha256(read.get("text") or "")})
            continue
        if page_ok and planned is not None and page not in planned:
            rejected.append(_reject(page, [{"code": "PAGE_NOT_PLANNED",
                                            "message": f"page {page} was not part of the fallback plan",
                                            "severity": "hard"}], read))
            continue
        if page_ok and page in accepted_pages:
            rejected.append(_reject(page, [{"code": "DUPLICATE_PAGE",
                                            "message": f"a reading for page {page} was already applied",
                                            "severity": "hard"}], read))
            continue

        read_sha = read.get("source_sha256")
        if read_sha and result_sha and read_sha != result_sha:
            rejected.append(_reject(page, [{
                "code": "SOURCE_SHA_MISMATCH",
                "message": ("reading was produced from a different source file "
                            f"({read_sha[:12]}… != {str(result_sha)[:12]}…)"),
                "severity": "hard"}], read))
            continue

        verdict = vmt.verify(read,
                             native_text=native_by_page.get(page) if page_ok else None,
                             page=page if page_ok else None,
                             is_image_page=page_ok and page in image_pages)
        if not verdict["ok"]:
            rejected.append(_reject(page, verdict["reasons"], read))
            continue

        record = _applied_record(page, read, verdict, run_id=run_id, applied_at=applied_at)
        new_blocks.append(_block(page, read, record))
        applied.append(record)
        accepted_pages.add(page)
        merged["warnings"].append(
            f"model_read_applied: page {page} ({record['chars']} chars, "
            f"model={record['model']}, dpi={record['dpi']}, bbox=null"
            + (", TEST-DOUBLE" if record["test_double"] else "") + ")")

    for record in rejected:
        merged["warnings"].append(
            f"model_read_rejected: page {record['page']} "
            f"[{','.join(record['codes'])}]")
    for record in skipped:
        merged["warnings"].append(
            f"model_read_skipped: page {record['page']} [{record['reason']}]")

    if new_blocks:
        merged["blocks"] = list(merged["blocks"]) + new_blocks
        model_text = "\n\n".join(b["text"] for b in new_blocks)
        base = result.get("text") or ""
        merged["text_with_model_read"] = (base + "\n\n" + model_text).strip() if base else model_text
    merged["text_native_only"] = True

    merged["model_read_applied"] = applied
    merged["model_read_rejected"] = rejected
    merged["model_read_skipped"] = skipped
    merged["model_read"] = {
        "run_id": run_id,
        "reads": len(reads or []),
        "applied": len(applied),
        "rejected": len(rejected),
        "skipped": len(skipped),
        "pages_applied": [r["page"] for r in applied],
        "pages_rejected": [r["page"] for r in rejected],
        "prompt_sha256": prompt_sha256,
        "test_double": any(r.get("test_double") for r in applied),
        "needs_visual_unchanged": merged.get("needs_visual"),
        "completeness_unchanged": merged.get("completeness"),
    }
    meta = merged.setdefault("meta", {})
    meta["model_read"] = {"applied": len(applied), "rejected": len(rejected),
                          "skipped": len(skipped), "run_id": run_id}
    return merged


merge = merge_model_reads
