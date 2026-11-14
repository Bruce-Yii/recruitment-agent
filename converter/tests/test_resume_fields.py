"""Recruitment fields: tri-state (7), attribution (8), timeline (9), protected (11)."""
from __future__ import annotations

import re

import pytest

from conftest import field_states, hard_codes
from src import resume_fields as rf

STATES = {"present", "absent", "unreadable"}
FIELDS = ("name", "phone", "email", "work_experience", "education")


def _block(text, page, bbox, kind="paragraph", level=None):
    block = {"kind": kind, "text": text,
             "location": {"page": page, "bbox": list(bbox)},
             "links": [], "provenance": "native_text"}
    if level:
        block["level"] = level
    return block


def _resume_blocks(lines, *, page=1, x=40, width=250, top=80, step=20):
    """A heading '工作经历' plus one line per entry, each on its own visual row."""
    blocks = [_block("工作经历", page, (x, top, x + 60, top + 12), kind="heading", level=2)]
    y = top + step
    for line in lines:
        blocks.append(_block(line, page, (x, y, x + width, y + 12)))
        y += step
    return blocks


def _analyze(blocks, **kwargs):
    return rf.analyze(blocks, page_info=kwargs.pop("page_info", [{"page": 1, "images": 0}]),
                      page_count=1, source_sha256="0" * 64,
                      issues_before=kwargs.pop("issues_before", []), **kwargs)


# ---------------------------------------------------------------- item 7
def test_tri_state_complete(corpus_results):
    problems = []
    for row, result in corpus_results:
        fields = result.get("fields") or {}
        if set(fields) != set(FIELDS):
            problems.append((row["id"], "fields", sorted(fields)))
            continue
        for key, field in fields.items():
            if field.get("state") not in STATES:
                problems.append((row["id"], key, "state", field.get("state")))
            for required in ("state", "value", "evidence", "provenance", "reason"):
                if required not in field:
                    problems.append((row["id"], key, "missing", required))
            if field["state"] != "present" and field.get("value") is not None:
                problems.append((row["id"], key, "value on non-present"))
    assert not problems, problems[:10]


# 这些 code 说明"有内容没读出来"——此时任何 absent 都不成立。
CONTENT_UNREAD = {"pdf_no_text", "unread_visual_page", "pdf_text_encoding_unread",
                  "encrypted_pdf", "reader_failed", "reader_timeout",
                  "pdf_damaged_repaired", "pdf_layout_unread"}


def test_absent_only_when_document_fully_read(corpus_results):
    """Red line: 'unreadable' must never be downgraded to 'absent'."""
    problems = []
    for row, result in corpus_results:
        states = field_states(result)
        if "absent" not in states.values():
            continue
        unread = CONTENT_UNREAD & set(hard_codes(result))
        if unread:
            problems.append((row["id"], "absent with unread content", sorted(unread)))
        if "structure_unidentified" in hard_codes(result):
            # 结构不明时经历类字段必须 unreadable（文本类字段仍可断言缺失）
            for key in ("work_experience", "education"):
                if states.get(key) == "absent":
                    problems.append((row["id"], key, "absent with unidentified structure"))
        order_warn = any(w.startswith("pdf_reading_order_soft")
                         for w in result.get("warnings") or [])
        if order_warn and (states.get("work_experience") == "absent"
                           or states.get("education") == "absent"):
            problems.append((row["id"], "absent with unverified order"))
    assert not problems, problems[:10]


def test_unreadable_never_carries_absence_claim(corpus_results):
    """An unreadable field must explain itself and carry no value."""
    problems = []
    for row, result in corpus_results:
        for key, field in (result.get("fields") or {}).items():
            if field["state"] != "unreadable":
                continue
            if not field.get("reason"):
                problems.append((row["id"], key, "no reason"))
            if field.get("value") is not None:
                problems.append((row["id"], key, "value on unreadable"))
    assert not problems, problems[:10]


def test_screening_never_uses_unreadable(corpus_results):
    problems = []
    for row, result in corpus_results:
        screening = result.get("screening") or {}
        states = field_states(result)
        expected = {k for k, v in states.items() if v == "present"}
        if set(screening.get("eligible_fields") or []) != expected:
            problems.append((row["id"], "eligible", screening.get("eligible_fields"), expected))
        blocked = {b["field"] for b in screening.get("blocked_fields") or []}
        if blocked != {k for k, v in states.items() if v != "present"}:
            problems.append((row["id"], "blocked", blocked))
    assert not problems, problems[:10]


def test_identity_merge_rules(corpus_results):
    """§9.7: only native_text + format-validated identity fields may auto-merge."""
    problems = []
    for row, result in corpus_results:
        screening = result.get("screening") or {}
        for key in screening.get("identity_merge_eligible") or []:
            field = result["fields"][key]
            if field["provenance"] != "native_text" or field["state"] != "present":
                problems.append((row["id"], key, field["provenance"], field["state"]))
        for item in screening.get("identity_manual_review") or []:
            if item["field"] not in ("name", "phone", "email"):
                problems.append((row["id"], "bad manual field", item))
    assert not problems, problems[:10]


# ---------------------------------------------------------------- item 8
def test_entries_pair_within_one_visual_row():
    """Two rows, each 'company + dates': facts must stay inside their own row."""
    blocks = [
        _block("工作经历", 1, (40, 60, 120, 72), kind="heading", level=2),
        _block("甲公司", 1, (40, 100, 160, 112)),
        _block("2020.07-2021.06", 1, (420, 100, 540, 112)),
        _block("乙公司", 1, (40, 140, 160, 152)),
        _block("2021.07-2023.06", 1, (420, 140, 540, 152)),
    ]
    analysis = _analyze(blocks)
    entries = analysis["fields"]["work_experience"]["entries"]
    assert len(entries) == 2, entries
    assert entries[0]["dates"][0]["raw"] == "2020.07-2021.06"
    assert entries[1]["dates"][0]["raw"] == "2021.07-2023.06"
    for entry in entries:
        pages = {ev["page"] for ev in entry["header_blocks"]}
        assert pages == {entry["page"]}
        # 同一行的两个块 y 区间必须重叠（这正是"同行"的定义）
        ys = [(ev["bbox"][1], ev["bbox"][3]) for ev in entry["header_blocks"]]
        assert max(y0 for y0, _ in ys) < min(y1 for _, y1 in ys)
    codes = [i["code"] for i in analysis["issues"]]
    assert "resume_experience_cross_block" not in codes, codes


def test_isolated_date_row_is_reported_not_assembled():
    """A date row with no adjacent organisation must not be joined to another row."""
    blocks = [
        _block("工作经历", 1, (40, 60, 120, 72), kind="heading", level=2),
        _block("甲公司", 1, (40, 100, 160, 112)),
        _block("2020.07-2021.06", 1, (420, 600, 540, 612)),
    ]
    analysis = _analyze(blocks)
    codes = [i["code"] for i in analysis["issues"]]
    assert "resume_experience_cross_block" in codes, codes
    entry = analysis["fields"]["work_experience"]["entries"][0]
    assert entry["company"] is None and entry["title"] is None
    assert entry["attribution"] == "isolated_row"


def test_no_entry_mixes_pages_or_rows(corpus_results):
    problems = []
    checked = 0
    for row, result in corpus_results:
        for key in ("work_experience", "education"):
            for entry in (result["fields"][key].get("entries") or []):
                checked += 1
                pages = {ev["page"] for ev in entry["header_blocks"]}
                if pages != {entry["page"]}:
                    problems.append((row["id"], key, entry["index"], "pages", pages))
                if entry["company"] is not None and entry["company"] not in entry["header_text"]:
                    problems.append((row["id"], key, entry["index"], "company not in header"))
                ys = [(ev["bbox"][1], ev["bbox"][3]) for ev in entry["header_blocks"]]
                if len(ys) > 1:
                    assert max(y0 for y0, _ in ys) < min(y1 for _, y1 in ys)
    assert checked > 100, checked
    assert not problems, problems[:10]


# ---------------------------------------------------------------- item 9
def test_timeline_clean_when_contiguous():
    blocks = _resume_blocks(["甲公司 工程师 2020.07-2021.06",
                             "乙公司 架构师 2021.07-2023.06"])
    analysis = _analyze(blocks)
    codes = [i["code"] for i in analysis["issues"]]
    assert "resume_timeline_gap" not in codes, codes
    assert "resume_timeline_overlap" not in codes, codes
    assert analysis["timeline"]["intervals"] == 2
    assert analysis["timeline"]["covered_months_closed"] == 36


def test_timeline_gap_exposed():
    blocks = _resume_blocks(["甲公司 工程师 2020.07-2021.06",
                             "乙公司 架构师 2022.07-2023.06"])
    analysis = _analyze(blocks)
    gaps = [i for i in analysis["issues"] if i["code"] == "resume_timeline_gap"]
    assert len(gaps) == 1, analysis["issues"]
    assert "12 month" in gaps[0]["message"]


def test_timeline_overlap_exposed():
    blocks = _resume_blocks(["甲公司 工程师 2020.07-2022.06",
                             "乙公司 架构师 2021.07-2023.06"])
    analysis = _analyze(blocks)
    overlaps = [i for i in analysis["issues"] if i["code"] == "resume_timeline_overlap"]
    assert len(overlaps) == 1, analysis["issues"]


def test_timeline_inversion_exposed():
    blocks = _resume_blocks(["甲公司 工程师 2023.06-2020.07"])
    analysis = _analyze(blocks)
    codes = [i["code"] for i in analysis["issues"]]
    assert "resume_timeline_inversion" in codes, codes


def test_timeline_never_repairs_raw_dates(corpus_results):
    """§9.4: intervals are reported verbatim; nothing is padded or guessed."""
    problems = []
    checked = 0
    for row, result in corpus_results:
        for entry in (result["fields"]["work_experience"].get("entries") or []):
            for date in entry.get("dates") or []:
                checked += 1
                if date["raw"] not in entry["header_text"]:
                    problems.append((row["id"], date["raw"]))
    assert checked > 50, checked
    assert not problems, problems[:10]


def test_open_ended_not_converted_to_months():
    blocks = _resume_blocks(["甲公司 工程师 2020.07-至今"])
    analysis = _analyze(blocks)
    assert analysis["timeline"]["open_ended_intervals"] == 1
    assert analysis["timeline"]["covered_months_closed"] == 0


# ---------------------------------------------------------------- item 11
def test_protected_never_in_fields(corpus_results):
    problems = []
    for row, result in corpus_results:
        fields = result.get("fields") or {}
        protected = result.get("protected_attributes") or {}
        if set(protected) != set(rf.PROTECTED_ATTRS):
            problems.append((row["id"], "protected keys", sorted(protected)))
        for key in protected:
            if key in fields:
                problems.append((row["id"], "protected leaked into fields", key))
        for key, item in protected.items():
            if not item.get("screening_excluded"):
                problems.append((row["id"], "not excluded", key))
        for key in result["screening"]["protected_excluded"]:
            if key not in protected:
                problems.append((row["id"], "unknown excluded attr", key))
    assert not problems, problems[:10]


def test_protected_detected_with_evidence():
    blocks = [_block("张三", 1, (40, 40, 80, 64), kind="heading", level=1),
              _block("男│2003 年│西安某学院·本科", 1, (40, 70, 400, 84)),
              _block("邮箱：a@b.com 电话：13800138000", 1, (40, 100, 400, 112))]
    analysis = _analyze(blocks)
    protected = analysis["protected_attributes"]
    assert protected["gender"]["state"] == "present"
    assert protected["age_or_birth"]["state"] == "present"
    for item in (protected["gender"], protected["age_or_birth"]):
        assert item["evidence"] and item["evidence"][0]["page"] == 1
    codes = [i["code"] for i in analysis["issues"]]
    assert "resume_protected_attribute_present" in codes


def test_gender_word_does_not_fire_in_work_text():
    """「男装」「女装」是经历描述，不是受保护属性。"""
    blocks = [_block("工作经历", 1, (40, 60, 120, 72), kind="heading", level=2),
              _block("甲公司 男装设计师 2020.07-2021.06", 1, (40, 90, 300, 102))]
    analysis = _analyze(blocks)
    assert analysis["protected_attributes"]["gender"]["state"] == "absent"


def test_photo_never_claimed_as_identified():
    blocks = [_block("张三", 1, (40, 40, 80, 64), kind="heading", level=1)]
    analysis = _analyze(blocks, page_info=[{"page": 1, "images": 1}])
    photo = analysis["protected_attributes"]["photo"]
    assert photo["state"] == "unverified"
    assert "portrait" in photo["reason"] or "geometry" in photo["reason"]


# ------------------------------------------------ item 12（D-67 / IR-F4 来源闸门）
def _block_with_provenance(text, page, bbox, provenance, kind="paragraph", level=None):
    """造块：``provenance=None`` 表示块上**没有** provenance 键（fail-closed 用例）。"""
    block = _block(text, page, bbox, kind=kind, level=level)
    if provenance is None:
        block.pop("provenance", None)
    else:
        block["provenance"] = provenance
    return block


def _identity_blocks(provenance, *, phone=True, email=True, name=True):
    """身份字段块（合成文本，无真实个人资料）。"""
    blocks = []
    if name:
        blocks.append(_block_with_provenance("姓名：张某", 1, (40, 40, 200, 60), provenance))
    parts = []
    if phone:
        parts.append("电话：138 0000 1234")
    if email:
        parts.append("邮箱：zhang.example@example.test")
    if parts:
        blocks.append(_block_with_provenance("  ".join(parts), 1, (40, 80, 520, 100), provenance))
    return blocks


def test_ocr_block_identity_fields_are_ocr_not_native_text():
    """D-67：整页 OCR 重读的块抽出的身份字段必须标 `ocr`，绝不冒充 `native_text`。

    这条守的是「把 OCR 认出来的号码当原生强标识 → 自动把材料挂错人」的入口。
    """
    blocks = _identity_blocks("ocr")
    analysis = _analyze(blocks, issues_before=[{"code": "pdf_text_recovered_by_ocr"}])
    fields = analysis["fields"]
    assert fields["phone"]["state"] == "present"
    assert fields["email"]["state"] == "present"
    assert fields["name"]["state"] == "present"
    assert fields["phone"]["provenance"] == "ocr"
    assert fields["email"]["provenance"] == "ocr"
    assert fields["name"]["provenance"] == "ocr"
    # 身份闸门（doc11 §9.7）：非 native_text 一个都不许进自动归并集合
    assert analysis["screening"]["identity_merge_eligible"] == []
    reasons = {item["field"]: item["reason"]
               for item in analysis["screening"]["identity_manual_review"]}
    assert reasons["phone"] == "provenance=ocr"
    assert reasons["email"] == "provenance=ocr"


def test_native_block_identity_fields_stay_auto_merge_eligible():
    """正例：原生文本块的 phone/email 仍然可以自动归并（不得把闸门做成全阻塞）。"""
    blocks = _identity_blocks("native_text")
    analysis = _analyze(blocks)
    fields = analysis["fields"]
    assert fields["phone"]["provenance"] == "native_text"
    assert fields["email"]["provenance"] == "native_text"
    assert set(analysis["screening"]["identity_merge_eligible"]) == {"phone", "email"}


def test_block_without_provenance_is_unknown_not_native_text():
    """缺失 provenance → `unknown`（fail-closed）；不得默认成 native_text 进入自动归并。"""
    blocks = _identity_blocks(None, email=False)
    analysis = _analyze(blocks)
    phone = analysis["fields"]["phone"]
    assert phone["state"] == "present"
    assert phone["provenance"] == "unknown"
    assert analysis["screening"]["identity_merge_eligible"] == []
    reasons = {item["field"]: item["reason"]
               for item in analysis["screening"]["identity_manual_review"]}
    assert reasons["phone"] == "provenance=unknown"


def test_mixed_native_and_ocr_sources_keep_only_native_eligible():
    """同一份简历：电话来自原生块、邮箱来自 OCR 块 → 只有 phone 可自动，email 只能人工。"""
    blocks = [
        _block_with_provenance("姓名：张某", 1, (40, 40, 200, 60), "native_text"),
        _block_with_provenance("电话：138 0000 1234", 1, (40, 80, 400, 100), "native_text"),
        _block_with_provenance("邮箱：zhang.example@example.test", 1, (40, 120, 520, 140), "ocr"),
    ]
    analysis = _analyze(blocks, issues_before=[{"code": "pdf_text_recovered_by_ocr"}])
    fields = analysis["fields"]
    assert fields["phone"]["provenance"] == "native_text"
    assert fields["email"]["provenance"] == "ocr"
    assert analysis["screening"]["identity_merge_eligible"] == ["phone"]
    reasons = {item["field"]: item["reason"]
               for item in analysis["screening"]["identity_manual_review"]}
    assert reasons["email"] == "provenance=ocr"
