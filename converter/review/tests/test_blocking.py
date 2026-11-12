"""阻断判据（D）：未处理必须非空，处理后必须为空，且能说明为什么。"""

from __future__ import annotations

import uuid

import pytest

from review import blocking, queue


def _gate(conn, subject):
    return conn.execute(
        """
        select gate, blocking, open_items, human_verdict
          from recruitment.v_source_gate
         where tenant_id = %s and source_sha256 = %s
        """,
        (subject["tenant"], subject["sha"]),
    ).fetchone()


def test_unresolved_queue_blocks_and_matches_source_gate(enqueued):
    conn = enqueued["conn"]
    reasons = blocking.screening_blocked(enqueued["application"], conn=conn)

    assert reasons, "队列项未处理时 screening_blocked 必须非空"
    assert reasons[0]["code"] == "REVIEW_PENDING"
    assert reasons[0]["item_id"] == enqueued["item_id"]
    assert reasons[0]["deadline"] is not None, "阻断原因必须带 deadline（HUM-04 要靠它升级）"
    assert reasons[0]["overdue"] is False
    assert "待核" in reasons[0]["message"]

    report = blocking.evaluate(enqueued["application"], conn=conn)
    assert report["blocked"] is True
    assert report["subject_type"] == "APPLICATION"
    assert report["sources"][0]["verdict"] == "PENDING_REVIEW"
    assert report["sources"][0]["latest_run_status"] == "QUARANTINED"

    gate = _gate(conn, enqueued)
    assert gate["gate"] == "PENDING_REVIEW"
    assert gate["blocking"] is True


def test_approved_queue_releases_and_matches_source_gate(corrected):
    conn = corrected["conn"]
    queue.approve(
        corrected["item_id"],
        corrected["reviewer_b"],
        "复核：与原件逐页对照，放行",
        conn=conn,
    )

    reasons = blocking.screening_blocked(corrected["application"], conn=conn)
    assert reasons == [], "处理完之后必须放行（空列表）"

    report = blocking.evaluate(corrected["application"], conn=conn)
    assert report["blocked"] is False
    assert report["sources"][0]["verdict"] == "CLEARED"
    assert report["sources"][0]["human_verdict"] == "APPROVED"

    gate = _gate(conn, corrected)
    assert gate["gate"] == "CLEARED"
    assert gate["blocking"] is False


def test_corrected_still_blocks_by_default_but_policy_can_release(corrected):
    """默认与 0003 的 v_review_open 一致：CORRECTED 不是终态，仍阻断。

    任务书字面口径（APPROVED/CORRECTED 即放行）用 open_states 显式切换；
    代码默认不替使用者选口径，但两种行为都有断言。
    """
    conn = corrected["conn"]
    strict = blocking.screening_blocked(corrected["application"], conn=conn)
    assert [reason["code"] for reason in strict] == ["CORRECTION_AWAITING_APPROVAL"]
    assert strict[0]["status"] == "CORRECTED"

    lenient = blocking.screening_blocked(
        corrected["application"], conn=conn, open_states=("QUEUED", "IN_REVIEW")
    )
    assert lenient == []


def test_run_without_queue_item_blocks_fail_closed(subject):
    reasons = blocking.screening_blocked(subject["application"], conn=subject["conn"])
    assert [reason["code"] for reason in reasons] == ["QUEUE_ITEM_MISSING"]
    assert reasons[0]["run_id"] == subject["run_id"]


def test_latest_accepted_run_clears_older_failure(subject, make_run, build_result):
    """重跑成功（新 run ACCEPTED）后放行；旧 run 的漏记由 v_conversion_ledger 报 ⑤。

    这是本模块与 0003 视图一致的边界：阻断看「当前最新一次转换 + 任一未结案条目」，
    历史漏记不重复阻断，否则永远无法放行。
    """
    conn = subject["conn"]
    clean = build_result(subject["sha"])
    clean.update({"completeness": "complete", "issues": [], "needs_visual": False})
    make_run(
        subject["tenant"],
        subject["sha"],
        status="ACCEPTED",
        completeness="complete",
        needs_visual=False,
        issues=(),
        result=clean,
    )
    reasons = blocking.screening_blocked(subject["application"], conn=conn)
    assert reasons == []
    ledger = conn.execute(
        "select accounting from recruitment.v_conversion_ledger where run_id = %s",
        (subject["run_id"],),
    ).fetchone()
    assert ledger["accounting"] == "MISSING_QUEUE_ITEM", "旧失败仍要被 ⑤ 看见"


def test_any_unresolved_item_blocks_even_after_newer_accepted_run(subject, make_run, build_result):
    """「任一 conversion_run 上有未结案条目」优先于最新 run 的状态。"""
    conn = subject["conn"]
    old_item = queue.enqueue(
        subject["run_id"],
        "第一次失败，先入队（合成测试）",
        actor=subject["system_actor"],
        conn=conn,
    )
    clean = build_result(subject["sha"])
    clean.update({"completeness": "complete", "issues": [], "needs_visual": False})
    make_run(
        subject["tenant"],
        subject["sha"],
        status="ACCEPTED",
        completeness="complete",
        needs_visual=False,
        issues=(),
        result=clean,
    )
    reasons = blocking.screening_blocked(subject["application"], conn=conn)
    assert [reason["item_id"] for reason in reasons] == [old_item]
    assert reasons[0]["code"] == "REVIEW_PENDING"


def test_rejected_verdict_releases_auto_screening_but_is_not_approved(in_review):
    conn = in_review["conn"]
    queue.reject(
        in_review["item_id"],
        in_review["reviewer_b"],
        "原件损坏，无法读取（合成测试）",
        conn=conn,
    )
    report = blocking.evaluate(in_review["application"], conn=conn)
    assert report["blocked"] is False
    assert report["sources"][0]["verdict"] == "REJECTED"
    assert report["sources"][0]["human_verdict"] == "REJECTED"


def test_unknown_subject_raises(conn):
    with pytest.raises(blocking.SubjectNotFound):
        blocking.screening_blocked(str(uuid.uuid4()), conn=conn)


def test_candidate_without_source_blocks(conn):
    tenant = str(uuid.uuid4())
    candidate = str(uuid.uuid4())
    conn.execute(
        "insert into recruitment.organization (id, name) values (%s, %s)",
        (tenant, "合成测试租户-无来源"),
    )
    conn.execute(
        "insert into recruitment.candidate (id, tenant_id, display_name) values (%s, %s, %s)",
        (candidate, tenant, "合成测试候选人-无简历"),
    )
    reasons = blocking.screening_blocked(candidate, conn=conn)
    assert [reason["code"] for reason in reasons] == ["NO_SOURCE_RECORD"]


def test_source_without_conversion_run_blocks(conn):
    """有简历原件 sha256 但从未转换：没有证据，宁可待核（fail closed）。"""
    tenant = str(uuid.uuid4())
    department = str(uuid.uuid4())
    candidate = str(uuid.uuid4())
    event = str(uuid.uuid4())
    record = str(uuid.uuid4())
    asset = str(uuid.uuid4())
    resume = str(uuid.uuid4())
    sha = uuid.uuid4().hex + uuid.uuid4().hex
    conn.execute(
        "insert into recruitment.organization (id, name) values (%s, %s)",
        (tenant, "合成测试租户-未转换"),
    )
    conn.execute(
        "insert into recruitment.department (id, tenant_id, name) values (%s, %s, %s)",
        (department, tenant, "合成部门"),
    )
    conn.execute(
        "insert into recruitment.candidate (id, tenant_id, display_name) values (%s, %s, %s)",
        (candidate, tenant, "合成测试候选人-未转换"),
    )
    conn.execute(
        """
        insert into recruitment.event_inbox
          (event_id, tenant_id, provider, event_type, idempotency_key, trust_level, payload)
        values (%s, %s, 'internal', 'test.synthetic', %s, 'INTERNAL', '{}'::jsonb)
        """,
        (event, tenant, f"test:{event}"),
    )
    conn.execute(
        "insert into recruitment.intake_record (id, tenant_id, event_id) values (%s, %s, %s)",
        (record, tenant, event),
    )
    conn.execute(
        """
        insert into recruitment.intake_asset
          (id, tenant_id, intake_record_id, file_name, byte_size, sha256, storage_ref)
        values (%s, %s, %s, 'synthetic-unconverted.pdf', 1024, %s, 'test://synthetic/x.pdf')
        """,
        (asset, tenant, record, sha),
    )
    conn.execute(
        "insert into recruitment.resume (id, tenant_id, candidate_id, intake_asset_id) values (%s, %s, %s, %s)",
        (resume, tenant, candidate, asset),
    )
    reasons = blocking.screening_blocked(candidate, conn=conn)
    assert [reason["code"] for reason in reasons] == ["NO_CONVERSION_RUN"]
    assert reasons[0]["sha256"] == sha
