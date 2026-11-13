#!/usr/bin/env python3
"""S8 真实 headless 验收：一句自然语言 → 模型自己调 `recruitment_interview_schedule`
→ 再调 `recruitment_interview_get` 读回。

为什么不写步骤：本 lane 的验收要求"一句自然语言安排面试"，所以 goal 里**不提工具名、
不给调用顺序**，只给业务事实（哪条申请、第几轮、面试官是谁、什么时候、会议标识）。

证据落盘（`manual/interview-line/evidence/<时间戳>/`）：
  goal.txt            —— 逐字输入
  dsh-stdout.txt      —— headless 输出
  dsh-stderr.txt
  session-path.txt    —— 本次会话日志路径
  tool-trace.txt      —— 从会话日志抽出的 tool/call + tool/result 原文（复用 extract-session-tools.py）

用法（PowerShell，在 `dsh/dsh-recruitment` 下）：
  $env:RECRUITMENT_DB_PASSWORD='123456'
  D:\\Python3.12.9\\python.exe manual\\interview-line\\run-headless.py
  # 可选：--application <uuid> --slot S8DEMO --profile rec-agent-s8
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve()
PACKAGE = HERE.parents[2]                 # dsh/dsh-recruitment
REPO = HERE.parents[4]                    # recruitment-agent
DSH_HOME = Path(os.environ.get('DSH_HOME', r'D:\12412\dsh-home'))
DEFAULT_PROFILE = 'rec-agent-s8'
DEFAULT_APPLICATION = '11111111-1111-4111-8111-000000000701'   # ACTIVE，S7，0002_seed
INTERVIEWER = '11111111-1111-4111-8111-000000000104'           # 演示-面试官（HUMAN）
HR = '11111111-1111-4111-8111-000000000103'                    # 演示-HR 专员（HUMAN）
PY = r'D:\Python3.12.9\python.exe'


def iso_now() -> str:
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def next_wednesday_after(today: datetime) -> datetime:
    """自然语言里的"下周三"：严格在下一周（周一为起点）的周三。"""
    days_to_next_monday = 7 - today.weekday()
    next_monday = (today + timedelta(days=days_to_next_monday)).replace(
        hour=0, minute=0, second=0, microsecond=0)
    return next_monday + timedelta(days=2)


def build_goal(application: str, slot: str, external_id: str, today: datetime) -> str:
    wednesday = next_wednesday_after(today)
    return (
        f'给招聘系统里的这条申请安排一场面试：application_id={application}，第 1 轮，'
        f'场次代码 {slot}。面试官是「演示-面试官」（actor_id={INTERVIEWER}）和'
        f'「演示-HR 专员」（actor_id={HR}），两人都要交面评。'
        f'时间是下周三下午两点（今天是 {today:%Y-%m-%d} 周{"一二三四五六日"[today.weekday()]}），'
        f'时长 60 分钟，线上视频面试。会议先按飞书会议登记：provider=FEISHU，'
        f'external_meeting_id={external_id}。排好后用读工具把这场面试回读给我确认，'
        f'我需要看到时间、面试官和会议绑定。全程自己决定怎么做，不要问我。'
    )


def find_session(started_ms: int, marker: str) -> Path | None:
    """找本次会话日志：user/message 里出现 marker，且 mtime 足够新。"""
    best: tuple[int, Path] | None = None
    root = DSH_HOME / 'sessions'
    if not root.is_dir():
        return None
    for path in root.glob('*/session-*/*.jsonl.zstd'):
        try:
            if path.stat().st_mtime * 1000 < started_ms - 5000:
                continue
            import zstandard
            with path.open('rb') as handle:
                raw = zstandard.ZstdDecompressor().stream_reader(
                    handle, read_across_frames=True).read()
            text = raw.decode('utf-8', errors='replace')
        except Exception:
            continue
        if marker in text:
            score = path.stat().st_mtime_ns
            if best is None or score > best[0]:
                best = (score, path)
    return None if best is None else best[1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', default=DEFAULT_PROFILE)
    parser.add_argument('--application', default=DEFAULT_APPLICATION)
    parser.add_argument('--slot', default=None, help='缺省按当前时分生成，避免 uq_interview_slot')
    parser.add_argument('--goal', default=None)
    parser.add_argument('--timeout', type=int, default=900)
    args = parser.parse_args()

    password = os.environ.get('RECRUITMENT_DB_PASSWORD')
    if not password:
        print('FATAL: $env:RECRUITMENT_DB_PASSWORD 未设置', file=sys.stderr)
        return 2

    today = datetime.now()
    stamp = today.strftime('%Y%m%d-%H%M%S')
    slot = args.slot or f'S8T{today:%H%M}'
    external_id = f'feishu-s8-demo-{stamp}'
    goal = args.goal or build_goal(args.application, slot, external_id, today)

    out_dir = HERE.parent / 'evidence' / stamp
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / 'goal.txt').write_text(goal + '\n', encoding='utf-8')

    env = dict(os.environ)
    env['DSH_HOME'] = str(DSH_HOME)
    env['NL_GOAL'] = goal
    command = f'dsh --profile {args.profile} $env:NL_GOAL'
    print(f'[{iso_now()}] running: {command}')
    print(f'[{iso_now()}] goal: {goal}')
    started_ms = int(today.timestamp() * 1000)
    completed = subprocess.run(
        ['pwsh', '-NoProfile', '-Command', command],
        cwd=str(REPO), env=env, capture_output=True, timeout=args.timeout,
    )
    stdout = completed.stdout.decode('utf-8', errors='replace')
    stderr = completed.stderr.decode('utf-8', errors='replace')
    (out_dir / 'dsh-stdout.txt').write_text(stdout, encoding='utf-8')
    (out_dir / 'dsh-stderr.txt').write_text(stderr, encoding='utf-8')
    print(f'[{iso_now()}] dsh exit={completed.returncode}')

    session = find_session(started_ms, slot)
    if session is None:
        print('FATAL: 找不到本次会话日志（会话里没有出现 slot 标记）', file=sys.stderr)
        print(stdout[-2000:], file=sys.stderr)
        return 3
    (out_dir / 'session-path.txt').write_text(str(session) + '\n', encoding='utf-8')
    print(f'[{iso_now()}] session: {session}')

    trace = subprocess.run(
        [PY, str(PACKAGE / 'manual' / 'extract-session-tools.py'), str(session)],
        capture_output=True, text=True, encoding='utf-8',
    )
    (out_dir / 'tool-trace.txt').write_text(trace.stdout + ('\n--- stderr ---\n' + trace.stderr if trace.stderr else ''),
                                            encoding='utf-8')
    print(trace.stdout[-12000:])
    print(f'[{iso_now()}] evidence: {out_dir}')
    return completed.returncode


if __name__ == '__main__':
    raise SystemExit(main())
