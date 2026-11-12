"""Shared fixtures: corpus loading, PDF fixtures, fidelity helpers.

Everything here reads the original PDFs **read-only**.  Generated PDFs used by
the unit tests are written to pytest's tmp_path, never into the repository.
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

import fitz
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src import pdf_reader, resume_fields  # noqa: E402

CORPUS = ROOT / "corpus"
SYNTHETIC = CORPUS / "synthetic"
MANIFEST = CORPUS / "manifest.jsonl"
SYNTH_MANIFEST = SYNTHETIC / "synthetic-manifest.jsonl"

_LINK_MD = re.compile(r"\[((?:\\.|[^\]])*)\]\(<[^>]*>\)")


def load_manifest(path: Path) -> list[dict]:
    """Load rows and attach a resolved ``path`` for every row.

    The committed manifests carry a logical ``root`` + ``rel`` pair; tests read
    ``row["path"]``. Resolution happens once here so no test has to know about
    the portability scheme.
    """
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()]
    for row in rows:
        resolved = resolve_original(row)
        if resolved is not None:
            row["path"] = str(resolved)
    return rows


# Corpus originals are not in the repository (size + real candidate material).
# A manifest row carries either a machine `path` (legacy, local only) or a
# logical `root` + `rel` pair resolved through CORPUS_ROOT_<ROOT> environment
# variables. Identity stays the sha256 in the row; the path is just a locator.
ROOT_ENV = {
    "talent_pool": "CORPUS_ROOT_TALENT_POOL",
    "odoo_samples": "CORPUS_ROOT_ODOO_SAMPLES",
    "codex_converted": "CORPUS_ROOT_CODEX_CONVERTED",
    "synthetic": "CORPUS_ROOT_SYNTHETIC",
}


def resolve_original(row: dict) -> Path | None:
    import os

    if row.get("path"):
        candidate = Path(row["path"])
        return candidate if candidate.is_file() else None
    env_name = ROOT_ENV.get(row.get("root", ""))
    if env_name is None:
        return None
    root = os.environ.get(env_name, "").strip()
    if not root:
        return None
    candidate = Path(root) / row["rel"]
    return candidate if candidate.is_file() else None


@pytest.fixture(scope="session", autouse=True)
def _require_corpus() -> None:
    """Fail fast with an actionable message instead of skipping silently.

    A skipped run must never be reported as a passing acceptance run.
    """
    missing = [row["id"] for row in load_manifest(MANIFEST) + load_manifest(SYNTH_MANIFEST)
               if resolve_original(row) is None]
    if missing:
        pytest.exit(
            "corpus originals unavailable for %d row(s) (e.g. %s).\n"
            "Set CORPUS_ROOT_TALENT_POOL / CORPUS_ROOT_ODOO_SAMPLES / "
            "CORPUS_ROOT_CODEX_CONVERTED / CORPUS_ROOT_SYNTHETIC, then re-run.\n"
            "Corpus tests cannot pass without the originals; they must not be reported as green."
            % (len(missing), ", ".join(missing[:5])),
            returncode=2,
        )


@pytest.fixture(scope="session")
def corpus_rows() -> list[dict]:
    rows = load_manifest(MANIFEST)
    rows += load_manifest(SYNTH_MANIFEST)
    return rows


@pytest.fixture(scope="session")
def real_rows() -> list[dict]:
    return load_manifest(MANIFEST)


@pytest.fixture(scope="session")
def synthetic_rows() -> list[dict]:
    return load_manifest(SYNTH_MANIFEST)


@pytest.fixture(scope="session")
def corpus_results(corpus_rows) -> list[tuple[dict, dict]]:
    """Read every corpus PDF once, in-process (no subprocess overhead)."""
    out = []
    for row in corpus_rows:
        out.append((row, pdf_reader.read_pdf(str(resolve_original(row)))))
    return out


@pytest.fixture(scope="session")
def real_results(real_rows) -> list[tuple[dict, dict]]:
    return [(row, pdf_reader.read_pdf(str(resolve_original(row)))) for row in real_rows]


def sha256(path) -> str:
    import hashlib
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def build_pdf(path: Path, lines, *, page_size=(595, 842)) -> Path:
    """Write a small PDF from ``(x, y, text, fontsize)`` lines (CJK-safe)."""
    doc = fitz.open()
    page = doc.new_page(width=page_size[0], height=page_size[1])
    for x, y, text, size in lines:
        page.insert_text((x, y), text, fontsize=size, fontname="china-s")
    doc.save(str(path))
    doc.close()
    return path


def native_text_of_block(block: dict) -> str:
    """Recover the native text of a block: strip the Markdown link markup.

    ``content.link_md`` writes ``[label](<href>)``; the label is native text and
    the href is a link target (which is *not* native body text).  Undoing the
    markup lets A2 compare like with like.
    """
    text = block.get("text") or ""
    text = _LINK_MD.sub(lambda m: m.group(1), text)
    return text.replace("\\[", "[").replace("\\]", "]")


def _non_space(text: str) -> Counter:
    return Counter(re.sub(r"\s", "", text or ""))


def page_identity(result: dict, path) -> list[dict]:
    """Per page: native == native-provenance blocks + declared removals.

    ``declared removals`` are exactly the characters the reader says it removed:
    undecodable glyphs (A6) and platform noise (§9.5).  Nothing else may be
    missing or added, otherwise fidelity is broken.
    """
    native = pdf_reader.native_page_text(path)
    info = {p["page"]: p for p in (result.get("meta") or {}).get("page_info") or []}
    checks = []
    for page_no, native_text in enumerate(native, 1):
        want = _non_space(native_text)
        got: Counter = Counter()
        for block in result.get("blocks") or []:
            location = block.get("location") or {}
            if location.get("page") != page_no:
                continue
            if block.get("provenance") != "native_text":
                continue
            if block.get("kind") == "link":
                continue  # 纯链接记录块，不是原生正文
            got += _non_space(native_text_of_block(block))
        page = info.get(page_no, {})
        got += _non_space(page.get("encoding_removed") or "")
        got += _non_space(page.get("noise_removed") or "")
        checks.append({"page": page_no, "equal": want == got,
                       "native_chars": sum(want.values()),
                       "block_chars": sum(got.values())})
    return checks


def hard_codes(result: dict) -> list[str]:
    from src.issues import hard_codes as _hard
    return _hard(result.get("issues"))


def field_states(result: dict) -> dict:
    return {k: v.get("state") for k, v in (result.get("fields") or {}).items()}


def all_evidence(result: dict) -> list[dict]:
    """Every evidence record the reader emitted for fields/protected attributes."""
    out = []
    for key, field in (result.get("fields") or {}).items():
        for ev in field.get("evidence") or []:
            out.append({"field": key, **ev})
        for entry in field.get("entries") or []:
            for ev in entry.get("header_blocks") or []:
                out.append({"field": key, "entry": entry.get("index"), **ev})
    for key, item in (result.get("protected_attributes") or {}).items():
        for ev in item.get("evidence") or []:
            out.append({"protected": key, **ev})
    return out


@pytest.fixture()
def tmp_pdf(tmp_path):
    """Factory: ``tmp_pdf(name, lines)`` -> Path of a generated PDF."""
    def _make(name: str, lines, **kwargs) -> Path:
        return build_pdf(tmp_path / name, lines, **kwargs)
    return _make


