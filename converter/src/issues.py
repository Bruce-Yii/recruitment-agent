"""Issue severity: HARD means "content is missing or the read failed".

Provenance
----------
``_HARD_ISSUE_CODES`` / ``_SOFT_ISSUE_PREFIXES`` / ``_issue_severity`` are copied
from ``resume-conversion-build/tools/conversion/batch.py`` (read-only reference,
L114-141).  The rule "an unknown code is treated as HARD" is copied verbatim and
is the reason a new code can never silently become harmless.

Recruitment additions
---------------------
The reference reader has no recruitment fields, so a small number of codes had
to be added for facts it never emitted.  They are listed in ``ADDED_CODES`` with
their severity and are named in the same families as the copied ones
(``*_unread`` / ``*_unverified`` / ``pdf_*`` / ``resume_*``).  Nothing copied was
renamed or re-graded.  See README §"issue code 清单".
"""
from __future__ import annotations

# 抄自 batch.py:117-124（原样）
_HARD_ISSUE_CODES = {
    'unread_visual_page', 'pdf_no_text', 'pdf_text_encoding_unread',
    'reader_timeout', 'reader_failed', 'no_reader', 'office_backend_unavailable',
    'epub_embedded_image_unread', 'missing_word_part', 'missing_word_note',
    'unread_word_object', 'encrypted_pdf', 'pdf_layout_unread',
    'text_decode_unread', 'fetch_failed', 'source_changed_during_read',
    'structure_unidentified',
}

# 抄自 batch.py:125-126（原样）
_SOFT_ISSUE_PREFIXES = ('unverified_', 'html_', 'display_relation_', 'display_entry_',
                        'pdf_reading_order_', 'markdown_page_context_')

# 招聘字段层新增（无对应参考实现）。HARD = 该事实读不出/归属不可确认；
# SOFT = 事实已读出，只是解释或隔离动作需要记录。
ADDED_CODES = {
    # code: (severity, 含义)
    'pdf_damaged_repaired': ('hard', '解析器修复了结构损坏的文件，内容可能不完整'),
    'resume_field_unreadable': ('hard', '字段在原文中出现但读不出（或整篇未读完，不能断言缺失）'),
    'resume_experience_cross_block': ('hard', '经历事实需要跨区块拼装，拒绝组合并标记为不可读'),
    'platform_noise_inline_unresolved': ('hard', '平台噪声与正文同块，未移除，需人工确认'),
    'resume_timeline_gap': ('soft', '时间线断档（原文如此，未修补）'),
    'resume_timeline_overlap': ('soft', '时间线重叠（原文如此，未修补）'),
    'resume_timeline_inversion': ('soft', '时间线倒挂（起止颠倒，未修补）'),
    'resume_timeline_unparsed': ('soft', '含年份但无法归一为区间'),
    'resume_attribution_unverified': ('soft', '经历行的组织上下文不可确认（未做跨区块组合）'),
    'platform_noise_excluded': ('soft', '平台噪声已识别并移出正文（保留记录）'),
    'pdf_page_empty': ('soft', '该页无文字、无图像、无矢量图形（空页，仅记录）'),
    'resume_protected_attribute_present': ('soft', '识别到受保护属性并隔离，未进入筛选特征'),
    'resume_ocr_heading_inserted': ('soft', '标题来自 OCR 区域补读（正文仍为原生文本）'),
    'pdf_text_recovered_by_ocr': ('soft', '原生文本层含未解码字形，整页已由 OCR 重读；恢复文本 provenance=ocr，身份字段需交叉核对'),
    # RTF reader（rtf_reader.py，2026-11-14）。RTF 是文本容器不是扫描件，所以没有
    # OCR 类恢复码；这里只登记"读取本身失败/不可信"的两条 HARD 事实。
    'rtf_no_text': ('hard', 'RTF 正文没有可解码的段落文本（空文档或整篇不可解）'),
    'rtf_text_encoding_unread': ('hard', 'RTF 正文含按声明字符集无法解码的字节，已从正文剔除并声明；身份字段需核对原件'),
}

# doc 11 A4 覆盖 batch.py 的 soft 前缀：
#   "无后端时若内容流回跳——页字 <800 必须 HARD，≥800 可降 warning"
# 参考实现只在页字 <800 时才发这个 code（≥800 只写 warning），因此一旦发出就是
# doc 11 说的 HARD 情形。批处理层 batch.py 把 `pdf_reading_order_` 整族当 SOFT，
# 与本项目的验收标准冲突；此处按 doc 11（更严、更保守）登记为 HARD，并在
# reports/acceptance.md 里显式记录这次取舍。
_HARD_ISSUE_CODES.add('pdf_reading_order_unverified')

for _code, (_sev, _desc) in ADDED_CODES.items():
    if _sev == 'hard':
        _HARD_ISSUE_CODES.add(_code)


def issue_severity(issues) -> tuple[bool, list]:
    """返回 (有 hard issue?, soft issue codes)。未知 code 按 hard 处理（保守）。"""
    has_hard = False
    soft = []
    for i in issues or []:
        code = i.get('code') or ''
        if code in _HARD_ISSUE_CODES:
            has_hard = True
        elif code.startswith(_SOFT_ISSUE_PREFIXES):
            soft.append(code)
        elif code in ADDED_CODES:
            soft.append(code)  # 已登记且为 soft
        elif code:
            has_hard = True  # 未知 code 保守当 hard
    return has_hard, soft


def hard_codes(issues) -> list:
    """所有 HARD issue 的 code（去重、保序）。未知 code 计入。"""
    out = []
    for i in issues or []:
        code = i.get('code') or ''
        if not code:
            continue
        if code in _HARD_ISSUE_CODES or not (
                code.startswith(_SOFT_ISSUE_PREFIXES) or code in ADDED_CODES):
            if code not in out:
                out.append(code)
    return out
