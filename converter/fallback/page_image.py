"""Render one PDF page to PNG for the model fallback (fallback step A).

Why this module exists
----------------------
The converter has already said *which* pages it could not read::

    unread_visual_page          page has graphics and almost no text layer
    pdf_text_encoding_unread    native text layer contains undecoded glyphs
    pdf_reading_order_unverified content stream order is not trustworthy

The fallback path needs a picture of exactly those pages and nothing else, so
that a 200-page document is not rasterised to read one page, and the model is
shown the original page rather than a re-flowed approximation.

Hard rules (fallback/README.md §A)
----------------------------------
* Render **only** the pages asked for.  There is deliberately no
  "render every page" helper.
* Write into the system temp directory, **never** into the repository.
  ``_assert_outside_repo`` raises instead of writing when a caller passes a
  path inside the converter tree; ``cleanup`` refuses to delete anything that
  is not a directory this module created under the OS temp dir.
* Record the render parameters (dpi, pixel size, page geometry, source
  sha256, timings, oversampling hint) both in the return value and in
  ``render-manifest.json`` next to the images.  A render without parameters
  cannot be reproduced or audited.

What this module does **not** do: read the text layer, decide whether a page
is readable, call a model, or keep images after the caller is done.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import fitz

DEFAULT_DPI = 200
MIN_DPI = 50
MAX_DPI = 600
# A vision endpoint usually downscales anything longer than ~4000 px.  We do
# not silently change the requested dpi; we record the risk so the caller (and
# the acceptance report) can see it.
MODEL_INPUT_LONG_SIDE = 4000
TEMP_PREFIX = "dsh-fallback-render-"
MANIFEST_NAME = "render-manifest.json"

# converter/ — the repository root of the package this module belongs to.
PACKAGE_ROOT = Path(__file__).resolve().parents[1]

# issue code -> reason name used in the page plan
TRIGGER_CODES = {
    "unread_visual_page": "image_page",
    "pdf_text_encoding_unread": "encoding_unread",
    "pdf_reading_order_unverified": "order_unverified",
}

# page_info.chars below this value == "no usable text layer" (doc 11 B1 uses 80)
LOW_TEXT_CHARS = 80

_SHA_CACHE: dict[tuple, str] = {}


class RenderError(RuntimeError):
    """A page could not be turned into an image; the caller degrades."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message

    def as_dict(self) -> dict:
        return {"code": self.code, "message": self.message}


# ============================== helpers ==============================
def sha256_of(path) -> str:
    """sha256 of a file, cached by (path, size, mtime)."""
    p = Path(path)
    st = p.stat()
    key = (str(p.resolve()), st.st_size, st.st_mtime_ns)
    hit = _SHA_CACHE.get(key)
    if hit:
        return hit
    digest = hashlib.sha256()
    with p.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    value = digest.hexdigest()
    if len(_SHA_CACHE) > 32:  # bounded cache: renders are one-shot
        _SHA_CACHE.pop(next(iter(_SHA_CACHE)))
    _SHA_CACHE[key] = value
    return value


def resolve_dpi(dpi=None) -> int:
    """Explicit argument, else ``RESUME_FALLBACK_DPI``, else 200.

    dpi is configuration, not a constant: 200 is the default, 150 is often
    enough for A4 text, 300 only helps when the source page really has that
    resolution (see ``source_dpi_hint`` — upsampling adds bytes, not detail).
    """
    raw = dpi if dpi is not None else os.environ.get("RESUME_FALLBACK_DPI")
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return DEFAULT_DPI
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise RenderError("dpi_invalid", f"dpi must be an integer, got {raw!r}") from exc
    if not MIN_DPI <= value <= MAX_DPI:
        raise RenderError("dpi_out_of_range",
                          f"dpi must be {MIN_DPI}..{MAX_DPI}, got {value}")
    return value


def _assert_outside_repo(path) -> Path:
    """Refuse to write rendered pages inside the repository."""
    p = Path(path).resolve()
    try:
        p.relative_to(PACKAGE_ROOT)
    except ValueError:
        return p
    raise RenderError(
        "render_path_in_repo",
        f"refusing to write rendered pages inside the repository: {p}",
    )


def make_temp_dir(prefix: str = TEMP_PREFIX) -> Path:
    """A fresh directory under the OS temp dir (never the repository)."""
    path = Path(tempfile.mkdtemp(prefix=prefix))
    _assert_outside_repo(path)
    return path


def cleanup(out_dir) -> bool:
    """Delete a render directory, but only one this module could have made.

    Refuses (returns False) for anything outside the OS temp dir or without
    the module's own prefix, so a wrong argument can never delete work.
    """
    if not out_dir:
        return False
    p = Path(out_dir).resolve()
    tmp = Path(tempfile.gettempdir()).resolve()
    if tmp != p and tmp not in p.parents:
        return False
    if not p.name.startswith(TEMP_PREFIX):
        return False
    if not p.is_dir():
        return False
    shutil.rmtree(p, ignore_errors=True)
    return not p.exists()


# ============================== page plan ==============================
def plan_pages(result, *, pages=None, trigger_codes=None) -> dict:
    """Which pages need a rendered image, decided by the converter's issues.

    Only page-scoped issues trigger a render.  ``pdf_no_text`` is document
    scoped: it does not say *which* page to look at, and in practice the pages
    that carry it also carry ``unread_visual_page`` (or ``pdf_page_empty``,
    which has nothing to read).  Guessing "all pages" here would rasterise
    documents that are already fully read.
    """
    triggers = dict(TRIGGER_CODES if trigger_codes is None else trigger_codes)
    reasons: dict[int, list[str]] = {}
    codes: list[str] = []
    for issue in result.get("issues") or []:
        if not isinstance(issue, dict):
            continue
        code = issue.get("code") or ""
        if code not in triggers:
            continue
        page = (issue.get("location") or {}).get("page")
        if not isinstance(page, int) or isinstance(page, bool) or page < 1:
            continue  # not a single-page problem
        bucket = reasons.setdefault(page, [])
        reason = triggers[code]
        if reason not in bucket:
            bucket.append(reason)
        if code not in codes:
            codes.append(code)

    if pages is not None:
        for raw in pages:
            if isinstance(raw, bool) or not isinstance(raw, int) or raw < 1:
                raise ValueError(f"page numbers must be positive integers, got {raw!r}")
            bucket = reasons.setdefault(raw, [])
            if "explicit" not in bucket:
                bucket.append("explicit")

    planned = [{"page": p, "reasons": reasons[p]} for p in sorted(reasons)]
    return {
        "pages": planned,
        "issue_codes": codes,
        "explicit": pages is not None,
        "has_pdf_no_text": any((i or {}).get("code") == "pdf_no_text"
                               for i in result.get("issues") or [] if isinstance(i, dict)),
    }


def image_pages(result) -> set[int]:
    """Pages whose text layer is unusable but which carry graphics (doc 11 B1)."""
    out: set[int] = set()
    for info in ((result.get("meta") or {}).get("page_info") or []):
        page = info.get("page")
        chars = info.get("chars") or 0
        if isinstance(page, int) and chars < LOW_TEXT_CHARS and (info.get("images") or info.get("drawings")):
            out.add(page)
    for issue in result.get("issues") or []:
        if isinstance(issue, dict) and issue.get("code") == "unread_visual_page":
            page = (issue.get("location") or {}).get("page")
            if isinstance(page, int):
                out.add(page)
    return out


# ============================== rendering ==============================
def _largest_embedded_image(page) -> list[int] | None:
    """Native pixel size of the largest embedded image, if any."""
    best = None
    try:
        images = page.get_images(full=True) or []
    except Exception:  # noqa: BLE001 - geometry only, never fatal
        return None
    for item in images:
        try:
            width, height = int(item[2] or 0), int(item[3] or 0)
        except (TypeError, ValueError, IndexError):
            continue
        if width <= 0 or height <= 0:
            continue
        if best is None or width * height > best[0] * best[1]:
            best = [width, height]
    return best


def render_page(pdf_path, page_no, *, dpi=None, out_dir=None, max_side=None) -> dict:
    """Render one page to PNG and return the render record.

    Parameters
    ----------
    pdf_path : source PDF (read-only; the file is never modified)
    page_no  : 1-based page number
    dpi      : render resolution; ``None`` -> env -> 200
    out_dir  : target directory; ``None`` -> a fresh temp dir (caller cleans)
    max_side : optional long-side pixel cap.  When set, the *effective* dpi is
               lowered so the long side fits; ``dpi_requested`` keeps the
               original value so the change is visible, never silent.
    """
    path = Path(pdf_path)
    if not path.is_file():
        raise RenderError("pdf_missing", f"no such file: {path}")
    if isinstance(page_no, bool) or not isinstance(page_no, int) or page_no < 1:
        raise RenderError("page_invalid", f"page number must be a positive integer, got {page_no!r}")
    if max_side is not None:
        if isinstance(max_side, bool) or not isinstance(max_side, int) or max_side < 64:
            raise RenderError("max_side_invalid",
                              f"max_side must be an integer >= 64, got {max_side!r}")

    dpi_requested = resolve_dpi(dpi)

    started = time.perf_counter()
    try:
        doc = fitz.open(str(path))
    except Exception as exc:  # noqa: BLE001
        raise RenderError("pdf_open_failed",
                          f"PDF could not be opened: {type(exc).__name__}: {exc}") from exc
    try:
        if getattr(doc, "is_encrypted", False) and not doc.authenticate(""):
            raise RenderError("encrypted_pdf",
                              "page cannot be rendered without a password")
        page_count = doc.page_count
        if page_no > page_count:
            raise RenderError("page_out_of_range",
                              f"page {page_no} > page count {page_count}")
        page = doc[page_no - 1]
        rect = page.rect

        # The output directory is created only after the page is known to be
        # renderable: a rejected request must not leave an empty temp dir.
        out = Path(out_dir) if out_dir is not None else make_temp_dir()
        _assert_outside_repo(out)  # before mkdir: never create a directory in the repo
        out.mkdir(parents=True, exist_ok=True)

        dpi_used = dpi_requested
        long_inches = max(rect.width, rect.height) / 72.0
        if max_side is not None and long_inches > 0:
            cap = int(max_side / long_inches)
            if cap < dpi_used:
                dpi_used = max(1, cap)

        t_render = time.perf_counter()
        try:
            pix = page.get_pixmap(dpi=dpi_used, alpha=False)
        except Exception as exc:  # noqa: BLE001
            raise RenderError("render_failed",
                              f"page {page_no} could not be rasterised: "
                              f"{type(exc).__name__}: {exc}") from exc
        t_saved = time.perf_counter()

        png = out / f"page-{page_no:04d}@{dpi_used}dpi.png"
        try:
            pix.save(str(png))
        except Exception as exc:  # noqa: BLE001
            raise RenderError("png_write_failed", f"PNG could not be written: {exc}") from exc
        t_done = time.perf_counter()

        source_px = _largest_embedded_image(page)
        hint = None
        if source_px and rect.width > 0:
            hint = source_px[0] / (rect.width / 72.0)
        warnings: list[str] = []
        if max(pix.width, pix.height) > MODEL_INPUT_LONG_SIDE:
            warnings.append(
                f"long_side_px {max(pix.width, pix.height)} > {MODEL_INPUT_LONG_SIDE}: "
                "most vision endpoints downscale this; use max_side= to bound it "
                "or expect the small text to be lost"
            )
        if hint and dpi_used > hint * 1.05:
            warnings.append(
                f"oversampled: embedded image is ~{hint:.0f} dpi, rendered at {dpi_used} dpi "
                "(more pixels, not more detail)"
            )

        record = {
            "png_path": str(png.resolve()),
            "png_name": png.name,
            "png_sha256": sha256_of(png),
            "png_bytes": png.stat().st_size,
            "page": page_no,
            "page_count": page_count,
            "dpi": dpi_used,
            "dpi_requested": dpi_requested,
            "dpi_capped": dpi_used != dpi_requested,
            "max_side": max_side,
            "pixel_size": [pix.width, pix.height],
            "page_size_pt": [round(rect.width, 2), round(rect.height, 2)],
            "page_size_in": [round(rect.width / 72.0, 2), round(rect.height / 72.0, 2)],
            "source_image_px": source_px,
            "source_dpi_hint": round(hint, 1) if hint is not None else None,
            "oversampled": bool(hint and dpi_used > hint * 1.05),
            "render_ms": round((t_saved - t_render) * 1000, 2),
            "save_ms": round((t_done - t_saved) * 1000, 2),
            "total_ms": round((t_done - started) * 1000, 2),
            "source_path": str(path),
            "source_sha256": sha256_of(path),
            "out_dir": str(out.resolve()),
            "rendered_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "warnings": warnings,
        }
        return record
    finally:
        try:
            doc.close()
        except Exception:  # noqa: BLE001
            pass


def render_pages(pdf_path, pages, *, dpi=None, out_dir=None, max_side=None) -> dict:
    """Render the given pages into one directory and write the manifest.

    A page that cannot be rendered is recorded in ``errors``; it never aborts
    the other pages (one bad page must not hide the rest).
    """
    wanted: list[int] = []
    for raw in pages:
        if isinstance(raw, bool) or not isinstance(raw, int) or raw < 1:
            raise RenderError("page_invalid", f"page numbers must be positive integers, got {raw!r}")
        if raw not in wanted:
            wanted.append(raw)
    out = Path(out_dir) if out_dir is not None else make_temp_dir()
    _assert_outside_repo(out)  # before mkdir: never create a directory in the repo
    out.mkdir(parents=True, exist_ok=True)

    renders, errors = [], []
    started = time.perf_counter()
    for page_no in wanted:
        try:
            renders.append(render_page(pdf_path, page_no, dpi=dpi, out_dir=out,
                                       max_side=max_side))
        except RenderError as exc:
            errors.append({"page": page_no, **exc.as_dict()})
    total_ms = round((time.perf_counter() - started) * 1000, 2)
    payload = {
        "source_path": str(Path(pdf_path)),
        "dpi": resolve_dpi(dpi),
        "max_side": max_side,
        "requested_pages": wanted,
        "renders": renders,
        "errors": errors,
        "total_ms": total_ms,
        "written_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    manifest = out / MANIFEST_NAME
    manifest.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    return {
        "renders": renders,
        "errors": errors,
        "out_dir": str(out.resolve()),
        "manifest": str(manifest.resolve()),
        "dpi": payload["dpi"],
        "count": len(renders),
        "total_ms": total_ms,
    }
