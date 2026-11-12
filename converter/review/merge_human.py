"""把人工转录并进转换器输出（doc 12 §2④ HUM-05；D-29 的同一口径）。

合并语义与 `fallback/merge.py`（③ 模型层的合并）保持一致的方向：

1. **只追加**：每条采用中的转录变成一个新的 ``paragraph`` block，
   ``provenance="human_read"``，``location={page, bbox: null}``
   （人工读的是整页，不伪造坐标）。
2. **不覆盖原生 block**：原生 block 逐字段原样保留在数组前部；合并前后做
   快照比对，任何改动直接报错而不是「悄悄修好」。
3. **`text` 一字不改**：与 `fallback/merge.py` 相同，原生正文保持可做
   doc 11 A2 保真校验；人工文本另给 ``text_with_human_read``，并标
   ``text_native_only=True``，避免下游把派生正文当原生正文。
4. **不改机器判定**：``completeness`` / ``needs_visual`` / ``fields`` 保持机器值；
   人工证据放在 ``human_read_applied`` 与 ``human_read_merge`` 里。
5. **不删 issue**：原始 ``issues`` 原样保留；被人工读过的页上的 issue 另记一条
   ``issue_resolutions``（``status="resolved_by_human"``），旧记录不消失。
6. **幂等**：同一条转录重复合并会被跳过（``skipped_already_applied``），
   重跑不会堆出重复 block。
7. **不修改入参**：内部深拷贝，返回新对象，调用方可以对照前后两份。

机器原文仍然在 ``conversion_run.result_json``（0003 禁止 UPDATE 整行），
本函数产出的是**派生文档**，不是新的事实源。
"""

from __future__ import annotations

import copy
import hashlib
import uuid
from datetime import datetime, timezone
from typing import Any, Iterable

from . import queue, transcription

HUMAN_PROVENANCE = "human_read"
MACHINE_BLOCK_KEYS = ("kind", "text", "location", "links", "provenance")


def _text_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class MergeError(ValueError):
    """合并失败。``code`` 稳定可断言。"""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def _now(value: Any) -> str:
    if value is None:
        return datetime.now(timezone.utc).isoformat(timespec="microseconds")
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat(timespec="microseconds")
    if isinstance(value, str):
        return value
    raise MergeError("MERGED_AT_INVALID", f"merged_at 类型不支持：{type(value).__name__}")


def _native_snapshot(blocks: list[dict]) -> list[dict]:
    """原生 block 的保真快照：只比契约字段，忽略调用方自己加的扩展键。"""
    return [{key: block.get(key) for key in MACHINE_BLOCK_KEYS} for block in blocks]


def _human_block(record: dict) -> dict:
    """人工转录 → 一个契约内的新 block（不多塞字段，避免下游 schema 校验炸）。"""
    return {
        "kind": "paragraph",
        "text": record["text"],
        "location": {"page": record["page_no"], "bbox": None},
        "links": [],
        "provenance": HUMAN_PROVENANCE,
    }


def _issue_page(issue: Any) -> int | None:
    if not isinstance(issue, dict):
        return None
    location = issue.get("location")
    if not isinstance(location, dict):
        return None
    page = location.get("page")
    return page if isinstance(page, int) and not isinstance(page, bool) else None


def merge(
    result: dict,
    transcriptions: Iterable[dict],
    *,
    item_id: Any = None,
    run_id: Any = None,
    merged_by: Any = None,
    merged_at: Any = None,
    resolutions: Iterable[dict] | None = None,
    auto_resolve_page_issues: bool = True,
) -> dict:
    """返回合并后的新结果（不落库、不修改 ``result``）。"""
    if not isinstance(result, dict):
        raise MergeError("RESULT_NOT_OBJECT", "转换器输出必须是 JSON 对象")
    blocks = result.get("blocks")
    if not isinstance(blocks, list):
        raise MergeError("RESULT_BLOCKS_MISSING", "转换器输出缺少 blocks 数组")

    records = [transcription.validate_record(record) for record in transcriptions]
    pages = [record["page_no"] for record in records]
    if len(set(pages)) != len(pages):
        duplicates = sorted({page for page in pages if pages.count(page) > 1})
        raise MergeError(
            "DUPLICATE_PAGE_TRANSCRIPTION",
            f"同一页传入了多份转录（页 {duplicates}）：先按 adopted 选一份再合并",
        )

    out = copy.deepcopy(result)
    source_sha = ((out.get("meta") or {}).get("source_sha256") if isinstance(out.get("meta"), dict) else None)
    if source_sha:
        for record in records:
            if record["sha256"] != source_sha:
                raise MergeError(
                    "SHA256_MISMATCH",
                    f"转录 {record['transcription_id']} 属于 {record['sha256']}，"
                    f"但转换器输出是 {source_sha}",
                )

    applied = out.get("human_read_applied") or []
    if not isinstance(applied, list):
        raise MergeError("HUMAN_READ_APPLIED_BAD_SHAPE", "human_read_applied 必须是数组")
    already = {
        entry.get("transcription_id")
        for entry in applied
        if isinstance(entry, dict) and entry.get("transcription_id")
    }

    native = _native_snapshot(blocks)
    native_count = len(blocks)
    merged_at_text = _now(merged_at)
    appended: list[dict] = []
    skipped: list[dict] = []

    for record in sorted(records, key=lambda r: (r["page_no"], r["created_at"], r["transcription_id"])):
        if record["transcription_id"] in already:
            skipped.append(
                {
                    "transcription_id": record["transcription_id"],
                    "page": record["page_no"],
                    "reason": "ALREADY_APPLIED",
                }
            )
            continue
        out["blocks"].append(_human_block(record))
        entry = {
            "transcription_id": record["transcription_id"],
            "sha256": record["sha256"],
            "page": record["page_no"],
            "actor": record["actor"],
            "created_at": record["created_at"],
            "source": HUMAN_PROVENANCE,
            "applied": True,
            "chars": len(record["text"]),
            "text_sha256": _text_sha256(record["text"]),
            "location": {"page": record["page_no"], "bbox": None},
            "block_index": len(out["blocks"]) - 1,
        }
        applied.append(entry)
        appended.append(entry)

    # 原生 block 必须一个字符都没变；变了就是 bug，不许带着错误继续往下走
    if _native_snapshot(out["blocks"][:native_count]) != native:
        raise MergeError("NATIVE_BLOCKS_CHANGED", "合并过程改动了原生 block（必须保持原样）")

    out["human_read_applied"] = applied

    # 原始 issue 保留；被人工读过页上的 issue 另记「已解决」事实（不是删除/改写）
    existing_resolutions = out.get("issue_resolutions") or []
    if not isinstance(existing_resolutions, list):
        raise MergeError("ISSUE_RESOLUTIONS_BAD_SHAPE", "issue_resolutions 必须是数组")
    resolutions_out: list[dict] = list(existing_resolutions)
    seen = {
        (entry.get("issue_index"), entry.get("code"), entry.get("page"), entry.get("transcription_id"))
        for entry in resolutions_out
        if isinstance(entry, dict)
    }
    pages_applied = {entry["page"] for entry in appended}
    by_page = {entry["page"]: entry for entry in appended}
    if auto_resolve_page_issues:
        for index, issue in enumerate(out.get("issues") or []):
            page = _issue_page(issue)
            if page is None or page not in pages_applied:
                continue
            entry = by_page[page]
            key = (index, issue.get("code"), page, entry["transcription_id"])
            if key in seen:
                continue
            resolved = {
                "issue_index": index,
                "code": issue.get("code"),
                "page": page,
                "status": "resolved_by_human",
                "basis": "human_transcribed_page",
                "transcription_id": entry["transcription_id"],
                "actor": entry["actor"],
                "resolved_at": merged_at_text,
            }
            resolutions_out.append(resolved)
            seen.add(key)
    for resolution in resolutions or []:
        if not isinstance(resolution, dict):
            raise MergeError("RESOLUTION_NOT_OBJECT", "resolutions 的每一项必须是对象")
        item = {
            "code": resolution.get("code"),
            "page": resolution.get("page"),
            "status": resolution.get("status", "resolved_by_human"),
            "basis": resolution.get("basis", "explicit"),
            "actor": resolution.get("actor"),
            "note": resolution.get("note"),
            "resolved_at": resolution.get("resolved_at", merged_at_text),
        }
        key = (resolution.get("issue_index"), item["code"], item["page"], resolution.get("transcription_id"))
        if key in seen:
            continue
        resolutions_out.append(item)
        seen.add(key)
    if resolutions_out:
        out["issue_resolutions"] = resolutions_out

    # 正文与 blocks 分离（与 fallback/merge.py 同口径）：
    # ``text`` 保持原生正文不动（doc 11 A2 保真校验仍成立），
    # 人工文本只出现在 ``text_with_human_read`` 与带 provenance 的 block 里。
    if appended:
        additions = [out["blocks"][entry["block_index"]]["text"] for entry in appended]
        base = out.get("text") or ""
        addition = "\n\n".join(additions)
        out["text_with_human_read"] = f"{base}\n\n{addition}".strip() if base.strip() else addition
    out["text_native_only"] = True
    out["human_read_skipped"] = skipped

    warnings = out.get("warnings") if isinstance(out.get("warnings"), list) else []
    warnings = list(warnings)
    for entry in appended:
        warnings.append(
            f"human_read_applied: page {entry['page']} "
            f"({entry['chars']} chars, transcription={entry['transcription_id']}, bbox=null)"
        )
    for entry in skipped:
        warnings.append(
            f"human_read_skipped: page {entry['page']} "
            f"[{entry['reason']}] transcription={entry['transcription_id']}"
        )
    out["warnings"] = warnings

    out["human_read_merge"] = {
        "schema": "human_read_merge/v1",
        "item_id": str(item_id) if item_id is not None else None,
        "run_id": str(run_id) if run_id is not None else None,
        "merged_by": str(merged_by) if merged_by is not None else None,
        "merged_at": merged_at_text,
        "native_blocks": native_count,
        "human_blocks": len(appended),
        "applied_pages": [entry["page"] for entry in appended],
        "skipped_already_applied": [entry["transcription_id"] for entry in skipped],
        "machine_completeness": result.get("completeness"),
        "completeness_unchanged": out.get("completeness"),
        "needs_visual_unchanged": out.get("needs_visual"),
        "machine_chars": result.get("chars"),
        "text_native_only": True,
    }
    return out


def merge_for_item(
    item_id: Any,
    *,
    conn: Any = None,
    merged_by: Any = None,
    merged_at: Any = None,
    resolutions: Iterable[dict] | None = None,
    auto_resolve_page_issues: bool = True,
) -> dict:
    """按队列条目组装并合并：读机器原文 + 读当前采用的转录。

    只允许在人工写过结论之后调用（``CORRECTED`` / ``APPROVED`` / ``REJECTED``）；
    ``QUEUED`` / ``IN_REVIEW`` 直接拒绝——没补正就合并等于把空内容当人工结果。
    """
    item = queue.get_item(item_id, conn=conn)
    status = item["status"]
    if status not in ("CORRECTED", "APPROVED", "REJECTED"):
        raise queue.Conflict(
            "QUEUE_NOT_CORRECTED",
            f"条目状态 {status} 还没有人工结论，不能合并",
        )
    current = transcription.current_records(item.get("human_result"))
    if not current:
        raise queue.Conflict("NO_CURRENT_TRANSCRIPTION", "条目没有当前采用的转录，不能合并")
    result_json = item.get("result_json")
    if not isinstance(result_json, dict):
        raise MergeError("MACHINE_RESULT_MISSING", f"run {item['run_id']} 没有 result_json（机器原文）")

    return merge(
        result_json,
        current,
        item_id=item["item_id"],
        run_id=item["run_id"],
        merged_by=merged_by,
        merged_at=merged_at,
        resolutions=resolutions,
        auto_resolve_page_issues=auto_resolve_page_issues,
    )


def merge_source_sha(result: dict) -> str | None:
    """小工具：读转换器输出里声明的源文件 sha256（没有就返回 None）。"""
    meta = result.get("meta") if isinstance(result, dict) else None
    if isinstance(meta, dict):
        value = meta.get("source_sha256")
        return value if isinstance(value, str) else None
    return None


def block_key(block: dict) -> tuple:
    """测试/审计用的 block 身份键（不含人工扩展字段）。"""
    return tuple(_freeze(block.get(key)) for key in MACHINE_BLOCK_KEYS)


def _freeze(value: Any) -> Any:
    if isinstance(value, dict):
        return tuple(sorted((k, _freeze(v)) for k, v in value.items()))
    if isinstance(value, list):
        return tuple(_freeze(v) for v in value)
    if isinstance(value, uuid.UUID):
        return str(value)
    return value
