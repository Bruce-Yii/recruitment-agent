"""测试夹具：只连自建库 ``ra_review_check``，每个用例一个回滚事务。

为什么不用 DELETE 清场：0003/0001 的 ``fn_block_delete`` 禁止物理删除历史，
清场只能靠回滚事务。这样每个用例看到的是干净的一张表，也不会在库里堆垃圾。
"""

from __future__ import annotations

import os
import uuid

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from review import queue

EXPECTED_DB = "ra_review_check"


def new_uuid() -> str:
    return str(uuid.uuid4())


def new_sha() -> str:
    return uuid.uuid4().hex + uuid.uuid4().hex


def _dsn() -> str:
    return os.environ.get("REVIEW_TEST_DSN", "")


@pytest.fixture(scope="session")
def dsn() -> str:
    dsn = _dsn()
    try:
        conn = psycopg.connect(dsn)
    except psycopg.OperationalError as exc:  # pragma: no cover - 环境问题，直接失败不跳过
        pytest.fail(
            f"连不上 PostgreSQL（dsn={dsn!r}）：{exc}\n"
            "本测试要求 D:\\12412\\PostgreSQL 17 在跑，且 REVIEW_TEST_DSN / PGHOST / "
            "PGUSER / PGPASSWORD / PGDATABASE 指向 ra_review_check。"
        )
    try:
        with conn.cursor() as cur:
            db = cur.execute("select current_database()").fetchone()[0]
            ok = cur.execute(
                "select to_regclass('recruitment.review_queue') is not null"
            ).fetchone()[0]
        if db != EXPECTED_DB:
            pytest.fail(f"测试只允许跑在 {EXPECTED_DB}，当前连的是 {db!r}（任务边界：不碰其它库）")
        if not ok:
            pytest.fail(
                "ra_review_check 里没有 0003 的表；先跑 "
                "0001_init.sql → 0002_seed.sql → 0003_review_queue.sql"
            )
    finally:
        conn.close()
    return dsn


@pytest.fixture()
def conn(dsn):
    connection = psycopg.connect(dsn, autocommit=False, row_factory=dict_row)
    with connection.transaction(force_rollback=True):
        yield connection
    connection.close()


def machine_result(sha: str) -> dict:
    """合成转换器输出：两页，第 1 页有字，第 2 页是纯图像（HUM-01 的注入样本）。

    全部是「合成测试文本」，不含任何真实简历内容（R7）。
    """
    return {
        "text": "合成测试第 1 页文本。",
        "blocks": [
            {
                "kind": "paragraph",
                "text": "合成测试第 1 页文本。",
                "location": {"page": 1, "bbox": [10.0, 20.0, 200.0, 40.0]},
                "links": [],
                "provenance": "native_text",
            }
        ],
        "title": "合成测试材料（非真实简历）",
        "chars": 11,
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
        "meta": {"pages": 2, "source_sha256": sha, "backend": "test"},
        "links": [],
        "fields": {
            "name": {"state": "present", "value": "示例"},
            "phone": {"state": "unreadable", "reason": "unread_visual_page"},
        },
        "protected_attributes": {},
        "screening": {"eligible_fields": ["name"], "blocked_fields": ["phone"]},
    }


def add_run(
    conn,
    tenant_id: str,
    sha: str,
    *,
    status: str = "QUARANTINED",
    completeness: str = "partial",
    needs_visual: bool = True,
    issues: tuple[str, ...] = ("unread_visual_page",),
    result: dict | None = None,
    source_name: str = "synthetic-test.pdf",
    started_minutes_ago: int = 0,
) -> str:
    run_id = new_uuid()
    payload = result if result is not None else machine_result(sha)
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into recruitment.conversion_run
              (id, tenant_id, source_sha256, source_name, converter_version,
               status, completeness, needs_visual, issue_codes, pages, blocks,
               elapsed_ms, started_at, finished_at, recorded_at, result_json)
            values
              (%s, %s, %s, %s, 'test/1.0', %s, %s, %s, %s, 2, 1, 1000,
               clock_timestamp() - make_interval(mins => %s),
               clock_timestamp() - make_interval(mins => %s) + interval '1 minute',
               clock_timestamp(),
               %s)
            """,
            (
                run_id,
                tenant_id,
                sha,
                source_name,
                status,
                completeness,
                needs_visual,
                list(issues),
                started_minutes_ago,
                started_minutes_ago,
                Jsonb(payload),
            ),
        )
    return run_id


@pytest.fixture()
def subject(conn):
    """一套完整但合成的对象：租户 / 3 个 actor / 岗位 / 候选人 / 简历 / 申请 / 1 个 run。"""
    ids = {
        "tenant": new_uuid(),
        "department": new_uuid(),
        "system_actor": new_uuid(),
        "reviewer_a": new_uuid(),
        "reviewer_b": new_uuid(),
        "job": new_uuid(),
        "job_version": new_uuid(),
        "candidate": new_uuid(),
        "event": new_uuid(),
        "intake_record": new_uuid(),
        "intake_asset": new_uuid(),
        "resume": new_uuid(),
        "resume_version": new_uuid(),
        "application": new_uuid(),
        "sha": new_sha(),
    }
    payload_hash = new_sha()
    with conn.cursor() as cur:
        cur.execute(
            "insert into recruitment.organization (id, name) values (%s, %s)",
            (ids["tenant"], "合成测试租户（非真实数据）"),
        )
        cur.execute(
            "insert into recruitment.department (id, tenant_id, name) values (%s, %s, %s)",
            (ids["department"], ids["tenant"], "合成测试部门"),
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
            values (%s, %s, %s, %s, '合成测试岗位', 'OPEN')
            """,
            (ids["job"], ids["tenant"], ids["department"], f"TEST-{ids['job'][:8]}"),
        )
        cur.execute(
            """
            insert into recruitment.job_version
              (id, tenant_id, job_id, version_no, description_md, payload_hash, created_by_actor_id)
            values (%s, %s, %s, 1, '合成测试 JD（非真实招聘信息）', %s, %s)
            """,
            (ids["job_version"], ids["tenant"], ids["job"], payload_hash, ids["reviewer_a"]),
        )
        cur.execute(
            "insert into recruitment.candidate (id, tenant_id, display_name) values (%s, %s, %s)",
            (ids["candidate"], ids["tenant"], "合成测试候选人（非真实）"),
        )
        cur.execute(
            """
            insert into recruitment.event_inbox
              (event_id, tenant_id, provider, event_type, idempotency_key, trust_level, payload)
            values (%s, %s, 'internal', 'test.synthetic', %s, 'INTERNAL', '{}'::jsonb)
            """,
            (ids["event"], ids["tenant"], f"test:{ids['event']}"),
        )
        cur.execute(
            """
            insert into recruitment.intake_record (id, tenant_id, event_id)
            values (%s, %s, %s)
            """,
            (ids["intake_record"], ids["tenant"], ids["event"]),
        )
        cur.execute(
            """
            insert into recruitment.intake_asset
              (id, tenant_id, intake_record_id, file_name, mime_type, byte_size,
               sha256, storage_ref, validation_status)
            values (%s, %s, %s, 'synthetic-test.pdf', 'application/pdf', 2048,
                    %s, 'test://synthetic/synthetic-test.pdf', 'VALID')
            """,
            (ids["intake_asset"], ids["tenant"], ids["intake_record"], ids["sha"]),
        )
        cur.execute(
            "insert into recruitment.resume (id, tenant_id, candidate_id, intake_asset_id) values (%s, %s, %s, %s)",
            (ids["resume"], ids["tenant"], ids["candidate"], ids["intake_asset"]),
        )
        cur.execute(
            """
            insert into recruitment.resume_version
              (id, tenant_id, resume_id, version_no, source_asset_sha256, content_sha256,
               parser_name, parser_version, parse_status)
            values (%s, %s, %s, 1, %s, %s, 'test-parser', '1.0', 'PARSED')
            """,
            (ids["resume_version"], ids["tenant"], ids["resume"], ids["sha"], payload_hash),
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

    ids["conn"] = conn
    ids["run_id"] = add_run(conn, ids["tenant"], ids["sha"])
    return ids


@pytest.fixture()
def make_run(conn):
    """在同一个回滚事务里补建 conversion_run（HUM-02/03 的多 run 场景用）。"""

    def _make(tenant_id: str, sha: str, **kwargs) -> str:
        return add_run(conn, tenant_id, sha, **kwargs)

    return _make


@pytest.fixture()
def build_result():
    """构造合成转换器输出（``machine_result(sha)`` 的别名）。"""
    return machine_result


@pytest.fixture()
def enqueued(subject):
    item_id = queue.enqueue(
        subject["run_id"],
        "机器判定：第 2 页纯图像未读（合成测试）",
        actor=subject["system_actor"],
        conn=subject["conn"],
    )
    return {**subject, "item_id": item_id}


@pytest.fixture()
def in_review(enqueued):
    queue.claim(
        enqueued["item_id"], enqueued["reviewer_a"], actor=enqueued["reviewer_a"], conn=enqueued["conn"]
    )
    return enqueued


@pytest.fixture()
def corrected(in_review):
    queue.submit_correction(
        in_review["item_id"],
        2,
        "合成测试第 2 页：人工转录的示例正文。",
        in_review["reviewer_a"],
        conn=in_review["conn"],
    )
    return in_review

