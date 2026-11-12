"""人工转录的存取（B）：并存、历史不覆盖、当前采用可切换、按 sha+页查。"""

from __future__ import annotations

import copy

import pytest

from review import queue, transcription


def test_submit_keeps_machine_result_and_writes_human_result(in_review):
    conn = in_review["conn"]
    item_id = in_review["item_id"]
    before = queue.get_item(item_id, conn=conn)

    result = queue.submit_correction(
        item_id,
        2,
        "合成测试第 2 页：人工读到的示例正文（非真实简历）。",
        in_review["reviewer_a"],
        conn=conn,
    )
    after = queue.get_item(item_id, conn=conn)

    # 并存：机器摘要一个字节没变，人工结果另存一份
    assert after["machine_result"] == before["machine_result"]
    assert after["status"] == "CORRECTED"
    assert after["closed_at"] is None
    assert "unread_visual_page" in after["issue_codes"], "原始 issue 不得因为人工补正而消失"

    block = after["human_result"]["human_read"]
    assert block["schema"] == "human_read/v1"
    assert len(block["transcriptions"]) == 1
    record = block["transcriptions"][0]
    assert record["page_no"] == 2
    assert record["actor"] == in_review["reviewer_a"]
    assert record["source"] == "human_read"
    assert record["sha256"] == in_review["sha"]
    assert block["adopted"]["2"] == record["transcription_id"]
    assert result["transcription"]["transcription_id"] == record["transcription_id"]


def test_multiple_transcriptions_same_page_keep_history_and_can_switch(corrected):
    conn = corrected["conn"]
    item_id = corrected["item_id"]

    queue.submit_correction(
        item_id, 2, "复核员乙读到的第 2 页。", corrected["reviewer_b"], conn=conn
    )
    listing = queue.list_transcriptions(item_id, conn=conn)
    assert len(listing["records"]) == 2, "同页第二份转录必须保留第一份"
    by_text = {record["text"]: record for record in listing["records"]}
    assert set(by_text) == {"合成测试第 2 页：人工转录的示例正文。", "复核员乙读到的第 2 页。"}
    assert listing["current"][0]["text"] == "复核员乙读到的第 2 页。"
    assert listing["summary"]["pages"] == [2]

    first = by_text["合成测试第 2 页：人工转录的示例正文。"]
    switched = queue.adopt_transcription(
        item_id, first["transcription_id"], corrected["reviewer_a"], conn=conn
    )
    assert switched["current_pages"] == [2]
    listing = queue.list_transcriptions(item_id, conn=conn)
    assert len(listing["records"]) == 2, "切换采用不得删除另一份"
    assert listing["current"][0]["transcription_id"] == first["transcription_id"]
    assert listing["records"][0]["transcription_id"] != listing["records"][1]["transcription_id"]


def test_find_by_sha_and_page(corrected):
    conn = corrected["conn"]
    rows = transcription.find(conn, corrected["sha"], 2)
    assert len(rows) == 1
    assert rows[0]["item_id"] == corrected["item_id"]
    assert rows[0]["item_status"] == "CORRECTED"
    assert rows[0]["adopted"] is True
    assert rows[0]["page_no"] == 2

    assert transcription.find(conn, corrected["sha"], 1) == []
    assert transcription.find(conn, "0" * 64) == []


def test_submit_rejected_before_claim(enqueued):
    with pytest.raises(queue.Conflict) as excinfo:
        queue.submit_correction(
            enqueued["item_id"], 2, "还没认领就录入", enqueued["reviewer_a"], conn=enqueued["conn"]
        )
    assert excinfo.value.code == "QUEUE_NOT_IN_REVIEW"


def test_submit_rejects_blank_text(in_review):
    with pytest.raises(transcription.TranscriptionError) as excinfo:
        queue.submit_correction(
            in_review["item_id"], 2, "   \n  ", in_review["reviewer_a"], conn=in_review["conn"]
        )
    assert excinfo.value.code == "TEXT_EMPTY"


def test_submit_rejects_bad_page_no(in_review):
    with pytest.raises(transcription.TranscriptionError) as excinfo:
        queue.submit_correction(
            in_review["item_id"], 0, "第零页不存在", in_review["reviewer_a"], conn=in_review["conn"]
        )
    assert excinfo.value.code == "PAGE_NO_OUT_OF_RANGE"


def test_append_preserves_other_human_result_keys():
    """human_result 里别的工具写的键必须原样保留（并存不只对机器结果成立）。"""
    human_result = {
        "note": "既有的人工备注",
        "corrected_fields": {"work_experience": "present"},
        "human_read": {"schema": "human_read/v1", "transcriptions": [], "adopted": {}},
    }
    new_human, record = transcription.append_to_human_result(
        human_result,
        sha256="a" * 64,
        page_no=3,
        text="合成测试第 3 页转录。",
        actor="11111111-1111-4111-8111-000000000101",
    )
    assert new_human["note"] == "既有的人工备注"
    assert new_human["corrected_fields"] == {"work_experience": "present"}
    assert len(new_human["human_read"]["transcriptions"]) == 1
    assert transcription.current_for_page(new_human, 3)["text"] == "合成测试第 3 页转录。"
    assert record["source"] == "human_read"


def test_current_requires_adoption_pointer():
    new_human, record = transcription.append_to_human_result(
        None,
        sha256="b" * 64,
        page_no=1,
        text="只记录不采用。",
        actor="11111111-1111-4111-8111-000000000101",
        adopt=False,
    )
    assert transcription.records(new_human)[0]["transcription_id"] == record["transcription_id"]
    with pytest.raises(transcription.TranscriptionError) as excinfo:
        transcription.current_records(new_human)
    assert excinfo.value.code == "CURRENT_TRANSCRIPTION_UNSET"


def test_adopt_does_not_mutate_input():
    human_result, record = transcription.append_to_human_result(
        None,
        sha256="c" * 64,
        page_no=1,
        text="原始转录。",
        actor="11111111-1111-4111-8111-000000000101",
    )
    snapshot = copy.deepcopy(human_result)
    adopted = transcription.adopt_in_human_result(
        human_result,
        transcription_id=record["transcription_id"],
        actor="11111111-1111-4111-8111-000000000102",
    )
    assert human_result == snapshot
    assert adopted["human_read"]["adopted"]["1"] == record["transcription_id"]


def test_validate_record_rejects_wrong_source():
    with pytest.raises(transcription.TranscriptionError) as excinfo:
        transcription.validate_record(
            {
                "transcription_id": "11111111-1111-4111-8111-000000000001",
                "sha256": "d" * 64,
                "page_no": 1,
                "text": "x",
                "actor": "11111111-1111-4111-8111-000000000101",
                "created_at": "2026-11-13T00:00:00+00:00",
                "source": "ocr",
            }
        )
    assert excinfo.value.code == "RECORD_BAD_SOURCE"
