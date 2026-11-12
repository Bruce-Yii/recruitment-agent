"""Tests for step D: the anti-hallucination checks.

Every check is exercised twice where it matters: the negative sample must be
rejected, and a normal reading of the same page must pass (no blanket refusal).
"""
from __future__ import annotations

import pytest

from fallback import verify_model_text as vmt
from helpers import model_block, native_block, read_stub, result_stub

NATIVE_ZH = "张三  13800001234  后端工程师  2020.07-2023.06  星河科技  北京"
NATIVE_EN = ("alpha bravo charlie delta echo foxtrot golf hotel india juliet "
             "kilo lima mike november papa")


def test_normal_reading_passes():
    verdict = vmt.verify(read_stub(NATIVE_ZH), native_text=NATIVE_ZH, page=1)
    assert verdict["ok"] is True, verdict["reasons"]
    assert verdict["codes"] == []
    assert verdict["stats"]["overlap"] == 1.0
    assert verdict["stats"]["native_chars"] == len(NATIVE_ZH)


def test_empty_text_rejected():
    verdict = vmt.verify(read_stub(""), page=1, is_image_page=True)
    assert verdict["ok"] is False
    assert "EMPTY_TEXT" in verdict["codes"]


def test_too_short_text_rejected():
    verdict = vmt.verify(read_stub("好的"), native_text=None, page=1, is_image_page=True)
    assert "TEXT_TOO_SHORT" in verdict["codes"]


def test_apology_is_meta_discourse():
    verdict = vmt.verify(read_stub("抱歉，这一页我看不清，请换一份清晰的文件。"),
                         page=1, is_image_page=True)
    assert verdict["ok"] is False
    assert "META_DISCOURSE" in verdict["codes"]
    assert any("道歉语" in r["message"] for r in verdict["reasons"])


def test_ai_self_reference_is_meta_discourse():
    verdict = vmt.verify(read_stub("作为AI，我不能处理这张图片，请见谅。"),
                         page=1, is_image_page=True)
    assert "META_DISCOURSE" in verdict["codes"]


def test_english_refusal_is_meta_discourse():
    verdict = vmt.verify(read_stub("I'm sorry, I cannot read this image."),
                         page=1, is_image_page=True)
    assert "META_DISCOURSE" in verdict["codes"]


def test_unrelated_chinese_text_rejected():
    verdict = vmt.verify(read_stub("今天天气很好，适合出门散步；这段文字与页面无关。"),
                         native_text=NATIVE_ZH, page=1)
    assert verdict["ok"] is False
    assert "NATIVE_OVERLAP_LOW" in verdict["codes"]
    assert verdict["stats"]["overlap"] == 0.0


def test_unrelated_english_words_rejected_even_when_letters_match():
    verdict = vmt.verify(
        read_stub("zulu yankee xray whiskey victor uniform tango sierra romeo quebec"),
        native_text=NATIVE_EN, page=1)
    assert verdict["ok"] is False
    # letters overlap, words do not: the token check is what catches this
    assert verdict["stats"]["overlap"] > 0.2
    assert verdict["stats"]["token_overlap"] == 0.0
    assert "NATIVE_TOKEN_OVERLAP_LOW" in verdict["codes"]


def test_bad_glyph_rejected():
    verdict = vmt.verify(read_stub("张三\ufffd电话(cid:12)"), native_text=None,
                         page=1, is_image_page=True)
    assert "BAD_GLYPH" in verdict["codes"]


def test_placeholder_heavy_rejected():
    verdict = vmt.verify(read_stub("□" * 20), page=1, is_image_page=True)
    assert verdict["ok"] is False
    assert "PLACEHOLDER_HEAVY" in verdict["codes"]


def test_a_few_placeholders_are_allowed():
    text = "张三  13800001234  后端工程□  2020.07-2023.06  星河科技"
    verdict = vmt.verify(read_stub(text), native_text=text, page=1)
    assert verdict["ok"] is True, verdict["reasons"]


def test_page_mismatch_rejected():
    verdict = vmt.verify(read_stub("SYNTHETIC TEXT FOR A PAGE", page=2), page=1)
    assert "PAGE_MISMATCH" in verdict["codes"]


def test_page_missing_rejected():
    read = read_stub("SYNTHETIC TEXT FOR A PAGE")
    read.pop("page")
    verdict = vmt.verify(read, page=1)
    assert "PAGE_MISSING" in verdict["codes"]


def test_source_not_model_rejected_for_image_page():
    verdict = vmt.verify(read_stub("SYNTHETIC TEXT FOR A PAGE", source="native_text"),
                         page=1, is_image_page=True)
    assert "SOURCE_NOT_MODEL" in verdict["codes"]


def test_native_text_smuggled_into_reading_rejected():
    read = read_stub("SYNTHETIC TEXT FOR A PAGE", native_text="native words here")
    verdict = vmt.verify(read, page=1, is_image_page=True)
    assert "NATIVE_MIXED" in verdict["codes"]


def test_code_fence_wrapper_rejected():
    verdict = vmt.verify(read_stub("```\nALPHA BRAVO CHARLIE\n```"),
                         native_text="ALPHA BRAVO CHARLIE", page=1)
    assert "OUTPUT_WRAPPED" in verdict["codes"]


def test_preamble_line_rejected():
    verdict = vmt.verify(read_stub("以下是转录内容：\nALPHA BRAVO CHARLIE DELTA"),
                         native_text="ALPHA BRAVO CHARLIE DELTA", page=1)
    assert "OUTPUT_WRAPPED" in verdict["codes"]


def test_missing_model_id_rejected():
    read = read_stub("SYNTHETIC TEXT FOR A PAGE", model="")
    verdict = vmt.verify(read, page=1, is_image_page=True)
    assert "MODEL_ID_MISSING" in verdict["codes"]


def test_image_page_has_nothing_to_compare_and_says_so():
    verdict = vmt.verify(read_stub("SYNTHETIC TEXT FOR A PAGE"), native_text="",
                         page=1, is_image_page=True)
    assert verdict["ok"] is True
    assert verdict["stats"]["overlap"] is None
    assert "skipped" in verdict["stats"]["overlap_note"]
    assert "NATIVE_OVERLAP" in verdict["stats"]["checks"]


def test_too_long_text_rejected():
    verdict = vmt.verify(read_stub("A" * (vmt.MAX_CHARS + 1)), page=1, is_image_page=True)
    assert "TEXT_TOO_LONG" in verdict["codes"]


def test_non_string_text_rejected():
    verdict = vmt.verify({"page": 1, "text": 42, "source": "MODEL", "model": "m"}, page=1)
    assert "TEXT_NOT_STRING" in verdict["codes"]


def test_page_text_by_page_excludes_model_read_blocks():
    result = result_stub(blocks=[
        native_block("ALPHA BRAVO", page=1),
        native_block("CHARLIE DELTA", page=2),
        model_block("MODEL GUESS", page=1),
    ])
    pages = vmt.page_text_by_page(result)
    assert pages[1] == "ALPHA BRAVO"
    assert pages[2] == "CHARLIE DELTA"
    assert "MODEL GUESS" not in pages[1]


def test_char_and_token_overlap_helpers():
    words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet"
    assert vmt.char_overlap("alpha bravo", "alpha bravo") == 1.0
    assert vmt.char_overlap("alpha", "qqqq") == 0.0
    assert vmt.token_overlap(words, words) == 1.0
    assert vmt.token_overlap("alpha", "alpha") is None  # too few words -> not applicable
    assert vmt.placeholder_ratio("□□ab") == 0.5
