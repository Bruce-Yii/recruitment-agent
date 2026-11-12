"""负例：绕过本模块直接写库也必须被 0003 拦住（验收第 4 项）。"""

from __future__ import annotations

import psycopg
import pytest

from review import queue


def _expect_23514(conn, actor, sql, params):
    """在 savepoint 里跑一条非法 SQL，断言 SQLSTATE 23514 并返回错误文本。"""
    with pytest.raises(psycopg.errors.CheckViolation) as excinfo:
        with conn.transaction():
            conn.execute("select set_config('recruitment.actor_id', %s, true)", (actor,))
            conn.execute(sql, params)
    assert excinfo.value.sqlstate == "23514"
    return str(excinfo.value)


def test_db_rejects_queued_to_approved(enqueued):
    message = _expect_23514(
        enqueued["conn"],
        enqueued["reviewer_a"],
        "update recruitment.review_queue set status = 'APPROVED', reason = '跳过认领' "
        "where id = %s",
        (enqueued["item_id"],),
    )
    assert "QUEUE_ILLEGAL_TRANSITION" in message
    assert "QUEUED" in message and "APPROVED" in message


def test_db_rejects_corrected_without_human_result(in_review):
    message = _expect_23514(
        in_review["conn"],
        in_review["reviewer_a"],
        "update recruitment.review_queue set status = 'CORRECTED', reason = '只改状态不写结论' "
        "where id = %s",
        (in_review["item_id"],),
    )
    assert "QUEUE_CORRECTED_NEEDS_HUMAN_RESULT" in message


def test_db_forbids_overwriting_machine_result(in_review):
    message = _expect_23514(
        in_review["conn"],
        in_review["reviewer_a"],
        "update recruitment.review_queue set machine_result = '{\"run_status\": \"ACCEPTED\"}'::jsonb "
        "where id = %s",
        (in_review["item_id"],),
    )
    assert "QUEUE_IMMUTABLE" in message


def test_db_requires_actor(subject):
    """直接插入也必须带 SET LOCAL actor；没有 actor 的写入不允许发生（D-18）。"""
    with pytest.raises(psycopg.errors.CheckViolation) as excinfo:
        with subject["conn"].transaction():
            subject["conn"].execute(
                """
                insert into recruitment.review_queue (tenant_id, run_id, machine_result)
                values (%s, %s, '{"run_status": "QUARANTINED"}'::jsonb)
                """,
                (subject["tenant"], subject["run_id"]),
            )
    assert excinfo.value.sqlstate == "23514"
    assert "ACTOR_REQUIRED" in str(excinfo.value)


def test_db_rejects_deadline_shrink(in_review):
    message = _expect_23514(
        in_review["conn"],
        in_review["reviewer_a"],
        "update recruitment.review_queue set deadline = deadline - interval '1 hour' "
        "where id = %s",
        (in_review["item_id"],),
    )
    assert "QUEUE_DEADLINE_NOT_EXTENDED" in message


def test_db_audit_is_immutable(corrected):
    message = _expect_23514(
        corrected["conn"],
        corrected["reviewer_a"],
        "update recruitment.review_audit set reason = '篡改审计' where item_id = %s",
        (corrected["item_id"],),
    )
    assert "IMMUTABLE_COLUMN" in message


def test_db_forbids_deleting_queue_item(enqueued):
    message = _expect_23514(
        enqueued["conn"],
        enqueued["reviewer_a"],
        "delete from recruitment.review_queue where id = %s",
        (enqueued["item_id"],),
    )
    assert "DELETE_FORBIDDEN" in message


def test_approve_does_not_touch_machine_result(corrected):
    """放行前后机器摘要逐字节相同（HUM-05 的并存由库层保证）。"""
    conn = corrected["conn"]
    before = queue.get_item(corrected["item_id"], conn=conn)["machine_result"]
    queue.approve(corrected["item_id"], corrected["reviewer_b"], "复核通过，放行", conn=conn)
    after = queue.get_item(corrected["item_id"], conn=conn)
    assert after["machine_result"] == before
    assert after["status"] == "APPROVED"
    assert after["human_result"]["human_read"]["transcriptions"], "人工结果同样保留"

