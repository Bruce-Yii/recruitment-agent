"""Ask an **injected** model to transcribe one rendered page (fallback step B).

The model is injected: ``model_call(prompt, image_path) -> str``.  This module
never imports a provider SDK, never opens a socket, never reads a credential.
That is deliberate — the interface has to be testable and dry-runnable while
the real model is unavailable, and a module that cannot reach the network
cannot accidentally invent a reading.

Contract
--------
``read_page`` returns a **candidate**, never a verdict::

    {"page": 3, "text": "...", "source": "MODEL", "model": "...",
     "confidence": None, ...}

The text is only accepted after :mod:`fallback.verify_model_text` says so.

Failure rules
-------------
* Any exception from ``model_call`` -> :class:`ModelUnavailable`.
* ``None`` / non-``str`` return -> :class:`ModelUnavailable` (an adapter bug is
  not a reading).
* An empty string is **not** ``ModelUnavailable``: the model answered, the
  answer is empty, and the verifier rejects it (``EMPTY_TEXT``).  What is
  forbidden is returning ``""`` *as a success* — so the candidate is marked
  ``status="EMPTY"`` and the docstring of every caller says "verify first".
* ``confidence`` is ``None`` unless the model adapter supplies one; this module
  will not fabricate a number to look more trustworthy.
"""
from __future__ import annotations

import hashlib
import time
from pathlib import Path

PROMPT_PATH = Path(__file__).with_name("prompt.md")
PAGE_PLACEHOLDER = "{{PAGE_NO}}"
MIN_PROMPT_CHARS = 200
SOURCE = "MODEL"


class ModelUnavailable(RuntimeError):
    """The model could not be asked (quota, auth, timeout, crash, bad return).

    Callers must degrade (keep ``needs_visual``, queue for a human) — never
    substitute text of their own.
    """

    def __init__(self, code: str, message: str, *, cause_type: str | None = None,
                 retryable: bool = True):
        super().__init__(message)
        self.code = code
        self.message = message
        self.cause_type = cause_type
        self.retryable = retryable

    def as_dict(self) -> dict:
        return {"code": self.code, "message": self.message,
                "cause_type": self.cause_type, "retryable": self.retryable}


class InputError(ValueError):
    """Our side is wrong (missing png, bad page number, unreadable prompt)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message

    def as_dict(self) -> dict:
        return {"code": self.code, "message": self.message}


# ============================== prompt ==============================
def load_prompt() -> str:
    """Read the fixed transcription prompt.

    A missing or truncated prompt is an ``InputError``: sending a half prompt
    would produce a reading that no longer matches the acceptance criteria.
    """
    try:
        text = PROMPT_PATH.read_text(encoding="utf-8")
    except OSError as exc:
        raise InputError("prompt_missing", f"prompt file is not readable: {exc}") from exc
    if len(text.strip()) < MIN_PROMPT_CHARS:
        raise InputError("prompt_too_short",
                         f"prompt is only {len(text.strip())} chars; refusing to use it")
    return text


def build_prompt(page_no, prompt: str | None = None) -> str:
    """Fixed prompt + the page number the image belongs to."""
    if isinstance(page_no, bool) or not isinstance(page_no, int) or page_no < 1:
        raise InputError("page_invalid", f"page number must be a positive integer, got {page_no!r}")
    text = load_prompt() if prompt is None else prompt
    if PAGE_PLACEHOLDER in text:
        return text.replace(PAGE_PLACEHOLDER, str(page_no))
    # The prompt file is editable; if the slot disappears the page number is
    # still attached rather than silently dropped.
    return text.rstrip("\n") + f"\n\n（本图是原 PDF 第 {page_no} 页。）\n"


# ============================== model call ==============================
def _classify(exc: BaseException) -> tuple[str, bool]:
    """Map an adapter exception to (code, retryable) for the fallback ladder."""
    detail = f"{type(exc).__name__}: {exc}".lower()
    if any(k in detail for k in ("insufficient balance", "quota", "rate limit",
                                 "too many requests", "429", "余额")):
        return "model_quota", False
    if any(k in detail for k in ("unauthorized", "invalid api key", "401", "403",
                                 "authentication", "permission denied")):
        return "model_auth", False
    if any(k in detail for k in ("timeout", "timed out", "deadline exceeded")):
        return "model_timeout", True
    return "model_call_failed", True


def _model_id(model_call, explicit) -> str:
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()
    for attr in ("model_id", "model", "__name__"):
        value = getattr(model_call, attr, None)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return "injected"


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def read_page(png_path, page_no, *, model_call, prompt: str | None = None,
              model_id: str | None = None) -> dict:
    """Ask the injected model to transcribe ``png_path``.

    Returns a candidate dict; **always run** :func:`fallback.verify_model_text.verify`
    before merging.  Raises :class:`ModelUnavailable` when the model cannot be
    asked, and :class:`InputError` when the request itself is malformed.
    """
    if not callable(model_call):
        raise InputError("model_call_not_callable",
                         "model_call must be callable as model_call(prompt, image_path) -> str")
    png = Path(png_path)
    if not png.is_file():
        raise InputError("png_missing", f"rendered page not found: {png}")
    try:
        png_bytes = png.stat().st_size
    except OSError as exc:
        raise InputError("png_unreadable", f"rendered page is not readable: {exc}") from exc
    if png_bytes <= 0:
        raise InputError("png_empty", f"rendered page is empty: {png}")

    text_prompt = build_prompt(page_no, prompt)
    started = time.perf_counter()
    try:
        raw = model_call(text_prompt, str(png))
    except Exception as exc:  # noqa: BLE001 - every adapter failure is a downgrade
        code, retryable = _classify(exc)
        raise ModelUnavailable(
            code,
            f"model could not read page {page_no}: {type(exc).__name__}: {exc}",
            cause_type=type(exc).__name__,
            retryable=retryable,
        ) from exc
    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)

    if raw is None:
        raise ModelUnavailable("model_returned_none",
                               f"model returned None for page {page_no}",
                               cause_type="NoneType", retryable=True)
    if not isinstance(raw, str):
        raise ModelUnavailable("model_bad_return_type",
                               f"model must return str, got {type(raw).__name__} for page {page_no}",
                               cause_type=type(raw).__name__, retryable=True)

    text = raw.strip()  # ends only: inner line breaks and spacing stay untouched
    stripped = len(raw) - len(text)
    model_name = _model_id(model_call, model_id)
    return {
        "page": page_no,
        "text": text,
        "source": SOURCE,
        "model": model_name,
        "confidence": None,
        "confidence_note": ("not provided by model_call; a number here would be "
                            "invented, so none is written"),
        # "the model answered" — NOT "the reading is accepted".  Acceptance is
        # verify_model_text.verify(); an EMPTY answer is a valid answer that the
        # verifier will reject.
        "answer": "TEXT" if text else "EMPTY",
        "chars": len(text),
        "raw_chars": len(raw),
        "stripped_chars": stripped,
        "png_path": str(png),
        "png_bytes": png_bytes,
        "png_sha256": _sha256_of_file(png),
        "prompt_sha256": _sha256_text(text_prompt),
        "elapsed_ms": elapsed_ms,
        "text_sha256": _sha256_text(text),
        # An injected callable that declares itself a test double is recorded as
        # one, all the way into the merged artifact.  A dry run must never be
        # mistakable for a real reading.
        "test_double": bool(getattr(model_call, "test_double", False)),
    }


def _sha256_of_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()
