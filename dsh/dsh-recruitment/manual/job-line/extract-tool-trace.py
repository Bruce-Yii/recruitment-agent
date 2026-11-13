#!/usr/bin/env python3
"""从 DSH 会话日志里抽出 `tool/call` / `tool/result` 原文（岗位线取证用）。

为什么需要它：模型在最终回答里怎么转述都不算证据；`session.v3.jsonl.zstd` 里
落盘的 `tool/call`（name + arguments）与 `tool/result`（text 原文）才是
"真实入口真的调过什么、返回了什么"的证据。

用法（PowerShell，在 dsh/dsh-recruitment 下）：

    D:\\Python3.12.9\\python.exe manual\\job-line\\extract-tool-trace.py <session-id|session.v3.jsonl.zstd>
    D:\\Python3.12.9\\python.exe manual\\job-line\\extract-tool-trace.py --list

会话根是 `$env:DSH_HOME`（默认 `D:\\12412\\dsh-home`）下的
`sessions/<cwd-encoded>/session-<id>/session.v3.jsonl.zstd`。日志可能多帧、
无 content-size，所以必须 `read_across_frames=True`（与
`manual/natural-language-acceptance.py` 的 `read_events()` 同一做法）。

输出按 `seq` 升序：先 `#<seq> tool/call <name>` 与 arguments 原文，再
`#<seq> tool/result [isError=...]` 与逐块 text 原文。脚本只读会话日志，
不写仓库、不连库、不改会话。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

try:
    import zstandard
except ImportError:  # pragma: no cover - 环境问题要明确报出来
    print('FATAL: python package "zstandard" is required', file=sys.stderr)
    raise SystemExit(2)

DSH_HOME = Path(os.environ.get('DSH_HOME', r'D:\12412\dsh-home'))
SESSIONS = DSH_HOME / 'sessions'


def read_events(path: Path) -> list[dict]:
    """解压会话日志（可能多帧、无 content-size），返回事件列表。"""
    with path.open('rb') as handle:
        raw = zstandard.ZstdDecompressor().stream_reader(handle, read_across_frames=True).read()
    events: list[dict] = []
    for line in raw.decode('utf-8').splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def walk_text(node, out: list[str]) -> None:
    """递归收集 content 里的 text 块（v3 的 tool-result 是多层嵌套）。"""
    if isinstance(node, dict):
        if node.get('type') == 'text' and isinstance(node.get('text'), str):
            out.append(node['text'])
            return
        for key, value in node.items():
            if key == 'text':
                continue
            walk_text(value, out)
    elif isinstance(node, list):
        for item in node:
            walk_text(item, out)


def result_error(message: dict) -> bool:
    """tool-result 块里的 isError（缺省 False）。"""
    for block in message.get('content') or []:
        if isinstance(block, dict) and block.get('type') == 'tool-result':
            return bool(block.get('isError'))
    return False


def resolve_session(value: str) -> Path | None:
    """会话 id / 文件名 / 绝对路径 → 日志文件。"""
    candidate = Path(value)
    if candidate.is_file():
        return candidate
    if not SESSIONS.is_dir():
        return None
    for path in sorted(SESSIONS.glob(f'*/{value}/*.jsonl.zstd')):
        return path
    for path in sorted(SESSIONS.glob(f'*/session-{value}/*.jsonl.zstd')):
        return path
    return None


def list_sessions() -> list[Path]:
    if not SESSIONS.is_dir():
        return []
    paths = list(SESSIONS.glob('*/session-*/*.jsonl.zstd'))
    paths.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    return paths


def format_arguments(arguments) -> str:
    """arguments 可能是 JSON 文本（会话里的原样），也可能是对象。"""
    if isinstance(arguments, str):
        return arguments
    return json.dumps(arguments, ensure_ascii=False, sort_keys=True)


def main() -> int:
    parser = argparse.ArgumentParser(description='Print tool/call and tool/result from a DSH session log.')
    parser.add_argument('session', nargs='?', help='session id, session file name, or absolute path')
    parser.add_argument('--list', action='store_true', help='list the newest session logs and exit')
    args = parser.parse_args()

    if args.list or args.session is None:
        paths = list_sessions()
        if not paths:
            print(f'no session logs under {SESSIONS}', file=sys.stderr)
            return 1
        for path in paths[:30]:
            print(path)
        return 0

    path = resolve_session(args.session)
    if path is None:
        print(f'FATAL: session log not found for {args.session!r} under {SESSIONS}', file=sys.stderr)
        return 2

    events = read_events(path)
    # 会话事件几乎都带 seq；缺 seq 的按原顺序兜底（稳定排序）。
    indexed = list(enumerate(events))
    indexed.sort(key=lambda pair: (pair[1].get('seq') if isinstance(pair[1].get('seq'), int) else 2**31, pair[0]))

    print(f'# session: {path}')
    print(f'# events:  {len(events)}')
    tool_events = 0
    for _index, event in indexed:
        kind = event.get('type')
        data = event.get('data') or {}
        seq = event.get('seq', '?')
        if kind == 'tool/call':
            tool_events += 1
            print('')
            print(f'# seq={seq}  tool/call  {data.get("name")}')
            print(f'  arguments: {format_arguments(data.get("arguments"))}')
        elif kind == 'tool/result':
            tool_events += 1
            message = data.get('message') or {}
            blocks: list[str] = []
            walk_text(message.get('content'), blocks)
            print('')
            print(f'# seq={seq}  tool/result  isError={str(result_error(message)).lower()}')
            text = '\n'.join(blocks)
            for line in text.splitlines() or ['']:
                print(f'  | {line}')
        elif kind == 'assistant/message':
            blocks = []
            walk_text((data.get('message') or {}).get('content'), blocks)
            text = '\n'.join(blocks)
            if text:
                print('')
                print(f'# seq={seq}  assistant/message')
                for line in text.splitlines():
                    print(f'  > {line}')

    print('')
    print(f'# tool events: {tool_events}')
    return 0 if tool_events else 1


if __name__ == '__main__':
    raise SystemExit(main())
