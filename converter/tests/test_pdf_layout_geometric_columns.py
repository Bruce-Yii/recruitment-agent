"""纯几何分栏/单列重排（``pdf_layout.geometric_order``）的单元与端到端测试。

为什么单列也要测：
    真实简历单列是多数；内容流顺序经常是"绘制顺序"（页眉页脚先出、章节乱序）。
    只要几何上只存在一种阅读顺序（自上而下、行内自左而右），它就是**已验证的顺序**，
    可以写 ``order_verified=True``；反之（块跨列、行内 x 重叠、行间 y 交错、列缝不清、
    逐行对齐的表）一律不得下结论。

三条"不许硬凑"的负例（对应 lead 2026-11-14 裁决 B 的条件 1/2/3）：
    * 条件 1：非通栏块必须落在主列内（x 与主列重叠 >= 90%）；否则不是单列页
      -> ``test_blocks_without_common_column_are_not_claimed`` /
         ``test_block_outside_main_column_is_not_claimed``
    * 条件 2：同一视觉行内的块 x 区间不得重叠（左右不可判）
      -> ``test_same_row_horizontal_overlap_is_not_claimed``
    * 条件 3：相邻跨行块的 y 区间不得实质交错（上下不可判）；交叠 <= 较矮块
      字高 25% 属行盒 ascender/descender 噪声，不算交错
      -> ``test_adjacent_row_interleave_is_not_claimed`` /
         ``test_interleave_above_line_height_noise_is_not_claimed`` /
         ``test_interleave_at_line_height_noise_boundary_is_allowed``

单列页允许"居中姓名/联系方式 + 左对齐正文 + 整行标题"（通栏块不参与列判定）。
端到端用例用 fitz **现场生成** PDF（不碰真实候选人材料、不写仓库）。
"""
from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path

import fitz
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src import pdf_layout, pdf_reader  # noqa: E402


# ============================ 工具 ============================
def _block(x0, y0, x1, y1, text='块'):
    """只有 bbox 有意义的 block（几何函数不得读取/改写 text 语义）。"""
    return {'kind': 'paragraph', 'text': text,
            'location': {'page': 1, 'bbox': [float(x0), float(y0), float(x1), float(y1)]},
            'links': [], 'provenance': 'native_text'}


def _order_texts(blocks, plan):
    return [blocks[index]['text'] for index in plan['order']]


def _write_pdf(path: Path, pages, *, page_size=(595, 842)) -> Path:
    """按页写入 ``(x, y, text)``；插入顺序 = 内容流顺序（可故意打乱）。"""
    doc = fitz.open()
    for lines in pages:
        page = doc.new_page(width=page_size[0], height=page_size[1])
        for x, y, text in lines:
            page.insert_text((x, y), text, fontsize=11, fontname='china-s')
    doc.save(str(path))
    doc.close()
    return path


def _non_space(text: str) -> Counter:
    return Counter(re.sub(r'\s', '', text or ''))


# ============================ 正例 ============================
def test_two_column_page_is_reordered_left_to_right():
    """两列各自独立时：列内按 y、列间按 x 重排。"""
    blocks = [
        _block(330, 110, 550, 130, '右一'),
        _block(60, 100, 280, 120, '左一'),
        _block(330, 150, 550, 170, '右二'),
        _block(60, 140, 280, 160, '左二'),
        _block(330, 190, 550, 210, '右三'),
        _block(60, 180, 280, 200, '左三'),
    ]
    plan = pdf_layout.geometric_order(blocks, 595)
    assert plan is not None
    assert plan['backend'] == pdf_layout.GEOMETRIC_COLUMNS
    assert _order_texts(blocks, plan) == ['左一', '左二', '左三', '右一', '右二', '右三']


def test_three_column_page_is_reordered_left_to_right():
    """至少支持 2 列；3 列（递归切 2 次）也必须按 x 升序。"""
    blocks = [
        _block(210, 104, 350, 124, '中一'),
        _block(40, 100, 180, 120, '左一'),
        _block(380, 108, 520, 128, '右一'),
        _block(40, 140, 180, 160, '左二'),
        _block(210, 144, 350, 164, '中二'),
        _block(380, 148, 520, 168, '右二'),
    ]
    plan = pdf_layout.geometric_order(blocks, 595)
    assert plan is not None
    assert plan['backend'] == pdf_layout.GEOMETRIC_COLUMNS
    assert _order_texts(blocks, plan) == ['左一', '左二', '中一', '中二', '右一', '右二']


def test_full_width_header_precedes_columns():
    """整行页眉（块跨列）先出现；它下面的两列再按列重排。"""
    blocks = [
        _block(330, 125, 550, 145, '右一'),
        _block(60, 120, 280, 140, '左一'),
        _block(40, 60, 550, 80, '整行页眉'),
        _block(330, 165, 550, 185, '右二'),
        _block(60, 160, 280, 180, '左二'),
    ]
    plan = pdf_layout.geometric_order(blocks, 595)
    assert plan is not None
    assert _order_texts(blocks, plan) == ['整行页眉', '左一', '左二', '右一', '右二']


def test_single_column_page_is_reordered_top_to_bottom():
    """单列页：几何上只有一种顺序 —— 自上而下、行内自左而右。"""
    blocks = [
        _block(60, 220, 500, 240, '第三行'),
        _block(60, 100, 500, 120, '第一行'),
        _block(60, 160, 500, 180, '第二行'),
    ]
    plan = pdf_layout.geometric_order(blocks, 595)
    assert plan is not None
    assert plan['backend'] == pdf_layout.GEOMETRIC_ORDER
    assert _order_texts(blocks, plan) == ['第一行', '第二行', '第三行']


def test_single_column_with_centered_header_is_verified():
    """单列 + 居中姓名 + 左对齐正文 + 右对齐日期：通栏块不参与列判定，顺序唯一。"""
    blocks = [
        _block(60, 220, 120, 240, '2023.09'),
        _block(250, 100, 350, 120, '姓名居中'),
        _block(60, 140, 520, 160, '正文一' * 12),
        _block(60, 180, 520, 200, '正文二' * 12),
    ]
    plan = pdf_layout.geometric_order(blocks, 595)
    assert plan is not None
    assert plan['backend'] == pdf_layout.GEOMETRIC_ORDER
    assert _order_texts(blocks, plan) == ['姓名居中', '正文一' * 12,
                                          '正文二' * 12, '2023.09']


def test_same_row_blocks_are_ordered_left_to_right():
    """同一视觉行内左右并排的块（姓名/电话）按 x 升序，且不影响整列判定。"""
    blocks = [
        _block(300, 100, 500, 120, '电话'),
        _block(60, 100, 200, 120, '姓名'),
        _block(60, 160, 500, 180, '正文一'),
        _block(60, 220, 500, 240, '正文二'),
    ]
    plan = pdf_layout.geometric_order(blocks, 595)
    assert plan is not None
    assert _order_texts(blocks, plan) == ['姓名', '电话', '正文一', '正文二']


# ============================ 负例：三条唯一性条件 ============================
def test_blocks_without_common_column_are_not_claimed():
    """条件 1（负例）：不同行的块 x 区间不相交 → 不是同一列 → 不得声明已验证。"""
    blocks = [
        _block(60, 100, 200, 120, '左上'),
        _block(300, 160, 500, 180, '右下'),
    ]
    assert pdf_layout.geometric_order(blocks, 595) is None


def test_block_outside_main_column_is_not_claimed():
    """主列之外的块（右对齐侧栏、又不够格当第二列）→ 不能判成单列。"""
    blocks = [
        _block(60, 100, 520, 120, '正文一' * 12),
        _block(60, 140, 520, 160, '正文二' * 12),
        _block(560, 100, 590, 120, '侧栏'),
    ]
    assert pdf_layout.geometric_order(blocks, 595) is None


def test_same_row_horizontal_overlap_is_not_claimed():
    """条件 2（负例）：同一视觉行内 x 重叠 → 左右关系不可判 → 不得声明已验证。"""
    blocks = [
        _block(60, 100, 300, 120, '甲'),
        _block(200, 100, 500, 120, '乙'),
    ]
    assert pdf_layout.geometric_order(blocks, 595) is None


def test_adjacent_row_interleave_is_not_claimed():
    """条件 3（负例）：相邻块 y 区间实质交错（超过较矮块字高 25%）→ 不得声明已验证。"""
    blocks = [
        _block(60, 100, 500, 160, '甲'),   # 高 60
        _block(60, 140, 500, 200, '乙'),   # 交叠 20pt = 较矮块字高 33%
    ]
    assert pdf_layout.geometric_order(blocks, 595) is None


def test_interleave_above_line_height_noise_is_not_claimed():
    """条件 3（负例）：交叠 30% 字高（超过 25% 噪声线）→ 仍必须拒绝。"""
    a = _block(60, 100, 500, 120, '第一行')   # 高 20
    b = _block(60, 114, 500, 140, '第二行')   # 交叠 6pt = 较矮块字高 30%
    assert pdf_layout.geometric_order([a, b], 595) is None


def test_interleave_at_line_height_noise_boundary_is_allowed():
    """条件 3 边界：交叠恰好 25% 字高（行盒噪声）→ 允许验证，顺序按 y。"""
    a = _block(60, 100, 500, 140, '第一行')   # 高 40
    b = _block(60, 130, 500, 180, '第二行')   # 交叠 10pt = 40 * 25%
    plan = pdf_layout.geometric_order([a, b], 595)
    assert plan is not None
    assert plan['backend'] == pdf_layout.GEOMETRIC_ORDER
    assert _order_texts([a, b], plan) == ['第一行', '第二行']


# ============================ 负例：多列条件 ============================
def test_row_aligned_columns_are_not_read_by_column():
    """逐行对齐的表（主体 | 时间）不能按列读：按列读会把主体和时间拆开。"""
    blocks = [
        _block(60, 100, 200, 120, '公司甲'),
        _block(300, 100, 500, 120, '2020.01'),
        _block(60, 140, 200, 160, '公司乙'),
        _block(300, 140, 500, 160, '2021.01'),
    ]
    assert pdf_layout.geometric_order(blocks, 595) is None


def test_narrow_column_gutter_is_not_claimed():
    """列间距不明显（< max(8pt, 2% 页宽)）→ 不自信。"""
    blocks = [
        _block(60, 100, 300, 120, '左一'),
        _block(304, 110, 540, 130, '右一'),
        _block(60, 140, 300, 160, '左二'),
        _block(304, 150, 540, 170, '右二'),
    ]
    assert pdf_layout.geometric_order(blocks, 595) is None


def test_unbalanced_columns_are_not_claimed():
    """右侧只有很窄的一列（照片/页码/标签）不算第二列。"""
    blocks = [
        _block(40, 100, 500, 120, '正文一'),
        _block(40, 140, 500, 160, '正文二'),
        _block(40, 180, 500, 200, '正文三'),
        _block(520, 110, 545, 130, '照'),
        _block(520, 150, 545, 170, '片'),
    ]
    assert pdf_layout.geometric_order(blocks, 595) is None


def test_block_spanning_two_columns_is_not_claimed():
    """块跨列（横跨左右两栏且纵向与两栏内容粘在一起）→ 不得声明已验证。"""
    blocks = [
        _block(60, 100, 280, 120, '左一'),
        _block(60, 140, 280, 160, '左二'),
        _block(330, 100, 550, 120, '右一'),
        _block(330, 140, 550, 160, '右二'),
        _block(60, 110, 550, 150, '横跨两栏的块'),
    ]
    assert pdf_layout.geometric_order(blocks, 595) is None


def test_invalid_bbox_aborts_geometry():
    """bbox 不合法时不得给结论（宁可退回内容流顺序）。"""
    blocks = [
        _block(60, 100, 280, 120, '左'),
        {'kind': 'paragraph', 'text': '坏', 'location': {'page': 1, 'bbox': [1, 2, 3]}},
    ]
    assert pdf_layout.geometric_order(blocks, 595) is None
    assert pdf_layout.geometric_order([], 595) is None


# ============================ 端到端：read_pdf ============================
def test_reader_marks_two_column_pdf_verified(tmp_path):
    """内容流是"右栏在前"的 PDF：读响应按左栏→右栏输出，并写 verified。"""
    path = _write_pdf(tmp_path / 'two_columns.pdf', [[
        (320, 125, '右栏甲'), (320, 165, '右栏乙'), (320, 205, '右栏丙'),
        (60, 100, '左栏甲'), (60, 140, '左栏乙'), (60, 180, '左栏丙'),
    ]])
    result = pdf_reader.read_pdf(path)
    meta = result['meta']
    assert meta['order_verified'] is True
    assert meta['layout_backend'] == pdf_layout.GEOMETRIC_COLUMNS
    assert meta['page_info'][0]['layout_order_applied'] is True
    assert meta['page_info'][0]['layout_backend'] == pdf_layout.GEOMETRIC_COLUMNS
    texts = [block['text'].strip() for block in result['blocks']]
    assert texts == ['左栏甲', '左栏乙', '左栏丙', '右栏甲', '右栏乙', '右栏丙']
    assert not any(issue['code'] == 'pdf_layout_unread' for issue in result['issues'])


def test_reader_marks_single_column_pdf_verified(tmp_path):
    """单列但内容流乱序的 PDF：按 y 重排并写 geometric-order。"""
    path = _write_pdf(tmp_path / 'single_column.pdf', [[
        (60, 300, '第三行'), (60, 100, '第一行'), (60, 200, '第二行'),
    ]])
    result = pdf_reader.read_pdf(path)
    meta = result['meta']
    assert meta['order_verified'] is True
    assert meta['layout_backend'] == pdf_layout.GEOMETRIC_ORDER
    assert [block['text'].strip() for block in result['blocks']] == ['第一行', '第二行', '第三行']


def test_reader_keeps_stream_order_when_geometry_is_ambiguous(tmp_path):
    """几何不敢下结论时：保持内容流顺序 + 保留旧兜底判定（不得假装排好）。"""
    path = _write_pdf(tmp_path / 'ambiguous.pdf', [[
        (60, 260, '正文乙'), (250, 100, '姓名甲'), (60, 160, '正文丙'),
    ]])
    result = pdf_reader.read_pdf(path)
    meta = result['meta']
    assert meta['order_verified'] is False
    assert meta['layout_backend'] is None
    assert meta['page_info'][0]['layout_order_applied'] is False
    codes = [issue['code'] for issue in result['issues']]
    assert 'pdf_reading_order_unverified' in codes, codes
    assert [block['text'].strip() for block in result['blocks']] == ['正文乙', '姓名甲', '正文丙']


def test_reader_rejects_plan_that_drops_characters(tmp_path, monkeypatch):
    """字符守恒（需求 3）：重排后 Counter 不等 → 放弃重排并记 pdf_layout_unread。"""
    path = _write_pdf(tmp_path / 'chars.pdf', [[
        (60, 100, '第一行'), (60, 200, '第二行'),
    ]])
    monkeypatch.setattr(pdf_layout, 'geometric_order',
                        lambda blocks, width: {'order': [0],
                                               'backend': pdf_layout.GEOMETRIC_ORDER})
    result = pdf_reader.read_pdf(path)
    codes = [issue['code'] for issue in result['issues']]
    assert 'pdf_layout_unread' in codes, codes
    assert result['meta']['order_verified'] is False
    assert result['meta']['layout_backend'] is None
    # 正文一个字都没丢（放弃的是重排，不是内容）
    assert [block['text'].strip() for block in result['blocks']] == ['第一行', '第二行']


def test_document_requires_every_text_page_verified(tmp_path):
    """整份 order_verified 只在"所有有文字的页都完成几何排序"时为真。"""
    path = _write_pdf(tmp_path / 'mixed_pages.pdf', [
        [(320, 125, '右甲'), (320, 165, '右乙'), (60, 100, '左甲'), (60, 140, '左乙')],
        [(250, 100, '居中'), (60, 160, '左正文'), (60, 260, '左正文二')],
    ])
    result = pdf_reader.read_pdf(path)
    meta = result['meta']
    assert meta['order_verified'] is False       # 第 2 页不敢下结论 → 整份不着色
    assert meta['layout_backend'] is None        # backend 与 verified 必须同进同退
    assert meta['page_info'][0]['layout_order_applied'] is True
    assert meta['page_info'][0]['layout_backend'] == pdf_layout.GEOMETRIC_COLUMNS
    assert meta['page_info'][1]['layout_order_applied'] is False


def test_mixed_page_backends_are_reported_per_page(tmp_path):
    """单列页与多列页混排：每页记自己的 backend，整份用组合名。"""
    path = _write_pdf(tmp_path / 'mixed_modes.pdf', [
        [(320, 125, '右甲'), (320, 165, '右乙'), (60, 100, '左甲'), (60, 140, '左乙')],
        [(60, 100, '单甲'), (60, 140, '单乙'), (60, 180, '单丙')],
    ])
    result = pdf_reader.read_pdf(path)
    meta = result['meta']
    assert meta['order_verified'] is True
    assert meta['layout_backend'] == 'geometric-columns+geometric-order'
    assert [p['layout_backend'] for p in meta['page_info']] == [
        pdf_layout.GEOMETRIC_COLUMNS, pdf_layout.GEOMETRIC_ORDER]


def test_reorder_preserves_every_non_space_character(tmp_path):
    """只改顺序不改文字：非空白字符 Counter 与原件逐字相等。"""
    path = _write_pdf(tmp_path / 'fidelity.pdf', [[
        (320, 125, '右栏甲'), (320, 165, '右栏乙'),
        (60, 100, '左栏甲'), (60, 140, '左栏乙'),
    ]])
    result = pdf_reader.read_pdf(path)
    native = ''.join(pdf_reader.native_page_text(path))
    assert _non_space(result['text']) == _non_space(native)
    native_blocks = [line for line in native.split('\n') if line.strip()]
    assert sorted(_non_space(''.join(block['text'] for block in result['blocks']))) == \
        sorted(_non_space(''.join(native_blocks)))
