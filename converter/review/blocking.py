"""④ 人工兜底的**阻断判据**（doc 12 §2④ / §5③：必须验阻断，不只是验入队）。

``screening_blocked(candidate_or_application_id)`` 回答一个问题：

> 这个候选人/申请现在能不能进入**自动筛选结论**？

返回空列表 = 可以；返回非空 = 不可以，每一项都是一条可展示的阻断原因
（``code`` / ``message`` / ``item_id`` / ``run_id`` / ``deadline`` / ``overdue``）。

判据（与 0003 的 ``v_source_gate`` 同一套事实，且更严格）
----------------------------------------------------------
对一个对象关联到的每个源文件 ``sha256``：

1. **任一** run 上有未结案条目（``QUEUED`` / ``IN_REVIEW`` / ``CORRECTED``）
   → 阻断。任务书说「任一 conversion_run」，所以这里不只看最新 run。
   * ``QUEUED`` / ``IN_REVIEW`` → ``REVIEW_PENDING``
   * ``CORRECTED``           → ``CORRECTION_AWAITING_APPROVAL``
     （0003 里 CORRECTED **不是终态**：``closed_at`` 为空、``v_review_open``
     仍把它算作 open。人工补正 ≠ 复核放行，所以默认仍阻断；如产品口径要求
     「CORRECTED 即放行」，调用方显式传 ``open_states=("QUEUED","IN_REVIEW")``，
     或 ``released_verdicts`` 里加 ``"CORRECTED"``。）
2. 最新 run 是 ``ACCEPTED`` → 放行。
3. 最新 run 不是 ACCEPTED，但有已结案的人工结论：
   * ``APPROVED`` → 放行（机器结果经人工确认）
   * ``REJECTED`` → 放行**自动筛选**（人工已判原件不可用，下游只能显示「不符合」，
     不会出现自动淘汰）；``evaluate`` 的 ``human_verdict`` 会把它标出来。
4. 最新 run 非 ACCEPTED 且队列里**没有**对应条目 → 阻断 ``QUEUE_ITEM_MISSING``
   （0003 的 ``v_conversion_ledger`` 称之为 ``MISSING_QUEUE_ITEM``；失败没被
   看见就必须 fail closed）。
5. 最新 run 有已结案条目但没有放行结论（例如 ``REPROCESS``）→ 阻断
   ``NO_RELEASING_VERDICT``。
6. 源文件在库里**从未转换过**（没有 conversion_run）→ 阻断 ``NO_CONVERSION_RUN``
   （没有转换结果就没有可筛选的证据，宁可待核）。

第 6 条比任务书更保守，是本模块的 fail-closed 选择：只对「有 sha 但无 run」的
情况触发，不会影响正常已转换的对象。
"""

from __future__ import annotations

import uuid
from typing import Any, Iterable

from psycopg.rows import dict_row

from . import queue

ALL_STATES: tuple[str, ...] = queue.OPEN_STATES + queue.TERMINAL_STATES

#: 默认把 CORRECTED 也算「未结案」。理由见模块 docstring；要按任务书字面
#: 「APPROVED/CORRECTED 即放行」，传 ``open_states=("QUEUED", "IN_REVIEW")``。
DEFAULT_OPEN_STATES: tuple[str, ...] = queue.OPEN_STATES
DEFAULT_RELEASED_VERDICTS: tuple[str, ...] = ("APPROVED", "REJECTED")


class SubjectNotFound(queue.NotFound):
    default_code = "SUBJECT_NOT_FOUND"


def _resolve_subject(conn, subject_id: str) -> dict:
    with conn.cursor(row_factory=dict_row) as cur:
        row = cur.execute(
            """
            select 'APPLICATION' as subject_type, id, tenant_id, candidate_id, resume_version_id
              from recruitment.application
             where id = %s
            """,
            (subject_id,),
        ).fetchone()
        if row is not None:
            return dict(row)
        row = cur.execute(
            """
            select 'CANDIDATE' as subject_type, id, tenant_id,
                   id as candidate_id, null::uuid as resume_version_id
              from recruitment.candidate
             where id = %s
            """,
            (subject_id,),
        ).fetchone()
    if row is None:
        raise SubjectNotFound(
            "SUBJECT_NOT_FOUND",
            f"{subject_id} 既不是 application 也不是 candidate（或不属于任何租户）",
        )
    return dict(row)


def _source_sha256s(conn, subject: dict) -> list[str]:
    """对象 → 源文件 sha256 集合：申请绑定的版本 + 候选人名下全部简历版本/原件。"""
    with conn.cursor(row_factory=dict_row) as cur:
        rows = cur.execute(
            """
            select distinct sha
              from (
                select rv.source_asset_sha256 as sha
                  from recruitment.resume_version rv
                 where rv.id = %(resume_version_id)s
                   and rv.tenant_id = %(tenant_id)s
                union
                select rv2.source_asset_sha256
                  from recruitment.resume_version rv2
                  join recruitment.resume r2
                    on r2.id = rv2.resume_id and r2.tenant_id = rv2.tenant_id
                 where r2.candidate_id = %(candidate_id)s
                   and r2.tenant_id = %(tenant_id)s
                union
                select ia.sha256
                  from recruitment.resume r3
                  join recruitment.intake_asset ia
                    on ia.id = r3.intake_asset_id and ia.tenant_id = r3.tenant_id
                 where r3.candidate_id = %(candidate_id)s
                   and r3.tenant_id = %(tenant_id)s
              ) sources
             where sha is not null
             order by sha
            """,
            {
                "resume_version_id": subject.get("resume_version_id"),
                "candidate_id": subject.get("candidate_id"),
                "tenant_id": subject["tenant_id"],
            },
        ).fetchall()
    return [row["sha"] for row in rows]


def _runs_and_items(conn, tenant_id: str, shas: Iterable[str]) -> list[dict]:
    shas = list(shas)
    if not shas:
        return []
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(
            """
            select r.id as run_id, r.source_sha256, r.status as run_status, r.completeness,
                   r.needs_visual, r.issue_codes, r.started_at, r.recorded_at,
                   q.id as item_id, q.status as item_status, q.assignee,
                   q.opened_at, q.deadline, q.closed_at, q.updated_at
              from recruitment.conversion_run r
              left join recruitment.review_queue q
                     on q.run_id = r.id and q.tenant_id = r.tenant_id
             where r.tenant_id = %s
               and r.source_sha256 = any(%s::text[])
             order by r.source_sha256,
                      r.started_at desc, r.recorded_at desc,
                      q.opened_at desc nulls last
            """,
            (tenant_id, shas),
        ).fetchall()


def _item_view(row: dict, as_of) -> dict:
    deadline = row.get("deadline")
    return {
        "item_id": str(row["item_id"]) if row.get("item_id") else None,
        "run_id": str(row["run_id"]),
        "run_status": row["run_status"],
        "status": row.get("item_status"),
        "assignee": str(row["assignee"]) if row.get("assignee") else None,
        "opened_at": row["opened_at"].isoformat() if row.get("opened_at") else None,
        "deadline": deadline.isoformat() if deadline else None,
        "closed_at": row["closed_at"].isoformat() if row.get("closed_at") else None,
        "overdue": bool(deadline is not None and deadline < as_of),
    }


def _reason(
    code: str,
    message: str,
    *,
    sha256: str | None,
    run_id: Any = None,
    item: dict | None = None,
) -> dict:
    item = item or {}
    return {
        "code": code,
        "severity": "BLOCK",
        "sha256": sha256,
        "run_id": str(run_id) if run_id else item.get("run_id"),
        "item_id": item.get("item_id"),
        "status": item.get("status"),
        "deadline": item.get("deadline"),
        "overdue": item.get("overdue", False),
        "message": message,
    }


def evaluate(
    candidate_or_application_id: Any,
    *,
    conn: Any = None,
    open_states: Iterable[str] = DEFAULT_OPEN_STATES,
    released_verdicts: Iterable[str] = DEFAULT_RELEASED_VERDICTS,
) -> dict:
    """完整判定（``screening_blocked`` 是它的 ``reasons`` 投影，CLI 用这个）。"""
    subject_id = queue.validate_uuid(candidate_or_application_id, "subject_id")
    open_states = tuple(open_states)
    released_verdicts = tuple(released_verdicts)
    unknown = (set(open_states) | set(released_verdicts)) - set(ALL_STATES)
    if unknown:
        raise queue.ValidationError("STATE_UNKNOWN", f"不认识的状态：{sorted(unknown)}")

    own = conn is None
    conn = conn if conn is not None else queue.connect()
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            as_of = cur.execute("select now() as now").fetchone()["now"]
        subject = _resolve_subject(conn, subject_id)
        shas = _source_sha256s(conn, subject)
        rows = _runs_and_items(conn, str(subject["tenant_id"]), shas)

        reasons: list[dict] = []
        sources: list[dict] = []

        if not shas:
            reasons.append(
                _reason(
                    "NO_SOURCE_RECORD",
                    "对象没有关联任何简历源文件（无法证明转换发生过），按阻断处理",
                    sha256=None,
                )
            )

        for sha in shas:
            sha_rows = [row for row in rows if row["source_sha256"] == sha]
            if not sha_rows:
                sources.append(
                    {
                        "sha256": sha,
                        "latest_run_id": None,
                        "latest_run_status": None,
                        "latest_run_at": None,
                        "completeness": None,
                        "human_verdict": None,
                        "verdict": "NOT_CONVERTED",
                        "queue_items": [],
                    }
                )
                reasons.append(
                    _reason(
                        "NO_CONVERSION_RUN",
                        f"源文件 {sha[:12]}… 没有任何 conversion_run，筛选没有可用的转换证据",
                        sha256=sha,
                    )
                )
                continue

            latest = sha_rows[0]
            items = [row for row in sha_rows if row.get("item_id")]
            open_items = [row for row in items if row["item_status"] in open_states]
            # 口径开关：CORRECTED 不在 open_states 时，它就是一种「人工已处理」的放行结论。
            corrected_releases = "CORRECTED" not in open_states
            releasable = [
                row
                for row in items
                if row["item_status"] in released_verdicts
                or (corrected_releases and row["item_status"] == "CORRECTED")
            ]
            released_item = (
                max(releasable, key=lambda row: row.get("closed_at") or row.get("updated_at"))
                if releasable
                else None
            )
            latest_run_items = [row for row in items if row["run_id"] == latest["run_id"]]

            if open_items:
                verdict = "PENDING_REVIEW"
            elif latest["run_status"] == "ACCEPTED":
                verdict = "CLEARED"
            elif released_item is not None:
                verdict = {
                    "APPROVED": "CLEARED",
                    "REJECTED": "REJECTED",
                    "CORRECTED": "CORRECTED",
                }[released_item["item_status"]]
            elif not latest_run_items:
                verdict = "UNACCOUNTED"
            else:
                verdict = "NO_RELEASING_VERDICT"

            queue_items = [_item_view(row, as_of) for row in items]
            sources.append(
                {
                    "sha256": sha,
                    "latest_run_id": str(latest["run_id"]),
                    "latest_run_status": latest["run_status"],
                    "latest_run_at": latest["started_at"].isoformat() if latest.get("started_at") else None,
                    "completeness": latest["completeness"],
                    "human_verdict": released_item["item_status"] if released_item else None,
                    "verdict": verdict,
                    "queue_items": queue_items,
                }
            )

            for row in open_items:
                view = _item_view(row, as_of)
                if row["item_status"] == "CORRECTED":
                    reasons.append(
                        _reason(
                            "CORRECTION_AWAITING_APPROVAL",
                            f"run {row['run_id']} 的人工补正已录入但尚未复核放行"
                            f"（item {view['item_id']}，状态 CORRECTED；0003 视其为未结案）",
                            sha256=sha,
                            run_id=row["run_id"],
                            item=view,
                        )
                    )
                else:
                    reasons.append(
                        _reason(
                            "REVIEW_PENDING",
                            f"run {row['run_id']} 处于 {row['run_status']}，"
                            f"人工队列项未结案（{row['item_status']}）；下游只能显示「待核」",
                            sha256=sha,
                            run_id=row["run_id"],
                            item=view,
                        )
                    )

            if not open_items:
                if verdict == "UNACCOUNTED":
                    reasons.append(
                        _reason(
                            "QUEUE_ITEM_MISSING",
                            f"最新 run {latest['run_id']} 是 {latest['run_status']}，"
                            "但队列里没有对应条目（漏记；按阻断处理）",
                            sha256=sha,
                            run_id=latest["run_id"],
                        )
                    )
                elif verdict == "NO_RELEASING_VERDICT":
                    reasons.append(
                        _reason(
                            "NO_RELEASING_VERDICT",
                            f"最新 run {latest['run_id']} 非 ACCEPTED，条目已结案但没有放行结论",
                            sha256=sha,
                            run_id=latest["run_id"],
                        )
                    )

        return {
            "subject_id": subject_id,
            "subject_type": subject["subject_type"],
            "tenant_id": str(subject["tenant_id"]),
            "as_of": as_of.isoformat(),
            "blocked": bool(reasons),
            "reasons": reasons,
            "sources": sources,
            "policy": {
                "open_states": list(open_states),
                "released_verdicts": list(released_verdicts),
            },
        }
    finally:
        if own:
            conn.close()


def screening_blocked(
    candidate_or_application_id: Any,
    *,
    conn: Any = None,
    open_states: Iterable[str] = DEFAULT_OPEN_STATES,
    released_verdicts: Iterable[str] = DEFAULT_RELEASED_VERDICTS,
) -> list[dict]:
    """筛选是否被阻断：空列表 = 放行；非空 = 每条阻断原因。

    默认口径与 0003 的 ``v_source_gate`` 一致（``CORRECTED`` 仍阻断，直到人工
    复核放行）。要在字面口径下运行（``APPROVED``/``CORRECTED`` 都放行），传
    ``open_states=("QUEUED", "IN_REVIEW")``。
    """
    return evaluate(
        candidate_or_application_id,
        conn=conn,
        open_states=open_states,
        released_verdicts=released_verdicts,
    )["reasons"]
