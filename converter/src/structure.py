"""Unified structure layer: heading levels from *evidence*, never from wording alone.

Provenance
----------
Faithful subset of ``resume-conversion-build/tools/conversion/structure.py``
(read-only reference, 2026-11).  Copied functions keep their original logic,
word lists and thresholds; the parts that are irrelevant for PDF (HTML tags,
Markdown assembly, OCR block building) are omitted.  Deviations are marked
``DEVIATION`` and are behaviour-preserving for PDF input:

* ``_infer_by_metric`` only rewrites ``block['text']`` when an ATX ``#`` prefix
  was actually stripped.  The reference always reassigns the stripped text; for
  PDF blocks (which never carry ``#``) the value is identical, but not touching
  the text keeps "原生文本一字不改" auditable.
* ``mark_headings`` is new and tiny: the reference lets the *assembler* read
  ``level``; our contract also needs ``kind="heading"``.  It only sets a field,
  never the text.

Conservative rules inherited from the reference (do not relax):
    * geometry alone cannot decide a semantic role
    * unknown role stays unknown — no invented headings
    * a wrong level is worse than a missing level
"""
from __future__ import annotations

import re

# 中文简历常见章节词（含中英对照）——原样照抄
_SECTION_WORDS = (
    '个人信息', '基本信息', '个人资料', '联系方式', '求职意向', '求职目标', '求职方向',
    '教育背景', '教育经历', '学习经历', '学历', '在校经历',
    '工作经历', '工作经验', '职业经历', '任职经历', '实习经历', '实习经验', '项目经历',
    '项目经验', '核心项目', '代表项目', '代表作品', '作品', '作品集', '开源项目',
    '专业技能', '技能清单', '技能', '能力', '技术栈', '证书', '资质', '认证',
    '获奖', '荣誉', '奖项', '荣誉奖项', '获奖经历',
    '自我评价', '自我介绍', '个人总结', '总结', '个人简介', '关于我',
    '研究经历', '科研成果', '论文', '专利', '致谢', '其他', '兴趣', '爱好',
    # 单字/短词：原 scope.PERSONAL_HEADING 会认「我的经历」「教育」这类写法
    '经历', '教育', '技能', '能力关键词', '核心能力',
    'profile', 'summary', 'about', 'education', 'experience', 'work experience',
    'projects', 'skills', 'awards', 'honors', 'certificates', 'publications',
    'contact', 'interests',
)

ROLE_SECTION = "section"    # 简历章节：教育/工作/项目/技能/获奖...
ROLE_SETUP = "setup"        # 安装/部署/运行/环境配置
ROLE_DEV = "dev"            # 开发/构建/测试/贡献
ROLE_PERSONAL = "personal"  # 关于我/个人简介/自我介绍
ROLE_CONTACT = "contact"    # 联系方式
ROLE_NAV = "nav"            # 导航/菜单/页眉页脚
ROLE_OTHER = "other"

_SETUP_WORDS = (
    '安装', '部署', '运行', '环境配置', '快速开始', '使用方法', '使用说明',
    '项目结构', '目录结构', '运行方式', '启动方式',
    'install', 'installation', 'setup', 'usage', 'getting started',
    'quick start', 'quickstart', 'deploy', 'deployment', 'requirements', 'dependencies',
)
_DEV_WORDS = (
    '开发', '构建', '测试', '贡献', '维护内容', '开发指南', '贡献指南', 'changelog',
    'development', 'build', 'testing', 'tests', 'contribute', 'contributing', 'license',
)
_PERSONAL_WORDS = (
    '关于我', '自我介绍', '个人简介', '个人介绍', '个人简历', '个人总结',
    'about me', 'profile', 'introduction',
)
_CONTACT_WORDS = ('联系方式', '联系我', 'contact', 'get in touch')
_NAV_WORDS = ('导航', '菜单', '页眉', '页脚', '回到顶部', 'menu', 'navigation')


def classify_heading(title: str) -> str:
    """判断标题文字的语义角色，返回 ROLE_*。

    只回答"这个标题属于哪一类"，不判断"这份材料是什么"。
    """
    t = (title or "").strip()
    if not t:
        return ROLE_OTHER
    low = t.lower()
    squashed = low.replace(" ", "")

    # 顺序有意义：越具体的越先判
    for words, role in (
        (_NAV_WORDS, ROLE_NAV),
        (_CONTACT_WORDS, ROLE_CONTACT),
        (_SETUP_WORDS, ROLE_SETUP),
        (_DEV_WORDS, ROLE_DEV),
        (_PERSONAL_WORDS, ROLE_PERSONAL),
        (_SECTION_WORDS, ROLE_SECTION),
    ):
        for w in words:
            wl = w.lower()
            if wl in low or wl.replace(" ", "") in squashed:
                return role
    return ROLE_OTHER


# ===== Markdown 标题解析（与参考实现同一正则） =====
HEADING_MAX_LEVEL = 6
_MD_HEADING = re.compile(r"^[ \t]{0,3}(#{1,6})[ \t]+(.*)$")


def parse_heading(line: str) -> tuple[int, str]:
    """判断一行是否为 ATX 标题。返回 (level, title)；不是标题返回 (0, '')。"""
    text = (line or "").rstrip("\r\n")
    m = _MD_HEADING.match(text)
    if not m:
        return 0, ""
    return len(m.group(1)), m.group(2).strip()


_SENTENCE_END = '。！？.!?，,；;：:、'
_CJK_NAME = re.compile(r'^[\u4e00-\u9fa5]{2,4}$')
_EN_NAME = re.compile(r'^[A-Za-z][A-Za-z.\-]{1,24}(?:\s+[A-Za-z][A-Za-z.\-]{0,24}){0,2}$')
_YEAR_RANGE = re.compile(r'(?:19|20)\d{2}\s*[.\-/年]')


# ============================ 证据读取 ============================
def _evidence(block: dict) -> dict:
    ev = block.get('evidence')
    return ev if isinstance(ev, dict) else {}


def _existing_level(block: dict) -> int:
    ev = _evidence(block)
    lv = ev.get('existing_level')
    if isinstance(lv, int) and 1 <= lv <= 6:
        return lv
    m = _MD_HEADING.match((block.get('text') or '').strip())
    if m:
        return len(m.group(1))
    return 0


def _font_size(block: dict) -> float:
    try:
        return float(_evidence(block).get('font_size') or 0)
    except (TypeError, ValueError):
        return 0.0


def _is_bold(block: dict) -> bool:
    """排版强调信号（PDF 粗体）。与字号独立。"""
    return bool(_evidence(block).get('is_bold'))


def _bbox_height(block: dict) -> float:
    ev = _evidence(block)
    direct = ev.get('bbox_height')
    if direct is not None:
        try:
            v = float(direct)
            if v > 0:
                return v
        except (TypeError, ValueError):
            pass
    bbox = ev.get('bbox') or block.get('location', {}).get('bbox')
    if not bbox or len(bbox) != 4:
        return 0.0
    try:
        return abs(float(bbox[3]) - float(bbox[1]))
    except (TypeError, ValueError):
        return 0.0


# ============================ 标题文本校验 ============================
def _title_candidate(text: str) -> bool:
    """这段文本适不适合当标题（避免把长段落/句子标成标题）。"""
    t = (text or '').strip()
    if not t or len(t) > 40:
        return False
    if t[-1] in _SENTENCE_END:
        return False
    return bool(re.search(r'[\u4e00-\u9fa5A-Za-z0-9]', t))


def _classify_title(text: str, *, is_top_size: bool, page_no: int = 1) -> int:
    """把候选标题映射到层级。1=姓名 2=章节 3=条目。"""
    t = (text or '').strip()
    short = re.sub(r'\s+', '', t)

    # ① 姓名（只可能在首页）：纯中文 2-4 字 / 英文名，且是最大字号
    if page_no == 1 and is_top_size:
        head = re.match(r'^([\u4e00-\u9fa5]{2,4})(?=[\s\uff08(]|$)', t)
        if head and not any(head.group(1).startswith(w) for w in _SECTION_WORDS):
            return 1
        head_en = re.match(r'^([A-Za-z][A-Za-z.\-]{1,24})(?=[\s(]|$)', t)
        if head_en and len(t) <= 30:
            return 1

    # ② 章节词开头 → 章节
    if len(short) <= 14 and any(short.lower().startswith(w.lower()) for w in _SECTION_WORDS):
        return 2

    # ③ 含年份区间 → 公司/项目条目
    if _YEAR_RANGE.search(t):
        return 3

    # ④ 其余不标为标题（宁缺勿滥：识别错层级比识别不到更糟）
    return 0


# ============================ 结构推断 ============================
def heading_count(blocks: list) -> int:
    """标题数量（供上层判断"结构是否识别成功"）。

    DEVIATION：只数结构层给出的 level，不数正文里的 "#"——PDF 里那是内容。
    """
    return sum(1 for b in blocks or [] if (b.get("level") or 0) > 0)


def infer_structure(blocks: list, *, page_of: dict | None = None) -> list:
    """给 blocks 标注 heading level（0=正文）。返回同一 list（就地标注）。

    证据优先级：existing_level > font_size > bbox_height。
    """
    if not blocks:
        return blocks

    # DEVIATION（相对参考实现）：PDF 里行首的 "#" 是**正文内容**，不是 Markdown 标记。
    # 参考实现面向 Markdown 源，会把 "# " 前缀剥掉并把该块当 existing_level 标题；
    # 在这里那样做等于改写原生正文（doc 11 A2/A3 明确禁止），因此不采用
    # existing_level 证据，也绝不改写 block['text']。
    sizes = [(_font_size(b), b) for b in blocks if _font_size(b) > 0]
    heights = [(_bbox_height(b), b) for b in blocks if _bbox_height(b) > 0]

    if sizes:
        return _infer_by_metric(blocks, sizes, key='font_size', page_of=page_of)

    if heights:
        return _infer_by_metric(blocks, heights, key='bbox_height', page_of=page_of)

    return blocks


def _infer_by_metric(blocks: list, pairs: list, *, key: str, page_of=None) -> list:
    """按数值指标（字号/块高）分档推断标题层级。"""
    from collections import Counter
    vals = [v for v, _ in pairs if v > 0]
    if len(vals) < 4:
        return blocks
    counter = Counter(round(v, 1) for v in vals)
    # 正文字号估计：先用「长文本」的字号（正文的可靠特征是文本长，
    # 不是出现次数多——章节多的极简简历会让众数落在标题字号上）。
    long_sizes = [round(v, 1) for v, b in pairs
                  if v > 0 and len((b.get('text') or '').strip()) >= 20]
    if long_sizes:
        body_val = Counter(long_sizes).most_common(1)[0][0]
    else:
        body_val = counter.most_common(1)[0][0]
    if body_val <= 0:
        return blocks

    if key == 'bbox_height' and len(vals) >= 10:
        ordered = sorted(round(v, 1) for v in vals)
        p50 = ordered[len(ordered) // 2]
        p85 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.85))]
        threshold = max(p50 * 1.08, p85)
    elif key == 'bbox_height':
        threshold = body_val * 1.30
    else:
        threshold = body_val * 1.15
    top_val = max(round(v, 1) for v in vals)

    used = set()
    counts = {1: 0, 2: 0, 3: 0}
    for val, block in pairs:
        rv = round(val, 1)
        # 两种独立信号：字号明显大于正文，或排版加粗
        bold = _is_bold(block)
        if rv < threshold and not bold:
            continue
        text = (block.get('text') or '').strip()
        if not _title_candidate(text):
            continue
        norm = re.sub(r'\s+', '', text)
        if norm in used:
            continue
        used.add(norm)
        page_no = (page_of or {}).get(id(block), 1)
        # 只有字号最大时才可能是姓名；纯加粗不参与 h1 判定
        lvl = _classify_title(text, is_top_size=(rv == top_val and rv >= threshold),
                              page_no=page_no)
        if lvl <= 0:
            continue  # 不是标题，保持正文
        if counts[lvl] >= 20:
            continue
        counts[lvl] += 1
        block['level'] = lvl  # 只加 level，绝不动 text
    return blocks


def mark_headings(blocks: list) -> list:
    """把 level>0 的 block 标成 kind="heading"。只改 kind，不改 text。"""
    for b in blocks:
        if (b.get('level') or 0) > 0 and b.get('kind') == 'paragraph':
            b['kind'] = 'heading'
    return blocks
