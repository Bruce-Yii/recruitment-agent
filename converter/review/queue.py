"""人工兜底队列的读写（doc 12 §2④；0003 的三张表）。

设计边界
--------
* **只封装** ``recruitment.conversion_run`` / ``review_queue`` / ``review_audit``。
  表结构、状态机、审计全部由 ``db/migrations/0003_review_queue.sql`` 定义，
  本模块不建表、不改约束、不绕过状态机。
* 审计用**数据库触发器**，不在应用层显式插入——理由见 :func:`_set_actor` 上方。
* 驱动用 psycopg 3（本机已装 3.3.5）：真参数绑定（正文里的引号/换行不会变成 SQL）、
  一个连接内用 ``set_config(..., is_local=true)`` 实现 0003 要求的
  ``SET LOCAL recruitment.actor_id``（D-18：不能用 ``SET``，会经连接池泄漏）。
  psql 子进程的取舍见 ``review/README.md`` §2。

调用方式
--------
每个函数都可以不传 ``conn``（模块按 ``REVIEW_DSN`` / libpq 环境变量自建连接并在
成功时提交）；也可以传一个已有连接，此时操作落在调用方的事务里（内层是
savepoint，失败只回滚这一手）。测试用后者。

现状与并存
----------
``enqueue`` 写 ``machine_result``（摘要，不是全文），``submit_correction`` 只写
``human_result``；0003 的 ``fn_review_queue_before_update`` 禁止 UPDATE
``machine_result``，所以「两份都保留」是库层保证，不是调用约定。
"""

from __future__ import annotations

import os
import re
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterable, Iterator

import psycopg
from psycopg import errors as pg_errors
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from . import transcription

#: 0003 的视图 `v_review_open` 对「未结案」的定义，也是本模块的唯一定义。
OPEN_STATES: tuple[str, ...] = ("QUEUED", "IN_REVIEW", "CORRECTED")
TERMINAL_STATES: tuple[str, ...] = ("APPROVED", "REJECTED", "REPROCESS")

#: 入队时记在审计里的「机器侧 actor」。人不能冒充它：它由部署配置给出，
#: 不从人工命令的 --actor 默认值里取（见 README §2「谁算 enqueue 的 actor」）。
SYSTEM_ACTOR_ENV = "REVIEW_SYSTEM_ACTOR_ID"

_DEFAULT_DSN_ENV = "REVIEW_DSN"
_REASON_MAX = 2000


class ReviewError(RuntimeError):
    """队列操作的稳定错误类型。``code`` 优先取数据库约束名/触发器错误码。"""

    default_code = "REVIEW_ERROR"

    def __init__(self, code: str | None, message: str, *, sqlstate: str | None = None):
        self.code = code or self.default_code
        self.message = message
        self.sqlstate = sqlstate
        super().__init__(f"{self.code}: {message}")


class NotFound(ReviewError):
    default_code = "REVIEW_NOT_FOUND"


class Conflict(ReviewError):
    default_code = "REVIEW_CONFLICT"


class IllegalTransition(Conflict):
    default_code = "QUEUE_ILLEGAL_TRANSITION"


class ValidationError(ReviewError):
    default_code = "REVIEW_INVALID_INPUT"


# ---------------------------------------------------------------------------
# 连接 / 事务 / 错误翻译
# ---------------------------------------------------------------------------


def connect(dsn: str | None = None) -> psycopg.Connection:
    """建立连接（不自动提交）。

    不传 ``dsn`` 时依次看 ``REVIEW_DSN`` 和 libpq 环境变量（PGHOST/PGUSER/...）。
    密码不写进代码，也不写进仓库（R7）。
    """
    conn = psycopg.connect(dsn or os.environ.get(_DEFAULT_DSN_ENV) or "", autocommit=False)
    conn.row_factory = dict_row
    return conn


def _set_actor(conn: psycopg.Connection, actor: Any) -> None:
    """把本次事务的操作者写进 ``recruitment.actor_id``。

    为什么用 ``set_config(name, value, true)``：它等价于 ``SET LOCAL``，
    作用域是当前事务，提交/回滚即失效；用 ``SET`` 会被连接池带给下一个请求，
    责任人记错是**静默错误**（D-18）。
    """
    actor_id = _as_uuid(actor, "actor")
    with conn.cursor() as cur:
        cur.execute("select set_config('recruitment.actor_id', %s, true)", (actor_id,))


@contextmanager
def _mutating(conn: psycopg.Connection | None, actor: Any) -> Iterator[psycopg.Connection]:
    """在一个事务里执行一手变更；``conn`` 为 None 时自建并负责关闭。

    审计不是这里插的：0003 的 ``trg_review_queue_audit``（AFTER INSERT OR UPDATE）
    会写 ``review_audit``。选触发器的理由：
      1. 应用层**无法漏记**——不经过本模块的 UPDATE 也会被记；
      2. 手工 insert 会和触发器重复写入，撞 ``uq_review_audit_transition``；
      3. actor 由 ``SET LOCAL`` 提供，审计里的「谁」不依赖调用方自觉传参。
    """
    own = conn is None
    conn = conn if conn is not None else connect()
    try:
        with conn.transaction():
            _set_actor(conn, actor)
            yield conn
    except ReviewError:
        raise
    except psycopg.Error as exc:
        raise _translate(exc) from exc
    finally:
        if own:
            conn.close()


def _translate(exc: psycopg.Error) -> ReviewError:
    diag = getattr(exc, "diag", None)
    message = (getattr(diag, "message_primary", None) or str(exc)).strip()
    code = getattr(diag, "constraint_name", None) if diag is not None else None
    if not code:
        match = re.match(r"^([A-Z][A-Z0-9_]{2,}):", message)
        code = match.group(1) if match else None
    sqlstate = getattr(exc, "sqlstate", None)
    if isinstance(exc, pg_errors.UniqueViolation):
        return Conflict(code or "UNIQUE_VIOLATION", message, sqlstate=sqlstate)
    if isinstance(exc, pg_errors.ForeignKeyViolation):
        return Conflict(code or "FOREIGN_KEY_VIOLATION", message, sqlstate=sqlstate)
    if isinstance(exc, pg_errors.CheckViolation) or sqlstate == "23514":
        return Conflict(code or "CONSTRAINT_VIOLATION", message, sqlstate=sqlstate)
    return ReviewError(code or "DB_ERROR", message, sqlstate=sqlstate)


def _as_uuid(value: Any, field: str) -> str:
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, str):
        try:
            return str(uuid.UUID(value))
        except ValueError as exc:
            raise ValidationError(f"{field.upper()}_INVALID", f"{field} 不是合法 uuid：{value!r}", ) from exc
    raise ValidationError(f"{field.upper()}_INVALID", f"{field} 必须是 uuid，收到 {value!r}")


def validate_uuid(value: Any, field: str = "id") -> str:
    """公开的 uuid 校验（别的模块复用同一套错误码）。"""
    return _as_uuid(value, field)


def _require_reason(reason: Any) -> str:
    if not isinstance(reason, str):
        raise ValidationError("REASON_INVALID", "reason 必须是字符串")
    reason = reason.strip()
    if not reason:
        raise ValidationError("REASON_REQUIRED", "reason 不能为空（每次决策都要给出本次理由）")
    if len(reason) > _REASON_MAX:
        raise ValidationError("REASON_TOO_LONG", f"reason 超过 {_REASON_MAX} 字符")
    return reason


def _system_actor() -> str:
    actor = os.environ.get(SYSTEM_ACTOR_ENV, "").strip()
    if not actor:
        raise ValidationError(
            "ACTOR_REQUIRED",
            f"enqueue 需要机器侧 actor：设置环境变量 {SYSTEM_ACTOR_ENV}，或显式传 actor=",
        )
    return _as_uuid(actor, "actor")


def _jsonable(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    if isinstance(value, tuple):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    return value


def _row(row: dict | None) -> dict | None:
    return _jsonable(row) if row is not None else None


# ---------------------------------------------------------------------------
# 入队 / 查询
# ---------------------------------------------------------------------------


def enqueue(
    run_id: Any,
    reason: str,
    deadline_hours: float = 24,
    *,
    actor: Any = None,
    conn: psycopg.Connection | None = None,
) -> str:
    """把一个非 ACCEPTED 的 run 排进人工队列，返回 ``item_id``。

    * 队列里一个 run 只允许一条（0003 ``uq_review_queue_run``）；
    * ``machine_result`` 存**摘要**（状态 / 完整性 / issue codes / 页数 / 时间），
      全文在 ``conversion_run.result_json``，不在这里复制；
    * ``deadline`` 默认 now()+24h，必须 > opened_at（0003 CHECK）；
    * 入队这一手由触发器自动写 ``review_audit``（from_status 为空）。
    """
    reason = _require_reason(reason)
    run_id = _as_uuid(run_id, "run_id")
    if isinstance(deadline_hours, bool) or not isinstance(deadline_hours, (int, float)):
        raise ValidationError("DEADLINE_INVALID", "deadline_hours 必须是数字")
    if deadline_hours <= 0:
        raise ValidationError("DEADLINE_INVALID", "deadline_hours 必须 > 0")
    actor = actor if actor is not None else _system_actor()

    with _mutating(conn, actor) as connection:
        with connection.cursor() as cur:
            run = cur.execute(
                """
                select id, tenant_id, status, completeness, needs_visual, issue_codes,
                       pages, blocks, source_sha256, source_name, converter_version,
                       started_at, finished_at, result_json is not null as has_result_json
                  from recruitment.conversion_run
                 where id = %s
                """,
                (run_id,),
            ).fetchone()
            if run is None:
                raise NotFound("RUN_NOT_FOUND", f"conversion_run {run_id} 不存在")
            if run["status"] == "ACCEPTED":
                raise Conflict(
                    "QUEUE_ACCEPTED_RUN",
                    f"run {run_id} 已 ACCEPTED，不入人工兜底队列（④ 只收机器判不了的）",
                )

            existing = cur.execute(
                "select id as item_id from recruitment.review_queue where run_id = %s", (run_id,)
            ).fetchone()
            if existing is not None:
                raise Conflict(
                    "QUEUE_ALREADY_EXISTS",
                    f"run {run_id} 已入队（item_id={existing['item_id']}）；重跑应产生新 run",
                )

            machine_result = {
                "run_id": str(run["id"]),
                "run_status": run["status"],
                "completeness": run["completeness"],
                "needs_visual": run["needs_visual"],
                "issue_codes": list(run["issue_codes"] or []),
                "pages": run["pages"],
                "blocks": run["blocks"],
                "source_sha256": run["source_sha256"],
                "source_name": run["source_name"],
                "converter_version": run["converter_version"],
                "started_at": _jsonable(run["started_at"]),
                "finished_at": _jsonable(run["finished_at"]),
                "has_result_json": run["has_result_json"],
            }
            inserted = cur.execute(
                """
                insert into recruitment.review_queue (tenant_id, run_id, machine_result, reason, deadline)
                values (%s, %s, %s, %s, now() + make_interval(secs => %s))
                returning id as item_id
                """,
                (
                    run["tenant_id"],
                    run["id"],
                    Jsonb(machine_result),
                    reason,
                    float(deadline_hours) * 3600.0,
                ),
            ).fetchone()
            return str(inserted["item_id"])


def list_pending(
    *,
    statuses: Iterable[str] = OPEN_STATES,
    overdue_only: bool = False,
    tenant_id: Any = None,
    conn: psycopg.Connection | None = None,
) -> list[dict]:
    """未结案清单（来自 ``recruitment.v_review_open``）。

    返回的每一行都带 ``deadline`` 与 ``overdue``：HUM-04 的升级检查就在这两个
    字段上做，不允许出现「进了队列但没有截止时间」。
    """
    wanted = list(statuses)
    unknown = set(wanted) - set(OPEN_STATES)
    if unknown:
        raise ValidationError("STATUS_UNKNOWN", f"v_review_open 不包含这些状态：{sorted(unknown)}")
    own = conn is None
    conn = conn if conn is not None else connect()
    try:
        sql = """
            select item_id, run_id, status, assignee, opened_at, deadline,
                   overdue, age_hours, source_sha256, source_name,
                   run_status, completeness, needs_visual, issue_codes
              from recruitment.v_review_open
             where status = any(%s::text[])
        """
        params: list[Any] = [wanted]
        if overdue_only:
            sql += " and overdue"
        if tenant_id is not None:
            sql += " and tenant_id = %s"
            params.append(uuid.UUID(str(tenant_id)))
        sql += " order by deadline asc, opened_at asc"
        with conn.cursor(row_factory=dict_row) as cur:
            rows = cur.execute(sql, params).fetchall()
        return [_jsonable(row) for row in rows]
    finally:
        if own:
            conn.close()


def get_item(item_id: Any, *, conn: psycopg.Connection | None = None) -> dict:
    """单条详情（含 run 摘要；``human_result`` 原样返回）。"""
    item_id = _as_uuid(item_id, "item_id")
    own = conn is None
    conn = conn if conn is not None else connect()
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            row = cur.execute(
                """
                select q.id as item_id, q.tenant_id, q.run_id, q.status, q.assignee, q.deadline,
                       q.opened_at, q.closed_at, q.reason, q.record_version, q.updated_at,
                       q.machine_result, q.human_result,
                       r.status as run_status, r.completeness, r.needs_visual,
                       r.issue_codes, r.source_sha256, r.source_name, r.converter_version,
                       r.result_json
                  from recruitment.review_queue q
                  join recruitment.conversion_run r
                    on r.id = q.run_id and r.tenant_id = q.tenant_id
                 where q.id = %s
                """,
                (item_id,),
            ).fetchone()
        if row is None:
            raise NotFound("ITEM_NOT_FOUND", f"review_queue 条目 {item_id} 不存在")
        return _jsonable(row)
    finally:
        if own:
            conn.close()


def list_audit(item_id: Any, *, conn: psycopg.Connection | None = None) -> list[dict]:
    """按 ``audit_seq`` 逐条查回审计（同一事务内 ``at`` 相同，不能用时间排序）。"""
    item_id = _as_uuid(item_id, "item_id")
    own = conn is None
    conn = conn if conn is not None else connect()
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            rows = cur.execute(
                """
                select a.audit_seq, a.from_status, a.to_status, a.actor,
                       ac.display_name as actor_name, a.reason, a.at
                  from recruitment.review_audit a
                  left join recruitment.actor ac
                    on ac.id = a.actor and ac.tenant_id = a.tenant_id
                 where a.item_id = %s
                 order by a.audit_seq
                """,
                (item_id,),
            ).fetchall()
        return [_jsonable(row) for row in rows]
    finally:
        if own:
            conn.close()


# ---------------------------------------------------------------------------
# 状态迁移
# ---------------------------------------------------------------------------


def claim(
    item_id: Any,
    assignee: Any,
    *,
    actor: Any = None,
    conn: psycopg.Connection | None = None,
) -> dict:
    """``QUEUED → IN_REVIEW`` 并设置处理人。

    没有认领就没有决策：0003 的状态机禁止 ``QUEUED → APPROVED`` 这类跳级，
    本函数也不提供绕过路径。
    """
    item_id = _as_uuid(item_id, "item_id")
    assignee = _as_uuid(assignee, "assignee")
    actor = _as_uuid(actor, "actor") if actor is not None else assignee
    with _mutating(conn, actor) as connection:
        with connection.cursor() as cur:
            current = cur.execute(
                "select status from recruitment.review_queue where id = %s", (item_id,)
            ).fetchone()
            if current is None:
                raise NotFound("ITEM_NOT_FOUND", f"review_queue 条目 {item_id} 不存在")
            if current["status"] != "QUEUED":
                raise IllegalTransition(
                    "QUEUE_ILLEGAL_TRANSITION",
                    f"只有 QUEUED 可以认领，当前是 {current['status']}",
                )
            row = cur.execute(
                """
                update recruitment.review_queue
                   set status = 'IN_REVIEW', assignee = %s
                 where id = %s and status = 'QUEUED'
                 returning id as item_id, status, assignee, deadline, opened_at, record_version, updated_at
                """,
                (assignee, item_id),
            ).fetchone()
            if row is None:  # 并发下被抢走
                raise IllegalTransition("QUEUE_ILLEGAL_TRANSITION", "认领失败：状态已被其他事务改掉")
            return _jsonable(row)


def submit_correction(
    item_id: Any,
    page_no: int,
    text: str,
    actor: Any,
    *,
    adopt: bool = True,
    conn: psycopg.Connection | None = None,
) -> dict:
    """录入一页人工转录：``IN_REVIEW → CORRECTED``（已 CORRECTED 时只追加）。

    并存语义：
      * 只写 ``human_result``，不碰 ``machine_result``（0003 的触发器会拒绝后者）；
      * 同一页可以多次录入（不同人/不同时间），历史全部保留；
      * ``adopt=True`` 把该页「当前采用」指向本条，旧记录仍可切回；
      * 原始 issue（``conversion_run.issue_codes``）一个字都不删，补正只记为
        「已由人工处理」的独立事实（见 :mod:`review.merge_human`）。
    """
    item_id = _as_uuid(item_id, "item_id")
    actor = _as_uuid(actor, "actor")
    page_no = transcription.validate_page_no(page_no)
    with _mutating(conn, actor) as connection:
        with connection.cursor() as cur:
            row = cur.execute(
                """
                select q.id as item_id, q.status, q.human_result, q.tenant_id,
                       r.source_sha256, r.id as run_id
                  from recruitment.review_queue q
                  join recruitment.conversion_run r
                    on r.id = q.run_id and r.tenant_id = q.tenant_id
                 where q.id = %s
                   for update of q
                """,
                (item_id,),
            ).fetchone()
            if row is None:
                raise NotFound("ITEM_NOT_FOUND", f"review_queue 条目 {item_id} 不存在")
            if row["status"] not in ("IN_REVIEW", "CORRECTED"):
                raise Conflict(
                    "QUEUE_NOT_IN_REVIEW",
                    f"只有 IN_REVIEW / CORRECTED 可以录入人工转录，当前是 {row['status']}",
                )

            db_now = cur.execute("select now() as now").fetchone()["now"]
            new_human, record = transcription.append_to_human_result(
                row["human_result"],
                sha256=row["source_sha256"],
                page_no=page_no,
                text=text,
                actor=actor,
                created_at=db_now,
                adopt=adopt,
            )
            all_records = transcription.records(new_human)
            current = transcription.current_records(new_human)
            reason = (
                f"人工逐页转录：第 {page_no} 页"
                f"（累计 {len(all_records)} 条转录 / 当前采用 {len(current)} 页）"
            )
            updated = cur.execute(
                """
                update recruitment.review_queue
                   set status = 'CORRECTED', human_result = %s, reason = %s
                 where id = %s and status = %s
                 returning id as item_id, status, assignee, human_result, closed_at,
                           record_version, updated_at
                """,
                (
                    Jsonb(new_human),
                    reason,
                    item_id,
                    row["status"],
                ),
            ).fetchone()
            if updated is None:
                raise Conflict("QUEUE_CONCURRENT_UPDATE", "录入失败：条目状态已被其他事务改掉")
            return {
                "item_id": str(updated["item_id"]),
                "status": updated["status"],
                "record_version": updated["record_version"],
                "transcription": record,
                "transcriptions": len(all_records),
                "current_pages": [r["page_no"] for r in current],
                "human_result": _jsonable(updated["human_result"]),
            }


def approve(
    item_id: Any,
    actor: Any,
    reason: str,
    *,
    conn: psycopg.Connection | None = None,
) -> dict:
    """``IN_REVIEW|CORRECTED → APPROVED``（终态，closed_at 由触发器写）。"""
    return _decide(item_id, "APPROVED", actor, reason, conn=conn)


def reject(
    item_id: Any,
    actor: Any,
    reason: str,
    *,
    conn: psycopg.Connection | None = None,
) -> dict:
    """``IN_REVIEW|CORRECTED → REJECTED``（原件不可用；只有人能下这个结论）。"""
    return _decide(item_id, "REJECTED", actor, reason, conn=conn)


def adopt_transcription(
    item_id: Any,
    transcription_id: Any,
    actor: Any,
    *,
    conn: psycopg.Connection | None = None,
) -> dict:
    """把某页的「当前采用」切到一条历史转录（只改指针，不删任何历史）。

    只允许在 ``CORRECTED``（尚未复核放行）时切换：已 APPROVED/REJECTED 的条目
    再改「当前采用」等于改掉被批准的内容，必须走新的复核，不在这里开后门。
    """
    item_id = _as_uuid(item_id, "item_id")
    actor = _as_uuid(actor, "actor")
    with _mutating(conn, actor) as connection:
        with connection.cursor() as cur:
            row = cur.execute(
                """
                select id, status, human_result
                  from recruitment.review_queue
                 where id = %s
                   for update
                """,
                (item_id,),
            ).fetchone()
            if row is None:
                raise NotFound("ITEM_NOT_FOUND", f"review_queue 条目 {item_id} 不存在")
            if row["status"] != "CORRECTED":
                raise Conflict(
                    "QUEUE_NOT_CORRECTED",
                    f"只有 CORRECTED 可以切换采用哪份转录，当前是 {row['status']}",
                )
            new_human = transcription.adopt_in_human_result(
                row["human_result"], transcription_id=transcription_id, actor=actor
            )
            current = transcription.current_for_page(new_human, _record_page(new_human, transcription_id))
            reason = (
                f"人工切换采用转录：第 {current['page_no'] if current else '?'} 页 "
                f"→ {str(transcription_id)[:8]}…（历史保留）"
            )
            updated = cur.execute(
                """
                update recruitment.review_queue
                   set human_result = %s, reason = %s
                 where id = %s and status = 'CORRECTED'
                 returning id as item_id, status, human_result, record_version, updated_at
                """,
                (Jsonb(new_human), reason, item_id),
            ).fetchone()
            if updated is None:
                raise Conflict("QUEUE_CONCURRENT_UPDATE", "切换失败：条目状态已被其他事务改掉")
            return {
                "item_id": str(updated["item_id"]),
                "status": updated["status"],
                "current_pages": sorted(transcription.adopted_map(updated["human_result"])),
                "record_version": updated["record_version"],
            }


def _record_page(human_result: dict, transcription_id: Any) -> int:
    tid = _as_uuid(transcription_id, "transcription_id")
    for record in transcription.records(human_result):
        if record["transcription_id"] == tid:
            return record["page_no"]
    raise Conflict("TRANSCRIPTION_NOT_FOUND", f"找不到转录 {tid}")


def _decide(
    item_id: Any,
    target: str,
    actor: Any,
    reason: str,
    *,
    conn: psycopg.Connection | None = None,
) -> dict:
    item_id = _as_uuid(item_id, "item_id")
    actor = _as_uuid(actor, "actor")
    reason = _require_reason(reason)
    if target not in ("APPROVED", "REJECTED"):
        raise ValidationError("TARGET_INVALID", f"不支持的终态 {target}")

    with _mutating(conn, actor) as connection:
        with connection.cursor() as cur:
            current = cur.execute(
                "select status, reason from recruitment.review_queue where id = %s for update",
                (item_id,),
            ).fetchone()
            if current is None:
                raise NotFound("ITEM_NOT_FOUND", f"review_queue 条目 {item_id} 不存在")
            if current["status"] not in ("IN_REVIEW", "CORRECTED"):
                raise IllegalTransition(
                    "QUEUE_ILLEGAL_TRANSITION",
                    f"{current['status']} → {target} 不在允许的边内（必须先 IN_REVIEW）",
                )
            row = cur.execute(
                """
                update recruitment.review_queue
                   set status = %s, reason = %s
                 where id = %s and status = %s
                 returning id as item_id, status, assignee, reason, closed_at,
                           record_version, updated_at
                """,
                (target, reason, item_id, current["status"]),
            ).fetchone()
            if row is None:
                raise Conflict("QUEUE_CONCURRENT_UPDATE", "决策失败：条目状态已被其他事务改掉")
            return _jsonable(row)


# ---------------------------------------------------------------------------
# 人工转录的查询封装（格式在 transcription，这里只取）
# ---------------------------------------------------------------------------


def list_transcriptions(item_id: Any, *, conn: psycopg.Connection | None = None) -> dict:
    """某条目的全部转录 + 当前采用 + 摘要（摘要不含正文）。"""
    item = get_item(item_id, conn=conn)
    human = item.get("human_result")
    return {
        "item_id": item["item_id"],
        "status": item["status"],
        "records": transcription.records(human),
        "current": transcription.current_records(human),
        "summary": transcription.summarize(human),
    }
