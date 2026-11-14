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
def _require_corpus(request) -> None:
    """Fail fast with an actionable message instead of skipping silently.

    A skipped run must never be reported as a passing acceptance run.

    D-56：``--no-corpus`` 是唯一的例外——CI 里没有语料原件时，用它可以跑
    不依赖语料的用例。它不是"没语料就静默 skip"：不传这个开关时行为完全
    不变（缺原件 → ``pytest.exit``，退出码 2）。
    """
    if request.config.getoption("--no-corpus"):
        return
    missing = [row["id"] for row in load_manifest(MANIFEST) + load_manifest(SYNTH_MANIFEST)
               if resolve_original(row) is None]
    if missing:
        pytest.exit(
            "corpus originals unavailable for %d row(s) (e.g. %s).\n"
            "Set CORPUS_ROOT_TALENT_POOL / CORPUS_ROOT_ODOO_SAMPLES / "
            "CORPUS_ROOT_CODEX_CONVERTED / CORPUS_ROOT_SYNTHETIC, then re-run.\n"
            "Corpus tests cannot pass without the originals; they must not be reported as green.\n"
            "If you only need the corpus-independent tests, pass --no-corpus "
            "(those cases are then reported as skipped, never as passed)."
            % (len(missing), ", ".join(missing[:5])),
            returncode=2,
        )


def pytest_addoption(parser) -> None:
    parser.addoption(
        "--no-corpus",
        action="store_true",
        default=False,
        help="run without corpus originals: corpus-dependent cases are skipped "
             "(never reported as passed); without this flag a missing corpus is a hard exit 2",
    )


def _skip_without_corpus(request) -> None:
    """D-56：传了 --no-corpus，依赖语料的用例逐个 skip 并说明原因。"""
    if request.config.getoption("--no-corpus"):
        pytest.skip("--no-corpus：依赖语料原件的用例未运行（skipped 不是 passed）")


@pytest.fixture(scope="session")
def corpus_rows(request) -> list[dict]:
    _skip_without_corpus(request)
    rows = load_manifest(MANIFEST)
    rows += load_manifest(SYNTH_MANIFEST)
    return rows


@pytest.fixture(scope="session")
def real_rows(request) -> list[dict]:
    _skip_without_corpus(request)
    return load_manifest(MANIFEST)


@pytest.fixture(scope="session")
def synthetic_rows(request) -> list[dict]:
    _skip_without_corpus(request)
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


def recovered_ocr_pages(result: dict) -> set[int]:
    """声明"整页已由 OCR 重读"的页号（D-98 的 ``pdf_text_recovered_by_ocr``）。

    这些页的原生文本层本身就是坏的（Type3/坏字形），reader 已经用 issue 显式声明
    "恢复文本 provenance=ocr，不是原生文本"。所以保真恒等式
    （native == native blocks + declared removals）只对**未被声明重读**的页成立：
    对声明页的正确判定是"原生文本不可用"，不能拿坏文本层去和 OCR 文本逐字比。
    "该声明却没声明"由 ``test_encoding_issue_recorded_when_glyphs_removed`` 守。
    """
    pages: set[int] = set()
    for issue in result.get("issues") or []:
        if issue.get("code") != "pdf_text_recovered_by_ocr":
            continue
        page = (issue.get("location") or {}).get("page")
        if isinstance(page, int):
            pages.add(page)
    return pages


def page_identity(result: dict, path) -> list[dict]:
    """Per page: native == native-provenance blocks + declared removals.

    ``declared removals`` are exactly the characters the reader says it removed:
    undecodable glyphs (A6) and platform noise (§9.5).  Nothing else may be
    missing or added, otherwise fidelity is broken.

    D-98 的唯一豁免（**显式且窄**）：某页同时满足
      ① 带 ``pdf_text_recovered_by_ocr`` 声明（声明里 page 指向该页）；
      ② 该页的**正文块**全部是 ``provenance='ocr'``（没有任何 native_text 正文冒充）；
      ③ 该页除 ``kind='link'`` 的链接记录块外，没有别的非 ``ocr`` 块
         （链接记录块本来就不算正文，``page_identity`` 的恒等式也一直排除它）；
      ④ 该页有 OCR 块、且 OCR 文本非空
    时，该页原生恒等式不适用（原生文本层本身坏了），返回 ``applicable=False`` 并带
    自证字段（``declaration`` / ``body_block_provenances`` / ``non_ocr_block_kinds`` /
    ``ocr_block_count`` / ``ocr_text_chars``）交由调用方**逐条断言**，不是静默放过。
    缺声明、或该页混有非 link 的非 ocr 块 → 不豁免，仍必须满足恒等式。
    """
    native = pdf_reader.native_page_text(path)
    info = {p["page"]: p for p in (result.get("meta") or {}).get("page_info") or []}
    recovered = recovered_ocr_pages(result)
    checks = []
    for page_no, native_text in enumerate(native, 1):
        page_blocks = [b for b in result.get("blocks") or []
                       if (b.get("location") or {}).get("page") == page_no]
        non_ocr = [b for b in page_blocks if b.get("provenance") != "ocr"]
        ocr_blocks = [b for b in page_blocks if b.get("provenance") == "ocr"]
        body_provenances = {b.get("provenance") for b in page_blocks
                            if b.get("kind") != "link"}
        non_ocr_kinds = sorted({b.get("kind") for b in non_ocr})
        if (page_no in recovered
                and len(ocr_blocks) > 0
                and body_provenances == {"ocr"}
                and all(b.get("kind") == "link" for b in non_ocr)):
            ocr_text = "".join((b.get("text") or "") for b in ocr_blocks)
            checks.append({"page": page_no, "applicable": False,
                           "reason": "declared_ocr_recovery",
                           "declaration": "pdf_text_recovered_by_ocr",
                           "body_block_provenances": sorted(body_provenances),
                           "non_ocr_block_kinds": non_ocr_kinds,
                           "ocr_block_count": len(ocr_blocks),
                           "ocr_text_chars": len(ocr_text.strip()),
                           "block_count": len(page_blocks),
                           "equal": True, "native_chars": 0, "block_chars": 0})
            continue
        want = _non_space(native_text)
        got: Counter = Counter()
        for block in page_blocks:
            if block.get("provenance") != "native_text":
                continue
            if block.get("kind") == "link":
                continue  # 纯链接记录块，不是原生正文
            got += _non_space(native_text_of_block(block))
        page = info.get(page_no, {})
        got += _non_space(page.get("encoding_removed") or "")
        got += _non_space(page.get("noise_removed") or "")
        checks.append({"page": page_no, "applicable": True, "equal": want == got,
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


