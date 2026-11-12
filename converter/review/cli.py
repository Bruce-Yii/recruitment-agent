"""命令行：人工兜底队列 + 阻断检查（doc 12 §2④）。

用法（在 ``converter/`` 目录下）::

    set REVIEW_DSN=postgresql://postgres@127.0.0.1:5432/ra_review_check
    set REVIEW_SYSTEM_ACTOR_ID=<机器侧 actor uuid>

    python -m review.cli enqueue --run-id <uuid> --reason "pdf_no_text：纯图像页"
    python -m review.cli list
    python -m review.cli claim <item> --assignee <actor> --actor <actor>
    python -m review.cli submit <item> --page 2 --text-file page2.txt --actor <actor>
    python -m review.cli approve <item> --reason "逐页核对无误，放行" --actor <actor>
    python -m review.cli reject  <item> --reason "原件损坏，无法读取" --actor <actor>
    python -m review.cli check-blocking <application-or-candidate> [--json]

退出码（便于脚本把「阻断」当门禁）：
    0 成功 / 未阻断
    2 输入不合法（ValidationError）
    3 被阻断（仅 ``check-blocking``）
    4 业务冲突 / 找不到（NotFound / Conflict / IllegalTransition）
    1 其它错误

``--text`` 在 Windows 控制台可能被代码页改写；正文请优先用 ``--text-file``
（UTF-8），或 ``--text -`` 从标准输入读。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from . import blocking, merge_human, queue, transcription

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_USAGE = 2
EXIT_BLOCKED = 3
EXIT_CONFLICT = 4


def _print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, default=str))


def _print_rows(rows: list[dict], columns: list[str]) -> None:
    if not rows:
        print("(empty)")
        return
    widths = {column: len(column) for column in columns}
    for row in rows:
        for column in columns:
            widths[column] = max(widths[column], len(str(row.get(column, ""))))
    header = "  ".join(column.ljust(widths[column]) for column in columns)
    print(header)
    print("-" * len(header))
    for row in rows:
        print("  ".join(str(row.get(column, "")).ljust(widths[column]) for column in columns))


# ---------------------------------------------------------------------------
# 子命令
# ---------------------------------------------------------------------------


def _cmd_enqueue(args, conn) -> int:
    item_id = queue.enqueue(
        args.run_id,
        args.reason,
        deadline_hours=args.deadline_hours,
        actor=args.actor,
        conn=conn,
    )
    item = queue.get_item(item_id, conn=conn)
    if args.json:
        _print_json(item)
    else:
        print(f"item_id: {item_id}")
        print(f"status:  {item['status']}")
        print(f"deadline:{item['deadline']}")
        print(f"reason:  {item['reason']}")
    return EXIT_OK


def _cmd_list(args, conn) -> int:
    rows = queue.list_pending(
        statuses=tuple(args.status) if args.status else queue.OPEN_STATES,
        overdue_only=args.overdue,
        tenant_id=args.tenant,
        conn=conn,
    )
    if args.json:
        _print_json(rows)
    else:
        _print_rows(
            rows,
            ["item_id", "status", "deadline", "overdue", "run_status", "source_name", "age_hours"],
        )
    return EXIT_OK


def _cmd_claim(args, conn) -> int:
    row = queue.claim(args.item_id, args.assignee, actor=args.actor, conn=conn)
    if args.json:
        _print_json(row)
    else:
        print(f"item_id: {row['item_id']}  status: {row['status']}  assignee: {row['assignee']}")
    return EXIT_OK


def _read_text(args) -> str:
    if args.text_file and args.text not in (None, ""):
        raise queue.ValidationError("TEXT_AMBIGUOUS", "同时给了 --text 和 --text-file")
    if args.text_file == "-" or args.text == "-":
        return sys.stdin.read()
    if args.text_file:
        return Path(args.text_file).read_text(encoding="utf-8")
    if args.text is not None:
        return args.text
    raise queue.ValidationError("TEXT_REQUIRED", "需要 --text 或 --text-file（UTF-8）")


def _cmd_submit(args, conn) -> int:
    result = queue.submit_correction(
        args.item_id,
        args.page,
        _read_text(args),
        args.actor,
        adopt=not args.no_adopt,
        conn=conn,
    )
    if args.json:
        _print_json(result)
    else:
        record = result["transcription"]
        print(f"item_id:  {result['item_id']}")
        print(f"status:   {result['status']}")
        print(f"page:     {record['page_no']}")
        print(f"actor:    {record['actor']}")
        print(f"current:  pages {result['current_pages']} (共 {result['transcriptions']} 条转录)")
    return EXIT_OK


def _cmd_decision(target: str):
    def run(args, conn) -> int:
        row = (
            queue.approve(args.item_id, args.actor, args.reason, conn=conn)
            if target == "APPROVED"
            else queue.reject(args.item_id, args.actor, args.reason, conn=conn)
        )
        if args.json:
            _print_json(row)
        else:
            print(f"item_id: {row['item_id']}  status: {row['status']}  closed_at: {row['closed_at']}")
        return EXIT_OK

    return run


def _cmd_check_blocking(args, conn) -> int:
    open_states = (
        ("QUEUED", "IN_REVIEW") if args.treat_corrected_as_resolved else blocking.DEFAULT_OPEN_STATES
    )
    report = blocking.evaluate(args.subject_id, conn=conn, open_states=open_states)
    if args.json:
        _print_json(report)
    else:
        print(f"subject: {report['subject_id']} ({report['subject_type']})")
        print(f"policy:  open_states={report['policy']['open_states']}")
        print(f"blocked: {report['blocked']}")
        if report["reasons"]:
            print("reasons:")
            for reason in report["reasons"]:
                print(
                    f"  - [{reason['code']}] {reason['message']}"
                    f" (item={reason['item_id']}, deadline={reason['deadline']},"
                    f" overdue={reason['overdue']})"
                )
        else:
            print("reasons: (none — 放行)")
    return EXIT_BLOCKED if report["blocked"] else EXIT_OK


def _cmd_merge(args, conn) -> int:
    merged = merge_human.merge_for_item(
        args.item_id,
        conn=conn,
        merged_by=args.actor,
    )
    if args.out:
        Path(args.out).write_text(
            json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"merged: {args.out}")
    elif args.json:
        _print_json(merged)
    else:
        meta = merged["human_read_merge"]
        print(
            f"blocks: {len(merged['blocks'])} (native {meta['native_blocks']}, "
            f"human {meta['human_blocks']}), "
            f"completeness: {merged.get('completeness')} (机器值未改)"
        )
        for entry in merged.get("human_read_applied") or []:
            print(f"  + page {entry['page']} <- {entry['transcription_id']} (block #{entry['block_index']})")
        for resolution in merged.get("issue_resolutions") or []:
            print(
                f"  ! issue {resolution.get('code')} page {resolution.get('page')}"
                f" -> {resolution.get('status')} ({resolution.get('basis')})"
            )
    return EXIT_OK


def _cmd_show(args, conn) -> int:
    item = queue.get_item(args.item_id, conn=conn)
    if args.json:
        _print_json(item)
    else:
        print(f"item_id: {item['item_id']}")
        print(f"status:  {item['status']}  assignee: {item['assignee']}")
        print(f"run:     {item['run_id']} ({item['run_status']}, {item['completeness']})")
        print(f"source:  {item['source_name']}  sha256={item['source_sha256']}")
        print(f"deadline:{item['deadline']}  opened={item['opened_at']}  closed={item['closed_at']}")
        print(f"reason:  {item['reason']}")
        print("machine_result:", json.dumps(item["machine_result"], ensure_ascii=False, indent=2))
        summary = transcription.summarize(item.get("human_result"))
        print("human_result:", json.dumps(summary, ensure_ascii=False, indent=2))
    return EXIT_OK


def _cmd_transcriptions(args, conn) -> int:
    if args.sha256:
        rows = transcription.find(conn, args.sha256, args.page)
        if args.json:
            _print_json(rows)
        else:
            _print_rows(rows, ["item_id", "item_status", "page_no", "actor", "created_at", "adopted"])
        return EXIT_OK
    if not args.item_id:
        raise queue.ValidationError("ARG_REQUIRED", "需要 item_id 或 --sha256")
    result = queue.list_transcriptions(args.item_id, conn=conn)
    if args.json:
        _print_json(result)
    else:
        _print_rows(
            result["records"], ["transcription_id", "page_no", "actor", "created_at"]
        )
        print("summary:", json.dumps(result["summary"], ensure_ascii=False))
    return EXIT_OK


def _cmd_audit(args, conn) -> int:
    rows = queue.list_audit(args.item_id, conn=conn)
    if args.json:
        _print_json(rows)
    else:
        _print_rows(rows, ["audit_seq", "from_status", "to_status", "actor_name", "reason", "at"])
    return EXIT_OK


# ---------------------------------------------------------------------------
# 参数
# ---------------------------------------------------------------------------


def _add_actor(p: argparse.ArgumentParser) -> None:
    """子命令上也允许写 --actor（不写则沿用全局 --actor）。

    ``default=argparse.SUPPRESS`` 让子命令不覆盖父命令已经解析到的值。
    """
    p.add_argument("--actor", default=argparse.SUPPRESS, help="本次操作的 actor uuid")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m review.cli",
        description="人工兜底队列 / 人工转录 / 阻断检查（doc 12 §2④）",
    )
    parser.add_argument("--dsn", default=None, help="PostgreSQL DSN（默认取 REVIEW_DSN / libpq 环境变量）")
    parser.add_argument("--actor", default=None, help="本次操作的 actor uuid（人工操作必填）")
    parser.add_argument("--json", action="store_true", help="机器可读输出")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("enqueue", help="把一个非 ACCEPTED 的 run 入队")
    p.add_argument("--run-id", required=True)
    p.add_argument("--reason", required=True)
    p.add_argument("--deadline-hours", type=float, default=24)
    _add_actor(p)
    p.set_defaults(func=_cmd_enqueue)

    p = sub.add_parser("list", help="待处理清单（v_review_open）")
    p.add_argument("--status", action="append", choices=list(queue.OPEN_STATES))
    p.add_argument("--overdue", action="store_true", help="只看超过 deadline 的")
    p.add_argument("--tenant", default=None)
    p.set_defaults(func=_cmd_list)

    p = sub.add_parser("claim", help="QUEUED → IN_REVIEW")
    p.add_argument("item_id")
    p.add_argument("--assignee", required=True)
    _add_actor(p)
    p.set_defaults(func=_cmd_claim)

    p = sub.add_parser("submit", help="录入一页人工转录（IN_REVIEW → CORRECTED）")
    p.add_argument("item_id")
    p.add_argument("--page", type=int, required=True)
    p.add_argument("--text", default=None, help="转录正文（- 表示从 stdin 读）")
    p.add_argument("--text-file", default=None, help="UTF-8 文件路径（- 表示 stdin）")
    p.add_argument("--no-adopt", action="store_true", help="只记录，不把该页「当前采用」指向本条")
    _add_actor(p)
    p.set_defaults(func=_cmd_submit)

    p = sub.add_parser("approve", help="IN_REVIEW|CORRECTED → APPROVED")
    p.add_argument("item_id")
    p.add_argument("--reason", required=True)
    _add_actor(p)
    p.set_defaults(func=_cmd_decision("APPROVED"))

    p = sub.add_parser("reject", help="IN_REVIEW|CORRECTED → REJECTED")
    p.add_argument("item_id")
    p.add_argument("--reason", required=True)
    _add_actor(p)
    p.set_defaults(func=_cmd_decision("REJECTED"))

    p = sub.add_parser("check-blocking", help="该对象现在能不能进自动筛选")
    p.add_argument("subject_id")
    p.add_argument(
        "--treat-corrected-as-resolved",
        action="store_true",
        help="按任务书字面口径：CORRECTED 也放行（默认与 v_source_gate 一致，CORRECTED 仍阻断）",
    )
    p.set_defaults(func=_cmd_check_blocking)

    p = sub.add_parser("merge", help="把当前采用的人工转录并进机器结果")
    p.add_argument("item_id")
    p.add_argument("--out", default=None, help="把合并结果写到该路径（UTF-8 JSON）")
    _add_actor(p)
    p.set_defaults(func=_cmd_merge)

    p = sub.add_parser("show", help="单条详情（机器摘要 + 人工摘要，不打印正文）")
    p.add_argument("item_id")
    p.set_defaults(func=_cmd_show)

    p = sub.add_parser("transcriptions", help="按条目或 sha256(+页) 查人工转录")
    p.add_argument("item_id", nargs="?")
    p.add_argument("--sha256", default=None)
    p.add_argument("--page", type=int, default=None)
    p.set_defaults(func=_cmd_transcriptions)

    p = sub.add_parser("audit", help="逐条查回审计")
    p.add_argument("item_id")
    p.set_defaults(func=_cmd_audit)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    conn = None
    try:
        conn = queue.connect(args.dsn)
        return args.func(args, conn)
    except queue.ValidationError as exc:
        print(f"ERROR [{exc.code}] {exc.message}", file=sys.stderr)
        return EXIT_USAGE
    except queue.ReviewError as exc:
        print(f"ERROR [{exc.code}] {exc.message}", file=sys.stderr)
        return EXIT_CONFLICT
    except (merge_human.MergeError, ValueError) as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        return EXIT_USAGE
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # pragma: no cover - 兜底，避免栈信息淹没错误码
        print(f"ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_ERROR
    finally:
        if conn is not None:
            conn.close()


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
