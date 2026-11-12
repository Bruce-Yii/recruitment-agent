"""Mechanically check what the model claims to have read (fallback step D).

This is the anti-hallucination gate.  The model is *never* trusted: a reading
that fails any check here is **not merged** and the page stays ``needs_visual``
(that is the only allowed fallback).  There is no "confidence high enough to
skip the checks" path.

Five required checks (task spec) plus four cheap additions, all deterministic:

====  ==========================  ==========================================
#     code                        what it rejects
====  ==========================  ==========================================
1     EMPTY_TEXT / TEXT_TOO_SHORT empty or trivially short answer
2     META_DISCOURSE              "抱歉" / "我无法" / "作为 AI" / refusals
3     SOURCE_NOT_MODEL            a reading not labelled ``source="MODEL"``
      NATIVE_MIXED                native text smuggled into a model reading
4     NATIVE_OVERLAP_LOW          text that has nothing to do with the page
      NATIVE_TOKEN_OVERLAP_LOW    same, for space-delimited text (extra)
5     PAGE_MISSING / PAGE_MISMATCH a reading that does not say which page it is
====  ==========================  ==========================================

Additions (also hard failures, all "fail closed"):

* ``BAD_GLYPH``           ``U+FFFD`` / ``(cid:N)`` / control chars in model text
                          would put undecoded markers into the body (doc 11 A6)
* ``PLACEHOLDER_HEAVY``   more than half of the visible characters are ``□``:
                          the model did not read the page, it gave up quietly
* ``OUTPUT_WRAPPED``      code fences / JSON / "以下是…：" preambles: the model
                          ignored the fixed prompt, so the text is unverified
* ``MODEL_ID_MISSING``    no model id -> the reading is not auditable

Asymmetry on purpose: a false rejection costs one human queue entry; a false
acceptance puts invented text into a candidate's record.  Every check therefore
prefers rejecting.

The overlap metric is "how much of what the model claims is actually on the
page": ``|chars(model) ∩ chars(native)| / |chars(model)|`` over non-whitespace,
ASCII-case-folded characters.  Threshold 0.2 (task spec).  For pages with no
usable native text (image-only) there is nothing to compare against and the
check is recorded as ``skipped`` — never as ``passed``.
"""
from __future__ import annotations

import re

MIN_CHARS = 10
MAX_CHARS = 20000
MIN_NATIVE_FOR_OVERLAP = 20
MIN_OVERLAP = 0.2
MIN_TOKEN_OVERLAP = 0.1
MIN_TOKENS_FOR_OVERLAP = 10
MAX_PLACEHOLDER_RATIO = 0.5
PLACEHOLDER = "\u25a1"  # □

# Refusal / self-reference / apology.  Deliberately over-broad: "抱歉" alone is
# enough to reject, because a resume page that legitimately starts with an
# apology is far less likely than a model refusing the task.
_META_PATTERNS = (
    (r"作为\s*(?:一个|一名)?\s*(?:ai|人工智能|语言模型|大模型|智能助手|ai\s*助手|助手)",
     "自称 AI / 助手"),
    (r"(?:我|本模型|模型)\s*(?:无法|不能|不可以|不便|难以|拒绝)\s*"
     r"(?:读取|识别|辨认|查看|看到|打开|处理|提供|完成|访问|帮助)", "模型声称无法完成"),
    (r"抱歉|对不起|很遗憾", "道歉语"),
    (r"(?:无法|不能|难以)\s*(?:读取|识别|辨认|查看)\s*(?:这张|该|此)?\s*(?:图|图片|图像|页面|内容)",
     "声称无法读取图片"),
    (r"\bas\s+an?\s+(?:ai|assistant|language\s+model|ai\s+assistant)\b", "AI self-reference"),
    (r"\bi\s*(?:'|’)?m\s+sorry\b", "apology"),
    (r"\bi\s+am\s+sorry\b", "apology"),
    (r"\bi\s+(?:can\s*not|can't|cannot|am\s+unable\s+to)\s+"
     r"(?:read|see|view|access|help|process|interpret)", "refusal"),
    (r"\bunable\s+to\s+(?:read|view|access|process|interpret|transcribe)", "refusal"),
    (r"\b(?:i|the\s+model)\s+(?:cannot|can't|am\s+not\s+able\s+to)\s+transcribe", "refusal"),
)
_META_RE = tuple((re.compile(p, re.IGNORECASE), label) for p, label in _META_PATTERNS)

# A reading that arrives wrapped in ```json / "以下是..." was not produced under
# the fixed prompt contract, so its content cannot be attributed to the page.
_PREAMBLE_RE = re.compile(
    r"^(?:以下(?:是|为)|下面(?:是|为))\s*.{0,24}(?:转录|文字|内容|文本)\s*[：:。.]?\s*$"
    r"|^这是\s*(?:第\s*\d+\s*页|该页|本页|图片|图像|截图)\s*.{0,16}$"
    r"|^转录\s*(?:如下|结果)\s*[：:]?$"
    r"|^here\s+is\s+.{0,40}$",
    re.IGNORECASE,
)
_BAD_GLYPH_RE = re.compile(r"\ufffd|\(cid:\d+\)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_WORD_RE = re.compile(r"[a-z0-9]{3,}")


def _reason(code: str, message: str) -> dict:
    return {"code": code, "message": message, "severity": "hard"}


def _visible(text: str) -> str:
    return re.sub(r"\s", "", text or "")


def char_overlap(model_text: str, native_text: str) -> float:
    """Share of the model's characters that also occur on the native page."""
    model_chars = {c for c in _visible(model_text).casefold()}
    if not model_chars:
        return 0.0
    native_chars = {c for c in _visible(native_text).casefold()}
    return len(model_chars & native_chars) / len(model_chars)


def token_overlap(model_text: str, native_text: str) -> float | None:
    """Share of the model's 3+ char ASCII words that occur on the native page.

    ``None`` when either side has fewer than ``MIN_TOKENS_FOR_OVERLAP`` words
    (CJK text has no spaces, so the check simply does not apply).
    """
    model_words = _WORD_RE.findall((model_text or "").casefold())
    native_words = _WORD_RE.findall((native_text or "").casefold())
    if len(model_words) < MIN_TOKENS_FOR_OVERLAP or len(native_words) < MIN_TOKENS_FOR_OVERLAP:
        return None
    return len(set(model_words) & set(native_words)) / len(set(model_words))


def placeholder_ratio(text: str) -> float:
    visible = _visible(text)
    if not visible:
        return 0.0
    return visible.count(PLACEHOLDER) / len(visible)


def page_text_by_page(result, *, exclude_provenance=("model_read",)) -> dict[int, str]:
    """Native text per page, taken from the converter's own blocks.

    ``model_read`` blocks are excluded by default, so merging twice can never
    make the model's own output its own evidence.  Platform noise has already
    been removed from ``blocks`` by the converter; OCR titles stay (they are a
    reading of the same page, not a model transcription).
    """
    pages: dict[int, list[str]] = {}
    for block in result.get("blocks") or []:
        if not isinstance(block, dict):
            continue
        if block.get("provenance") in exclude_provenance:
            continue
        page = (block.get("location") or {}).get("page")
        if isinstance(page, bool) or not isinstance(page, int):
            continue
        text = block.get("text") or ""
        if not text.strip():
            continue
        pages.setdefault(page, []).append(text)
    return {page: "\n".join(parts) for page, parts in sorted(pages.items())}


def _wrapper_reasons(text: str) -> list[dict]:
    reasons: list[dict] = []
    stripped = text.lstrip()
    if stripped.startswith("```"):
        reasons.append(_reason("OUTPUT_WRAPPED",
                               "reading starts with a Markdown code fence "
                               "(the fixed prompt forbids it)"))
    first = next((line.strip() for line in text.splitlines() if line.strip()), "")
    if first and len(first) <= 48 and _PREAMBLE_RE.match(first):
        reasons.append(_reason("OUTPUT_WRAPPED",
                               f"reading starts with a preamble line {first[:24]!r}; "
                               "the fixed prompt forbids it"))
    if stripped[:1] in "{[":  # JSON wrapper
        head = stripped[:240].replace(" ", "").replace("\n", "")
        if '"text"' in head:
            reasons.append(_reason("OUTPUT_WRAPPED",
                                   "reading is a JSON object, not page text"))
    return reasons


def _is_page_number(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 1


def verify(read, *, native_text: str | None = None, page: int | None = None,
           is_image_page: bool = False, min_overlap: float = MIN_OVERLAP) -> dict:
    """Check one model reading.  Returns ``{ok, reasons, codes, stats}``.

    ``native_text`` is the text the converter itself read from that page (may be
    ``""`` for an image page).  ``page`` is the page this reading is supposed to
    be about; when given it must match ``read["page"]``.
    """
    reasons: list[dict] = []
    checks: list[str] = []
    read = read if isinstance(read, dict) else {}
    text = read.get("text")
    native = (native_text or "").strip()

    # ---- 0. shape -------------------------------------------------------
    checks.append("SHAPE")
    if not isinstance(text, str):
        reasons.append(_reason("TEXT_NOT_STRING",
                              f"reading text must be str, got {type(text).__name__}"))
        text = ""

    # ---- 1. non-empty, plausible length --------------------------------
    checks.append("LENGTH")
    body = text.strip()
    if not body:
        reasons.append(_reason("EMPTY_TEXT", "reading is empty"))
    elif len(body) <= MIN_CHARS:
        reasons.append(_reason("TEXT_TOO_SHORT",
                              f"reading has {len(body)} chars, minimum is {MIN_CHARS + 1}"))
    if len(text) > MAX_CHARS:
        reasons.append(_reason("TEXT_TOO_LONG",
                              f"reading has {len(text)} chars, maximum is {MAX_CHARS}"))

    # ---- 2. refusal / meta discourse -----------------------------------
    checks.append("META_DISCOURSE")
    if body:
        for pattern, label in _META_RE:
            match = pattern.search(body)
            if match:
                reasons.append(_reason("META_DISCOURSE",
                                      f"{label}: {match.group(0)!r} — the model "
                                      "talked about itself instead of transcribing"))
                break

    # ---- 3. provenance -------------------------------------------------
    checks.append("PROVENANCE")
    if read.get("source") != "MODEL":
        reasons.append(_reason("SOURCE_NOT_MODEL",
                              f"source must be 'MODEL', got {read.get('source')!r}"))
    if read.get("provenance") in ("native_text", "ocr_title"):
        reasons.append(_reason("NATIVE_MIXED",
                              f"reading claims provenance {read.get('provenance')!r}"))
    if read.get("native_text"):
        reasons.append(_reason("NATIVE_MIXED",
                              "reading carries a non-empty native_text field; "
                              "native and model text must not be mixed"))

    # ---- 4. which page -------------------------------------------------
    checks.append("PAGE")
    read_page_no = read.get("page")
    if not _is_page_number(read_page_no):
        reasons.append(_reason("PAGE_MISSING",
                              f"reading must name its page, got {read_page_no!r}"))
    elif page is not None and read_page_no != page:
        reasons.append(_reason("PAGE_MISMATCH",
                              f"reading says page {read_page_no}, expected page {page}"))
    model_id = read.get("model")
    if not isinstance(model_id, str) or not model_id.strip():
        reasons.append(_reason("MODEL_ID_MISSING",
                              "reading has no model id; it is not auditable"))

    # ---- 5. comparison with the native text of the same page -----------
    checks.append("NATIVE_OVERLAP")
    stats_overlap: float | None = None
    stats_token: float | None = None
    overlap_note = ""
    if len(_visible(native)) < MIN_NATIVE_FOR_OVERLAP:
        overlap_note = "skipped: page has no usable native text (image page or empty)"
    elif not body:
        overlap_note = "skipped: nothing to compare (empty reading)"
    else:
        stats_overlap = round(char_overlap(body, native), 4)
        if stats_overlap < min_overlap:
            reasons.append(_reason(
                "NATIVE_OVERLAP_LOW",
                f"only {stats_overlap:.3f} of the model's characters occur on the "
                f"native page (minimum {min_overlap})"))
        stats_token = token_overlap(body, native)
        if stats_token is not None and stats_token < MIN_TOKEN_OVERLAP:
            reasons.append(_reason(
                "NATIVE_TOKEN_OVERLAP_LOW",
                f"only {stats_token:.3f} of the model's words occur on the native "
                f"page (minimum {MIN_TOKEN_OVERLAP})"))

    # ---- 6. text quality additions -------------------------------------
    checks.append("GLYPH")
    if body and _BAD_GLYPH_RE.search(body):
        match = _BAD_GLYPH_RE.search(body)
        reasons.append(_reason("BAD_GLYPH",
                              f"reading contains an undecodable marker "
                              f"{match.group(0)!r}; it must not enter the body"))
    checks.append("PLACEHOLDER")
    ratio = round(placeholder_ratio(body), 4) if body else 0.0
    if body and ratio > MAX_PLACEHOLDER_RATIO:
        reasons.append(_reason(
            "PLACEHOLDER_HEAVY",
            f"{ratio:.0%} of the visible characters are placeholders "
            f"(maximum {MAX_PLACEHOLDER_RATIO:.0%}); the page was not read"))
    checks.append("WRAPPER")
    if body:
        reasons.extend(_wrapper_reasons(body))

    stats = {
        "chars": len(body),
        "native_chars": len(native),
        "image_page": bool(is_image_page),
        "overlap": stats_overlap,
        "token_overlap": stats_token,
        "overlap_note": overlap_note,
        "placeholder_ratio": ratio,
        "checks": checks,
    }
    return {
        "ok": not reasons,
        "reasons": reasons,
        "codes": [r["code"] for r in reasons],
        "stats": stats,
    }
