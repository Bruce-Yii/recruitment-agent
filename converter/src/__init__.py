"""招聘 Agent 的 PDF 读取器（recruitment-os / converter）。

模块分层（对齐 doc 11 与 resume-conversion-build 的既有实现）：

    content.py       读取契约：block() / result() / pending() 的形状与语义
    structure.py     结构层：只用字号/块高证据推断标题层级（照抄参考实现）
    pdf_layout.py    可选版面后端：只取几何；未配置时返回 None
    ocr_titles.py    独立进程 OCR：只输出标题候选，正文永远来自原生文本层
    issues.py        issue 分级：HARD / SOFT，未知 code 按 HARD
    resume_fields.py 招聘特有：字段三态 / 时间线 / 平台噪声 / 受保护属性
    pdf_reader.py    read_pdf() 主实现（判定顺序照抄参考实现）
    reader_worker.py 单份读取的隔离子进程（供超时控制使用）
    cli.py           python -m src.cli <pdf> -> JSON to stdout
    batch_run.py     按 manifest 批跑，产出 reports/corpus-results.jsonl
"""

__version__ = "1.0.0"
