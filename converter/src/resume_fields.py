"""招聘字段三态 / 时间线 / 平台噪声 / 受保护属性（doc 11 §9 的落法）。

设计原则（全部来自 doc 11，不得放宽）：

1. **三态不是布尔**。``present`` = 原文有且已读出；``absent`` = 原文确实没有；
   ``unreadable`` = 原文有但读不出。红线：``unreadable`` 绝不能当 ``absent``。
   落法：**只要整篇还有 HARD issue（有页/有块没读全），任何"没找到"的字段一律
   记为 ``unreadable``**，不允许在没读全的文档上断言"没有"。这样"因读取失败
   而淘汰候选人"在结构上不可能发生。

2. **不做跨区块拼装**。经历的（公司/职位/起止）只从**同一视觉行**（y 区间重叠
   ≥50%）的 block 取；跨行/跨页组合一律不拼，标记 ``unreadable`` 并报
   ``resume_experience_cross_block``。行内多块（左公司/右时间）是正常排版，
   记为 ``same_row_multi_block`` 并逐块留证据。

3. **不修补**。时间线断档/重叠/倒挂只报告，不补齐、不猜测。含"至今"的开放区间
   不按当天日期折算（否则输出不可复现）。

4. **噪声与受保护属性只隔离，不删原文**。平台水印整块移出 ``blocks`` 并逐条
   记录（page/bbox/text），受保护属性留在 blocks 里但绝不进入 ``fields``/
   ``screening``。
"""
from __future__ import annotations

import re

from . import structure as st
from .issues import hard_codes, issue_severity

PRESENT, ABSENT, UNREADABLE = "present", "absent", "unreadable"

# ============================ 平台噪声 ============================
# 招聘网站导出的 PDF 常带页眉/页脚/水印。判据不是"出现平台名"，
# 而是"整块只剩平台标识"——否则「BOSS直聘 产品经理」这种真实经历会被删掉。
_PLATFORM_MARKERS = (
    "boss直聘", "zhipin", "猎聘", "liepin", "智联招聘", "zhaopin", "前程无忧",
    "51job", "58同城", "58.com", "拉勾", "lagou", "脉脉", "maimai", "看准网",
    "kanzhun", "实习僧", "shixiseng", "牛客", "nowcoder", "中华英才网", "chinahr",
    "大街网", "dajie", "赶集网", "ganji", "百姓网", "baixing", "应届生求职网",
    "yingjiesheng", "智联",
)
# 注意：linkedin.com / github.com 这类**个人主页链接**是真实联系方式，不是平台水印，
# 因此不在 marker 里。加进来会把正常简历误判成噪声（实测 talent_pool-23/24）。
# 品牌残片：与 marker 一起被剔除后才允许判"整块都是噪声"
_BRAND_TOKENS = ("boss", "www", "http", "https", "com", "cn", "net", "org", "mail")
_URL_RE = re.compile(r"(?:https?://)?(?:www\.)?[a-z0-9\-]+(?:\.[a-z0-9\-]+)+(?:/[^\s]*)?", re.I)
_PAGE_NO_RE = re.compile(r"(?:第\s*\d+\s*页(?:\s*[/／]\s*共\s*\d+\s*页)?|共\s*\d+\s*页|"
                         r"page\s*\d+(?:\s*(?:of|/)\s*\d+)?|\d+\s*/\s*\d+)", re.I)


def _noise_residual(text: str) -> str:
    """去掉平台标识/URL/页码后还剩什么（只剩标点空白 = 空）。"""
    t = (text or "").lower()
    t = _URL_RE.sub(" ", t)
    t = _PAGE_NO_RE.sub(" ", t)
    for marker in _PLATFORM_MARKERS:
        t = t.replace(marker, " ")
    for token in _BRAND_TOKENS:
        t = re.sub(r"\b" + re.escape(token) + r"\b", " ", t)
    return re.sub(r"[\W_]+", "", t)


def is_noise_block(block: dict) -> tuple[bool, str]:
    """整块只有平台标识 → 噪声。返回 (是否噪声, 命中的 marker)。"""
    text = (block.get("text") or "").strip()
    if not text or len(text) > 120:
        return False, ""
    low = text.lower()
    hit = next((m for m in _PLATFORM_MARKERS if m in low), "")
    if not hit:
        return False, ""
    if _noise_residual(text):
        return False, ""          # 还剩下真实内容 → 不是纯噪声
    return True, hit


# ============================ 受保护属性 ============================
# doc 11 §9.6：年龄、性别、婚育、籍贯、民族、照片。识别 + 隔离，不进筛选特征。
_PERSONAL_CONTEXT = re.compile(r"年龄|岁|出生|生日|电话|手机|邮箱|学历|民族|婚|籍贯|户口|身高|体重")
_PROTECTED_PATTERNS = {
    "gender": (
        re.compile(r"性别\s*[:：]?\s*(男|女)"),
        re.compile(r"(?:^|[\s│|·・])男(?:[\s│|·・]|$)"),
        re.compile(r"(?:^|[\s│|·・])女(?:[\s│|·・]|$)"),
        re.compile(r"(?:男|女)\s*[│|]\s*(?:19|20)\d{2}"),
    ),
    "age_or_birth": (
        re.compile(r"年龄\s*[:：]?\s*(\d{1,2})"),
        re.compile(r"(\d{1,2})\s*岁"),
        re.compile(r"(?:出生(?:日期|年月)?|生日)\s*[:：]?\s*((?:19|20)\d{2}[^\s，,。;；]*)"),
        # 「男│2003 年│…」：性别紧跟年份的个人信息行，年份即出生年（实测语料写法）
        re.compile(r"(?:男|女)\s*[│|·・]\s*((?:19|20)\d{2})\s*年"),
    ),
    "marital_or_children": (
        re.compile(r"婚姻状况|已婚|未婚|离异|丧偶|子女|已育|未育"),
    ),
    "native_place": (
        re.compile(r"(?:籍贯|户口所在地|户籍|祖籍)\s*[:：]?\s*([\u4e00-\u9fa5]{2,12})"),
        re.compile(r"籍贯|户口所在地|户籍|祖籍"),
    ),
    "ethnicity": (
        re.compile(r"民族\s*[:：]?\s*([\u4e00-\u9fa5]{1,8}族)"),
        re.compile(r"(?:汉|回|满|壮|苗|维吾尔|蒙古|藏|土家|朝鲜|侗|瑶|白|彝|布依|傣)族"),
    ),
}
PROTECTED_ATTRS = tuple(_PROTECTED_PATTERNS) + ("photo",)


def _protected_hits(block: dict) -> list[tuple[str, str]]:
    """在一个 block 里识别受保护属性，返回 [(attr, 命中的原文片段)]。"""
    text = block.get("text") or ""
    if not text.strip():
        return []
    out = []
    personal = bool(_PERSONAL_CONTEXT.search(text))
    for attr, patterns in _PROTECTED_PATTERNS.items():
        for index, pattern in enumerate(patterns):
            m = pattern.search(text)
            if not m:
                continue
            # 宽松的性别单字模式只在"个人信息上下文"里成立，
            # 否则「男装」「女装」这类经历描述会被误判。
            if attr == "gender" and index in (1, 2) and not personal:
                continue
            out.append((attr, m.group(0).strip()))
            break
    return out


# ============================ 日期 / 时间线 ============================
_MONTH_NAMES = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9, "oct": 10,
    "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}
_PRESENT_WORDS = ("至今", "今", "现在", "present", "now", "current", "till now", "to date")
_DATE_CORE = (
    r"(?:"
    r"(?:19|20)\d{2}\s*[.\-/年]\s*(?:0?[1-9]|1[0-2])(?![0-9])"
    r"(?:\s*[.\-/月]\s*(?:0?[1-9]|[12]\d|3[01])(?![0-9])\s*日?)?"
    r"|(?:19|20)\d{2}"
    r"|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*,?\s*(?:19|20)\d{2}"
    r")"
)
_SEP = r"\s*(?:-|–|—|~|～|至|到|to|－)\s*"
_DATE_RANGE_RE = re.compile(
    r"(?P<start>" + _DATE_CORE + r")" + _SEP +
    r"(?P<end>" + _DATE_CORE + r"|至今|今|现在|present|now|current|till now|to date)",
    re.I,
)


def _parse_date_token(token: str):
    """日期 token → (year, month|None)；无法解析返回 None。"""
    t = (token or "").strip()
    if not t:
        return None
    low = t.lower()
    if low in _PRESENT_WORDS:
        return None
    m = re.match(r"((?:19|20)\d{2})\s*[.\-/年]\s*(\d{1,2})", t)
    if m:
        year, month = int(m.group(1)), int(m.group(2))
        if 1 <= month <= 12:
            return year, month
        return year, None
    m = re.match(r"((?:19|20)\d{2})", t)
    if m:
        return int(m.group(1)), None
    m = re.match(r"([a-z]+)\.?\s*,?\s*((?:19|20)\d{2})", low)
    if m and m.group(1) in _MONTH_NAMES:
        return int(m.group(2)), _MONTH_NAMES[m.group(1)]
    return None


def _month_index(year: int, month: int | None, *, as_end: bool) -> int:
    """年月 → 连续月序号。缺月份时：起点取 1 月，终点取 12 月（保守取宽）。"""
    if month is None:
        month = 12 if as_end else 1
    return year * 12 + (month - 1)


def find_date_ranges(text: str) -> list[dict]:
    """在一段原文里找起止区间。只认成对出现，不把单个年份当经历。"""
    out = []
    for m in _DATE_RANGE_RE.finditer(text or ""):
        raw = m.group(0).strip()
        start_raw = m.group("start").strip()
        end_raw = m.group("end").strip()
        start = _parse_date_token(start_raw)
        if start is None:
            continue
        present = end_raw.lower() in _PRESENT_WORDS
        end = None if present else _parse_date_token(end_raw)
        if not present and end is None:
            continue
        item = {
            "raw": raw,
            "start": {"year": start[0], "month": start[1]},
            "end": ({"year": end[0], "month": end[1]} if end else None),
            "open_ended": present,
            "start_index": _month_index(start[0], start[1], as_end=False),
            "end_index": (None if present else _month_index(end[0], end[1], as_end=True)),
        }
        out.append(item)
    return out


# ============================ 章节词表 ============================
# 只做"这一段属于哪个章节"的映射；标题判定本身仍由 structure.py 负责。
_SECTION_KINDS = (
    ("education", ("教育背景", "教育经历", "学习经历", "在校经历", "校园经历", "学历",
                   "教育", "education", "academic background", "academic", "schooling")),
    ("work", ("工作经历", "工作经验", "职业经历", "任职经历", "工作履历", "职业阶段",
              "职业历程", "工作历程", "职业发展", "从业经历", "实习经历",
              "实习经验", "工作范围", "社会经验", "工作", "experience", "work experience",
              "employment", "employment history", "work history", "professional history",
              "career history", "professional experience")),
    ("project", ("项目经历", "项目经验", "核心项目", "代表项目", "开源项目", "projects",
                 "project experience", "project", "作品集", "portfolio")),
    ("research", ("研究经历", "科研经历", "科研成果", "论文", "专利", "publications",
                  "research", "research experience")),
    ("skills", ("专业技能", "技能清单", "技能结构", "技能", "技术栈", "核心能力",
                "能力关键词", "证书", "资质", "认证", "certifications", "certification",
                "certificates", "skills", "technical skills", "my skills")),
    ("awards", ("获奖", "荣誉", "奖项", "荣誉奖项", "获奖经历", "awards", "award", "honors")),
    ("summary", ("自我评价", "自我介绍", "个人总结", "个人评价", "总结", "个人简介", "关于我",
                 "summary", "profile", "about", "self evaluation", "self-evaluation")),
    ("personal", ("个人信息", "基本信息", "个人资料", "资料", "联系方式", "求职意向",
                  "求职目标", "contact", "personal information", "profile information")),
    ("interests", ("兴趣", "爱好", "兴趣爱好", "interests", "interest", "hobbies")),
)
_TAIL_OK = r"[\s:：·\-—_0-9()（）/／]*"
# 章节标题的常见修饰前缀（"PROFESSIONAL EXPERIENCE" / "主要工作经历"）。
# 只允许"修饰词 + 章节词"整体匹配，不允许章节词出现在长句中间。
_SECTION_PREFIXES = ("professional", "work", "employment", "academic", "educational",
                     "technical", "personal", "core", "key", "main", "other", "my",
                     "additional", "主要", "相关", "专业", "个人", "其他", "核心", "我的")
# 双语标题（"工作经历 / EXPERIENCE"、"EDUCATION  教育背景"）与并列标题
# （"教育背景与专业技能"）的分隔符
_BILINGUAL_SEP = re.compile(r"[／/|｜]|\s{2,}")
_COMPOUND_SEP = re.compile(r"以及|与|和|及|、|&|＋|\+")


def _squash(text: str) -> str:
    return re.sub(r"\s+", "", (text or "")).lower()


# 一次性把"章节词 / 修饰词+章节词"展开成查表结构：判章节是每条 block 每行的热路径，
# 逐次拼 18×N 个正则会让 50 页的 PDF 从 0.5s 变成 >50s（实测 codex_converted-03）。
_FORM_TO_KIND: dict[str, str] = {}
for _kind, _words in _SECTION_KINDS:
    for _word in _words:
        _w = _squash(_word)
        _FORM_TO_KIND.setdefault(_w, _kind)
        for _prefix in _SECTION_PREFIXES:
            _FORM_TO_KIND.setdefault(_squash(_prefix) + _w, _kind)
_SECTION_ALT = re.compile(
    r"^(?P<form>" + "|".join(sorted(map(re.escape, _FORM_TO_KIND), key=len, reverse=True))
    + r")" + _TAIL_OK + r"$")


def section_kind(text: str) -> str | None:
    """一行文字对应的章节类别；不是章节标题返回 None。

    三条机械规则，都只对"短行"生效（标题常是短行，正文句子会被长度挡掉）：
      ① 整体匹配「(修饰词)+章节词」
      ② 双语标题：``工作经历 / EXPERIENCE`` —— 任一侧命中即算
      ③ 并列标题：``教育背景与专业技能`` —— 第一个片段命中即算
    """
    raw = (text or "").strip()
    if not raw or len(raw) > 28:
        return None
    squashed = _squash(raw)
    kind = _FORM_TO_KIND.get(squashed)
    if kind:
        return kind
    match = _SECTION_ALT.match(squashed)
    if match:
        return _FORM_TO_KIND.get(match.group("form"))
    parts = [p for p in _BILINGUAL_SEP.split(raw) if p.strip()]
    if len(parts) > 1:
        for part in parts:
            sub = section_kind(part.strip())
            if sub:
                return sub
    parts = [p for p in _COMPOUND_SEP.split(raw) if p.strip()]
    if len(parts) > 1:
        return section_kind(parts[0].strip())
    return None


def block_section_kind(block: dict) -> str | None:
    """块级章节判定：整块先判，再逐行判（标题常和正文合并在同一个 block 里）。"""
    text = block.get("text") or ""
    kind = section_kind(text)
    if kind:
        return kind
    for line in text.split("\n"):
        s = line.strip()
        if not s or len(s) > 28:
            continue
        kind = section_kind(s)
        if kind:
            return kind
    return None


# ============================ 证据 ============================
def _loc(block: dict) -> dict:
    location = block.get("location") or {}
    return {"page": location.get("page"), "bbox": location.get("bbox")}


def _evidence(block: dict, block_index: int, sha: str, text: str | None = None) -> dict:
    loc = _loc(block)
    return {"page": loc["page"], "bbox": loc["bbox"], "block": block_index,
            "text": (block.get("text") or "").strip() if text is None else text,
            "source_sha256": sha}


def _provenance_of(block: dict) -> str:
    """块 provenance → 字段 provenance（D-67 / doc11 §9.7：来源必须逐块传播）。

    只有原生文本块抽出来的值才允许标 ``native_text``（可自动归并）；整页 OCR 重读的块
    是 ``ocr``，模型读出的块是 ``agent_read``/``model_read``，OCR 补的标题是
    ``ocr_title``。块上没有 provenance 时记 ``unknown``——**fail-closed：不猜 native_text**，
    下游（身份闸门）只认 ``native_text``，``unknown`` 只能进人工。
    """
    value = block.get("provenance")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return "unknown"


def _field(state: str, *, value=None, evidence=None, reason="", provenance="native_text",
           extra=None) -> dict:
    item = {"state": state, "value": value, "evidence": list(evidence or []),
            "provenance": provenance, "reason": reason}
    if extra:
        item.update(extra)
    return item


# ============================ 姓名 / 电话 / 邮箱 ============================
_CJK_NAME_RE = re.compile(r"^[\u4e00-\u9fa5]{2,4}$")
_EN_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z.\-]{1,24}(?:\s+[A-Za-z][A-Za-z.\-]{0,24}){0,2}$")
_NAME_STOP = re.compile(r"[\d@:：/／]|简历|resume|curriculum", re.I)
# 「姓名：崔兴」这类带标签写法：字段在原文里被明确标注，属于已读出（最高优先级）。
# 标签必须出现在**行首**（允许前导空白），正文句子里的「姓名」不算字段标签；
# 大小写不敏感（Name / name / NAME）。值：2-20 个汉字，或 1-4 个英文单词。
# 英文 token 允许内部数字：合成简历的合法英文名是「P03 Synthetic Candidate D」，
# 只认纯字母 token 会把这类名字读丢（task-77 报告 deviation 有说明）。
_LABELED_NAME = re.compile(
    r"^[ \t]*(?:姓\s*名|name)\s*[:：]\s*(?P<cjk>[\u4e00-\u9fa5]{2,20})"
    r"|^[ \t]*(?:姓\s*名|name)\s*[:：]\s*"
    r"(?P<en>[A-Za-z][A-Za-z0-9.\-]{0,24}(?:\s+[A-Za-z][A-Za-z0-9.\-]{0,24}){0,3})",
    re.IGNORECASE | re.MULTILINE)
# 行首出现姓名标签（即使没读出值）→ 该字段不能记 absent，只能 unreadable（红线）
_NAME_LABEL = re.compile(r"^[ \t]*(?:姓\s*名|name)(?=\s*[:：]|\s*$)",
                         re.IGNORECASE | re.MULTILINE)
# 「姓名：张三  性别：男」写在同一 block 时汉字串会吞掉相邻字段词，按字段词截断
_LABELED_VALUE_STOP = re.compile(
    r"性别|年龄|电话|手机|邮箱|民族|籍贯|学历|婚姻|出生|身高|体重|城市|地址|住址|"
    r"政治面貌|求职|微信|联系方式|姓名|简历")
# 带标签但值本身就是文档/章节词时不是姓名（例如「姓名：个人简介」）
_LABELED_NAME_VETO = re.compile(
    r"^(?:姓名|声明|简历|个人简历|联系方式|基本信息|个人信息|个人简介|自我介绍|"
    r"求职意向|工作经历|教育经历|技能|项目经历|resume|curriculum vitae|"
    r"profile|summary|about|contact|personal (?:profile|information)?)$", re.I)
# 值以文档词开头（如「个人简历张三」）同样不可信：不截断、不猜，交给 unreadable
_LABELED_NAME_VETO_PREFIX = re.compile(
    r"^(?:声明|简历|个人简历|联系方式|基本信息|个人信息|个人简介|自我介绍|求职意向|"
    r"工作经历|教育经历|项目经历)")
# 出现标签但没读出值 → unreadable，不是 absent（红线：unreadable 不能当 absent）
_PHONE_LABEL = re.compile(r"电\s*话|手\s*机|联系电话|联系方式|\btel\b|\bmobile\b|\bphone\b", re.I)
_EMAIL_LABEL = re.compile(r"邮\s*箱|电子邮箱|电子邮件|\bemail\b|\be-mail\b", re.I)

_PHONE_PATTERNS = (
    re.compile(r"(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}(?!\d)"),
    re.compile(r"(?<!\d)0\d{2,3}[-\s]?\d{7,8}(?!\d)"),
)
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9](?:[A-Za-z0-9.\-]*[A-Za-z0-9])?\.[A-Za-z]{2,}")


def _name_shaped(text: str) -> bool:
    t = (text or "").strip()
    if not t or len(t) > 30 or _NAME_STOP.search(t):
        return False
    if st.classify_heading(t) != st.ROLE_OTHER:
        return False
    return bool(_CJK_NAME_RE.match(t) or _EN_NAME_RE.match(t))


def _labeled_name_value(match: re.Match) -> str:
    """带标签匹配 → 可信姓名；读不出或不可信时返回空串（交给 unreadable 兜底）。

    注意：这里**不**用 ``structure.classify_heading`` 判姓名——它是章节词表，
    会把「测试候选人丁」判成 ROLE_DEV（词表里有「测试」），把合法姓名误杀。
    带标签路径只排除"值本身就是文档词"的情况（``_LABELED_NAME_VETO``）。
    """
    cjk = (match.group("cjk") or "").strip()
    if cjk:
        # 先判"值本身就是文档词/以文档词开头"，再截断相邻字段——否则「个人简历」
        # 会被 `_LABELED_VALUE_STOP` 截成「个人」这种更糟的假姓名。
        if _LABELED_NAME_VETO.match(cjk) or _LABELED_NAME_VETO_PREFIX.match(cjk):
            return ""
        stop = _LABELED_VALUE_STOP.search(cjk)
        if stop:
            cjk = cjk[:stop.start()].strip()
        if len(cjk) < 2 or _LABELED_NAME_VETO.match(cjk):
            return ""
        return cjk
    en = (match.group("en") or "").strip()
    if not en or re.search(r"简历|resume|curriculum|[@:：/／]", en, re.I):
        return ""
    if _LABELED_NAME_VETO.match(en):
        return ""
    return en


def _find_name(blocks: list, sha: str) -> dict:
    """姓名只从两类可信来源取，优先级：① 带标签字段 ② 结构层 h1。

    绝不按"字号最大的姓名形态块"猜测：实测合成简历 V4 里首页正文小标题「声明」
    （12pt、姓名形态、无 level）就是被旧的 ``font_size_max`` fallback 当成姓名的。
    结构层 h1 已经同时含「首页 + 最大字号 + 姓名形态」三条信号，不再需要该 fallback。
    取不到可信姓名时如实 ``absent`` / ``unreadable``，绝不编造。
    """
    # ① 带标签字段（最高优先级）：原文明确标注了这是姓名
    for index, block in enumerate(blocks):
        text = block.get("text") or ""
        for match in _LABELED_NAME.finditer(text):
            value = _labeled_name_value(match)
            if value:
                return _field(PRESENT, value=value,
                              evidence=[_evidence(block, index, sha, value)],
                              provenance=_provenance_of(block),
                              extra={"match_rule": "labeled_name"})
    # ② 结构层 h1（只可能出现在首页；level=1 来自 structure 的「首页+最大字号+姓名形态」）
    for index, block in enumerate(blocks):
        location = block.get("location") or {}
        if location.get("page") != 1 or (block.get("level") or 0) != 1:
            continue
        text = (block.get("text") or "").strip()
        if _name_shaped(text):
            return _field(PRESENT, value=text,
                          evidence=[_evidence(block, index, sha, text)],
                          provenance=_provenance_of(block),
                          extra={"match_rule": "heading_level_1"})
        # 同一行还带职位（"张馨方  AI Product Manager"）：取开头的中文姓名段。
        # 规则与 structure._classify_title 的姓名判定一致。
        head = re.match(r"^([\u4e00-\u9fa5]{2,4})(?=[\s\uff08(]|$)", text)
        if head and st.classify_heading(head.group(1)) == st.ROLE_OTHER:
            value = head.group(1)
            return _field(PRESENT, value=value,
                          evidence=[_evidence(block, index, sha, value)],
                          provenance=_provenance_of(block),
                          extra={"match_rule": "heading_level_1_prefix"})
    # ③ 出现姓名标签但整篇都没读出可信值 → 读不出，而不是没有（红线）
    for index, block in enumerate(blocks):
        if _NAME_LABEL.search(block.get("text") or ""):
            return _field(UNREADABLE, reason="name_label_without_readable_value",
                          provenance=_provenance_of(block))
    return _field(ABSENT, reason="no_name_candidate", provenance="unknown")


def _find_pattern_field(blocks: list, patterns, sha: str, *, name: str) -> dict:
    for index, block in enumerate(blocks):
        text = block.get("text") or ""
        for pattern in patterns:
            m = pattern.search(text)
            if m:
                value = m.group(0).strip()
                if name == "phone":
                    digits = re.sub(r"\D", "", value)
                    if len(digits) < 7:
                        continue
                    return _field(PRESENT, value=value,
                                  evidence=[_evidence(block, index, sha, value)],
                                  provenance=_provenance_of(block),
                                  extra={"normalized": digits})
                return _field(PRESENT, value=value,
                              evidence=[_evidence(block, index, sha, value)],
                              provenance=_provenance_of(block))
    # 有标签、无值（脱敏/图片化）→ unreadable；不能记 absent
    label = _PHONE_LABEL if name == "phone" else _EMAIL_LABEL
    for index, block in enumerate(blocks):
        if label.search(block.get("text") or ""):
            return _field(UNREADABLE, reason=f"{name}_label_without_readable_value",
                          evidence=[_evidence(block, index, sha)],
                          provenance=_provenance_of(block))
    return _field(ABSENT, reason=f"no_{name}_pattern", provenance="unknown")


# ============================ 行聚类 / 章节 / 经历 ============================
def _row_clusters(blocks: list, indices: list) -> list[dict]:
    """把同一章节的 block 按视觉行聚类（y 区间重叠 ≥50% 视为同一行）。"""
    clusters: list[dict] = []
    for index in indices:
        location = blocks[index].get("location") or {}
        page = location.get("page") or 1
        bbox = location.get("bbox") or [0, 0, 0, 0]
        y0, y1 = float(bbox[1]), float(bbox[3])
        placed = False
        for cluster in clusters:
            if cluster["page"] != page:
                continue
            height = min(cluster["y1"] - cluster["y0"], y1 - y0) or 1.0
            overlap = min(cluster["y1"], y1) - max(cluster["y0"], y0)
            if overlap > 0 and overlap / height >= 0.5:
                cluster["blocks"].append(index)
                cluster["y0"] = min(cluster["y0"], y0)
                cluster["y1"] = max(cluster["y1"], y1)
                placed = True
                break
        if not placed:
            clusters.append({"page": page, "y0": y0, "y1": y1, "blocks": [index]})
    for cluster in clusters:
        cluster["blocks"].sort(
            key=lambda i: float(((blocks[i].get("location") or {}).get("bbox") or [0])[0]))
    clusters.sort(key=lambda c: (c["page"], c["y0"],
                                 float(((blocks[c["blocks"][0]].get("location") or {})
                                        .get("bbox") or [0])[0])))
    return clusters


def _median_height(blocks: list) -> float:
    heights = []
    for block in blocks:
        bbox = (block.get("location") or {}).get("bbox") or []
        if len(bbox) == 4:
            h = float(bbox[3]) - float(bbox[1])
            if h > 0:
                heights.append(h)
    if not heights:
        return 12.0
    heights.sort()
    return heights[len(heights) // 2]


_SPLIT_RE = re.compile(r"\s{2,}|[│|｜]")
# 教育行的机械标识（用于"工作章节里混入教育行"这种情况：既不能算工作经历，
# 也不能因此断言"没有教育经历"）。这是关键词匹配，不是语义推断。
_EDU_MARK_RE = re.compile(
    r"大学|学院|学校|中学|本科|专科|硕士|博士|研究生|学历|学位|毕业|在读|GPA|"
    r"university|college|institute|school|bachelor|master|ph\.?d|doctor|diploma",
    re.I,
)


def _is_education_row(text: str) -> bool:
    return bool(_EDU_MARK_RE.search(text or ""))


def _residual_text(text: str) -> str:
    """去掉日期区间后的剩余文字（判"这一行除了日期还有没有别的内容"）。"""
    residual = text or ""
    for rng in find_date_ranges(residual):
        residual = residual.replace(rng["raw"], " ")
    return residual.strip(" \t\n•·-—|｜,，;；:：")


def _split_header(text: str) -> tuple[str | None, str | None, str]:
    """同一块内机械切分"公司/职位"。切不干净就不猜，返回 (None, None, 'unsplit')。"""
    ranges = find_date_ranges(text)
    residual = text
    for rng in ranges:
        residual = residual.replace(rng["raw"], " ")
    residual = residual.strip(" \t\n·-—|｜,，;；:：")
    if not residual:
        return None, None, "date_only"
    parts = [p.strip() for p in _SPLIT_RE.split(residual) if p.strip()]
    if len(parts) == 2 and all(len(p) >= 2 for p in parts):
        return parts[0], parts[1], "two_part_split"
    if len(parts) == 1:
        return None, None, "unsplit"
    return None, None, "multi_part_unsplit"


def _entries(blocks: list, indices: list, kind: str, sha: str,
             line_height: float) -> tuple[list, list, list]:
    """把章节内 block 切成经历条目。返回 (entries, issues, education_rows)。

    ``education_rows`` 只可能来自 work 章节：有些简历把教育行直接排在"工作经历"
    下面而没有单独标题。那种行不能当工作经历（会张冠李戴），也不允许因此断言
    "没有教育经历"，所以单独交出、由调用方记成 education 的证据。
    """
    clusters = _row_clusters(blocks, indices)
    if not clusters:
        return [], [], []

    def cluster_has_date(cluster):
        return any(find_date_ranges(blocks[i].get("text") or "") for i in cluster["blocks"])

    anchors = [c for c in clusters if cluster_has_date(c)]
    granularity = "date_row"
    if not anchors:
        anchors = [c for c in clusters
                   if any((blocks[i].get("level") or 0) >= 3 for i in c["blocks"])]
        granularity = "entry_heading"
    if not anchors:
        # 整段没有任何日期行/条目标题：整段作为**一个**条目交出（不是一行一个），
        # 否则一条简历会被拆成几十条无日期的"经历"。
        anchors = [{"page": clusters[0]["page"],
                    "y0": min(c["y0"] for c in clusters),
                    "y1": max(c["y1"] for c in clusters),
                    "blocks": [i for c in clusters for i in c["blocks"]]}]
        granularity = "section"

    issues = []
    entries = []
    education_rows = []
    for order, anchor in enumerate(anchors):
        ranges = []
        for i in anchor["blocks"]:
            for rng in find_date_ranges(blocks[i].get("text") or ""):
                if rng not in ranges:
                    ranges.append(rng)
        header_text = " | ".join((blocks[i].get("text") or "").strip()
                                 for i in anchor["blocks"])
        if kind == "work" and _is_education_row(header_text):
            education_rows.append({
                "page": anchor["page"],
                "bbox": [min(float(((blocks[i].get("location") or {}).get("bbox") or [0, 0, 0, 0])[0])
                             for i in anchor["blocks"]),
                         anchor["y0"],
                         max(float(((blocks[i].get("location") or {}).get("bbox") or [0, 0, 0, 0])[2])
                             for i in anchor["blocks"]),
                         anchor["y1"]],
                "header_text": header_text,
                "evidence": [_evidence(blocks[i], i, sha) for i in anchor["blocks"]],
                "found_in": "work_section",
            })
            continue
        # 行内多块：事实只从同一行取；公司/职位只从最左块的**第一行**机械切分
        header_block = anchor["blocks"][0]
        first_line = ((blocks[header_block].get("text") or "").split("\n") or [""])[0]
        company, title, split_rule = _split_header(first_line)
        entry = {
            "index": order,
            "page": anchor["page"],
            "bbox": [min(float(((blocks[i].get("location") or {}).get("bbox") or [0, 0, 0, 0])[0])
                         for i in anchor["blocks"]),
                     anchor["y0"],
                     max(float(((blocks[i].get("location") or {}).get("bbox") or [0, 0, 0, 0])[2])
                         for i in anchor["blocks"]),
                     anchor["y1"]],
            "header_text": header_text,
            "header_blocks": [_evidence(blocks[i], i, sha) for i in anchor["blocks"]],
            "company": company,
            "title": title,
            "split_rule": split_rule,
            "dates": [{"raw": r["raw"], "start": r["start"], "end": r["end"],
                       "open_ended": r["open_ended"],
                       "start_index": r["start_index"], "end_index": r["end_index"]}
                      for r in ranges[:1]],
            # 同一块里出现的其他区间通常是正文里的项目期/任职期，属证据不属本条经历
            "other_dates": [{"raw": r["raw"]} for r in ranges[1:]],
            "attribution": ("single_block" if len(anchor["blocks"]) == 1
                            else "same_row_multi_block"),
            "granularity": granularity,
            "section": kind,
        }
        entries.append(entry)

        # 归属检查：本行有日期，但同一行/相邻行都找不到组织文本 → 不能拼装
        # "组织上下文"= 同一行里除日期以外的可见文字（公司名常和日期同块）
        has_org_text = any(len(_residual_text(blocks[i].get("text") or "")) >= 2
                           for i in anchor["blocks"])
        if not has_org_text:
            near = [c for c in clusters if c["page"] == anchor["page"] and c is not anchor
                    and abs(c["y0"] - anchor["y0"]) <= 3 * line_height]
            has_org_text = any(len(_residual_text(blocks[i].get("text") or "")) >= 2
                               for c in near for i in c["blocks"])
        if not has_org_text:
            entry["attribution"] = "isolated_row"
            entry["company"] = None
            entry["title"] = None
            issues.append({
                "code": "resume_experience_cross_block",
                "message": ("experience row carries a date range but no organisation text in "
                            "the same or adjacent row; assembling company/title would require "
                            "cross-block joining, so attribution is left unreadable"),
                "location": {"page": anchor["page"], "bbox": entry["bbox"]},
            })
        elif len(anchor["blocks"]) > 1:
            issues.append({
                "code": "resume_attribution_unverified",
                "message": ("entry header spans %d blocks in one visual row; facts are taken "
                            "from that row only (no cross-row joining)" % len(anchor["blocks"])),
                "location": {"page": anchor["page"], "bbox": entry["bbox"]},
            })
    return entries, issues, education_rows


def _timeline(entries: list) -> tuple[dict, list]:
    """时间线：断档/重叠/倒挂只报告，不修补。"""
    issues = []
    closed = []
    for entry in entries:
        for date in entry["dates"]:
            if date["start_index"] is None:
                continue
            if date["end_index"] is None:
                closed.append({"entry": entry["index"], "start": date["start_index"],
                               "end": None, "open": True, "raw": date["raw"],
                               "coarse": date["start"].get("month") is None})
                continue
            if date["start_index"] > date["end_index"]:
                issues.append({
                    "code": "resume_timeline_inversion",
                    "message": f"start is later than end: {date['raw']}",
                    "location": {"page": entry["page"], "bbox": entry["bbox"]},
                })
                continue
            coarse = (date["start"].get("month") is None
                      or (date["end"] or {}).get("month") is None)
            closed.append({"entry": entry["index"], "start": date["start_index"],
                           "end": date["end_index"], "open": False, "raw": date["raw"],
                           "coarse": coarse})
    ordered = sorted([c for c in closed if not c["open"]], key=lambda c: (c["start"], c["end"]))
    covered = 0
    cursor = None
    cursor_coarse = False
    for item in ordered:
        # 年粒度区间（没有月份）不参与断档/重叠判定：精度不足，判了就是猜
        if item["coarse"]:
            if cursor is None or item["end"] > cursor:
                cursor = item["end"]
                cursor_coarse = True
            continue
        if cursor is not None and item["start"] > cursor + 1:
            gap = item["start"] - cursor - 1
            if gap >= 3:
                issues.append({
                    "code": "resume_timeline_gap",
                    "message": f"{gap} month(s) without any interval before {item['raw']}",
                    "location": {"page": None, "bbox": None},
                })
        if cursor is not None and item["start"] <= cursor and not cursor_coarse:
            overlap = cursor - item["start"] + 1
            if overlap >= 2:
                issues.append({
                    "code": "resume_timeline_overlap",
                    "message": f"{overlap} month(s) of overlap at {item['raw']}",
                    "location": {"page": None, "bbox": None},
                })
        if cursor is None or item["end"] > cursor:
            start = item["start"] if cursor is None else max(item["start"], cursor + 1)
            covered += max(0, item["end"] - start + 1)
            cursor = item["end"]
            cursor_coarse = False
    summary = {
        "intervals": len(closed),
        "closed_intervals": len(ordered),
        "open_ended_intervals": sum(1 for c in closed if c["open"]),
        "year_only_intervals": sum(1 for c in closed if c["coarse"]),
        "covered_months_closed": covered,
        "covered_years_closed": round(covered / 12, 2),
        "note": ("open-ended intervals are not converted to months (a date-stamped run "
                 "would make the output non-reproducible)"),
    }
    return summary, issues


def _document_date_rows(blocks: list, sha: str) -> list[dict]:
    """全文范围的"带日期行"扫描（只在没有任何章节标题时用作证据，不当字段值）。"""
    clusters = _row_clusters(blocks, list(range(len(blocks))))
    rows = []
    for cluster in clusters:
        ranges = []
        for i in cluster["blocks"]:
            for rng in find_date_ranges(blocks[i].get("text") or ""):
                if rng not in ranges:
                    ranges.append(rng)
        if not ranges:
            continue
        rows.append({
            "page": cluster["page"],
            "bbox": [min(float(((blocks[i].get("location") or {}).get("bbox") or [0, 0, 0, 0])[0])
                         for i in cluster["blocks"]),
                     cluster["y0"],
                     max(float(((blocks[i].get("location") or {}).get("bbox") or [0, 0, 0, 0])[2])
                         for i in cluster["blocks"]),
                     cluster["y1"]],
            "header_text": " | ".join((blocks[i].get("text") or "").strip()
                                      for i in cluster["blocks"]),
            "dates": [{"raw": r["raw"], "start": r["start"], "end": r["end"],
                       "open_ended": r["open_ended"], "start_index": r["start_index"],
                       "end_index": r["end_index"]} for r in ranges],
            "blocks": list(cluster["blocks"]),
            "evidence": [_evidence(blocks[i], i, sha) for i in cluster["blocks"]],
        })
    return rows


# ============================ 主入口 ============================
def analyze(blocks: list, *, page_info: list, page_count: int, source_sha256: str,
            issues_before: list, order_unverified_pages: list | None = None) -> dict:
    """在已读出的 blocks 上抽取招聘字段，并给出噪声/受保护属性/时间线。

    ``issues_before`` 是页面级读取问题；只要有 HARD，本文档的"没找到"就不许
    记成 ``absent``（见模块 docstring 第 1 条）。
    ``order_unverified_pages`` 是"内容流顺序不可信"的页（含降级成 warning 的页）：
    章节区间依赖阅读顺序，因此这些页会让 work/education 的"没有该章节"不成立。
    """
    hard, _ = issue_severity(issues_before)
    # 两类 HARD 后果不同：
    #   CONTENT_UNREAD —— 有内容没读出来：连"电话/邮箱没有"都不能断言；
    #   其它 HARD（顺序/结构/归属）—— 文本读全了，只是分区/顺序不可信：
    #   只影响依赖分区与顺序的 work_experience / education。
    CONTENT_UNREAD = {"pdf_no_text", "unread_visual_page", "pdf_text_encoding_unread",
                      "encrypted_pdf", "reader_failed", "reader_timeout",
                      "pdf_damaged_repaired"}
    codes = hard_codes(issues_before)
    content_gate = ""
    structure_gate = ""
    if hard:
        unread = [c for c in codes if c in CONTENT_UNREAD]
        structure = [c for c in codes if c not in CONTENT_UNREAD]
        if unread:
            content_gate = "document_not_fully_read: " + ",".join(unread[:4])
        if structure:
            structure_gate = "structure_not_fully_read: " + ",".join(structure[:4])
    gate_reason = content_gate or structure_gate
    order_pages = sorted(set(order_unverified_pages or []))
    order_reason = ""
    if order_pages:
        order_reason = ("reading_order_unverified: page(s) "
                        + ",".join(str(p) for p in order_pages[:6]))

    fields: dict = {}
    issues: list = []
    warnings: list = []

    # ---- 身份字段 ----
    name = _find_name(blocks, source_sha256)
    phone = _find_pattern_field(blocks, _PHONE_PATTERNS, source_sha256, name="phone")
    email = _find_pattern_field(blocks, [_EMAIL_RE], source_sha256, name="email")
    fields["name"] = name
    fields["phone"] = phone
    fields["email"] = email

    # ---- 章节 → 经历 ----
    line_height = _median_height(blocks)
    sections = []
    for index, block in enumerate(blocks):
        kind = block_section_kind(block)
        if kind:
            sections.append((index, kind))
    # 同名章节可能重复（多页/续页）；按出现顺序建区间
    section_ranges = []
    for pos, (index, kind) in enumerate(sections):
        end = sections[pos + 1][0] if pos + 1 < len(sections) else len(blocks)
        if end > index:
            section_ranges.append((kind, index, end))

    exp_issues = []
    entries_by_kind: dict[str, list] = {"work": [], "education": []}
    education_rows: list[dict] = []
    for kind, start, end in section_ranges:
        if kind not in entries_by_kind:
            continue
        entries, entry_issues, skipped = _entries(blocks, list(range(start, end)), kind,
                                                  source_sha256, line_height)
        entries_by_kind[kind].extend(entries)
        exp_issues.extend(entry_issues)
        education_rows.extend(skipped)
    # 条目级问题（跨区块归属 / 同行多块）必须真的进入 issues，否则"报了但没人看见"
    issues.extend(exp_issues)

    for kind, label in (("work", "work_experience"), ("education", "education")):
        entries = entries_by_kind[kind]
        usable = [e for e in entries if e["granularity"] != "section"]
        if usable:
            evidence = [ev for e in usable for ev in e["header_blocks"]]
            fields[label] = _field(PRESENT, value=None, evidence=evidence,
                                   extra={"entries": usable,
                                          "entry_count": len(usable)})
        elif entries:
            # 章节存在、但整段没有可分割的条目（无日期行、无条目标题）：
            # 不能算 present（没有可用的经历事实），也不能算 absent（章节明明在）。
            fields[label] = _field(
                UNREADABLE, value=None,
                evidence=[ev for e in entries for ev in e["header_blocks"]],
                reason="entries_not_segmentable",
                extra={"candidate_rows": [{"page": e["page"], "bbox": e["bbox"],
                                           "header_text": e["header_text"][:200],
                                           "evidence": e["header_blocks"]} for e in entries]})
            issues.append({
                "code": "resume_attribution_unverified",
                "message": (f"{kind} section exists but no date row or entry heading could be "
                            "segmented; the field stays unreadable"),
                "location": {"page": entries[0]["page"], "bbox": entries[0]["bbox"]},
            })
        else:
            fields[label] = _field(ABSENT, reason=f"no_{kind}_section")

    # 没有任何 work/education 章节，但全文有带日期的行：不能断言"没有经历"。
    # 行是读出来的，只是"哪一行属于工作/教育"无法由结构确定 → unreadable + 证据。
    date_rows: list[dict] = []
    if not entries_by_kind["work"] and not entries_by_kind["education"]:
        date_rows = _document_date_rows(blocks, source_sha256)
        if date_rows:
            for label in ("work_experience", "education"):
                fields[label] = _field(
                    UNREADABLE, value=None,
                    evidence=[ev for row in date_rows for ev in row["evidence"]],
                    reason="no_section_headings",
                    extra={"candidate_rows": date_rows,
                           "candidate_count": len(date_rows)})
            issues.append({
                "code": "structure_unidentified",
                "message": (f"{len(date_rows)} date-bearing row(s) found but no work/education "
                            "section heading exists; rows are exposed as evidence and the "
                            "fields stay unreadable instead of guessing a section"),
                "location": {"page": date_rows[0]["page"], "bbox": date_rows[0]["bbox"]},
            })

    # 有章节但缺工作章节、正文里却有"没被任何经历章节认领"的日期行：
    # work_experience 同样不能记 absent（那会把"读到了但没归类"说成"没有"）。
    if fields["work_experience"]["state"] == ABSENT:
        # 任何已识别章节里的日期行都已被该章节"认领"（奖项/项目/科研的日期不是工作经历）
        claimed = set()
        for _kind, start, end in section_ranges:
            claimed.update(range(start, end))
        unclaimed = [row for row in _document_date_rows(blocks, source_sha256)
                     if not (set(row["blocks"]) & claimed)]
        if unclaimed:
            fields["work_experience"] = _field(
                UNREADABLE, value=None,
                evidence=[ev for row in unclaimed for ev in row["evidence"]],
                reason="work_rows_without_section_heading",
                extra={"candidate_rows": unclaimed[:20],
                       "candidate_count": len(unclaimed)})
            issues.append({
                "code": "resume_attribution_unverified",
                "message": (f"{len(unclaimed)} date-bearing row(s) sit outside any experience "
                            "section; work_experience stays unreadable (never 'absent')"),
                "location": {"page": unclaimed[0]["page"], "bbox": unclaimed[0]["bbox"]},
            })

    # 有章节但缺教育章节、正文里却有教育行：education 不能记 absent。
    if fields["education"]["state"] == ABSENT:
        edu_marks = list(education_rows)
        for index, block in enumerate(blocks):
            text = block.get("text") or ""
            if _is_education_row(text):
                edu_marks.append({"page": (block.get("location") or {}).get("page"),
                                  "bbox": (block.get("location") or {}).get("bbox"),
                                  "header_text": text.strip()[:200],
                                  "evidence": [_evidence(block, index, source_sha256)],
                                  "found_in": "body"})
        if edu_marks:
            fields["education"] = _field(
                UNREADABLE, value=None,
                evidence=[ev for row in edu_marks for ev in row["evidence"]],
                reason="education_rows_without_section_heading",
                extra={"candidate_rows": edu_marks[:20],
                       "candidate_count": len(edu_marks)})
            issues.append({
                "code": "resume_attribution_unverified",
                "message": (f"{len(edu_marks)} education-like row(s) exist but no education "
                            "section heading; rows are kept as evidence and the field stays "
                            "unreadable (never 'absent')"),
                "location": {"page": edu_marks[0]["page"], "bbox": edu_marks[0]["bbox"]},
            })

    # ---- 三态闸门：读不全就不许说 absent ----
    gated_hard, gated_order = [], []
    for key, field in fields.items():
        if field["state"] != ABSENT:
            continue
        structural = key in ("work_experience", "education")
        reason = content_gate or (structure_gate if structural else "")
        if reason:
            field["state"] = UNREADABLE
            field["reason"] = reason
            gated_hard.append(key)
        elif structural and order_reason:
            # 章节区间是从阅读顺序推出来的；顺序不可信时，"没有该章节"不成立。
            field["state"] = UNREADABLE
            field["reason"] = order_reason
            gated_order.append(key)
    if gated_hard:
        issues.append({
            "code": "resume_field_unreadable",
            "message": (f"{', '.join(gated_hard)} cannot be declared absent: {gate_reason}. "
                        "An unreadable field must never be used as a negative signal"),
            "location": {"page": None, "bbox": None},
        })
    if gated_order:
        issues.append({
            "code": "resume_attribution_unverified",
            "message": (f"{', '.join(gated_order)} cannot be declared absent: {order_reason} "
                        "(section ranges depend on reading order)"),
            "location": {"page": order_pages[0], "bbox": None},
        })

    # ---- 时间线 ----
    timeline, timeline_issues = _timeline(entries_by_kind["work"])
    if not entries_by_kind["work"] and date_rows:
        timeline["unheaded_date_rows"] = len(date_rows)
        timeline["note"] = ("no work section: unclassified date rows are exposed as evidence "
                            "but not used to compute a work timeline")
    issues.extend(timeline_issues)
    for entry in entries_by_kind["work"] + entries_by_kind["education"]:
        header = entry.get("header_text") or ""
        if re.search(r"(?:19|20)\d{2}", header) and not entry["dates"]:
            issues.append({
                "code": "resume_timeline_unparsed",
                "message": f"header contains a year but no parseable interval: {header[:80]}",
                "location": {"page": entry["page"], "bbox": entry["bbox"]},
            })

    # ---- 受保护属性（隔离，不进 fields）----
    protected: dict[str, dict] = {}
    for index, block in enumerate(blocks):
        for attr, hit in _protected_hits(block):
            item = protected.setdefault(attr, {"state": PRESENT, "value": hit,
                                               "evidence": [], "screening_excluded": True})
            item["evidence"].append(_evidence(block, index, source_sha256, hit))
    images_first_page = sum(int(p.get("images") or 0) for p in page_info
                            if p.get("page") == 1)
    if images_first_page:
        protected["photo"] = {
            "state": "unverified", "value": None,
            "evidence": [{"page": 1, "images": images_first_page,
                          "source_sha256": source_sha256}],
            "screening_excluded": True,
            "reason": ("geometry cannot decide whether an image is a portrait; "
                       "reported as unverified, never as a screening feature"),
        }
    for attr in PROTECTED_ATTRS:
        if attr in protected:
            continue
        protected[attr] = {"state": ABSENT if not gate_reason else UNREADABLE,
                           "value": None, "evidence": [],
                           "screening_excluded": True,
                           "reason": "" if not gate_reason else gate_reason}
    if any(v["state"] == PRESENT for v in protected.values()):
        present_attrs = sorted(k for k, v in protected.items() if v["state"] == PRESENT)
        issues.append({
            "code": "resume_protected_attribute_present",
            "message": "protected attributes identified and isolated from screening: "
                       + ", ".join(present_attrs),
            "location": {"page": None, "bbox": None},
        })

    # ---- 筛选可用性（doc 11 §9.7 / D3）----
    merge_eligible, manual_review = [], []
    for key in ("name", "phone", "email"):
        field = fields[key]
        if field["state"] != PRESENT:
            continue
        if field.get("provenance") == "native_text" and key != "name":
            merge_eligible.append(key)
        elif key == "name" and field.get("provenance") == "native_text":
            # 姓名形态规则本身有歧义（同名/英文名），只允许人工复核
            manual_review.append({"field": key,
                                  "reason": "name matching requires human confirmation"})
        else:
            manual_review.append({"field": key,
                                  "reason": f"provenance={field.get('provenance')}"})
    screening = {
        "eligible_fields": [k for k, f in fields.items() if f["state"] == PRESENT],
        "blocked_fields": [{"field": k, "reason": f["reason"]}
                           for k, f in fields.items() if f["state"] != PRESENT],
        "identity_merge_eligible": merge_eligible,
        "identity_manual_review": manual_review,
        "protected_excluded": sorted(k for k, v in protected.items()
                                     if v.get("screening_excluded")),
        "note": ("unreadable fields must never be used as a negative screening signal; "
                 "protected attributes never enter screening features"),
    }

    return {
        "fields": fields,
        "protected_attributes": protected,
        "timeline": timeline,
        "issues": issues,
        "warnings": warnings,
        "screening": screening,
    }


def empty_fields(reason: str) -> dict:
    """读取失败/超时时的字段表：五个字段全部 unreadable（绝不是 absent）。"""
    out = {}
    for key in ("name", "phone", "email"):
        out[key] = _field(UNREADABLE, reason=reason)
    for key in ("work_experience", "education"):
        out[key] = _field(UNREADABLE, reason=reason, extra={"entries": [], "entry_count": 0})
    return out


def empty_screening(reason: str) -> dict:
    """读取失败/加密/超时时的筛选可用性：全部字段 blocked，全部受保护属性隔离。"""
    return {"eligible_fields": [],
            "blocked_fields": [{"field": key, "reason": reason}
                               for key in ("name", "phone", "email",
                                           "work_experience", "education")],
            "identity_merge_eligible": [],
            "identity_manual_review": [],
            "protected_excluded": list(PROTECTED_ATTRS),
            "note": f"{reason}: nothing may be used for screening"}


def empty_protected(reason: str) -> dict:
    """读取失败/加密时的受保护属性表：全部 unreadable 且一律隔离。"""
    return {attr: {"state": UNREADABLE, "value": None, "evidence": [],
                   "screening_excluded": True, "reason": reason}
            for attr in PROTECTED_ATTRS}


def split_noise(blocks: list) -> tuple[list, list]:
    """把纯平台噪声整块移出 blocks，返回 (保留, 噪声记录)。

    只移"整块只剩平台标识"的块；噪声与正文同块时不动，交给 pdf_reader 报
    ``platform_noise_inline_unresolved``（宁可留着让人看，也不删真内容）。
    """
    kept, noise = [], []
    for index, block in enumerate(blocks):
        hit, marker = is_noise_block(block)
        if not hit:
            kept.append(block)
            continue
        location = block.get("location") or {}
        noise.append({"page": location.get("page"), "bbox": location.get("bbox"),
                      "text": block.get("text") or "", "marker": marker,
                      "block": index})
    return kept, noise
