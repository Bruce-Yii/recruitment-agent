"""Tests for step B: the injected model call and its failure contract."""
from __future__ import annotations

import pytest

from fallback import model_reader
from helpers import StubModel

GOOD_TEXT = "SYNTHETIC FALLBACK DEMO PAGE\nALPHA BRAVO CHARLIE DELTA"


def test_read_page_returns_a_candidate(png_file):
    stub = StubModel(GOOD_TEXT, model_id="stub/reader")
    read = model_reader.read_page(png_file, 1, model_call=stub)
    assert read["page"] == 1
    assert read["text"] == GOOD_TEXT
    assert read["source"] == "MODEL"
    assert read["model"] == "stub/reader"
    assert read["confidence"] is None, "confidence must never be invented"
    assert read["answer"] == "TEXT"
    assert read["chars"] == len(GOOD_TEXT)
    assert len(read["prompt_sha256"]) == 64
    assert read["png_sha256"] == model_reader._sha256_of_file(png_file)
    # the model really received the fixed prompt and the image path
    prompt, image_path = stub.calls[0]
    assert image_path == str(png_file)
    assert "第 1 页" in prompt
    assert "逐字转录" in prompt


def test_prompt_file_is_fixed_and_strict():
    raw = model_reader.PROMPT_PATH.read_text(encoding="utf-8")
    assert model_reader.PAGE_PLACEHOLDER in raw
    for needle in ("逐字转录", "□", "不翻译", "不总结", "不补全", "不推断",
                   "保留原始换行与顺序", "表格", "不要提到你自己", "不得猜"):
        assert needle in raw, f"prompt is missing {needle!r}"
    built = model_reader.build_prompt(7, raw)
    assert "{{" not in built
    assert "第 7 页" in built


def test_model_unavailable_on_exception(png_file):
    stub = StubModel(raises=RuntimeError("QUOTA: Insufficient Balance"))
    with pytest.raises(model_reader.ModelUnavailable) as excinfo:
        model_reader.read_page(png_file, 1, model_call=stub)
    err = excinfo.value
    assert err.code == "model_quota"
    assert err.retryable is False
    assert "Insufficient Balance" in err.message
    assert err.as_dict()["cause_type"] == "RuntimeError"


def test_model_unavailable_on_timeout_is_retryable(png_file):
    stub = StubModel(raises=TimeoutError("read timed out"))
    with pytest.raises(model_reader.ModelUnavailable) as excinfo:
        model_reader.read_page(png_file, 1, model_call=stub)
    assert excinfo.value.code == "model_timeout"
    assert excinfo.value.retryable is True


def test_model_unavailable_on_none(png_file):
    stub = StubModel(None)
    with pytest.raises(model_reader.ModelUnavailable) as excinfo:
        model_reader.read_page(png_file, 1, model_call=stub)
    assert excinfo.value.code == "model_returned_none"


def test_model_unavailable_on_non_string(png_file):
    stub = StubModel({"text": "sneaky"})
    with pytest.raises(model_reader.ModelUnavailable) as excinfo:
        model_reader.read_page(png_file, 1, model_call=stub)
    assert excinfo.value.code == "model_bad_return_type"


def test_empty_answer_is_not_unavailable(png_file):
    stub = StubModel("")
    read = model_reader.read_page(png_file, 1, model_call=stub)
    assert read["text"] == ""
    assert read["answer"] == "EMPTY"  # the verifier is what rejects it
    from fallback import verify_model_text as vmt
    verdict = vmt.verify(read, native_text=None, page=1, is_image_page=True)
    assert verdict["ok"] is False
    assert "EMPTY_TEXT" in verdict["codes"]


def test_png_missing_raises_input_error(tmp_path):
    with pytest.raises(model_reader.InputError) as excinfo:
        model_reader.read_page(tmp_path / "nope.png", 1, model_call=StubModel("x"))
    assert excinfo.value.code == "png_missing"


def test_model_call_must_be_callable(png_file):
    with pytest.raises(model_reader.InputError) as excinfo:
        model_reader.read_page(png_file, 1, model_call="not-callable")
    assert excinfo.value.code == "model_call_not_callable"


def test_model_id_falls_back_to_callable_attribute(png_file):
    stub = StubModel(GOOD_TEXT, model_id="stub/from-attribute")
    read = model_reader.read_page(png_file, 1, model_call=stub)
    assert read["model"] == "stub/from-attribute"
    read2 = model_reader.read_page(png_file, 1, model_call=stub, model_id="explicit/id")
    assert read2["model"] == "explicit/id"


def test_test_double_flag_propagates(png_file):
    stub = StubModel(GOOD_TEXT, test_double=True)
    assert model_reader.read_page(png_file, 1, model_call=stub)["test_double"] is True
    real_like = StubModel(GOOD_TEXT, test_double=False)
    assert model_reader.read_page(png_file, 1, model_call=real_like)["test_double"] is False


def test_missing_prompt_is_an_input_error(png_file, monkeypatch, tmp_path):
    monkeypatch.setattr(model_reader, "PROMPT_PATH", tmp_path / "no-prompt.md")
    with pytest.raises(model_reader.InputError) as excinfo:
        model_reader.read_page(png_file, 1, model_call=StubModel("x"))
    assert excinfo.value.code == "prompt_missing"
