"""端到端验收脚本（自跑，真实输出）：doc 12 §2④ 的「入队 → 补正 → 阻断 → 放行」。

用法（在 ``converter/`` 目录下，库里已跑过 0001→0002→0003）::

    set PGHOST=127.0.0.1
    set PGUSER=postgres
    set PGPASSWORD=******
    set PGDATABASE=ra_review_check
    python -m review.demo_acceptance

脚本只写 ``ra_review_check``；所有对象与正文都是**合成测试数据**（不是真实简历）。
每次运行用新的 UUID 前缀，因此可以在同一个库上重复跑。
"""

from __future__ import annotations

import hashlib
import json
import uuid

import psycopg
from psycopg.types.json import Jsonb

from . import blocking, merge_human, queue


def _uuid() -> str:
    return str(uuid.uuid4())


def _sha() -> str:
    return uuid.uuid4().hex + uuid.uuid4().hex


def _canonical(value) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()[:16]


def _banner(step: str, title: str) -> None:
    print()
    print("=" * 78)
    print(f"{step}  {title}")
    print("=" * 78)


def _print_blocking(label: str, report: dict) -> None:
    print(f"\n[{label}] blocked = {report['blocked']}")
    for reason in report["reasons"]:
        print(
            f"  - {reason['code']}: {reason['message']}"
            f"  (item={reason['item_id']}, deadline={reason['deadline']}, overdue={reason['overdue']})"
        )
    if not report["reasons"]:
        print("  (none)")
    for source in report["sources"]:
        print(
            f"  source {source['sha256'][:16]}…: latest_run={source['latest_run_status']}, "
            f"verdict={source['verdict']}, human_verdict={source['human_verdict']}"
        )


def _machine_result(sha: str) -> dict:
    return {
        "text": "合成测试第 1 页文本（非真实简历）。",
        "blocks": [
            {
                "kind": "paragraph",
                "text": "合成测试第 1 页文本（非真实简历）。",
                "location": {"page": 1, "bbox": [10.0, 20.0, 200.0, 40.0]},
                "links": [],
                "provenance": "native_text",
            }
        ],
        "title": "合成测试材料（非真实简历）",
        "chars": 18,
        "completeness": "partial",
        "issues": [
            {
                "code": "unread_visual_page",
                "message": "第 2 页几乎是图像，文本层没有可读内容",
                "location": {"page": 2, "bbox": None},
            }
        ],
        "needs_visual": True,
        "warnings": [],
        "meta": {"pages": 2, "source_sha256": sha, "backend": "demo-test"},
        "links": [],
        "fields": {
            "name": {"state": "present", "value": "示例"},
            "phone": {"state": "unreadable", "reason": "unread_visual_page"},
        },
        "protected_attributes": {},
        "screening": {"eligible_fields": ["name"], "blocked_fields": ["phone"]},
    }


def seed(conn) -> dict:
    """建一套合成对象并落一个 QUARANTINED run（提交）。"""
    ids = {
        "tenant": _uuid(),
        "department": _uuid(),
        "system_actor": _uuid(),
        "reviewer_a": _uuid(),
        "reviewer_b": _uuid(),
        "job": _uuid(),
        "job_version": _uuid(),
        "candidate": _uuid(),
        "event": _uuid(),
        "intake_record": _uuid(),
        "intake_asset": _uuid(),
        "resume": _uuid(),
        "resume_version": _uuid(),
        "application": _uuid(),
        "sha": _sha(),
    }
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute(
                "insert into recruitment.organization (id, name) values (%s, %s)",
                (ids["tenant"], "合成验收租户（DEMO ONLY / 非真实数据）"),
            )
            cur.execute(
                "insert into recruitment.department (id, tenant_id, name) values (%s, %s, %s)",
                (ids["department"], ids["tenant"], "合成验收部门"),
            )
            cur.execute(
                """
                insert into recruitment.actor (id, tenant_id, kind, display_name, department_id)
                values
                  (%s, %s, 'SYSTEM', '合成-转换器（系统）', %s),
                  (%s, %s, 'HUMAN',  '合成-复核员甲', %s),
                  (%s, %s, 'HUMAN',  '合成-复核员乙', %s)
                """,
                (
                    ids["system_actor"], ids["tenant"], ids["department"],
                    ids["reviewer_a"], ids["tenant"], ids["department"],
                    ids["reviewer_b"], ids["tenant"], ids["department"],
                ),
            )
            cur.execute(
                """
                insert into recruitment.job (id, tenant_id, department_id, code, title, status)
                values (%s, %s, %s, %s, '合成验收岗位', 'OPEN')
                """,
                (ids["job"], ids["tenant"], ids["department"], f"DEMO-{ids['job'][:8]}"),
            )
            cur.execute(
                """
                insert into recruitment.job_version
                  (id, tenant_id, job_id, version_no, description_md, payload_hash, created_by_actor_id)
                values (%s, %s, %s, 1, '合成验收 JD（非真实招聘信息）', %s, %s)
                """,
                (ids["job_version"], ids["tenant"], ids["job"], _sha(), ids["reviewer_a"]),
            )
            cur.execute(
                "insert into recruitment.candidate (id, tenant_id, display_name) values (%s, %s, %s)",
                (ids["candidate"], ids["tenant"], "合成验收候选人（非真实）"),
            )
            cur.execute(
                """
                insert into recruitment.event_inbox
                  (event_id, tenant_id, provider, event_type, idempotency_key, trust_level, payload)
                values (%s, %s, 'internal', 'demo.synthetic', %s, 'INTERNAL', '{}'::jsonb)
                """,
                (ids["event"], ids["tenant"], f"demo:{ids['event']}"),
            )
            cur.execute(
                "insert into recruitment.intake_record (id, tenant_id, event_id) values (%s, %s, %s)",
                (ids["intake_record"], ids["tenant"], ids["event"]),
            )
            cur.execute(
                """
                insert into recruitment.intake_asset
                  (id, tenant_id, intake_record_id, file_name, mime_type, byte_size,
                   sha256, storage_ref, validation_status)
                values (%s, %s, %s, 'synthetic-demo.pdf', 'application/pdf', 2048,
                        %s, 'test://synthetic/demo.pdf', 'VALID')
                """,
                (ids["intake_asset"], ids["tenant"], ids["intake_record"], ids["sha"]),
            )
            cur.execute(
                "insert into recruitment.resume (id, tenant_id, candidate_id, intake_asset_id) "
                "values (%s, %s, %s, %s)",
                (ids["resume"], ids["tenant"], ids["candidate"], ids["intake_asset"]),
            )
            cur.execute(
                """
                insert into recruitment.resume_version
                  (id, tenant_id, resume_id, version_no, source_asset_sha256, content_sha256,
                   parser_name, parser_version, parse_status)
                values (%s, %s, %s, 1, %s, %s, 'demo-parser', '1.0', 'PARTIAL')
                """,
                (ids["resume_version"], ids["tenant"], ids["resume"], ids["sha"], _sha()),
            )
            cur.execute(
                """
                insert into recruitment.application
                  (id, tenant_id, candidate_id, job_id, job_version_id, resume_version_id)
                values (%s, %s, %s, %s, %s, %s)
                """,
                (
                    ids["application"], ids["tenant"], ids["candidate"],
                    ids["job"], ids["job_version"], ids["resume_version"],
                ),
            )
            ids["run_id"] = _uuid()
            cur.execute(
                """
                insert into recruitment.conversion_run
                  (id, tenant_id, source_sha256, source_name, converter_version,
                   status, completeness, needs_visual, issue_codes, pages, blocks,
                   elapsed_ms, started_at, finished_at, recorded_at, result_json)
                values
                  (%s, %s, %s, 'synthetic-demo.pdf', 'pymupdf/1.28.0+layout',
                   'QUARANTINED', 'partial', true, array['unread_visual_page'], 2, 1,
                   1500, now() - interval '2 minutes', now() - interval '1 minute',
                   clock_timestamp(), %s)
                """,
                (ids["run_id"], ids["tenant"], ids["sha"], Jsonb(_machine_result(ids["sha"]))),
            )
    return ids


def _gate(conn, ids) -> dict:
    return conn.execute(
        """
        select gate, blocking, open_items, human_verdict
          from recruitment.v_source_gate
         where tenant_id = %s and source_sha256 = %s
        """,
        (ids["tenant"], ids["sha"]),
    ).fetchone()


def main() -> int:
    conn = queue.connect()
    try:
        _banner("0", "环境")
        env = conn.execute(
            "select current_database() as db, current_setting('server_version') as pg, "
            "current_user as usr"
        ).fetchone()
        print(
            f"database={env['db']}  pg={env['pg']}  user={env['usr']}  "
            f"tables={[conn.execute('select to_regclass(%s) as t', (t,)).fetchone()['t'] for t in ['recruitment.conversion_run', 'recruitment.review_queue', 'recruitment.review_audit']]}"
        )
        assert env["db"] == "ra_review_check", "只允许在 ra_review_check 上跑验收"

        ids = seed(conn)
        print(f"subject application={ids['application']}")
        print(f"run={ids['run_id']}  sha256={ids['sha']}  (QUARANTINED)")

        _banner("1", "阻断验证（入队前）：失败没有被看见 → fail closed")
        report0 = blocking.evaluate(ids["application"], conn=conn)
        _print_blocking("before enqueue", report0)
        assert report0["blocked"] is True
        assert [r["code"] for r in report0["reasons"]] == ["QUEUE_ITEM_MISSING"]
        gate0 = _gate(conn, ids)
        print(f"v_source_gate: {dict(gate0)}")

        _banner("2", "入队：QUEUED + deadline + 自动审计")
        item_id = queue.enqueue(
            ids["run_id"],
            "机器判定：第 2 页纯图像未读（unread_visual_page）",
            actor=ids["system_actor"],
            conn=conn,
        )
        item = queue.get_item(item_id, conn=conn)
        print(f"item_id={item_id}")
        print(
            f"status={item['status']}  deadline={item['deadline']}  "
            f"opened_at={item['opened_at']}  assignee={item['assignee']}"
        )
        print("audit:", [(a["from_status"], a["to_status"], a["actor_name"]) for a in queue.list_audit(item_id, conn=conn)])
        assert item["status"] == "QUEUED"

        report1 = blocking.evaluate(ids["application"], conn=conn)
        _print_blocking("QUEUED（未处理）", report1)
        assert report1["blocked"] is True
        assert report1["reasons"][0]["code"] == "REVIEW_PENDING"

        _banner("3", "认领：QUEUED → IN_REVIEW")
        claimed = queue.claim(item_id, ids["reviewer_a"], actor=ids["reviewer_a"], conn=conn)
        print(f"status={claimed['status']}  assignee={claimed['assignee']}")
        report2 = blocking.evaluate(ids["application"], conn=conn)
        _print_blocking("IN_REVIEW（未处理）", report2)
        assert report2["blocked"] is True

        _banner("4", "人工逐页转录：IN_REVIEW → CORRECTED（并存，不覆盖机器结果）")
        machine_before = queue.get_item(item_id, conn=conn)["machine_result"]
        result = queue.submit_correction(
            item_id,
            2,
            "合成测试第 2 页：人工读到的示例正文（不是真实简历内容）。",
            ids["reviewer_a"],
            conn=conn,
        )
        machine_after = queue.get_item(item_id, conn=conn)["machine_result"]
        print(f"status={result['status']}")
        print(f"transcription_id={result['transcription']['transcription_id']}")
        print(
            f"machine_result sha(16) before={_canonical(machine_before)} "
            f"after={_canonical(machine_after)}  equal={machine_before == machine_after}"
        )
        print("machine_result:", json.dumps(machine_after, ensure_ascii=False, sort_keys=True))
        listing = queue.list_transcriptions(item_id, conn=conn)
        print("human_result summary:", json.dumps(listing["summary"], ensure_ascii=False))
        print(
            "human_result transcription:",
            json.dumps(listing["current"][0], ensure_ascii=False, sort_keys=True),
        )
        assert machine_before == machine_after, "机器结果不得被人工结果覆盖"
        assert "unread_visual_page" in queue.get_item(item_id, conn=conn)["issue_codes"]

        report3 = blocking.evaluate(ids["application"], conn=conn)
        _print_blocking("CORRECTED（默认口径：等待复核）", report3)
        assert report3["blocked"] is True
        assert report3["reasons"][0]["code"] == "CORRECTION_AWAITING_APPROVAL"
        lenient = blocking.screening_blocked(
            ids["application"], conn=conn, open_states=("QUEUED", "IN_REVIEW")
        )
        print(f"\n[任务书字面口径 open_states=(QUEUED,IN_REVIEW)] reasons = {lenient}")
        assert lenient == []

        _banner("5", "回填：人工转录合并进转换器输出（只追加、不覆盖原生 block）")
        merged = merge_human.merge_for_item(item_id, conn=conn, merged_by=ids["reviewer_b"])
        print(f"blocks: {len(merged['blocks'])} (native {merged['human_read_merge']['native_blocks']})")
        print("native block[0]:", json.dumps(merged["blocks"][0], ensure_ascii=False, sort_keys=True))
        print("human block[-1]:", json.dumps(merged["blocks"][-1], ensure_ascii=False, sort_keys=True))
        print("human_read_applied:", json.dumps(merged["human_read_applied"], ensure_ascii=False))
        print("completeness:", merged["completeness"], "(机器值保持不变)")
        print("text (native only, unchanged):", repr(merged["text"]))
        print("text_with_human_read:", repr(merged["text_with_human_read"]))
        print("text_native_only:", merged["text_native_only"])
        print("issues:", [issue["code"] for issue in merged["issues"]])
        print("issue_resolutions:", json.dumps(merged["issue_resolutions"], ensure_ascii=False))
        assert len(merged["blocks"]) == 2
        assert merged["blocks"][-1]["provenance"] == "human_read"
        assert merged["blocks"][-1]["location"] == {"page": 2, "bbox": None}
        assert merged["blocks"][0] == _machine_result(ids["sha"])["blocks"][0]
        assert merged["text"] == _machine_result(ids["sha"])["text"]
        assert merged["text_native_only"] is True

        _banner("6", "复核放行：CORRECTED → APPROVED，阻断解除")
        approved = queue.approve(
            item_id,
            ids["reviewer_b"],
            "复核：逐页与原件对照，人工转录与原文一致，放行（合成测试）",
            conn=conn,
        )
        print(f"status={approved['status']}  closed_at={approved['closed_at']}")
        report4 = blocking.evaluate(ids["application"], conn=conn)
        _print_blocking("APPROVED（已处理）", report4)
        assert report4["blocked"] is False and report4["reasons"] == []
        gate1 = _gate(conn, ids)
        print(f"v_source_gate: {dict(gate1)}")
        assert gate1["gate"] == "CLEARED" and gate1["blocking"] is False

        print("\naudit trail:")
        for row in queue.list_audit(item_id, conn=conn):
            print(
                f"  #{row['audit_seq']} {row['from_status'] or '(入队)'} → {row['to_status']}  "
                f"by {row['actor_name']}  reason={row['reason']}"
            )

        _banner("7", "负例：绕过本模块直接写库，0003 必须拒绝")
        ids2 = seed(conn)
        item2 = queue.enqueue(
            ids2["run_id"], "负例：跳过认领直接放行（合成测试）", actor=ids2["system_actor"], conn=conn
        )
        for label, actor, sql in [
            (
                "QUEUED → APPROVED（跳过 IN_REVIEW）",
                ids2["reviewer_a"],
                "update recruitment.review_queue set status='APPROVED', reason='跳过认领' where id=%s",
            ),
            (
                "IN_REVIEW → CORRECTED（缺 human_result）",
                ids2["reviewer_a"],
                "update recruitment.review_queue set status='CORRECTED', reason='只改状态' where id=%s",
            ),
        ]:
            if label.startswith("IN_REVIEW"):
                queue.claim(item2, ids2["reviewer_a"], conn=conn)
            try:
                with conn.transaction():
                    conn.execute("select set_config('recruitment.actor_id', %s, true)", (actor,))
                    conn.execute(sql, (item2,))
            except psycopg.errors.CheckViolation as exc:
                print(f"[REJECTED] {label}")
                print(f"  sqlstate={exc.sqlstate}  message={exc.diag.message_primary}")
            else:
                raise AssertionError(f"{label} 没有被拒绝")
        print("[OK] 两条负例都被数据库拒绝，未留下状态变更")
        print("audit trail (负例条目):")
        for row in queue.list_audit(item2, conn=conn):
            print(f"  #{row['audit_seq']} {row['from_status'] or '(入队)'} → {row['to_status']}  by {row['actor_name']}")

        _banner("8", "结论")
        print("入队 → 认领 → 人工转录 → 合并 → 放行：全链路通过")
        print("阻断对比：QUEUED/IN_REVIEW/CORRECTED 非空；APPROVED 空")
        print("并存证明：machine_result 哈希前后一致，human_result 另存一份")
        conn.commit()
        return 0
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())

