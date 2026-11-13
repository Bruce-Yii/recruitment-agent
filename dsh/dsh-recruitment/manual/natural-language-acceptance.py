#!/usr/bin/env python3
"""自然语言验收（S6 简历入库 → S7 初筛）：只给一句目标，跑真实 headless 会话，
再从**会话日志**里数它读了几次源码。

为什么必须看会话日志：模型在回答里怎么转述都不算证据；`session.*.jsonl.zstd` 里
落盘的 `tool/call` / `tool/result` 才是"运行入口真的调过什么"的证据。

用法（PowerShell，在 dsh/dsh-recruitment 下）：

    $env:RECRUITMENT_DB_PASSWORD='123456'
    D:\\Python3.12.9\\python.exe manual\\natural-language-acceptance.py            # 跑一次并分析
    D:\\Python3.12.9\\python.exe manual\\natural-language-acceptance.py --session <session-id|jsonl.zstd>  # 只分析已有会话

做四件事：
  1. preflight：密码环境变量、PG 可连、岗位存在、PDF 在允许根内；
  2. 用**一句自然语言目标**启动 `dsh --profile <profile>`（不提工具名、不给步骤），
     stdout 落盘；
  3. 定位本次会话日志（按 user/message 里的 PDF 文件名认领，避免抓到别的 lane 的会话）；
  4. 统计：读了哪些工具、读了几次 `src/tools/*.ts`、`evidence/*.md`，并抽取
     job_get / intake / screening 的 `tool/result` 原文与最终 HR 报告，写到
     `manual/acceptance/<时间戳>/`。

判定（全部 PASS 才 exit 0）：
  A skill 被加载（`skill` 工具，名字 recruitment-s6-s7）；
  B 五个业务工具都被调用（job_get / serialize / validate / intake / screening）；
  C job_get 用的是真实 UUID，且返回真实岗位 + rubric；
  D intake 返回三态字段（application_action / structure_saved）；
  E screening 返回 verdict + criteria_evaluated；
  F `src/tools/*.ts` 读取次数 = 0（硬指标），`evidence/*.md` 读取次数 = 0；
  G 最终报告含三态业务词（新建/复用、已保存/未保存、已得出/证据不足）；
  H 最终报告不泄漏内部实现词（见 LEAK_PATTERNS）。

边界：脚本只读会话日志，不改仓库、不写数据库（写库由被测的 intake 工具自己做）。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

try:
    import zstandard
except ImportError:  # pragma: no cover - 环境问题要明确报出来
    print('FATAL: python package "zstandard" is required', file=sys.stderr)
    raise SystemExit(2)

# ---------------------------------------------------------------------------
#  常量与路径
# ---------------------------------------------------------------------------
HERE = Path(__file__).resolve()
PACKAGE = HERE.parents[1]                  # dsh/dsh-recruitment
REPO = HERE.parents[3]                     # recruitment-agent
PLUGIN_SRC = PACKAGE / 'src'
DSH_HOME = Path(os.environ.get('DSH_HOME', r'D:\12412\dsh-home'))
DEFAULT_PROFILE = 'rec-agent-test'
DEMO_JOB = '11111111-1111-4111-8111-000000000401'
DEFAULT_PDF = Path(os.environ.get('TEMP', r'C:\Users\12412\AppData\Local\Temp')) \
    / 'recruitment-r7-synthetic' / 'synthetic-resume-text.pdf'
REQUIRED_TOOLS = [
    'recruitment_job_get',
    'recruitment_resume_serialize',
    'recruitment_structure_validate',
    'recruitment_application_intake',
    'recruitment_screening_evaluate',
]
# 报告里不该出现的内部实现词（出现即视为"把技术细节丢给 HR"）。
LEAK_PATTERNS = [
    (r'\brecord_version\b', 'record_version'),
    (r'\bmaterial_ready\b', 'material_ready'),
    (r'human_queue', 'human_queue'),
    (r'人工队列检查', '人工队列检查'),
    (r'\bidempotent', 'idempotent'),
    (r'\breplay\b', 'replay'),
    (r'幂等', '幂等'),
    (r'RUBRIC_PIN_REQUIRED', 'RUBRIC_PIN_REQUIRED'),
    (r'CONFIRM_DECISION', 'CONFIRM_DECISION'),
    (r'NEEDS_REVIEW', 'NEEDS_REVIEW'),
    (r'\bMUST_HAVE\b', 'MUST_HAVE'),
    (r'\bblock_count\b', 'block_count'),
    (r'\bsnapshot:', 'snapshot:'),
    (r'\bevaluation_digest\b', 'evaluation_digest'),
    (r'写侧', '写侧'),
    (r'钉 ?`?rubric_version_id', '钉 rubric_version_id'),
    (r'\bSQL\b', 'SQL'),
]
SRC_TOOLS_RE = re.compile(r'[\\/]src[\\/]tools[\\/][^\\/]+\.ts$', re.IGNORECASE)
EVIDENCE_MD_RE = re.compile(r'[\\/]evidence[\\/][^\\/]+\.md$', re.IGNORECASE)


# ---------------------------------------------------------------------------
#  小工具
# ---------------------------------------------------------------------------
def iso_now() -> str:
    return time.strftime('%Y-%m-%d %H:%M:%S')


def read_events(path: Path) -> list[dict]:
    """解压会话日志（可能多帧、无 content-size），返回事件列表。"""
    with path.open('rb') as handle:
        raw = zstandard.ZstdDecompressor().stream_reader(handle, read_across_frames=True).read()
    events = []
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


def message_text(message: dict) -> str:
    out: list[str] = []
    walk_text(message.get('content'), out)
    return '\n'.join(out)


def tool_result_error(message: dict) -> bool:
    for block in message.get('content') or []:
        if isinstance(block, dict) and block.get('type') == 'tool-result':
            return bool(block.get('isError'))
    return False


def json_arg(arguments, key: str):
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except json.JSONDecodeError:
            return None
    if isinstance(arguments, dict):
        return arguments.get(key)
    return None


def find_session(marker: str, since_ms: int | None) -> Path | None:
    """在 $DSH_HOME/sessions 下找**本次**会话：user/message 里出现 marker，且足够新。"""
    best: tuple[int, Path] | None = None
    root = DSH_HOME / 'sessions'
    if not root.is_dir():
        return None
    for path in root.glob('*/session-*/*.jsonl.zstd'):
        try:
            if since_ms is not None and path.stat().st_mtime * 1000 < since_ms - 300_000:
                continue
            events = read_events(path)
        except Exception:
            continue
        for event in events:
            if event.get('type') != 'user/message':
                continue
            text = message_text(event.get('data') or {})
            if marker in text:
                mtime = int(path.stat().st_mtime * 1000)
                if best is None or mtime > best[0]:
                    best = (mtime, path)
                break
    return None if best is None else best[1]


def resolve_session(value: str) -> Path | None:
    candidate = Path(value)
    if candidate.is_file():
        return candidate
    root = DSH_HOME / 'sessions'
    for path in root.glob(f'*/{value}/*.jsonl.zstd'):
        return path
    for path in root.glob(f'*/session-{value}/*.jsonl.zstd'):
        return path
    return None


# ---------------------------------------------------------------------------
#  分析
# ---------------------------------------------------------------------------
def analyze(session_path: Path) -> dict:
    events = read_events(session_path)
    calls: dict[str, dict] = {}
    order: list[tuple[str, object]] = []
    results: dict[str, dict] = {}
    skill_loads = 0
    final_text = ''
    for event in events:
        kind = event.get('type')
        data = event.get('data') or {}
        if kind == 'tool/call':
            call_id = data.get('callId')
            name = data.get('name') or ''
            calls[call_id] = {
                'name': name,
                'arguments': data.get('arguments'),
                'callId': call_id,
            }
            order.append((name, data.get('arguments')))
            if name == 'skill' and 'recruitment-s6-s7' in json.dumps(data.get('arguments'), ensure_ascii=False):
                skill_loads += 1
        elif kind == 'tool/result':
            message = data.get('message') or {}
            source = message.get('source') or {}
            call_id = source.get('callId') or data.get('callId')
            if call_id is None:
                for block in message.get('content') or []:
                    if isinstance(block, dict) and isinstance(block.get('toolCallId'), str):
                        call_id = block['toolCallId']
                        break
            results[call_id] = {
                'text': message_text(message),
                'is_error': tool_result_error(message),
            }
        elif kind == 'assistant/message':
            text = message_text(data.get('message') or {})
            if text:
                final_text = text

    def calls_named(name: str) -> list[dict]:
        return [call for call in calls.values() if call['name'] == name]

    source_reads = []
    evidence_reads = []
    source_exploration = []
    for call in calls.values():
        name = call['name']
        arguments = call['arguments']
        if name == 'read':
            path = json_arg(arguments, 'file_path') or json_arg(arguments, 'path') or ''
            if isinstance(path, str) and SRC_TOOLS_RE.search(path):
                source_reads.append(path)
            if isinstance(path, str) and EVIDENCE_MD_RE.search(path):
                evidence_reads.append(path)
        elif name in ('grep', 'glob'):
            target = json_arg(arguments, 'path') or ''
            if isinstance(target, str) and str(PLUGIN_SRC).lower() in target.lower():
                source_exploration.append((name, target))

    tool_results = {}
    for name in ('recruitment_job_get', 'recruitment_application_intake', 'recruitment_screening_evaluate'):
        calls_of = calls_named(name)
        if not calls_of:
            tool_results[name] = None
            continue
        call_id = calls_of[-1]['callId']
        tool_results[name] = results.get(call_id)

    job_call = calls_named('recruitment_job_get')
    job_args = (job_call[-1]['arguments'] if job_call else None) or {}
    job_id_used = json_arg(job_args, 'job_id')

    return {
        'events': len(events),
        'order': order,
        'source_reads': source_reads,
        'evidence_reads': evidence_reads,
        'source_exploration': source_exploration,
        'skill_loads': skill_loads,
        'tool_results': tool_results,
        'final_text': final_text,
        'job_id_used': job_id_used,
        'results': results,
    }


def check_report(text: str) -> dict:
    lower = text
    states = {
        'application': ('新建' in text and '申请' in text) or '复用' in text,
        'structure': ('已保存' in text or '未保存' in text) and '结构化' in text,
        'screening': ('已得出' in text or '证据不足' in text or '判断' in text) and '初筛' in text,
    }
    leaks = [(label, pattern) for pattern, label in LEAK_PATTERNS if re.search(pattern, lower, re.IGNORECASE)]
    manual_items = text.count('责任人')
    next_steps = text.count('下一步')
    evidence_words = text.count('证据')
    return {
        'states': states,
        'leaks': leaks,
        'manual_items': manual_items,
        'next_steps': next_steps,
        'evidence_words': evidence_words,
    }


# ---------------------------------------------------------------------------
#  主流程
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', default=DEFAULT_PROFILE)
    parser.add_argument('--pdf', default=str(DEFAULT_PDF))
    parser.add_argument('--job', default=DEMO_JOB)
    parser.add_argument('--goal', default=None, help='覆盖默认的一句话目标')
    parser.add_argument('--session', default=None, help='只分析已有会话（session id 或 jsonl.zstd 路径）')
    parser.add_argument('--out', default=None, help='证据输出目录（默认 manual/acceptance/<时间戳>）')
    args = parser.parse_args()

    pdf = Path(args.pdf)
    stamp = time.strftime('%Y%m%d-%H%M%S')
    out_dir = Path(args.out) if args.out else HERE.parent / 'acceptance' / stamp
    out_dir.mkdir(parents=True, exist_ok=True)

    # ---- 1. preflight ----
    checks: list[tuple[str, bool, str]] = []
    password = os.environ.get('RECRUITMENT_DB_PASSWORD')
    if args.session is None:
        checks.append(('password env', bool(password),
                       'RECRUITMENT_DB_PASSWORD is set' if password else 'RECRUITMENT_DB_PASSWORD missing'))
    checks.append(('pdf exists', pdf.is_file(), str(pdf)))
    if args.session is None and not pdf.is_file():
        print(f'FATAL: pdf not found: {pdf}', file=sys.stderr)
        return 2

    started_ms = int(time.time() * 1000) if args.session is None else None
    session_path: Path | None = None

    # ---- 2. run ----
    if args.session is None:
        goal = args.goal or (
            f'这份简历要收进招聘系统：{pdf} 。岗位 job_id={args.job}。'
            '请自己决定怎么做，把它读进来、落库、给出初筛意见，'
            '并按 HR 能看懂的业务报告输出，需要人工核实的地方要写清问题和下一步。'
        )
        env = os.environ.copy()
        env['NL_GOAL'] = goal
        command = f'dsh --profile {args.profile} $env:NL_GOAL'
        print(f'[{iso_now()}] running: dsh --profile {args.profile} <one-sentence goal>')
        print(f'[{iso_now()}] goal: {goal}')
        run_started = time.time()
        completed = subprocess.run(
            ['pwsh', '-NoProfile', '-Command', command],
            cwd=str(REPO),
            env=env,
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            timeout=3600,
        )
        stdout = completed.stdout or ''
        stderr = completed.stderr or ''
        (out_dir / 'dsh-stdout.txt').write_text(stdout, encoding='utf-8')
        (out_dir / 'dsh-stderr.txt').write_text(stderr, encoding='utf-8')
        (out_dir / 'goal.txt').write_text(goal + '\n', encoding='utf-8')
        print(f'[{iso_now()}] exit={completed.returncode} elapsed={time.time() - run_started:.0f}s')
        checks.append(('dsh exit 0', completed.returncode == 0, f'exit={completed.returncode}'))
        session_path = find_session(pdf.name, started_ms)
    else:
        session_path = resolve_session(args.session)

    if session_path is None:
        print('FATAL: session log not found', file=sys.stderr)
        checks.append(('session log found', False, 'none'))
        write_summary(out_dir, checks, None, None)
        return 1
    checks.append(('session log found', True, str(session_path)))
    print(f'[{iso_now()}] session: {session_path}')

    # ---- 3. analyze ----
    report = analyze(session_path)
    names = [name for name, _ in report['order']]
    checks.append(('skill recruitment-s6-s7 loaded', report['skill_loads'] >= 1, f"skill calls={report['skill_loads']}"))
    for tool in REQUIRED_TOOLS:
        checks.append((f'{tool} called', tool in names, f'calls={names.count(tool)}'))
    checks.append(('job_get used the real UUID', report['job_id_used'] == args.job, f"job_id={report['job_id_used']}"))

    job_result = report['tool_results']['recruitment_job_get']
    job_text = '' if job_result is None else job_result['text']
    checks.append(('job_get returned a real job', 'DEMO-BE-001' in job_text and 'rubric v' in job_text,
                   'real job + rubric' if 'rubric v' in job_text else 'missing'))

    intake_result = report['tool_results']['recruitment_application_intake']
    intake_text = '' if intake_result is None else intake_result['text']
    checks.append(('intake reported application_action', 'application:' in intake_text and
                   ('CREATED' in intake_text or 'REUSED' in intake_text), intake_text.splitlines()[0] if intake_text else 'missing'))
    checks.append(('intake reported structure_saved', 'structure: saved=' in intake_text,
                   'structure line present' if 'structure: saved=' in intake_text else 'missing'))

    screening_result = report['tool_results']['recruitment_screening_evaluate']
    screening_text = '' if screening_result is None else screening_result['text']
    checks.append(('screening reported verdict + criteria_evaluated',
                   'verdict:' in screening_text and 'criteria_evaluated=' in screening_text,
                   'verdict line present' if 'verdict:' in screening_text else 'missing'))

    # ---- 4. the hard metric ----
    checks.append(('read src/tools/*.ts count == 0', len(report['source_reads']) == 0,
                   f'count={len(report["source_reads"])}'))
    checks.append(('read evidence/*.md count == 0', len(report['evidence_reads']) == 0,
                   f'count={len(report["evidence_reads"])}'))
    checks.append(('no grep/glob into plugin src', len(report['source_exploration']) == 0,
                   f'count={len(report["source_exploration"])}'))

    final = report['final_text']
    report_checks = check_report(final)
    for state, ok in report_checks['states'].items():
        checks.append((f'final report states {state}', ok, 'ok' if ok else 'missing'))
    checks.append(('final report has no internal leak', len(report_checks['leaks']) == 0,
                   ', '.join(label for label, _ in report_checks['leaks']) or 'none'))
    checks.append(('final report has 待人工 four elements', report_checks['manual_items'] >= 1
                   and report_checks['next_steps'] >= 1,
                   f"责任人={report_checks['manual_items']} 下一步={report_checks['next_steps']}"))

    # ---- 5. evidence bundle ----
    (out_dir / 'tool-calls.txt').write_text(
        '\n'.join(f'{index + 1}. {name} {json.dumps(arguments, ensure_ascii=False)[:400]}'
                  for index, (name, arguments) in enumerate(report['order'])) + '\n',
        encoding='utf-8',
    )
    for name, result in report['tool_results'].items():
        if result is None:
            continue
        (out_dir / f'{name}.txt').write_text(
            f'isError={result["is_error"]}\n{result["text"]}\n', encoding='utf-8')
    (out_dir / 'final-report.md').write_text(final + '\n', encoding='utf-8')
    checks.append(('tool results not error',
                   all(result is not None and not result['is_error'] for name, result in report['tool_results'].items()
                       if name in ('recruitment_job_get', 'recruitment_application_intake', 'recruitment_screening_evaluate')),
                   'ok'))

    write_summary(out_dir, checks, report, report_checks)
    failed = [label for label, ok, _ in checks if not ok]
    print('')
    print(f'=== summary ({len(checks) - len(failed)}/{len(checks)} passed) ===')
    for label, ok, detail in checks:
        print(f'  [{"PASS" if ok else "FAIL"}] {label} — {detail}')
    print('')
    print(f'source reads (src/tools/*.ts): {len(report["source_reads"])}')
    print(f'evidence reads (evidence/*.md): {len(report["evidence_reads"])}')
    print(f'grep/glob into plugin src:      {len(report["source_exploration"])}')
    print(f'evidence bundle: {out_dir}')
    if failed:
        print(f'FAILED: {len(failed)} check(s)', file=sys.stderr)
        return 1
    print('ALL CHECKS PASSED')
    return 0


def write_summary(out_dir: Path, checks, report, report_checks) -> None:
    lines = [f'generated {iso_now()}', '']
    for label, ok, detail in checks:
        lines.append(f'[{"PASS" if ok else "FAIL"}] {label} — {detail}')
    if report is not None:
        lines.extend([
            '',
            f'skill loads: {report["skill_loads"]}',
            f'tool calls: {", ".join(name for name, _ in report["order"])}',
            f'source reads: {len(report["source_reads"])}',
            f'evidence reads: {len(report["evidence_reads"])}',
            f'plugin src grep/glob: {len(report["source_exploration"])}',
        ])
        for path in report['source_reads']:
            lines.append(f'  read {path}')
        for path in report['evidence_reads']:
            lines.append(f'  read {path}')
        for name, target in report['source_exploration']:
            lines.append(f'  {name} {target}')
    if report_checks is not None:
        lines.extend(['', f'leaks: {[label for label, _ in report_checks["leaks"]]}'])
    (out_dir / 'summary.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')


if __name__ == '__main__':
    raise SystemExit(main())
