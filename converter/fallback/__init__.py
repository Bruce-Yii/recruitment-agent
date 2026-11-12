"""Model fallback for pages the converter could not read.

Package map (one file per step, no hidden coupling):

    page_image.py         A  render the pages an issue asks for -> PNG (temp dir)
    model_reader.py       B  injected ``model_call(prompt, image_path) -> str``
    prompt.md             B  the fixed transcription prompt
    verify_model_text.py  D  mechanical checks; failures are never merged
    merge.py              E  append verified text as a ``model_read`` block
    pipeline.py              A -> B -> D -> E with the failure policy

Everything is offline and deterministic: no provider SDK is imported, no
credential is read, and a test double is the only way this package has ever
produced text (the real model was unavailable while it was built).

    python -m fallback.dry_run --pdf <pdf> --fake ok
    python -m fallback.dry_run --synthetic --page 1 --fake unrelated
"""
from __future__ import annotations

from .merge import merge_model_reads
from .model_reader import InputError, ModelUnavailable, read_page
from .page_image import (DEFAULT_DPI, RenderError, cleanup, image_pages, plan_pages,
                         render_page, render_pages)
from .pipeline import describe, run_fallback
from .verify_model_text import verify

__all__ = [
    "DEFAULT_DPI",
    "InputError",
    "ModelUnavailable",
    "RenderError",
    "cleanup",
    "describe",
    "image_pages",
    "merge_model_reads",
    "plan_pages",
    "read_page",
    "render_page",
    "render_pages",
    "run_fallback",
    "verify",
]
