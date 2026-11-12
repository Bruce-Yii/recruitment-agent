"""人工结果并入转换器输出（C）：只追加、不覆盖、可追溯、幂等。"""

from __future__ import annotations

import copy

import pytest

from review import merge_human, queue, transcription


def test_merge_appends_human_block_without_touching_native(corrected):
    conn = corrected["conn"]
    item_id = corrected["item_id"]
    machine_before = queue.get_item(item_id, conn=conn)["result_json"]
    native_blocks = copy.deepcopy(machine_before["blocks"])

    merged = merge_human.merge_for_item(item_id, conn=conn, merged_by=corrected["reviewer_b"])

    assert merged["blocks"][: len(native_blocks)] == native_blocks, "原生 block 必须逐字段保持原样"
    human = merged["blocks"][-1]
    assert human["provenance"] == "human_read"
    assert human["kind"] == "paragraph"
    assert human["location"] == {"page": 2, "bbox": None}, "人工读的是整页，不伪造 bbox"
    assert human["text"] == "合成测试第 2 页：人工转录的示例正文。"

    assert merged["completeness"] == "partial", "机器判定不得被人工合并悄悄升级"
    assert merged["needs_visual"] is True
    assert len(merged["human_read_applied"]) == 1
    entry = merged["human_read_applied"][0]
    assert entry["page"] == 2
    assert entry["source"] == "human_read"
    assert entry["applied"] is True
    assert entry["chars"] == len(human["text"])
    assert entry["block_index"] == len(merged["blocks"]) - 1
    assert merged["human_read_merge"]["item_id"] == item_id
    assert merged["human_read_merge"]["native_blocks"] == len(native_blocks)
    assert merged["human_read_merge"]["human_blocks"] == 1
    # 与 fallback/merge.py 同口径：text 一字不改，人工文本另走带 provenance 的通道
    assert merged["text"] == machine_before["text"]
    assert merged["chars"] == machine_before["chars"]
    assert merged["text_native_only"] is True
    assert "人工转录的示例正文" in merged["text_with_human_read"]
    assert "human_read_applied: page 2" in merged["warnings"][-1]

    # 机器原文仍然在库里，一个字节没变（并存，不是覆盖）
    assert queue.get_item(item_id, conn=conn)["result_json"] == machine_before


def test_merge_keeps_original_issue_and_marks_resolution(corrected):
    merged = merge_human.merge_for_item(
        corrected["item_id"], conn=corrected["conn"], merged_by=corrected["reviewer_b"]
    )
    assert [issue["code"] for issue in merged["issues"]] == ["unread_visual_page"]
    resolutions = merged["issue_resolutions"]
    assert len(resolutions) == 1
    assert resolutions[0]["code"] == "unread_visual_page"
    assert resolutions[0]["page"] == 2
    assert resolutions[0]["status"] == "resolved_by_human"
    assert resolutions[0]["basis"] == "human_transcribed_page"
    assert resolutions[0]["transcription_id"] == merged["human_read_applied"][0]["transcription_id"]


def test_merge_is_idempotent(corrected):
    conn = corrected["conn"]
    merged = merge_human.merge_for_item(corrected["item_id"], conn=conn, merged_by=corrected["reviewer_b"])
    human_result = queue.get_item(corrected["item_id"], conn=conn)["human_result"]
    current = transcription.current_records(human_result)

    again = merge_human.merge(merged, current, item_id=corrected["item_id"])
    assert len(again["blocks"]) == len(merged["blocks"]), "重复合并不许堆出重复 block"
    assert len(again["human_read_applied"]) == 1
    assert again["human_read_merge"]["skipped_already_applied"] == [
        merged["human_read_applied"][0]["transcription_id"]
    ]
    assert again["human_read_skipped"] == [
        {
            "transcription_id": merged["human_read_applied"][0]["transcription_id"],
            "page": 2,
            "reason": "ALREADY_APPLIED",
        }
    ]


def test_merge_does_not_mutate_input(subject, build_result):
    record = transcription.make_record(
        sha256=subject["sha"],
        page_no=2,
        text="合成测试第 2 页转录。",
        actor=subject["reviewer_a"],
    )
    result = build_result(subject["sha"])
    snapshot = copy.deepcopy(result)

    merged = merge_human.merge(result, [record], item_id=None)
    assert result == snapshot, "merge 必须返回新对象，不得改入参"
    assert merged is not result
    assert merged["blocks"] is not result["blocks"]


def test_merge_rejects_two_versions_of_same_page(subject, build_result):
    records = [
        transcription.make_record(
            sha256=subject["sha"], page_no=2, text="版本甲", actor=subject["reviewer_a"]
        ),
        transcription.make_record(
            sha256=subject["sha"], page_no=2, text="版本乙", actor=subject["reviewer_b"]
        ),
    ]
    with pytest.raises(merge_human.MergeError) as excinfo:
        merge_human.merge(build_result(subject["sha"]), records)
    assert excinfo.value.code == "DUPLICATE_PAGE_TRANSCRIPTION"


def test_merge_rejects_sha_mismatch(subject, build_result):
    record = transcription.make_record(
        sha256="e" * 64, page_no=2, text="不属于这份文件", actor=subject["reviewer_a"]
    )
    with pytest.raises(merge_human.MergeError) as excinfo:
        merge_human.merge(build_result(subject["sha"]), [record])
    assert excinfo.value.code == "SHA256_MISMATCH"


def test_merge_requires_human_correction(enqueued):
    with pytest.raises(queue.Conflict) as excinfo:
        merge_human.merge_for_item(enqueued["item_id"], conn=enqueued["conn"])
    assert excinfo.value.code == "QUEUE_NOT_CORRECTED"


def test_merge_after_approve_still_available(corrected):
    conn = corrected["conn"]
    queue.approve(
        corrected["item_id"], corrected["reviewer_b"], "复核通过，放行", conn=conn
    )
    merged = merge_human.merge_for_item(corrected["item_id"], conn=conn, merged_by=corrected["reviewer_b"])
    assert merged["human_read_merge"]["human_blocks"] == 1
    assert merged["completeness"] == "partial"
