"""人工逐页转录的存取（doc 12 §2④，HUM-05）。

为什么存在这里
--------------
``db/`` 是只读的，0003 已经给了人工结论的落点：``review_queue.human_result``
（jsonb）。再建一张表就等于绕过迁移目录，制造 schema 漂移，所以本模块把
人工转录放在 ``human_result`` 的一个**带版本号的子对象**里：

.. code-block:: json

    {
      "human_read": {
        "schema": "human_read/v1",
        "transcriptions": [
          {"transcription_id": "...", "sha256": "…64 位…", "page_no": 2,
           "text": "人读到的第 2 页正文", "actor": "<uuid>",
           "created_at": "2026-11-13T…+00:00", "source": "human_read"}
        ],
        "adopted": {"2": "<transcription_id>"}
      }
    }

* ``transcriptions`` 只追加、不删改：同页可以有多份转录（不同人 / 不同时间）。
* ``adopted`` 标出**当前采用哪一份**（每页一个指针）；切换用
  :func:`adopt_in_human_result`，旧的转录仍然留在数组里。
* ``human_read`` 之外的键（例如 0003 自检里出现过的 ``corrected_fields`` /
  ``note``）原样保留，不吞掉别的工具写的人工结论。

并存的另一半在库里：``review_queue.machine_result`` 由 0003 的触发器禁止 UPDATE，
人工转录只能进 ``human_result``，所以「机器结果与人工结果两份都保留」不是靠
调用方自觉，而是数据库物理上拦住的。

取
--
:func:`find` 按 ``source_sha256``（+ 可选页号）跨队列项查，返回每条转录连同
它属于哪个 item / run、是否当前采用。机器结果永远在 ``machine_result`` /
``conversion_run.result_json`` 里，这里不读也不写它们。
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any, Iterable

SCHEMA = "human_read/v1"
KEY = "human_read"
SOURCE = "human_read"

#: 单页转录上限：human_result 是 jsonb 行内数据，不是文件仓库（同 0003 对
#: conversion_run.result_json 的 1 MiB 口径）。超了说明用错地方，应走对象存储。
MAX_TEXT_BYTES = 1024 * 1024
MAX_PAGE_NO = 100_000

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class TranscriptionError(ValueError):
    """转录格式 / 状态错误。``code`` 是稳定错误码，便于上层判断。"""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# 输入校验
# ---------------------------------------------------------------------------


def normalize_sha256(value: Any) -> str:
    if not isinstance(value, str) or not _SHA256_RE.match(value):
        raise TranscriptionError(
            "SHA256_INVALID", f"sha256 必须是小写 64 位十六进制，收到 {value!r}"
        )
    return value


def _as_page_no(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TranscriptionError("PAGE_NO_INVALID", f"page_no 必须是整数，收到 {value!r}")
    if not 1 <= value <= MAX_PAGE_NO:
        raise TranscriptionError(
            "PAGE_NO_OUT_OF_RANGE", f"page_no 必须在 1..{MAX_PAGE_NO}，收到 {value}"
        )
    return value


def validate_page_no(value: Any) -> int:
    """公开的页号校验（queue.py 复用同一套规则，避免两处漂移）。"""
    return _as_page_no(value)


def _as_text(value: Any) -> str:
    if not isinstance(value, str):
        raise TranscriptionError("TEXT_NOT_STRING", f"text 必须是字符串，收到 {type(value).__name__}")
    text = value.strip()
    if not text:
        raise TranscriptionError("TEXT_EMPTY", "text 不能为空（空页应显式记录说明，而不是空串）")
    if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise TranscriptionError(
            "TEXT_TOO_LARGE", f"单页转录超过 {MAX_TEXT_BYTES} 字节上限"
        )
    return text


def _as_uuid(value: Any, field: str) -> str:
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, str):
        try:
            return str(uuid.UUID(value))
        except ValueError as exc:
            raise TranscriptionError(f"{field.upper()}_INVALID", f"{field} 不是合法 uuid：{value!r}") from exc
    raise TranscriptionError(f"{field.upper()}_INVALID", f"{field} 必须是 uuid，收到 {value!r}")


def _as_time(value: Any) -> str:
    """归一成带 UTC 偏移的 ISO-8601 字符串；不带时区的按 UTC 解释。"""
    if value is None:
        dt = datetime.now(timezone.utc)
    elif isinstance(value, datetime):
        dt = value
    elif isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise TranscriptionError("CREATED_AT_INVALID", f"created_at 不是 ISO-8601：{value!r}") from exc
    else:
        raise TranscriptionError("CREATED_AT_INVALID", f"created_at 类型不支持：{type(value).__name__}")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="microseconds")


# ---------------------------------------------------------------------------
# 纯数据层：转录记录 + human_result 的读写
# ---------------------------------------------------------------------------


def make_record(
    *,
    sha256: str,
    page_no: int,
    text: str,
    actor: Any,
    created_at: Any = None,
    transcription_id: Any = None,
) -> dict:
    """构造一条转录记录（不落库）。字段即任务书要求的 7 项。"""
    return {
        "transcription_id": _as_uuid(transcription_id, "transcription_id") if transcription_id else str(uuid.uuid4()),
        "sha256": normalize_sha256(sha256),
        "page_no": _as_page_no(page_no),
        "text": _as_text(text),
        "actor": _as_uuid(actor, "actor"),
        "created_at": _as_time(created_at),
        "source": SOURCE,
    }


def validate_record(record: Any) -> dict:
    """校验一条已存在的转录记录；缺字段 / 类型不对就报错，不静默修补。"""
    if not isinstance(record, dict):
        raise TranscriptionError("RECORD_NOT_OBJECT", f"转录记录必须是对象，收到 {type(record).__name__}")
    expected = {"transcription_id", "sha256", "page_no", "text", "actor", "created_at", "source"}
    missing = expected - set(record)
    if missing:
        raise TranscriptionError("RECORD_MISSING_FIELDS", f"转录记录缺字段：{sorted(missing)}")
    if record["source"] != SOURCE:
        raise TranscriptionError("RECORD_BAD_SOURCE", f"source 必须是 {SOURCE!r}，收到 {record['source']!r}")
    return {
        "transcription_id": _as_uuid(record["transcription_id"], "transcription_id"),
        "sha256": normalize_sha256(record["sha256"]),
        "page_no": _as_page_no(record["page_no"]),
        "text": _as_text(record["text"]),
        "actor": _as_uuid(record["actor"], "actor"),
        "created_at": _as_time(record["created_at"]),
        "source": SOURCE,
    }


def _block(human_result: Any) -> dict:
    """取 ``human_result.human_read``；不存在返回空块，存在则校验版本。"""
    if human_result is None:
        return {"schema": SCHEMA, "transcriptions": [], "adopted": {}}
    if not isinstance(human_result, dict):
        raise TranscriptionError("HUMAN_RESULT_NOT_OBJECT", "human_result 必须是 JSON 对象")
    block = human_result.get(KEY)
    if block is None:
        return {"schema": SCHEMA, "transcriptions": [], "adopted": {}}
    if not isinstance(block, dict):
        raise TranscriptionError("HUMAN_READ_NOT_OBJECT", f"{KEY} 必须是 JSON 对象")
    schema = block.get("schema")
    if schema not in (None, SCHEMA):
        raise TranscriptionError(
            "HUMAN_READ_SCHEMA_UNKNOWN",
            f"不认识的 {KEY}.schema={schema!r}（本模块只认 {SCHEMA!r}）",
        )
    transcriptions = block.get("transcriptions", [])
    adopted = block.get("adopted", {})
    if not isinstance(transcriptions, list) or not isinstance(adopted, dict):
        raise TranscriptionError("HUMAN_READ_BAD_SHAPE", "transcriptions 必须是数组、adopted 必须是对象")
    return {
        "schema": SCHEMA,
        "transcriptions": [validate_record(r) for r in transcriptions],
        "adopted": {str(k): str(v) for k, v in adopted.items()},
    }


def records(human_result: Any) -> list[dict]:
    """全部历史转录（按 created_at、transcription_id 稳定排序）。"""
    rows = _block(human_result)["transcriptions"]
    return sorted(rows, key=lambda r: (r["created_at"], r["transcription_id"]))


def adopted_map(human_result: Any) -> dict[int, str]:
    """页号 -> 当前采用的 transcription_id。"""
    out: dict[int, str] = {}
    for key, value in _block(human_result)["adopted"].items():
        try:
            page = int(key)
        except ValueError as exc:
            raise TranscriptionError("ADOPTED_BAD_PAGE_KEY", f"adopted 的键不是页号：{key!r}") from exc
        out[_as_page_no(page)] = _as_uuid(value, "adopted")
    return out


def current_records(human_result: Any) -> list[dict]:
    """当前采用的转录（每页恰好一条）。

    有转录但一个 adopted 指针都没有 = 不知道该用哪一份，直接报错而不是猜
    （「必须能标出当前采用哪一份」）。指针指向不存在的转录同理。
    """
    all_records = records(human_result)
    if not all_records:
        return []
    adopted = adopted_map(human_result)
    if not adopted:
        raise TranscriptionError(
            "CURRENT_TRANSCRIPTION_UNSET",
            "存在转录但 adopted 为空：无法判断当前采用哪一份（拒绝猜测）",
        )
    by_id = {r["transcription_id"]: r for r in all_records}
    out: list[dict] = []
    for page in sorted(adopted):
        tid = adopted[page]
        record = by_id.get(tid)
        if record is None:
            raise TranscriptionError(
                "TRANSCRIPTION_DANGLING", f"第 {page} 页 adopted 指向不存在的转录 {tid}"
            )
        if record["page_no"] != page:
            raise TranscriptionError(
                "ADOPTED_PAGE_MISMATCH",
                f"adopted[{page}] 指向的转录属于第 {record['page_no']} 页",
            )
        out.append(record)
    return out


def current_for_page(human_result: Any, page_no: int) -> dict | None:
    page = _as_page_no(page_no)
    for record in current_records(human_result):
        if record["page_no"] == page:
            return record
    return None


def append_to_human_result(
    human_result: Any,
    *,
    sha256: str,
    page_no: int,
    text: str,
    actor: Any,
    created_at: Any = None,
    adopt: bool = True,
) -> tuple[dict, dict]:
    """追加一条转录，返回 ``(新的 human_result, 新记录)``。

    只追加：已有记录逐条原样保留；``human_read`` 之外的键也原样保留。
    ``adopt=True``（默认）把该页的「当前采用」指针指向新记录——这是录入者的
    显式动作，不是隐式覆盖：旧记录仍在，切回用 :func:`adopt_in_human_result`。
    """
    if not isinstance(human_result, (dict, type(None))):
        raise TranscriptionError("HUMAN_RESULT_NOT_OBJECT", "human_result 必须是 JSON 对象或 None")
    block = _block(human_result)
    record = make_record(sha256=sha256, page_no=page_no, text=text, actor=actor, created_at=created_at)
    if any(r["transcription_id"] == record["transcription_id"] for r in block["transcriptions"]):
        raise TranscriptionError("TRANSCRIPTION_DUPLICATE", f"转录 id 重复：{record['transcription_id']}")

    new_block = {
        "schema": SCHEMA,
        "transcriptions": block["transcriptions"] + [record],
        "adopted": dict(block["adopted"]),
    }
    if adopt:
        new_block["adopted"][str(record["page_no"])] = record["transcription_id"]

    merged = dict(human_result or {})
    merged[KEY] = new_block
    return merged, record


def adopt_in_human_result(
    human_result: Any, *, transcription_id: Any, actor: Any, at: Any = None
) -> dict:
    """把某一页的「当前采用」切到指定的历史转录（不改动任何转录内容）。"""
    tid = _as_uuid(transcription_id, "transcription_id")
    block = _block(human_result)
    target = next((r for r in block["transcriptions"] if r["transcription_id"] == tid), None)
    if target is None:
        raise TranscriptionError("TRANSCRIPTION_NOT_FOUND", f"找不到转录 {tid}")
    new_block = {
        "schema": SCHEMA,
        "transcriptions": block["transcriptions"],
        "adopted": dict(block["adopted"]),
        "adopted_by": _as_uuid(actor, "actor"),
        "adopted_at": _as_time(at),
    }
    new_block["adopted"][str(target["page_no"])] = tid
    merged = dict(human_result or {})
    merged[KEY] = new_block
    return merged


def summarize(human_result: Any) -> dict:
    """给审计/CLI 看的摘要（不含正文，避免把简历内容写进日志）。"""
    all_records = records(human_result)
    adopted = adopted_map(human_result)
    return {
        "schema": SCHEMA,
        "transcriptions": len(all_records),
        "pages": sorted({r["page_no"] for r in all_records}),
        "adopted_pages": sorted(adopted),
        "adopted_ids": {str(page): adopted[page] for page in sorted(adopted)},
        "actors": sorted({r["actor"] for r in all_records}),
    }


# ---------------------------------------------------------------------------
# 数据库读取：按 sha256（+ 页）跨条目查
# ---------------------------------------------------------------------------


def find(conn, sha256: str, page_no: int | None = None, *, tenant_id: Any = None) -> list[dict]:
    """按 ``source_sha256``（可选页号）查历史转录。

    返回每条转录 + 归属信息（item_id / item_status / run_id / adopted）。
    只读：不设置 actor、不写审计。``conn`` 由调用方负责生命周期，这样上层可以
    把「查转录取值 → 合并 → 放行」放进同一个读事务里。
    """
    sha = normalize_sha256(sha256)
    page = _as_page_no(page_no) if page_no is not None else None
    params: list[Any] = [sha]
    sql = """
        select q.id as item_id, q.status as item_status, q.human_result,
               r.id as run_id, r.source_sha256, r.tenant_id
          from recruitment.review_queue q
          join recruitment.conversion_run r
            on r.id = q.run_id and r.tenant_id = q.tenant_id
         where r.source_sha256 = %s
    """
    if tenant_id is not None:
        sql += " and r.tenant_id = %s"
        params.append(uuid.UUID(str(tenant_id)))
    sql += " order by q.opened_at desc, q.id"
    from psycopg.rows import dict_row

    with conn.cursor(row_factory=dict_row) as cur:
        rows = cur.execute(sql, params).fetchall()

    out: list[dict] = []
    for row in rows:
        human_result = row["human_result"]
        try:
            all_records = records(human_result)
            adopted = adopted_map(human_result)
        except TranscriptionError:
            # 某条历史数据坏了不能让整次查询哑掉：带错误标记返回，由调用方决定
            out.append(
                {
                    "transcription_id": None,
                    "sha256": sha,
                    "page_no": None,
                    "text": None,
                    "actor": None,
                    "created_at": None,
                    "source": SOURCE,
                    "item_id": str(row["item_id"]),
                    "item_status": row["item_status"],
                    "run_id": str(row["run_id"]),
                    "adopted": False,
                    "error": "HUMAN_RESULT_UNREADABLE",
                }
            )
            continue
        item_id = str(row["item_id"])
        run_id = str(row["run_id"])
        for record in all_records:
            if page is not None and record["page_no"] != page:
                continue
            out.append(
                {
                    **record,
                    "item_id": item_id,
                    "item_status": row["item_status"],
                    "run_id": run_id,
                    "adopted": adopted.get(record["page_no"]) == record["transcription_id"],
                }
            )
    return out


def iter_pages(human_result: Any) -> Iterable[dict]:
    for record in current_records(human_result):
        yield record
