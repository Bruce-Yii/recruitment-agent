"""从 DSH 会话日志里抽取 tool/call 与 tool/result 原文（R2 取证用）。

为什么要单独写：模型在回答里怎么转述都不算证据，`session.v3.jsonl.zstd` 里
落盘的 tool/call + tool/result 才是运行入口真的调过工具的证据。

用法：
  D:\\Python3.12.9\\python.exe manual\\extract-session-tools.py <session.v3.jsonl.zstd>

输出对手机号 / 邮箱 / 姓名做**打码**（R7：证据文件不留真实候选人资料）。
"""
from __future__ import annotations

import json
import re
import sys

import zstandard

MASK_PATTERNS = [
    (re.compile(r'(?<!\d)1[3-9]\d{9}(?!\d)'), '[手机号已打码]'),
    (re.compile(r'\+?86[-\s]?1[3-9]\d{9}'), '[手机号已打码]'),
    (re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'), '[邮箱已打码]'),
    (re.compile(r'1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}'), '[手机号已打码]'),
]


def mask(text: str) -> str:
    out = text
    for pattern, replacement in MASK_PATTERNS:
        out = pattern.sub(replacement, out)
    return out


def main() -> int:
    if len(sys.argv) < 2:
        print('usage: extract-session-tools.py <session.v3.jsonl.zstd>', file=sys.stderr)
        return 2
    path = sys.argv[1]
    with open(path, 'rb') as handle:
        # 会话日志可能由「无 content-size 的帧」流式写出，所以用流式解压而不是一次性解压。
        reader = zstandard.ZstdDecompressor().stream_reader(handle, read_across_frames=True)
        raw = reader.read()
    events = []
    for line in raw.decode('utf-8').splitlines():
        line = line.strip()
        if line == '':
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    calls = 0
    results = 0
    # tool/result 事件本身不带工具名（name 为空），只有 callId。
    # 所以先从 tool/call 建 callId -> name 的映射，再按映射筛结果。
    call_names = {}
    for event in events:
        if event.get('type') != 'tool/call':
            continue
        data = event.get('data') or {}
        if isinstance(data.get('callId'), str):
            call_names[data['callId']] = str(data.get('name') or '')
    wanted = {call_id for call_id, name in call_names.items() if name.startswith('recruitment_')}

    def result_call_id(data):
        source = ((data.get('message') or {}).get('source') or {})
        if isinstance(source.get('callId'), str):
            return source['callId']
        content = (data.get('message') or {}).get('content') or []
        for block in content if isinstance(content, list) else []:
            if isinstance(block, dict) and isinstance(block.get('toolCallId'), str):
                return block['toolCallId']
        return None

    for event in events:
        kind = event.get('type')
        if kind not in ('tool/call', 'tool/result'):
            continue
        data = event.get('data') or {}
        name = data.get('name') or ''
        call_id = data.get('callId') or data.get('call_id') or (result_call_id(data) if kind == 'tool/result' else None)
        if kind == 'tool/call' and name.startswith('recruitment_'):
            calls += 1
            print(f'--- tool/call #{calls} ---')
            print(mask(json.dumps({
                'name': name,
                'callId': call_id,
                'arguments': data.get('arguments'),
            }, ensure_ascii=False)))
            continue
        if kind == 'tool/result' and call_id in wanted:
            results += 1
            print(f'--- tool/result #{results} (call={call_id}, tool={call_names.get(call_id)}) ---')
            print(mask(json.dumps({
                'callId': call_id,
                'isError': (data.get('message') or {}).get('isError'),
                'content': data.get('message') or data.get('content'),
            }, ensure_ascii=False)))
    print(f'=== tool/call={calls} tool/result={results} ===')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
