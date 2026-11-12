"""Shared builders for the fallback tests (no test functions here)."""
from __future__ import annotations

from fallback import page_image


def native_block(text: str, page: int = 1, bbox=(40.0, 40.0, 500.0, 60.0)) -> dict:
    return {"kind": "paragraph", "text": text,
            "location": {"page": page, "bbox": list(bbox)},
            "links": [], "provenance": "native_text"}


def model_block(text: str, page: int = 1) -> dict:
    return {"kind": "paragraph", "text": text,
            "location": {"page": page, "bbox": None},
            "links": [], "provenance": "model_read"}


def result_stub(*, blocks=None, issues=None, text=None, needs_visual=True,
                completeness="partial", sha=None, pages=1, page_info=None) -> dict:
    """A converter-shaped result dict (same keys the real reader returns)."""
    blocks = list(blocks or [])
    if text is None:
        text = "\n\n".join(b.get("text") or "" for b in blocks)
    issues = list(issues or [])
    return {
        "text": text,
        "blocks": blocks,
        "chars": len(text.strip()),
        "completeness": completeness,
        "issues": issues,
        "needs_visual": needs_visual,
        "warnings": [],
        "links": [],
        "title": "",
        "meta": {"pages": pages, "source_sha256": sha,
                 "page_info": list(page_info or []), "backend": "stub"},
    }


def read_stub(text: str, page: int = 1, *, model: str = "stub/reader",
              source: str = "MODEL", **extra) -> dict:
    data = {"page": page, "text": text, "source": source, "model": model,
            "confidence": None, "answer": "TEXT" if text else "EMPTY"}
    data.update(extra)
    return data


class StubModel:
    """A test double: never a model, always labelled as one."""

    def __init__(self, text: str = "", *, model_id: str = "stub/reader",
                 raises: BaseException | None = None, test_double: bool = True):
        self.text = text
        self.model_id = model_id
        self.raises = raises
        self.test_double = test_double
        self.calls: list[tuple[str, str]] = []

    def __call__(self, prompt: str, image_path: str) -> str:
        self.calls.append((prompt, image_path))
        if self.raises is not None:
            raise self.raises
        return self.text


def sha_of(path) -> str:
    return page_image.sha256_of(path)
