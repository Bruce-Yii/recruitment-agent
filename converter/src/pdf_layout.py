"""Optional layout backend: geometry only, one-to-one preservation of native lines.

Provenance
----------
Copied from ``resume-conversion-build/tools/conversion/pdf_layout.py``
(read-only reference, 2026-11).  The contract is unchanged:

    * the *external* backend is optional; unconfigured means ``infer() -> None``
      and the caller must fall back to native content-stream order (never to a
      blanket x/y sort);
    * geometry may change order and paragraph breaks, never text or link targets;
    * every native line must be assigned exactly once or the page is rejected;
    * ``stream_order_issue`` only *recognises* a non-monotone native order —
      it never guesses a fix.

纯几何兜底（2026-11-14，见文件末尾 ``geometric_order``）
--------------------------------------------------------
外部版面后端仍然可选；没有后端时，本模块现在提供**纯几何**重排：只用每个
block 的 bbox 判列/判行，在"顺序唯一"时（多列且列缝清晰、单列且 x 重叠一致、
行内 x 不重叠、行间 y 不交错）给出新顺序，否则返回 ``None``。它不改写文本；
字符守恒由 ``pdf_reader`` 用 ``Counter(非空白字符)`` 复核。报告为
``layout_backend='geometric-columns'`` / ``'geometric-order'``，绝不冒充外部模型。
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import subprocess
import sys
from pathlib import Path

import fitz

from . import content


def dependency_root():
    configured = os.environ.get('RESUME_CONVERSION_PDF_LAYOUT', '')
    root = Path(configured).resolve() if configured else None
    return root if root and (root / 'pymupdf4llm').is_dir() else None


def fingerprint():
    root = dependency_root()
    if root is None:
        return 'pdf-layout-unconfigured'
    digest = hashlib.sha256()
    # Include model files, distribution versions and inference implementation;
    # cache reuse must not silently survive a model/package replacement.
    paths = sorted(p for p in root.rglob('*') if p.is_file() and (
        p.suffix in {'.onnx', '.safetensors', '.pt'} or
        (p.name in {'METADATA', 'RECORD'} and '.dist-info' in str(p.parent)) or
        (p.suffix == '.py' and any(part in {'pymupdf4llm', 'pymupdf_layout'} for part in p.parts))))
    for path in paths:
        digest.update(str(path.relative_to(root)).encode('utf8'))
        digest.update(path.read_bytes())
    return str(root) + ':' + digest.hexdigest()


def infer(path):
    """Return geometry for ``path`` or ``None`` when no backend is configured.

    A *configured but broken* backend raises: silently ignoring a broken backend
    would turn "unverified" into "verified".
    """
    root = dependency_root()
    if root is None:
        return None
    worker = Path(__file__).with_name('pdf_layout_worker.py')
    if not worker.is_file():
        raise RuntimeError('layout backend is configured but pdf_layout_worker.py is missing')
    env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONDONTWRITEBYTECODE='1')
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    original = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    result = subprocess.run([sys.executable, str(worker), str(root), str(Path(path).resolve())],
                            capture_output=True, text=True, encoding='utf8',
                            timeout=50, creationflags=flags, env=env)
    if result.returncode:
        raise RuntimeError('configured PDF layout backend could not read this original; native text retained')
    if hashlib.sha256(Path(path).read_bytes()).hexdigest() != original:
        raise RuntimeError('original changed during PDF layout inference')
    data = json.loads(result.stdout)
    data['source_sha256'] = original
    return data


def _rect(value):
    if not isinstance(value, (list, tuple)) or len(value) != 4 or not all(
            isinstance(v, (float, int)) and math.isfinite(v) for v in value):
        raise ValueError('invalid layout geometry')
    rect = fitz.Rect(value)
    if rect.is_empty or rect.is_infinite:
        raise ValueError('empty layout geometry')
    return rect


def order_page(page, geometry, number):
    """Assign every native line exactly once or reject this page's layout.

    Geometry may change order and paragraph breaks, never text or link targets.
    Duplicate model text in a picture is geometry only. Missing native lines,
    coordinate changes, rotated text or cross-region lines reject the order.
    """
    if abs(geometry['width'] - page.rect.width) > 1 or abs(geometry['height'] - page.rect.height) > 1:
        raise ValueError('layout page dimensions differ from native page')
    candidates = []
    for region_id, region in enumerate(geometry['regions']):
        candidates.append((region_id, None, region['kind'], _rect(region['bbox'])))
        for line_id, bbox in enumerate(region.get('lines', [])):
            candidates.append((region_id, line_id, region['kind'], _rect(bbox)))
    native = page.get_text('rawdict', sort=False)['blocks']
    assigned = []
    for block_id, block in enumerate(native):
        if block.get('type') != 0:
            continue
        for line_id, line in enumerate(block.get('lines', [])):
            characters = [char for span in line['spans'] for char in span.get('chars', [])]
            text = ''.join(char['c'] for char in characters)
            if not text.strip():
                continue
            if tuple(line.get('dir', (1, 0))) != (1, 0):
                raise ValueError('rotated native line needs a separate layout reader')
            rect = fitz.Rect()
            for char in characters:
                if char['c'].strip():
                    rect |= _rect(char['bbox'])
            rect = _rect(list(rect))
            scores = []
            for region_id, model_line, kind, target in candidates:
                coverage = (rect & target).get_area() / rect.get_area()
                overlap = rect & target
                # The model uses actual glyph boxes while the native reader
                # uses font ascenders/descenders. Match the line centre and
                # horizontal extent, not an identical font-box height. A line
                # crossing two independent columns still cannot match one side.
                if target.contains((rect.tl + rect.br) / 2) and overlap.width / rect.width >= .95:
                    score = (model_line is not None, coverage, kind != 'picture',
                             -abs(target.get_area() - rect.get_area()))
                    scores.append((score, region_id, model_line))
            if not scores:
                raise ValueError('native line has no complete model geometry match')
            _, region_id, model_line = max(scores, key=lambda item: item[0])
            baseline = min(span.get('origin', (0, rect.y1))[1] for span in line['spans'])
            assigned.append((region_id, round(baseline, 1), rect.x0, block_id, line_id, text, list(line['bbox'])))
    # Preserve native paragraphs inside each region. In a row-paired table,
    # interleaving every physical line would separate a role/date from its
    # company and weave the neighbouring description through it.
    groups = {}
    for item in assigned:
        groups.setdefault((item[0], item[3]), []).append(item)
    ordered_groups = sorted(groups.values(), key=lambda group: (
        group[0][0], min(item[1] for item in group), min(item[2] for item in group)))
    assigned = [item for group in ordered_groups for item in sorted(group, key=lambda item: item[4])]
    blocks = []
    previous = None
    for region, baseline, x0, block_id, line_id, text, bbox in assigned:
        key = (region, block_id)
        location = {'page': number, 'bbox': bbox, 'native_block': block_id,
                    'native_lines': [line_id], 'layout_region': region}
        if previous == key and line_id == blocks[-1]['location']['native_lines'][-1] + 1:
            target = blocks[-1]
            target['text'] += '\n' + content.normalize(text)
            target['location']['bbox'] = list(fitz.Rect(target['location']['bbox']) | fitz.Rect(bbox))
            target['location']['native_lines'].append(line_id)
        else:
            blocks.append(content.block('paragraph', text, location))
        previous = key
    return blocks


def stream_order_issue(blocks):
    """Recognize demonstrably non-monotone native order, without guessing a fix."""
    rects = [fitz.Rect(block['location']['bbox']) for block in blocks if block['kind'] == 'paragraph']
    return any(right.y1 + max(2, min(left.height, right.height)) < left.y0
               for left, right in zip(rects, rects[1:]))


# ==================== 纯几何分栏/单列重排（无外部版面后端） ====================
#
# 为什么需要这段：
#   真实简历左右分栏是常态（左侧联系方式/技能栏、右侧经历），而 PDF 原生内容流
#   经常是"绘制顺序/制表顺序"：右栏会被读到左栏中间，页眉页脚会跑到正文前面。
#   没有外部版面模型时，旧实现只能报 ``order_verified=False``，质量层于是拒绝
#   断言"没有该章节"（work_experience / education 被迫 unreadable）。
#
# 为什么敢用几何下结论（lead 2026-11-14 裁决 B：单列也核验，但只在顺序唯一时）：
#   只读每个 block 的 bbox 与非空白字符数（后者只用来选主列），不读语义、不改文字。
#   顺序可被"验证"当且仅当：
#     * 单列页：先按 x 区间重叠度聚类，取"非空白字符最多"的那一簇为主列；
#       **通栏块**（x 跨度 >= 主列宽度 90% 且与主列相交，或居中且宽 >= 页宽 60%）
#       不参与列判定，按 y 夹在主列块之间 —— 这覆盖真实简历常见的
#       "单列 + 居中姓名 + 左对齐正文 + 整行标题" 版式，不再因为姓名居中就判未核；
#       其余块必须落在主列内（x 与主列重叠 >= 90%），否则才走多列判定。
#     * 多列页：两列之间存在清晰、没有块跨越的竖向白缝；两侧列宽不能太失衡；
#       两列也不能是逐行对齐的表（公司 | 时间）—— 那种必须按行读，按列读会把
#       主体和时间拆开，正是 doc_cross_block_attribution 的成因。
#     * 行内唯一：同一视觉行（y 重叠 >= 50%）内的块 x 区间不得互相重叠
#       （重叠 = 左右关系不可判；不重叠是合法的并排关系，按 x 定序）。
#     * 行间唯一：相邻（跨行）块的 y 区间不得"实质交错"（上下不可判）。
#       相邻行 bbox 有 ascender/descender 级别的交叠是排版本性，不是顺序歧义；
#       只有交叠超过较矮块字高 25% 才算实质交错。用相对字高的比例、不用固定 pt：
#       固定 0.5pt 只是给某一种字号调出来的常数，换字号/OCR 就会误判。
#   任一条件不满足就返回 ``None``，调用方保持 ``order_verified=False``。
#   字符守恒由调用方（pdf_reader）用 ``Counter(非空白字符)`` 复核：几何只改顺序，
#   文本逐字不动；不等则放弃重排并记 ``pdf_layout_unread``。
#
# 后端名（下游要能看出这一页靠哪种几何验证过）：
#     'geometric-columns' —— 页内识别出 >=2 列并按列重排；
#     'geometric-order'   —— 单列页，按"自上而下、行内自左而右"重排/核对。
GEOMETRIC_COLUMNS = 'geometric-columns'
GEOMETRIC_ORDER = 'geometric-order'
GEOMETRIC_BACKENDS = (GEOMETRIC_COLUMNS, GEOMETRIC_ORDER)

_GEOM_EPS = 1e-4
# 测量噪声容差（pt）：PDF 块 bbox 含字形上下沿，相邻行/同行块可能轻微交叠；
# 只有超过这个量级才当成"真的重叠"，避免把 0.2pt 的 bbox 误差判成不可判。
_GEOM_TOL = 0.5
_GEOM_MIN_GUTTER_PT = 8.0          # 绝对最小列间距
_GEOM_MIN_GUTTER_RATIO = 0.02      # 相对页宽的最小列间距
_GEOM_MIN_COLUMN_BLOCKS = 2        # 每列至少 2 个块（单块窄条不算一列）
_GEOM_MIN_WIDTH_BALANCE = 0.28     # 两侧列宽比下限（防右对齐日期/标签列被当第二列）
_GEOM_ROW_OVERLAP = 0.5            # 同一视觉行：y 重叠占较矮块高度的比例
_GEOM_COLUMN_OVERLAP = 0.5         # 同一列（多列叶子）：x 重叠占较窄块宽度的比例
_GEOM_ROW_TOP_TOL = 2.0            # 逐行对齐判定容差（pt）
_GEOM_MAX_ROW_PAIRING = 0.45       # 逐行配对比例上限（表格式两列不能按列读）
_GEOM_MAX_DEPTH = 16
# 主列判定（单列页）：
_GEOM_CLUSTER_OVERLAP = 0.5        # x 聚类：重叠 / 较宽块宽度
_GEOM_WIDE_MAIN_RATIO = 0.9        # 通栏块：x 跨度 >= 主列宽度的 90%
_GEOM_WIDE_CENTER_RATIO = 0.6      # 通栏块（居中款）：宽度 >= 页宽的 60%
_GEOM_CENTER_SLACK = 0.10          # "居中"允许偏离页面中心 10% 页宽
_GEOM_INSIDE_RATIO = 0.9           # 其余块必须落在主列内：x 重叠 >= 90%
# 行间"实质交错"的判据：相邻行 bbox 的 ascender/descender 交叠是排版本性；
# 交叠 <= 较矮块字高的 25% 视为行盒噪声，不算上下关系不可判。
# 用相对字高的比例而不是固定 pt，避免换字号/OCR 时口径失效（lead 2026-11-14 裁决）。
_GEOM_INTERLEAVE_NOISE = 0.25


def _geom_items(blocks):
    """block -> [(原索引, bbox)]；任一 bbox 不合法则整页不给结论。"""
    items = []
    for index, block in enumerate(blocks):
        location = block.get('location') or {}
        bbox = location.get('bbox')
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            return None
        if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in bbox):
            return None
        rect = fitz.Rect(bbox)
        if rect.is_empty or rect.is_infinite:
            return None
        items.append((index, rect))
    return items


def _geom_gaps(items, axis):
    """返回 axis 方向上的白缝 [(start, end)]：该区间内没有任何块覆盖。"""
    events = []
    for _, rect in items:
        if axis == 'x':
            events.append((rect.x0, 1))
            events.append((rect.x1, -1))
        else:
            events.append((rect.y0, 1))
            events.append((rect.y1, -1))
    # 同一坐标先"收"后"开"：首尾相接的块之间不算白缝。
    events.sort(key=lambda item: (item[0], item[1]))
    gaps, depth, gap_start = [], 0, None
    for coordinate, delta in events:
        if delta > 0:
            if depth == 0 and gap_start is not None and coordinate - gap_start > _GEOM_EPS:
                gaps.append((gap_start, coordinate))
            depth += 1
        else:
            depth -= 1
            if depth == 0:
                gap_start = coordinate
    return gaps


def _geom_split(items, axis, gap):
    """按白缝切分；有任何块落在缝里（跨列/跨行）就返回 None。"""
    if axis == 'x':
        before = [item for item in items if item[1].x1 <= gap[0] + _GEOM_EPS]
        after = [item for item in items if item[1].x0 >= gap[1] - _GEOM_EPS]
    else:
        before = [item for item in items if item[1].y1 <= gap[0] + _GEOM_EPS]
        after = [item for item in items if item[1].y0 >= gap[1] - _GEOM_EPS]
    if len(before) + len(after) != len(items):
        return None
    return before, after


def _geom_extent(items, axis):
    if axis == 'x':
        return max(rect.x1 for _, rect in items) - min(rect.x0 for _, rect in items)
    return max(rect.y1 for _, rect in items) - min(rect.y0 for _, rect in items)


def _geom_x_overlap(left, right):
    return min(left.x1, right.x1) - max(left.x0, right.x0)


def _geom_y_overlap(left, right):
    return min(left.y1, right.y1) - max(left.y0, right.y0)


def _geom_row_paired(side, other):
    """逐行对齐比例：主体/时间分列的表不能被当成两栏独立阅读。"""
    if not side:
        return 1.0
    paired = 0
    for _, rect in side:
        for _, peer in other:
            if (abs(rect.y0 - peer.y0) <= _GEOM_ROW_TOP_TOL
                    and _geom_y_overlap(rect, peer) > _GEOM_EPS):
                paired += 1
                break
    return paired / len(side)


def _geom_rows(items):
    """按"同一视觉行"给块分组（y 重叠 >= 50% 较矮块高度，连通分量）。"""
    parent = list(range(len(items)))

    def _find(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def _union(a, b):
        root_a, root_b = _find(a), _find(b)
        if root_a != root_b:
            parent[root_b] = root_a

    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            rect_i, rect_j = items[i][1], items[j][1]
            smallest = max(min(rect_i.height, rect_j.height), _GEOM_EPS)
            if _geom_y_overlap(rect_i, rect_j) / smallest >= _GEOM_ROW_OVERLAP:
                _union(i, j)
    groups = {}
    for index in range(len(items)):
        groups.setdefault(_find(index), []).append(index)
    return list(groups.values())


def _geom_row_order(items):
    """同列堆叠的阅读顺序：行自上而下，行内自左而右。"""
    groups = _geom_rows(items)
    ordered = []
    for group in sorted(groups, key=lambda g: min(items[i][1].y0 for i in g)):
        ordered.extend(sorted(group, key=lambda i: items[i][1].x0))
    return [items[index] for index in ordered]


def _geom_validate_rows(items, *, strict_column):
    """条件 2/3（多列叶子还要额外条件 1）；返回 (ok, 原因)。

    条件 2（行内唯一）：同一视觉行内 x 区间不得重叠（重叠 = 左右不可判）。
    条件 3（行间唯一）：相邻（跨行）块的 y 区间不得"实质交错" —— 交叠超过
        较矮块字高的 25% 且既分离又不包含 → 上下不可判。相邻行 bbox 的
        ascender/descender 交叠（<= 字高 25%）属行盒噪声，不算交错。
        同一视觉行的块不参与条件 3（它们的左右关系由条件 2 负责）。
    条件 1（仅多列叶子）：不同行的块 x 重叠 >= 50%（较窄块为分母），确实是同一列。
        单列页的这一条由主列判定（``_geom_single_plan``）承担，不在这里重复。
    """
    if len(items) < 2:
        return True, ''
    groups = _geom_rows(items)
    row_of = {}
    for position, group in enumerate(groups):
        for index in group:
            row_of[index] = position
    # 条件 2：同一视觉行内 x 不许重叠（否则左右不可判）
    for group in groups:
        for a in range(len(group)):
            for b in range(a + 1, len(group)):
                rect_a, rect_b = items[group[a]][1], items[group[b]][1]
                overlap = _geom_x_overlap(rect_a, rect_b)
                if overlap > _GEOM_TOL:
                    return False, f'same-row blocks overlap horizontally ({overlap:.1f}pt)'
    # 条件 1（仅多列叶子）：不同行的块必须落在同一列
    if strict_column:
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                if row_of[i] == row_of[j]:
                    continue
                rect_i, rect_j = items[i][1], items[j][1]
                narrower = max(min(rect_i.width, rect_j.width), _GEOM_EPS)
                ratio = _geom_x_overlap(rect_i, rect_j) / narrower
                if ratio < _GEOM_COLUMN_OVERLAP:
                    return False, (f'blocks in different rows do not share a column '
                                   f'(x overlap {ratio:.2f})')
    # 条件 3：跨行相邻块的 y 区间不得交错
    ordered = []
    for group in sorted(groups, key=lambda g: min(items[i][1].y0 for i in g)):
        ordered.extend(sorted(group, key=lambda i: items[i][1].x0))
    for first, second in zip(ordered, ordered[1:]):
        if row_of[first] == row_of[second]:
            continue  # 同一视觉行：由条件 2 管
        rect_a, rect_b = items[first][1], items[second][1]
        overlap = _geom_y_overlap(rect_a, rect_b)
        smaller = max(min(rect_a.height, rect_b.height), _GEOM_EPS)
        if overlap <= _GEOM_TOL or overlap <= _GEOM_INTERLEAVE_NOISE * smaller:
            continue  # 行盒 ascender/descender 级别的交叠不算实质交错
        nested = ((rect_a.y0 <= rect_b.y0 + _GEOM_TOL and rect_b.y1 <= rect_a.y1 + _GEOM_TOL)
                  or (rect_b.y0 <= rect_a.y0 + _GEOM_TOL and rect_a.y1 <= rect_b.y1 + _GEOM_TOL))
        if not nested:
            return False, ('adjacent blocks interleave substantially '
                           f'({overlap:.1f}pt > {_GEOM_INTERLEAVE_NOISE:.0%} of line height)')
    return True, ''


def _geom_validate_single(items):
    """单列页的行内/行间唯一性（条件 1 由主列判定承担）。"""
    return _geom_validate_rows(items, strict_column=False)


def _geom_validate_column(items):
    """多列叶子：在条件 2/3 之外再要求"这些块确实在同一列"。"""
    return _geom_validate_rows(items, strict_column=True)


def _geom_char_weights(blocks):
    """非空白字符数（只用于选主列；不参与、也不改写文本）。"""
    return [len(re.sub(r'\s', '', block.get('text') or '')) for block in blocks]


def _geom_x_clusters(items, weights):
    """按 x 区间重叠度聚类：重叠 / 较宽块宽度 >= 50% 归为同一簇。"""
    parent = list(range(len(items)))

    def _find(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            rect_i, rect_j = items[i][1], items[j][1]
            wider = max(rect_i.width, rect_j.width, _GEOM_EPS)
            if _geom_x_overlap(rect_i, rect_j) / wider >= _GEOM_CLUSTER_OVERLAP:
                root_i, root_j = _find(i), _find(j)
                if root_i != root_j:
                    parent[root_j] = root_i
    groups = {}
    for index in range(len(items)):
        groups.setdefault(_find(index), []).append(index)
    return list(groups.values())


def _geom_single_plan(items, weights, page_width):
    """单列页判定：主列 + 通栏块。返回 (顺序列表, None) 或 (None, 原因)。

    为什么不再要求"所有块两两 x 重叠"：真实简历的姓名/联系方式常居中或右对齐，
    它们与左对齐正文天然不共列 —— 这不是多列，是"单列 + 通栏块"。判据改成：
        1. 先按 x 重叠度聚类，取非空白字符最多的簇为主列；
        2. x 跨度 >= 主列宽 90%（且与主列相交）或"居中且宽 >= 页宽 60%"的块
           是通栏块，不参与列判定，按 y 夹在主列块之间；
        3. 其余块必须落在主列内（x 与主列重叠 >= 90%），否则不是单列页。
    """
    if not items:
        return [], None
    groups = _geom_x_clusters(items, weights)

    def _strength(group):
        width = _geom_extent([items[i] for i in group], 'x')
        return (sum(weights[i] for i in group), len(group), width)

    main = max(groups, key=_strength)
    main_lo = min(items[i][1].x0 for i in main)
    main_hi = max(items[i][1].x1 for i in main)
    main_width = main_hi - main_lo
    main_rect = fitz.Rect(main_lo, 0.0, main_hi, 1.0)
    page_center = page_width / 2.0
    wide = set()
    for position, (_, rect) in enumerate(items):
        overlaps_main = _geom_x_overlap(rect, main_rect) > _GEOM_EPS
        centered = (abs((rect.x0 + rect.x1) / 2 - page_center)
                    <= _GEOM_CENTER_SLACK * page_width)
        if ((overlaps_main and rect.width >= _GEOM_WIDE_MAIN_RATIO * main_width)
                or (centered and rect.width >= _GEOM_WIDE_CENTER_RATIO * page_width)):
            wide.add(position)
    for position, (_, rect) in enumerate(items):
        if position in wide:
            continue
        inside = _geom_x_overlap(rect, main_rect) / max(rect.width, _GEOM_EPS)
        if inside < _GEOM_INSIDE_RATIO:
            return None, f'block does not sit inside the main column (x overlap {inside:.2f})'
    ok, reason = _geom_validate_single(items)
    if not ok:
        return None, reason
    return _geom_row_order(items), None


def _geom_columns_plan(items, page_width):
    """多列页：递归切分页面，返回 (顺序, 后端名, 说明) 或 (None, ...)。

    顺序 = 带自上而下、带内列自左而右、列内块自上而下。
    竖向切分只在"像真的两列"时采用；否则退回横向切分（横向切分对阅读顺序
    永远是安全的：上方的块一定先于下方的块）。没有切出任何列 → 不是多列页。
    """
    min_gutter = max(_GEOM_MIN_GUTTER_PT, _GEOM_MIN_GUTTER_RATIO * page_width)
    leaves: list = []
    columns = 0
    ambiguous = []

    def order(group, depth=0):
        nonlocal columns
        if len(group) < 2 or depth > _GEOM_MAX_DEPTH:
            leaves.append(list(group))
            return _geom_row_order(group)
        # --- 先试列 ---
        candidate = None
        for gap in _geom_gaps(group, 'x'):
            split = _geom_split(group, 'x', gap)
            if split is None:
                continue
            left, right = split
            if len(left) < _GEOM_MIN_COLUMN_BLOCKS or len(right) < _GEOM_MIN_COLUMN_BLOCKS:
                continue
            if candidate is None or gap[1] - gap[0] > candidate[0]:
                candidate = (gap[1] - gap[0], left, right)
        if candidate is not None:
            width, left, right = candidate
            left_width, right_width = _geom_extent(left, 'x'), _geom_extent(right, 'x')
            balance = min(left_width, right_width) / max(left_width, right_width, _GEOM_EPS)
            pairing = max(_geom_row_paired(left, right), _geom_row_paired(right, left))
            if (width >= min_gutter and balance >= _GEOM_MIN_WIDTH_BALANCE
                    and pairing < _GEOM_MAX_ROW_PAIRING):
                columns += 1
                return order(left, depth + 1) + order(right, depth + 1)
            if (width < min_gutter and balance >= _GEOM_MIN_WIDTH_BALANCE
                    and pairing < _GEOM_MAX_ROW_PAIRING):
                # 两侧都够"像列"，但缝太窄：列间距不明显 → 整页不自信。
                ambiguous.append(f'column gutter too narrow ({width:.1f}pt)')
        # --- 再试带（横向切分，阅读顺序永远安全）---
        candidate = None
        for gap in _geom_gaps(group, 'y'):
            split = _geom_split(group, 'y', gap)
            if split is None or not split[0] or not split[1]:
                continue
            if candidate is None or gap[1] - gap[0] > candidate[0]:
                candidate = (gap[1] - gap[0], split[0], split[1])
        if candidate is not None:
            _, top, bottom = candidate
            return order(top, depth + 1) + order(bottom, depth + 1)
        leaves.append(list(group))
        return _geom_row_order(group)

    ordered = order(list(items))
    if ambiguous:
        return None, None, ' '.join(ambiguous[:2])
    if not columns:
        return None, None, 'no clear column structure'
    # 多列页：每一列（叶子 = 单列堆叠）本身必须顺序唯一。
    for leaf in leaves:
        ok, reason = _geom_validate_column(leaf)
        if not ok:
            return None, None, reason
    return ordered, GEOMETRIC_COLUMNS, ''


def _geom_plan(items, weights, page_width):
    """先按单列（主列 + 通栏块）判定，判不了再按多列判定。"""
    ordered, reason = _geom_single_plan(items, weights, page_width)
    if ordered is not None:
        return ordered, GEOMETRIC_ORDER, ''
    ordered, backend, columns_reason = _geom_columns_plan(items, page_width)
    if ordered is not None:
        return ordered, backend, ''
    return None, None, reason or columns_reason


def geometric_order(blocks, page_width):
    """纯几何重排：返回 {'order': [...], 'backend': ...} 或 ``None``。

    ``order`` 是 ``blocks`` 的新索引顺序；``None`` = 几何证据不足以确认唯一
    阅读顺序，调用方必须保持原生内容流顺序与 ``order_verified=False``。
    只读 bbox 与非空白字符数（后者仅用于选主列），不读语义、不改写文本；
    文本守恒由调用方用 ``Counter(非空白字符)`` 复核。
    """
    if not blocks or page_width <= 0:
        return None
    items = _geom_items(blocks)
    if items is None:
        return None
    weights = _geom_char_weights(blocks)
    ordered, backend, _ = _geom_plan(items, weights, page_width)
    if ordered is None or backend is None:
        return None
    order = [index for index, _ in ordered]
    if len(order) != len(blocks) or sorted(order) != list(range(len(blocks))):
        return None
    return {'order': order, 'backend': backend}
