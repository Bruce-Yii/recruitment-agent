"""队列状态机 / 审计 / deadline（A + ④ 的「谁、何时、为什么」）。"""

from __future__ import annotations

from datetime import datetime

import pytest

from review import queue


def test_enqueue_creates_queued_with_deadline_and_audit(subject):
    conn = subject["conn"]
    item_id = queue.enqueue(
        subject["run_id"],
        "机器判定：第 2 页纯图像未读（合成测试）",
        actor=subject["system_actor"],
        conn=conn,
    )
    item = queue.get_item(item_id, conn=conn)

    assert item["status"] == "QUEUED"
    assert item["assignee"] is None
    assert item["closed_at"] is None
    assert item["machine_result"]["run_status"] == "QUARANTINED"
    assert item["machine_result"]["issue_codes"] == ["unread_visual_page"]

    opened = datetime.fromisoformat(item["opened_at"])
    deadline = datetime.fromisoformat(item["deadline"])
    hours = (deadline - opened).total_seconds() / 3600
    assert 23.99 <= hours <= 24.01, f"deadline 不是 24h：{hours}"

    audit = queue.list_audit(item_id, conn=conn)
    assert len(audit) == 1
    assert audit[0]["from_status"] is None
    assert audit[0]["to_status"] == "QUEUED"
    assert audit[0]["actor"] == subject["system_actor"]
    assert audit[0]["reason"].startswith("机器判定")


def test_enqueue_rejects_accepted_run(subject, make_run, build_result):
    clean = build_result(subject["sha"])
    clean.update({"completeness": "complete", "issues": [], "needs_visual": False})
    accepted_run = make_run(
        subject["tenant"],
        subject["sha"],
        status="ACCEPTED",
        completeness="complete",
        needs_visual=False,
        issues=(),
        result=clean,
    )
    with pytest.raises(queue.Conflict) as excinfo:
        queue.enqueue(
            accepted_run,
            "想给 ACCEPTED 也入队",
            actor=subject["system_actor"],
            conn=subject["conn"],
        )
    assert excinfo.value.code == "QUEUE_ACCEPTED_RUN"


def test_enqueue_same_run_twice_rejected(enqueued):
    with pytest.raises(queue.Conflict) as excinfo:
        queue.enqueue(
            enqueued["run_id"],
            "重复入队",
            actor=enqueued["system_actor"],
            conn=enqueued["conn"],
        )
    assert excinfo.value.code == "QUEUE_ALREADY_EXISTS"


def test_enqueue_rejects_blank_reason(subject):
    with pytest.raises(queue.ValidationError) as excinfo:
        queue.enqueue(
            subject["run_id"], "   ", actor=subject["system_actor"], conn=subject["conn"]
        )
    assert excinfo.value.code == "REASON_REQUIRED"


def test_claim_sets_assignee_and_writes_audit(enqueued):
    conn = enqueued["conn"]
    row = queue.claim(
        enqueued["item_id"], enqueued["reviewer_a"], actor=enqueued["reviewer_a"], conn=conn
    )
    assert row["status"] == "IN_REVIEW"
    assert row["assignee"] == enqueued["reviewer_a"]

    audit = queue.list_audit(enqueued["item_id"], conn=conn)
    assert [(a["from_status"], a["to_status"]) for a in audit] == [
        (None, "QUEUED"),
        ("QUEUED", "IN_REVIEW"),
    ]
    assert audit[-1]["actor"] == enqueued["reviewer_a"]


def test_claim_twice_rejected(in_review):
    with pytest.raises(queue.IllegalTransition) as excinfo:
        queue.claim(in_review["item_id"], in_review["reviewer_b"], conn=in_review["conn"])
    assert excinfo.value.code == "QUEUE_ILLEGAL_TRANSITION"
    assert "IN_REVIEW" in excinfo.value.message


def test_approve_directly_from_queued_rejected(enqueued):
    with pytest.raises(queue.IllegalTransition) as excinfo:
        queue.approve(
            enqueued["item_id"],
            enqueued["reviewer_a"],
            "跳过认领直接放行",
            conn=enqueued["conn"],
        )
    assert excinfo.value.code == "QUEUE_ILLEGAL_TRANSITION"
    assert "QUEUED" in excinfo.value.message


def test_approve_requires_reason(in_review):
    with pytest.raises(queue.ValidationError) as excinfo:
        queue.approve(in_review["item_id"], in_review["reviewer_a"], "  ", conn=in_review["conn"])
    assert excinfo.value.code == "REASON_REQUIRED"


def test_approve_rejects_reusing_previous_reason(corrected):
    conn = corrected["conn"]
    item = queue.get_item(corrected["item_id"], conn=conn)
    with pytest.raises(queue.Conflict) as excinfo:
        queue.approve(
            corrected["item_id"], corrected["reviewer_b"], item["reason"], conn=conn
        )
    assert excinfo.value.code == "QUEUE_REASON_REQUIRED"

    row = queue.approve(
        corrected["item_id"],
        corrected["reviewer_b"],
        "复核：与原件逐页对照，补正与原文一致，放行",
        conn=conn,
    )
    assert row["status"] == "APPROVED"
    assert row["closed_at"] is not None


def test_approve_after_corrected_keeps_full_audit_chain(corrected):
    conn = corrected["conn"]
    queue.approve(
        corrected["item_id"],
        corrected["reviewer_b"],
        "复核：与原件逐页对照，放行",
        conn=conn,
    )
    audit = queue.list_audit(corrected["item_id"], conn=conn)
    assert [(a["from_status"], a["to_status"]) for a in audit] == [
        (None, "QUEUED"),
        ("QUEUED", "IN_REVIEW"),
        ("IN_REVIEW", "CORRECTED"),
        ("CORRECTED", "APPROVED"),
    ]
    assert [a["actor"] for a in audit] == [
        corrected["system_actor"],
        corrected["reviewer_a"],
        corrected["reviewer_a"],
        corrected["reviewer_b"],
    ]
    assert [a["audit_seq"] for a in audit] == sorted(a["audit_seq"] for a in audit)


def test_reject_flow(in_review):
    conn = in_review["conn"]
    row = queue.reject(
        in_review["item_id"],
        in_review["reviewer_b"],
        "原件损坏，无法读取（合成测试）",
        conn=conn,
    )
    assert row["status"] == "REJECTED"
    assert row["closed_at"] is not None
    audit = queue.list_audit(in_review["item_id"], conn=conn)
    assert audit[-1]["to_status"] == "REJECTED"
    assert "原件损坏" in audit[-1]["reason"]


def test_list_pending_reports_deadline_and_overdue(enqueued):
    conn = enqueued["conn"]
    rows = queue.list_pending(tenant_id=enqueued["tenant"], conn=conn)
    assert [row["item_id"] for row in rows] == [enqueued["item_id"]]
    assert rows[0]["deadline"] is not None
    assert rows[0]["overdue"] is False
    assert queue.list_pending(tenant_id=enqueued["tenant"], overdue_only=True, conn=conn) == []

    queue.claim(enqueued["item_id"], enqueued["reviewer_a"], conn=conn)
    rows = queue.list_pending(tenant_id=enqueued["tenant"], conn=conn)
    assert rows[0]["status"] == "IN_REVIEW"
    assert rows[0]["assignee"] == enqueued["reviewer_a"]


def test_audit_is_written_even_for_content_edits(corrected):
    """改 human_result / 换采用也是 UPDATE，触发器同样留痕（from=to）。"""
    conn = corrected["conn"]
    records = queue.list_transcriptions(corrected["item_id"], conn=conn)["records"]
    queue.adopt_transcription(
        corrected["item_id"], records[0]["transcription_id"], corrected["reviewer_b"], conn=conn
    )
    audit = queue.list_audit(corrected["item_id"], conn=conn)
    assert (audit[-1]["from_status"], audit[-1]["to_status"]) == ("CORRECTED", "CORRECTED")
    assert audit[-1]["actor"] == corrected["reviewer_b"]
    assert "切换采用转录" in audit[-1]["reason"]


def test_missing_item_is_not_found(conn):
    import uuid

    with pytest.raises(queue.NotFound) as excinfo:
        queue.get_item(str(uuid.uuid4()), conn=conn)
    assert excinfo.value.code == "ITEM_NOT_FOUND"


def test_db_error_is_surfaced_with_code_and_sqlstate(corrected):
    """应用层错误带 code + sqlstate，便于上层区分「状态机拒绝」和「连接失败」。"""
    conn = corrected["conn"]
    item = queue.get_item(corrected["item_id"], conn=conn)
    with pytest.raises(queue.Conflict) as excinfo:
        queue.approve(corrected["item_id"], corrected["reviewer_b"], item["reason"], conn=conn)
    assert excinfo.value.sqlstate == "23514"
    assert excinfo.value.code == "QUEUE_REASON_REQUIRED"
