"""转换层的人工兜底 + 回填（doc 12 §2④，四件套第 4 件）。

四个模块各回答一个问题：

* :mod:`review.transcription` —— 人读到的每一页，怎么存、怎么取、历史怎么不被覆盖
* :mod:`review.queue`         —— 机器判不了的，怎么排队、认领、补正、放行/驳回
* :mod:`review.merge_human`   —— 人工结果怎么并进转换器输出而不覆盖机器结果
* :mod:`review.blocking`      —— 没处理完的，怎么真的挡住下游筛选

并存原则（DECISIONS-2026-11-12 D-29 的同一口径）：
机器结果、人工结果各存一份，谁都不能覆盖谁；来源逐块标注（``provenance``）。

本包只读写 ``recruitment`` schema 里 0003 已建的三张表，
**不建表、不改迁移**（``db/`` 只读）。人工转录存放在 ``review_queue.human_result``
的 ``human_read`` 子对象里，格式见 :mod:`review.transcription`。
"""

from __future__ import annotations

from . import blocking, merge_human, queue, transcription

__all__ = ["blocking", "merge_human", "queue", "transcription"]
