"""独立校验器（doc 11 的可执行版本）。

对外只暴露两个入口：

    from verify import verify, verify_files, read_native, VerifyInputError

    result = verify(output_dict_or_path, "D:/path/to/original.pdf",
                    second_output=second_dict_or_path)

本包**不 import** `converter/src/` 的任何东西：被检对象只有"输出 JSON"和
"用 fitz 独立重读的原件"。理由见 `verify_output.py` 的模块 docstring。
"""
from __future__ import annotations

from .verify_output import (  # noqa: F401
    CHECKS,
    VERIFIER_VERSION,
    NativeDoc,
    VerifyInputError,
    read_native,
    verify,
    verify_files,
)

__all__ = [
    "CHECKS",
    "VERIFIER_VERSION",
    "NativeDoc",
    "VerifyInputError",
    "read_native",
    "verify",
    "verify_files",
]
__version__ = VERIFIER_VERSION
