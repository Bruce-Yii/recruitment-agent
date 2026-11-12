"""Shared, JSON-serializable reader contract. Readability is not completeness.

Blocks retain source locations and links until Markdown rendering. Issues describe
unread material; they are not a judgement of a person's qualifications or value.

Provenance
----------
Copied from ``resume-conversion-build/tools/conversion/content.py`` (read-only
reference, 2026-11).  The shapes and semantics are kept identical on purpose:
``block()`` / ``result()`` / ``pending()`` must behave the same here, otherwise
downstream consumers of the two readers disagree about what "partial" means.

One addition (not a behaviour change): ``result()`` accepts ``extra`` so a reader
can attach its own top-level keys (``fields`` / ``noise`` ...) *before* the
completeness downgrade runs, keeping the single rule
"issues or needs_visual => completeness=partial" in one place.
"""
from __future__ import annotations

import re


def normalize(text: str) -> str:
    """Mechanical whitespace safety only — never a fact rewrite.

    PRD §5.2.1: NUL/CR normalization is format decoding, not content
    cleaning. Native Markdown blocks must NOT pass through here
    (use ``raw_block``); this helper is for plain-text flows only.
    """
    text = text.replace("\x00", " ").replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\u00a0", " ")
    return re.sub(r"\n{3,}", "\n\n", "\n".join(s.rstrip() for s in text.split("\n"))).strip("\n")


def raw_block(kind: str, text: str, location=None, links=None) -> dict:
    """A block whose text is already the exact Markdown to publish.

    Native Markdown / agent work-MD passthrough: whitespace, trailing
    double-space line breaks, fenced-code blank lines and table structure
    are preserved byte-for-byte.
    """
    return {"kind": kind, "text": text, "location": location or {},
            "links": links or [], "raw": True}


def link_md(label: str, href: str) -> str:
    label = (label or href).replace("[", "\\[").replace("]", "\\]")
    # Angle-delimited destinations protect spaces and parentheses in original URLs.
    return f"[{label}](<{href.replace('>', '%3E')}>)"


def block(kind: str, text: str, location=None, links=None) -> dict:
    return {"kind": kind, "text": normalize(text), "location": location or {}, "links": links or []}


def result(text: str = "", *, blocks=None, title: str = "", completeness="unverified",
           issues=None, needs_visual=False, warnings=None, meta=None, links=None,
           extra=None) -> dict:
    if completeness not in {"complete", "partial", "unverified"}:
        raise ValueError(f"invalid reader completeness: {completeness}")
    if blocks is None:
        blocks = [block("markdown", text)] if text.strip() else []
    else:
        text = "\n\n".join(b["text"] for b in blocks if b.get("text", "").strip())
    if blocks and all(b.get("raw") for b in blocks):
        pass  # native-Markdown passthrough: byte-exact, no whitespace rewrite
    else:
        text = normalize(text)
    issues = list(issues or [])
    if needs_visual and not issues:
        issues.append({"code": "visual_read_required", "message": "material has unread visual content"})
    if completeness == "partial" and not issues:
        issues.append({"code": "partial_read", "message": "reader returned only part of the material"})
    if issues or needs_visual:
        completeness = "partial"
    all_links = list(links or [])
    for b in blocks:
        for link in b.get("links") or []:
            if link not in all_links:
                all_links.append(link)
    out = {"text": text, "blocks": blocks, "title": title, "chars": len(text.strip()),
           "completeness": completeness, "issues": issues,
           "needs_visual": needs_visual, "warnings": warnings or [], "meta": meta or {},
           "links": all_links}
    if extra:
        out.update(extra)
    return out


def pending(result_row: dict, path: str, code: str, message: str, location=None) -> None:
    item = {"path": path, "code": code, "message": message}
    if location:
        item["location"] = location
    target = result_row.setdefault("pending_reads", [])
    if item not in target:
        target.append(item)


def observe_read(row: dict, entry: dict) -> None:
    """Carry every selected read's unknowns through fallback and deduplication."""
    path = entry.get("path", "")
    state = entry.get("completeness", "unverified")
    issues = list(entry.get("issues") or [])
    if state != "complete" and not issues:
        issues.append({"code": "partial_read" if state == "partial" else "reader_unverified",
                       "message": "selected material has not been completely read"})
    if not entry.get("ok") and not issues:
        issues.append({"code": "read_failed", "message": entry.get("error") or "selected material is unread"})
    if entry.get("needs_visual") and not issues:
        issues.append({"code": "visual_read_required", "message": "selected material has unread visual content"})
    observed = {"path": path, "state": "partial" if issues else state,
                "ok": bool(entry.get("ok"))}
    reads = row.setdefault("selected_reads", [])
    if observed not in reads:
        reads.append(observed)
    for issue in issues:
        pending(row, path, issue["code"], issue["message"], issue.get("location"))


def generation_status(row: dict) -> str:
    """A written Markdown can be partial, even when other sources supplied text."""
    if not row.get("body_chars"):
        return "FAILED_READ" if row.get("failures") or row.get("pending_reads") else "NO_CONTENT"
    mode = "AGENT" if row.get("manual_used") else "AUTO"
    partial = bool(row.get("pending_reads") or row.get("failures") or row.get("needs_visual"))
    return f"GENERATED_PARTIAL_{mode}" if partial else f"GENERATED_{mode}"
