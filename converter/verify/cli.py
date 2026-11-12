"""CLI：把校验器当命令行工具用。

两种用法（都要给原件，因为判据需要拿原件重算）：

    # ① 让校验器自己跑转换器两遍（V8 幂等才有数据）
    python -m verify.cli "D:\\path\\to\\resume.pdf"

    # ② 校验已经存在的输出（可再给第二份输出判幂等）
    python -m verify.cli "D:\\path\\to\\resume.pdf" --json out1.json --second out2.json

退出码：``0`` = 全部通过（含"无法判"的 skipped 项）；``1`` = 有检查失败；
``2`` = 输入/调用错误（不是判定结果）。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from .verify_output import VERIFIER_VERSION, verify

ROOT = Path(__file__).resolve().parents[1]   # converter/ 目录
DEFAULT_TIMEOUT = 300.0


def _run_converter(pdf: str, timeout: float) -> dict:
    """跑一次转换器（独立子进程，不 import src/），把 stdout 当 JSON 解析。

    注意：这里只把转换器当**外部程序**调用；校验逻辑一行都不碰它的实现。
    """
    cmd = [sys.executable, "-m", "src.cli", pdf, "--no-isolation", "--indent", "0"]
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONPATH=str(ROOT))
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    proc = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, env=env,
                          timeout=timeout, creationflags=flags)
    if proc.returncode != 0:
        raise RuntimeError(
            f"转换器退出码 {proc.returncode}：{proc.stderr.decode('utf-8', 'replace')[:600]}")
    try:
        return json.loads(proc.stdout.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"转换器 stdout 不是合法 JSON：{exc}") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m verify.cli",
        description="独立校验器：拿转换器输出 + 原件，按 doc 11 判它合不合格")
    parser.add_argument("pdf", help="原件 PDF 路径（只读）")
    parser.add_argument("--json", dest="output_json", default=None,
                        help="要校验的转换器输出 JSON；不给则自己跑转换器")
    parser.add_argument("--second", dest="second_json", default=None,
                        help="同一原件的第二次输出（给了才判 V8 幂等）")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT,
                        help=f"单次转换器调用超时秒数（默认 {DEFAULT_TIMEOUT:g}）")
    parser.add_argument("--save-dir", default=None,
                        help="把本次用到的输出 JSON 存到这个目录（便于留证）")
    parser.add_argument("--indent", type=int, default=2, help="结果 JSON 缩进（默认 2）")
    args = parser.parse_args(argv)

    pdf = str(Path(args.pdf))
    first: dict | None = None
    second: dict | None = None
    try:
        if args.output_json:
            first = json.loads(Path(args.output_json).read_text(encoding="utf-8"))
            if args.second_json:
                second = json.loads(Path(args.second_json).read_text(encoding="utf-8"))
        else:
            first = _run_converter(pdf, args.timeout)
            second = _run_converter(pdf, args.timeout)
    except (OSError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2

    if args.save_dir:
        target = Path(args.save_dir)
        target.mkdir(parents=True, exist_ok=True)
        if args.output_json is None:
            (target / "run1.json").write_text(
                json.dumps(first, ensure_ascii=False, indent=1), encoding="utf-8")
            (target / "run2.json").write_text(
                json.dumps(second, ensure_ascii=False, indent=1), encoding="utf-8")

    result = verify(first, pdf, second_output=second)
    result["verifier_version"] = VERIFIER_VERSION
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=args.indent) + "\n")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
