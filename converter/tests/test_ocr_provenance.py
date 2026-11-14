"""OCR 真实性契约：依赖声明 + 缺包 fail-closed + 兜底块 provenance。

本文件只测**契约与标签**，不跑真实 OCR 引擎（真 OCR 需要模型推理，证据放
``work/verify-2026-11-15-doc1/A/``，不进 pytest）。

钉住三件事（2026-11-15 doc1-A）：

1. ``converter/requirements.txt`` 声明 ``rapidocr_onnxruntime``，且本机环境真的装了
   该包（``importlib.metadata.version`` 可读），部署面不再是"文档里说有、实际靠
   开发者手工装"；
2. 缺 ``rapidocr_onnxruntime`` / ``pymupdf`` 时 ``ocr_titles.py`` **fail-closed**：
   子进程返回 3、stdout 只有一行合法 JSON、``missing``/``error`` 指名缺的包、
   **没有 ``pages`` 字段**（缺包绝不能被读成"没有需要补读的文字"）；
3. OCR 兜底块 ``pdf_reader._ocr_page_blocks`` 的标签诚实：``provenance='ocr'``、
   保留 ``location.page`` 与 ``bbox``、绝不出现 ``native_text``；OCR 没字时返回
   ``([], 'ocr_no_text')``（不是静默空列表）。

缺包用 ``PYTHONPATH`` 指向一个 ``raise ImportError`` 的影子模块来构造——不卸载、
不改本机环境、不联网。
"""
from __future__ import annotations

import importlib.metadata
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from src import pdf_reader

ROOT = Path(__file__).resolve().parents[1]
OCR_TOOL = ROOT / "src" / "ocr_titles.py"
REQUIREMENTS = ROOT / "requirements.txt"

#: 影子模块：导入时装成 ImportError（模拟"没装这个包"，不改本机环境）。
_SHADOW_TEMPLATE = (
    "raise ImportError({message!r})\n"
)


def _write_pdf(path: Path) -> Path:
    """造一份最小合成 PDF（内容无关，只为让工具通过 file-not-found 检查）。"""
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=200, height=120)
    page.insert_text((20, 60), "SYNTHETIC OCR PROBE", fontsize=12)
    doc.save(str(path))
    doc.close()
    return path


def _run_ocr_tool(pdf: Path, *, shadow: Path | None = None) -> subprocess.CompletedProcess:
    env = {key: value for key, value in os.environ.items() if key != "PYTHONPATH"}
    if shadow is not None:
        env["PYTHONPATH"] = str(shadow)
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, str(OCR_TOOL), str(pdf), "--max-pages", "1"],
        capture_output=True, timeout=300, env=env,
    )


def _shadow_package(directory: Path, module_name: str, message: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{module_name}.py").write_text(
        _SHADOW_TEMPLATE.format(message=message), encoding="utf-8")
    return directory


# ---------------------------------------------------------------- 依赖声明面
def test_rapidocr_is_declared_in_requirements_and_installed():
    """部署面：requirements.txt 声明 rapidocr_onnxruntime，且本机确实装了。"""
    requirements = REQUIREMENTS.read_text(encoding="utf-8")
    assert "rapidocr_onnxruntime" in requirements, (
        "OCR 引擎必须出现在 converter/requirements.txt，否则 CI/新机器上会静默缺包")
    version = importlib.metadata.version("rapidocr_onnxruntime")
    assert version, "importlib.metadata 必须能读出 rapidocr_onnxruntime 版本"
    # 声明的下界是 >=1.4.4；本机装 1.4.4（不在测试里装/升级任何包）
    parts = [int(part) for part in re.findall(r"\d+", version)[:3]]
    parts += [0] * (3 - len(parts))
    assert tuple(parts) >= (1, 4, 4), f"本机版本 {version} 低于声明下界 1.4.4"


# ---------------------------------------------------------------- 缺包 fail-closed
def test_ocr_tool_fails_closed_when_rapidocr_missing(tmp_path):
    """缺 rapidocr_onnxruntime：return 3 + 一行 JSON + missing 指名，且不给 pages。"""
    shadow = _shadow_package(
        tmp_path / "shadow-rapidocr", "rapidocr_onnxruntime",
        "rapidocr_onnxruntime deliberately unavailable (test shadow)")
    pdf = _write_pdf(tmp_path / "probe.pdf")

    proc = _run_ocr_tool(pdf, shadow=shadow)

    assert proc.returncode == 3, proc.stderr.decode("utf-8", "replace")[:800]
    stdout = proc.stdout.decode("utf-8")
    assert len(stdout.strip().splitlines()) == 1, f"stdout 只许有一行 JSON，实际：{stdout!r}"
    data = json.loads(stdout)
    assert data["ok"] is False
    assert data["missing"] == ["rapidocr_onnxruntime"]
    assert "rapidocr_onnxruntime" in data["error"]
    assert "rapidocr_onnxruntime" in data["detail"]
    # 缺包不是"没有标题/没有正文"：绝不能出现 pages
    assert "pages" not in data
    # 可诊断：错误里要有解释器路径（换机器 / 换 venv 时能直接定位）
    assert str(sys.executable) in data["error"] or "pip install" in data["error"]


def test_ocr_tool_fails_closed_when_pymupdf_missing(tmp_path):
    """缺 pymupdf：同一条 fail-closed 通道，missing 指名 pymupdf。

    rapidocr 用一个**成功可导入的桩**顶掉（只定义 RapidOCR 类），这样这条用例
    不依赖本机 ONNX Runtime 的导入开销/可用性——它要证明的是"缺 pymupdf 会被
    指名报出来"，不是"真引擎能跑"（真引擎证据在 A/ 的独立脚本里）。
    """
    shadow = _shadow_package(
        tmp_path / "shadow-fitz", "fitz",
        "pymupdf deliberately unavailable (test shadow)")
    (shadow / "rapidocr_onnxruntime.py").write_text(
        "class RapidOCR:\n"
        "    def __call__(self, *args, **kwargs):\n"
        "        return [], None\n",
        encoding="utf-8",
    )
    pdf = _write_pdf(tmp_path / "probe.pdf")

    proc = _run_ocr_tool(pdf, shadow=shadow)

    assert proc.returncode == 3, proc.stderr.decode("utf-8", "replace")[:800]
    data = json.loads(proc.stdout.decode("utf-8"))
    assert data["ok"] is False
    assert data["missing"] == ["pymupdf"]
    assert "pymupdf" in data["error"]
    assert "rapidocr_onnxruntime" not in data["missing"]
    assert "pages" not in data


# ---------------------------------------------------------------- 兜底块 provenance
_FAKE_TOOL_SOURCE = (
    "import os, sys\n"
    "sys.stdout.write(os.environ['FAKE_OCR_PAYLOAD'])\n"
)


def _install_fake_tool(tmp_path: Path, payload: dict) -> Path:
    tool = tmp_path / "fake_ocr_titles.py"
    tool.write_text(_FAKE_TOOL_SOURCE, encoding="utf-8")
    return tool


def _use_fake_tool(monkeypatch, tmp_path: Path, payload: dict) -> Path:
    tool = _install_fake_tool(tmp_path, payload)
    monkeypatch.setattr(pdf_reader, "_OCR_TOOL", tool)
    monkeypatch.setenv("RESUME_CONVERSION_OCR_PYTHON", sys.executable)
    monkeypatch.setenv("FAKE_OCR_PAYLOAD", json.dumps(payload, ensure_ascii=False))
    return tool


def test_ocr_page_blocks_are_tagged_ocr_and_keep_geometry(tmp_path, monkeypatch):
    """整页 OCR 兜底：块 provenance='ocr'，location page/bbox 保留，绝不冒充 native。"""
    pdf = _write_pdf(tmp_path / "scan.pdf")
    payload = {
        "ok": True,
        "dpi": 200,
        "pages": [{
            "page": 1,
            "lines": [
                {"text": "SYNTHETIC OCR LINE", "height": 18.0,
                 "bbox_pdf": [10.0, 20.0, 110.0, 38.0]},
                {"text": "SECOND LINE", "height": 18.0,
                 "bbox_pdf": [12.5, 40.0, 90.0, 58.0]},
                # 坏 bbox（不是 4 个数）必须被丢弃，不能编坐标
                {"text": "MALFORMED BBOX", "height": 18.0, "bbox_pdf": [1.0, 2.0, 3.0]},
                # 空文本行同样丢弃
                {"text": "   ", "height": 18.0, "bbox_pdf": [0.0, 0.0, 1.0, 1.0]},
            ],
        }],
    }
    _use_fake_tool(monkeypatch, tmp_path, payload)

    blocks, note = pdf_reader._ocr_page_blocks(pdf, [1])

    assert note == "", note
    assert [block["text"] for block in blocks] == ["SYNTHETIC OCR LINE", "SECOND LINE"]
    assert {block["provenance"] for block in blocks} == {"ocr"}
    assert all(block["provenance"] != "native_text" for block in blocks), (
        "OCR 是机器认字，绝不能冒充原生文本")
    for block in blocks:
        assert block["kind"] == "paragraph"
        assert block["location"]["page"] == 1
        assert len(block["location"]["bbox"]) == 4
    assert blocks[0]["location"]["bbox"] == [10.0, 20.0, 110.0, 38.0]
    assert blocks[1]["location"]["bbox"] == [12.5, 40.0, 90.0, 58.0]


def test_ocr_page_blocks_empty_result_is_reported_not_silent(tmp_path, monkeypatch):
    """OCR 跑通了但没字：必须是 ('', 'ocr_no_text')，不是静默空列表。"""
    pdf = _write_pdf(tmp_path / "blank.pdf")
    _use_fake_tool(monkeypatch, tmp_path, {"ok": True, "dpi": 200,
                                           "pages": [{"page": 1, "lines": []}]})

    blocks, note = pdf_reader._ocr_page_blocks(pdf, [1])

    assert blocks == []
    assert note == "ocr_no_text"


def test_ocr_page_blocks_only_returns_requested_pages(tmp_path, monkeypatch):
    """只搬调用方要的页：多出来的页/不认识的页不得混进结果。"""
    pdf = _write_pdf(tmp_path / "two.pdf")
    payload = {
        "ok": True,
        "dpi": 200,
        "pages": [
            {"page": 1, "lines": [{"text": "PAGE ONE", "height": 12.0,
                                   "bbox_pdf": [0.0, 0.0, 50.0, 12.0]}]},
            {"page": 2, "lines": [{"text": "PAGE TWO", "height": 12.0,
                                   "bbox_pdf": [0.0, 0.0, 50.0, 12.0]}]},
        ],
    }
    _use_fake_tool(monkeypatch, tmp_path, payload)

    blocks, note = pdf_reader._ocr_page_blocks(pdf, [2])

    assert note == ""
    assert [block["text"] for block in blocks] == ["PAGE TWO"]
    assert [block["location"]["page"] for block in blocks] == [2]


def test_ocr_page_blocks_reports_tool_failure_as_note(tmp_path, monkeypatch):
    """OCR 工具退出码非 0：返回说明而不是假装没有字（fail-closed 的调用方一半）。"""
    pdf = _write_pdf(tmp_path / "fail.pdf")
    tool = tmp_path / "broken_ocr_titles.py"
    tool.write_text("import sys\nsys.stderr.write('boom')\nsys.exit(3)\n", encoding="utf-8")
    monkeypatch.setattr(pdf_reader, "_OCR_TOOL", tool)
    monkeypatch.setenv("RESUME_CONVERSION_OCR_PYTHON", sys.executable)

    blocks, note = pdf_reader._ocr_page_blocks(pdf, [1])

    assert blocks == []
    assert note.startswith("ocr_exit_3"), note
