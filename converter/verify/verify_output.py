"""独立校验器：拿"转换器的输出 + 原件"，按 doc 11 的判据判它合不合格。

为什么要有这个东西
------------------
转换器说"我合格"不算数。doc 11 §0 的一句话标准是
**"抽出来的每个字都有出处，抽不出来的每一处都有说明"**；这句话只有拿原件
重算一遍才能判。本模块就是那条判据的可执行版本，也是 doc 12 §2① 的落地：
"工具能不能自己判自己不合格"——由**不是实现者**的代码来判。

独立性（硬约束）
----------------
1. **不 import `converter/src/` 里的任何模块**。判断所需的一切，只来自
   ① 输出 JSON（被检对象）② 用 `fitz` 独立重读原件（基准）。
   理由：如果校验器复用转换器的 `Counter`/`issue_severity`/`strip_unreadable`，
   那么转换器改一个常量就能把自己的缺陷"判合格"，校验器等于自证。
2. 因此 HARD/SOFT 分级是**本文件自带的一张表**（见 `SOFT_ISSUE_CODES`），
   而不是 `src/issues.py` 的那张。表外 code 一律按 HARD（doc 11 §1：
   "未知 issue code 一律按 HARD"，保守优先）。
3. 本模块是纯函数：输入 dict + 路径，输出 dict，无副作用、不写文件、不联网。

八项检查（编号与 doc 11 的对应关系）
-----------------------------------
V1 页覆盖      → doc 11 A1 / §5 红线 1（静默丢页）
                 注意：A1 的"要么有 block，要么有 issue"必须读成"要么读到、
                 要么声明读不到"。一条 `unverified_pdf_image` 之类的软记录
                 不算声明——否则页级 note 就能把整页正文丢失洗成"已声明"。
                 实测：删掉某页全部 block 后，那页仍有一条图片软 issue，
                 按字面判 V1 会放过；按本实现判 V1 必须失败（见 README 边界）。
V2 逐页字符恒等 → doc 11 A2 + A6 / §5 红线 2（输出原生不存在的文字）
V3 无凭空 URI  → doc 11 A5 / §5 红线 2
V4 坏字形不进正文 → doc 11 A6
V5 无文本页标 visual → doc 11 B1 / §5 红线 3（扫描件标 complete）
V6 加密/损坏报 code → doc 11 B2 + §5 红线 5
V7 声明一致性  → doc 11 §1「任何 issue 或 needs_visual → completeness 必须降为 partial」
V8 幂等        → doc 11 C1 / §5 红线 4

V2 的链接口径（关键，单独说明）
------------------------------
块文本里链接写成 Markdown：`[label](<href>)`。判字符恒等时：

* **`label` 算文字**——它是页面上真实可见的词；
* **`href` 不算文字**——它是注解里的跳转目标，页面上并没有印出来。

这是转换器的设计（`content.link_md()` 把注解 URI 写成 `[可见词](<URI>)`）。
于是 `[GitHub](<https://github.com/x>)` 还原成 `GitHub`，原件该页的
`Counter` 正好对上；如果连 `href` 也算文字，每加一条链接就会凭空多出一串
字符，保真校验从第一天就是红的。

**唯一例外**：无可见文字的链接（注解矩形里没有任何词，例如整块是图片或图标）
用 URI 当 label，写作 `[https://x](<https://x>)`。此时 label 与 href 完全相同，
"URL 算文字"是把这条链接表达出来的唯一方式——但它在原件**文本层**里并不存在，
所以**不能**进入字符恒等式，否则等价于要求原件印出过这个 URL。
本模块对这种情况的豁免条件被刻意收窄为四个同时成立：
① `label == href`（不含别的词）；② `href` 是原件 `get_links()` 里的真实 URI；
③ 该字面量（忽略空白）**不在**原件该页文本里；④ 报告豁免条数（不静默）。
四条之外一律按"label 算文字"处理。详见 README"已知边界"。
"""
from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

__all__ = [
    "VERIFIER_VERSION",
    "VerifyInputError",
    "CHECKS",
    "verify",
    "verify_files",
    "read_native",
    "NativeDoc",
]

VERIFIER_VERSION = "1.0.0"

# 检查项清单（顺序即输出顺序）
CHECKS = (
    ("V1_page_coverage", "页覆盖"),
    ("V2_char_identity", "逐页字符恒等"),
    ("V3_no_fabricated_uri", "无凭空 URI"),
    ("V4_no_bad_glyph_in_body", "坏字形不进正文"),
    ("V5_visual_page_declared", "无文本页必须标 visual"),
    ("V6_encrypted_or_damaged_reported", "加密/损坏必须报 code"),
    ("V7_completeness_consistency", "声明一致性"),
    ("V8_idempotent", "幂等"),
)

# ============================ doc 11 常量（本文件自带）============================

# 只有"内容已读出、只是需要记录"的 code 才允许是 SOFT。表内**逐条列举**，
# 有意不用"unverified_ 前缀算 SOFT"这种规则：前缀规则会让一个全新 code
# 仅凭名字就自动降级，而 doc 11 §1 要求未知 code 一律 HARD。
SOFT_ISSUE_CODES = frozenset({
    "unverified_pdf_image",             # 图片角色未核实（几何已记录，正文未丢）
    "resume_attribution_unverified",    # 经历行归属不做跨块组合，事实未断言
    "resume_timeline_gap",
    "resume_timeline_overlap",
    "resume_timeline_inversion",
    "resume_timeline_unparsed",         # 原文如此，未修补
    "resume_protected_attribute_present",  # 已识别并隔离，不进筛选特征
    "resume_ocr_heading_inserted",      # 标题来自 OCR，正文仍是原生文本
    "platform_noise_excluded",          # 平台噪声已移出正文且有记录
    "pdf_page_empty",                   # 空页（无字/无图/无矢量）已记录
})

# 声明"整篇/整份没读出来"的 code：这些出现时 V1 允许"每页都没有 block"，
# 因为"读不到"已经被声明了（doc 11 B3 不可静默）。
GLOBAL_UNREAD_CODES = frozenset({
    "encrypted_pdf", "reader_failed", "reader_timeout", "pdf_no_text",
})

# doc 11 A6：坏字形标记。这些字符**不允许**出现在正文里。
BODY_BAD_GLYPH_RE = re.compile(r"\ufffd|\(cid:\d+\)")
# 允许被声明为"已剔除"的字符集合：坏字形标记 + 控制字符（NUL 属格式解码）。
# 别的字符（哪怕是一个普通字母）不得以"剔除"的名义进 `encoding_removed`，
# 否则删正文 + 假装剔坏字形就能把 V2 骗平。
DECLARABLE_REMOVED_RE = re.compile(r"\ufffd|\(cid:\d+\)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

# `[label](<href>)`；label 里的 `[`/`]` 由 link_md 转义成 `\[`/`\]`，
# href 里的 `>` 被替换成 %3E，所以括号内的贪婪可以安全排除。
LINK_MD_RE = re.compile(r"\[((?:[^\[\]\\]|\\.)*)\]\(<([^>]*)>\)")

# doc 11 B1：页字符 <80 且有图形 → 必须报
LOW_TEXT_CHARS = 80

# 哪些 issue 可以算"这一页的图形内容已声明未读"
VISUAL_ISSUE_CODES = frozenset({
    "unread_visual_page", "pdf_no_text", "pdf_text_encoding_unread",
    "pdf_layout_unread", "visual_read_required",
})

# "这一页没有 block" 只有在"这一页的内容缺席被内容级 issue 声明"时才算合格。
# 一条 `unverified_pdf_image`（图片角色未核实）之类的软记录**不构成声明**——
# 否则随便一条页级 note 就能把"整页正文丢了"洗成"已声明"。
# 这是 doc 11 A1 的可执行读法：A1 要的是"要么读到、要么说明读不到"，
# 不是"页号在某个 location 里出现过"。
PAGE_ABSENCE_CODES = frozenset({
    "pdf_page_empty", "pdf_no_text", "unread_visual_page",
    "pdf_text_encoding_unread", "pdf_layout_unread", "visual_read_required",
    "reader_failed", "reader_timeout", "encrypted_pdf",
})

_WS_RE = re.compile(r"\s")


class VerifyInputError(ValueError):
    """输出 JSON 形状不对（不是 dict / 不是合法 JSON），无法作为被检对象。"""


# ============================ 原生读取（基准）============================
@dataclass
class NativeDoc:
    """用 fitz 独立重读原件得到的基准事实。"""

    opened: bool = False                 # fitz 能否打开这个文件
    readable: bool = False               # 文本层是否可逐页读取
    page_count: int = 0
    pages: list[str] = field(default_factory=list)     # 1-based 原生文本
    uris: set[str] = field(default_factory=set)        # 全部真实 URI
    graphics: list[bool] = field(default_factory=list) # 每页是否有位图或矢量图形
    encrypted: bool = False
    repaired: bool = False
    error: str | None = None


def read_native(pdf_path: str | Path) -> NativeDoc:
    """独立读取原件（只用 fitz），产出校验基准。

    与转换器的实现无关：这里只调 PyMuPDF 的公开 API，不 import src/。
    """
    import fitz  # 局部 import：本模块的纯字符串工具不需要 fitz

    path = Path(pdf_path)
    native = NativeDoc()
    if not path.is_file():
        native.error = f"file not found: {path}"
        return native
    try:
        doc = fitz.open(str(path))
    except Exception as exc:  # noqa: BLE001 - 任何打不开都算"原件不可读"
        native.error = f"{type(exc).__name__}: {exc}"
        return native

    try:
        native.opened = True
        native.page_count = int(doc.page_count)
        native.encrypted = bool(getattr(doc, "is_encrypted", False))
        native.repaired = bool(getattr(doc, "is_repaired", False))
        if native.encrypted and not doc.authenticate(""):
            native.error = "encrypted: 空密码无法解密，文本层不可读"
            return native
        pages: list[str] = []
        graphics: list[bool] = []
        uris: set[str] = set()
        for number, page in enumerate(doc, 1):
            try:
                pages.append(page.get_text("text"))
            except Exception as exc:  # noqa: BLE001
                native.error = f"page {number} text unreadable: {type(exc).__name__}: {exc}"
                return native
            try:
                for link in page.get_links():
                    uri = link.get("uri")
                    if uri:
                        uris.add(uri)
            except Exception:  # noqa: BLE001 - 链接读不到不影响文本基准
                pass
            try:
                images = sorted(page.get_images(full=True))
                drawings = len(page.get_drawings())
            except Exception:  # noqa: BLE001
                images, drawings = [], 0
            graphics.append(bool(images) or drawings > 0)
        native.pages = pages
        native.graphics = graphics
        native.uris = uris
        native.readable = True
        return native
    finally:
        try:
            doc.close()
        except Exception:  # noqa: BLE001
            pass


# ============================ 小工具 ============================
def _ns_counter(text: str) -> Counter:
    """非空白字符计数器（doc 11 A2 的唯一口径）。"""
    return Counter(_WS_RE.sub("", text or ""))


def _ws_strip(text: str) -> str:
    """去掉全部空白后的字面量，用于"这串字在不在这一页"的判定。"""
    return _WS_RE.sub("", text or "")


def _unescape_md(label: str) -> str:
    """还原 link_md 的 `\\[` / `\\]`（label 里唯一会出现的转义）。"""
    return label.replace("\\[", "[").replace("\\]", "]")


def _strip_link_markdown(text: str, native_page_text: str,
                         real_uris: Iterable[str] | None = None) -> tuple[str, list[str]]:
    """把 `[label](<href>)` 还原成 `label`，并返回被豁免的 href 列表。

    * href 不算文字（它没有印在页面上）；
    * label 算文字（它是页面上的可见词）；
    * 例外：无可见文字链接（label == href 且是原件真实 URI 且该字面量不在
      原件该页文本里）→ 整条链接都不进入字符恒等式。判据见模块 docstring。
    """
    real = real_uris if real_uris is not None else ()
    exempted: list[str] = []
    haystack = _ws_strip(native_page_text)

    def _repl(match: re.Match) -> str:
        label = _unescape_md(match.group(1))
        href = match.group(2)
        if label == href and href and href in real and _ws_strip(label) not in haystack:
            exempted.append(href)
            return ""
        return label

    return LINK_MD_RE.sub(_repl, text or ""), exempted


def _page_of(item: dict) -> Any:
    return (item.get("location") or {}).get("page")


def _blocks_by_page(output: dict) -> dict[Any, list[dict]]:
    out: dict[Any, list[dict]] = {}
    for block in output.get("blocks") or []:
        if isinstance(block, dict):
            out.setdefault(_page_of(block), []).append(block)
    return out


def _issue_codes(output: dict) -> list[str]:
    return [str(i.get("code") or "") for i in output.get("issues") or []
            if isinstance(i, dict)]


def _absence_pages(output: dict) -> set[int]:
    """声明了"这一页没有内容/没读出来"的页号（只认内容级 code）。"""
    pages: set[int] = set()
    for issue in output.get("issues") or []:
        if not isinstance(issue, dict):
            continue
        if str(issue.get("code") or "") not in PAGE_ABSENCE_CODES:
            continue
        page = _page_of(issue)
        if isinstance(page, int) and page >= 1:
            pages.add(page)
    return pages


def _is_hard(code: str) -> bool:
    """HARD = 内容缺失/读取失败；未知 code 一律 HARD（doc 11 §1）。"""
    return code not in SOFT_ISSUE_CODES


def _fmt_counter(counter: Counter, limit: int = 8) -> str:
    if not counter:
        return "无"
    parts = [f"{ch!r}×{n}" for ch, n in counter.most_common(limit)]
    if len(counter) > limit:
        parts.append(f"...共 {len(counter)} 种")
    return ", ".join(parts)


def _check(name: str, ok: bool, detail: str, *, skipped: bool = False) -> dict:
    title = dict(CHECKS)[name]
    item = {"name": name, "title": title, "ok": bool(ok), "detail": detail}
    if skipped:
        item["skipped"] = True
    return item


def _skip(name: str, detail: str) -> dict:
    """无法判（基准不可得）→ 既不算 pass 也不算 fail，单独计数。"""
    return _check(name, True, detail, skipped=True)


# ============================ V1 页覆盖 ============================
def _check_v1(output: dict, native: NativeDoc) -> dict:
    name = "V1_page_coverage"
    meta = output.get("meta") or {}
    meta_pages = meta.get("pages")
    blocks_by_page = _blocks_by_page(output)
    absence_pages = _absence_pages(output)
    codes = _issue_codes(output)
    global_unread = bool(meta.get("failed") or meta.get("timed_out")) or any(
        c in GLOBAL_UNREAD_CODES for c in codes)

    if not native.opened:
        return _skip(name, f"原件打不开（{native.error}），页数无法独立核对；"
                           f"输出已报 issue={sorted(set(codes)) or '无'}")

    problems: list[str] = []
    if meta_pages != native.page_count:
        problems.append(f"meta.pages={meta_pages!r} 而原件 {native.page_count} 页")

    missing: list[int] = []
    soft_only: dict[int, list[str]] = {}
    for number in range(1, native.page_count + 1):
        if blocks_by_page.get(number):
            continue
        if number in absence_pages:
            continue
        missing.append(number)
        soft_only[number] = sorted({
            str(i.get("code") or "") for i in output.get("issues") or []
            if isinstance(i, dict) and _page_of(i) == number})
    if missing and not global_unread:
        detail = "；".join(
            f"第 {n} 页既无 block，也没有内容级 issue 声明"
            + (f"（该页 issue 只有 {soft_only[n]}，不算'读不到'的声明）"
               if soft_only.get(n) else "")
            for n in missing)
        problems.append(detail + "（静默丢页）")

    stray = len(blocks_by_page.get(None) or [])
    if stray:
        problems.append(f"{stray} 个 block 没有 location.page（无法归属任何页）")

    if problems:
        return _check(name, False, "；".join(problems))
    detail = (f"meta.pages={meta_pages} == 原件 {native.page_count} 页；"
              f"每页都有 block 或内容级 issue 声明")
    if missing and global_unread:
        detail = (f"meta.pages={meta_pages} == 原件 {native.page_count} 页；"
                  f"第 {missing} 页无 block，但已用 "
                  f"{sorted(set(codes) & set(GLOBAL_UNREAD_CODES))} 声明整份未读")
    return _check(name, True, detail)


# ============================ V2 逐页字符恒等 ============================
def _check_v2(output: dict, native: NativeDoc) -> dict:
    name = "V2_char_identity"
    if not native.readable:
        return _skip(name, f"原件文本层不可读（{native.error or '未知原因'}），"
                           f"无法独立重算字符基准")

    meta = output.get("meta") or {}
    page_info: dict[int, dict] = {}
    for item in meta.get("page_info") or []:
        if isinstance(item, dict) and isinstance(item.get("page"), int):
            page_info[item["page"]] = item
    noise_by_page: dict[Any, list[dict]] = {}
    for item in output.get("noise") or []:
        if isinstance(item, dict):
            noise_by_page.setdefault(item.get("page"), []).append(item)

    blocks_by_page = _blocks_by_page(output)
    problems: list[str] = []
    ok_pages = 0
    enc_chars = noise_chars = exempt_links = 0
    whole_doc = None in blocks_by_page

    def _page_parts(number: int, native_text: str) -> tuple[Counter, Counter, Counter, str]:
        """返回 (该页声明剔除的字符, 坏字形部分, 噪声部分, 声明一致性说明)。"""
        info = page_info.get(number) or {}
        enc = str(info.get("encoding_removed") or "")
        noise_decl = str(info.get("noise_removed") or "")
        entries = noise_by_page.get(number) or []
        joined = "".join(str(e.get("text") or "") for e in entries)
        notes: list[str] = []
        if enc:
            leftover = DECLARABLE_REMOVED_RE.sub("", enc)
            if leftover:
                notes.append(f"encoding_removed 里出现非坏字形字符 {leftover[:20]!r}"
                             f"（只允许 U+FFFD/(cid:N)/控制字符被声明剔除）")
        if noise_decl and not entries:
            notes.append("noise_removed 非空但 noise[] 里没有该页记录（剔除无记录）")
        if entries and noise_decl and joined != noise_decl:
            notes.append("noise[] 与 page_info.noise_removed 不一致（两份声明对不上）")
        noise_text, _ = _strip_link_markdown(noise_decl or joined, native_text, native.uris)
        enc_counter = _ns_counter(enc)
        noise_counter = _ns_counter(noise_text)
        return enc_counter + noise_counter, enc_counter, noise_counter, "；".join(notes)

    if whole_doc:
        # 有 block 缺 location.page：无法逐页归属，退化为整篇比对（用**全部** block，
        # 只取无页的那些会把有页的正文漏掉），并在 detail 里说明。
        native_all = "\n".join(native.pages)
        joined, exempted = _blocks_text_all(output.get("blocks") or [], native_all,
                                            native.uris)
        exempt_links += len(exempted)
        declared = Counter()
        for number in range(1, native.page_count + 1):
            part, enc_part, noise_part, note = _page_parts(number, native.pages[number - 1])
            declared += part
            enc_chars += sum(enc_part.values())
            noise_chars += sum(noise_part.values())
            if note:
                problems.append(f"第{number}页：{note}")
        expected = _ns_counter(native_all)
        got = _ns_counter(joined) + declared
        if got != expected:
            problems.append("全文（有 block 缺 location.page，退化为整篇比对）字符不恒等："
                            f"缺 {_fmt_counter(expected - got)}，多 {_fmt_counter(got - expected)}")
        else:
            ok_pages = native.page_count
    else:
        for number in range(1, native.page_count + 1):
            native_text = native.pages[number - 1]
            expected = _ns_counter(native_text)
            text, exempted = _blocks_text_all(blocks_by_page.get(number) or [], native_text,
                                              native.uris)
            exempt_links += len(exempted)
            declared, enc_part, noise_part, note = _page_parts(number, native_text)
            got = _ns_counter(text) + declared
            enc_chars += sum(enc_part.values())
            noise_chars += sum(noise_part.values())
            if note:
                problems.append(f"第{number}页：{note}")
            if got != expected:
                problems.append(
                    f"第{number}页字符不恒等：原件 {sum(expected.values())} 个非空白字符，"
                    f"输出 {sum(got.values())} 个（缺 {_fmt_counter(expected - got)}；"
                    f"多 {_fmt_counter(got - expected)}）")
            else:
                ok_pages += 1

    if problems:
        return _check(name, False, "；".join(problems))

    pages = "全文" if whole_doc else f"{ok_pages}/{native.page_count} 页"
    return _check(name, True,
                  f"{pages}字符恒等（链接 label 计入、href 不计；"
                  f"URL-as-label 豁免 {exempt_links} 条；"
                  f"声明剔除：坏字形 {enc_chars} 字 / 噪声 {noise_chars} 字）")


def _blocks_text_all(blocks: Iterable[dict], native_text: str,
                     real_uris: Iterable[str]) -> tuple[str, list[str]]:
    parts: list[str] = []
    exempted: list[str] = []
    for block in blocks:
        text, ex = _strip_link_markdown(block.get("text") or "", native_text, real_uris)
        parts.append(text)
        exempted.extend(ex)
    return "\n".join(parts), exempted


# ============================ V3 无凭空 URI ============================
def _check_v3(output: dict, native: NativeDoc) -> dict:
    name = "V3_no_fabricated_uri"
    if not native.opened:
        return _skip(name, f"原件打不开（{native.error}），真实 URI 集合不可得")

    hrefs: dict[str, str] = {}   # href -> 出自哪里（便于定位）
    for link in output.get("links") or []:
        if isinstance(link, dict) and link.get("href"):
            hrefs.setdefault(str(link["href"]), "links[]")
    for block in output.get("blocks") or []:
        if not isinstance(block, dict):
            continue
        for link in block.get("links") or []:
            if isinstance(link, dict) and link.get("href"):
                hrefs.setdefault(str(link["href"]), f"block@{_page_of(block)}.links[]")
        # 正文 Markdown 里的 href 也要查：藏在这里同样是"凭空 URI"
        for match in LINK_MD_RE.finditer(block.get("text") or ""):
            href = match.group(2)
            if href:
                hrefs.setdefault(href, f"block@{_page_of(block)}.text")

    fabricated = {href: src for href, src in hrefs.items() if href not in native.uris}
    missing_real = sorted(native.uris - set(hrefs))
    recall = (f"；原件 {len(native.uris)} 条真实 URI 未出现在输出中 {len(missing_real)} 条"
              f"（A5 recall，仅告知，不判失败）")
    if fabricated:
        listed = "；".join(f"{href!r}（来自 {src}）"
                           for href, src in list(fabricated.items())[:5])
        return _check(name, False,
                      f"输出 {len(hrefs)} 条 href，其中 {len(fabricated)} 条不在原件 "
                      f"get_links() 里：{listed}{recall if not missing_real else ''}")
    return _check(name, True,
                  f"输出 {len(hrefs)} 条 href 全部属于原件 {len(native.uris)} 条真实 URI"
                  f"（含正文 Markdown 内的 href；裸文本 URL 不在本检查范围）{recall}")


# ============================ V4 坏字形不进正文 ============================
def _check_v4(output: dict, native: NativeDoc) -> dict:
    name = "V4_no_bad_glyph_in_body"
    hits: list[str] = []
    for block in output.get("blocks") or []:
        if not isinstance(block, dict):
            continue
        text = block.get("text") or ""
        match = BODY_BAD_GLYPH_RE.search(text)
        if match:
            start = max(0, match.start() - 20)
            snippet = text[start:match.end() + 20].replace("\n", "\\n")
            hits.append(f"第{_page_of(block)}页 {match.group(0)!r} 附近 {snippet!r}")
    text = output.get("text") or ""
    match = BODY_BAD_GLYPH_RE.search(text)
    if match and not hits:
        hits.append(f"顶层 text 含 {match.group(0)!r}")
    if hits:
        return _check(name, False,
                      f"正文出现 {len(hits)} 处坏字形标记（doc 11 A6 要求不得出现在正文）："
                      + "；".join(hits[:5]))
    return _check(name, True, "正文（blocks[].text 与顶层 text）无 U+FFFD、无 (cid:N)")


# ============================ V5 无文本页必须标 visual ============================
def _check_v5(output: dict, native: NativeDoc) -> dict:
    name = "V5_visual_page_declared"
    if not native.readable:
        return _skip(name, f"原件文本层不可读（{native.error or '未知原因'}），"
                           f"无法判定哪一页是低文字图形页")

    low_pages: list[int] = []
    for number in range(1, native.page_count + 1):
        chars = len(native.pages[number - 1].strip())
        if chars < LOW_TEXT_CHARS and native.graphics[number - 1]:
            low_pages.append(number)
    if not low_pages:
        return _check(name, True, "原件没有『低文字 + 有图形』的页，本检查不适用（通过）")

    declared: set[int] = set()
    for issue in output.get("issues") or []:
        if not isinstance(issue, dict):
            continue
        if str(issue.get("code") or "") in VISUAL_ISSUE_CODES:
            page = _page_of(issue)
            if isinstance(page, int):
                declared.add(page)
    undeclared = [p for p in low_pages if p not in declared]
    needs_visual = bool(output.get("needs_visual"))
    if undeclared:
        return _check(name, False,
                      f"第 {undeclared} 页字符 <{LOW_TEXT_CHARS} 且有图形，但输出没有该页的 "
                      f"unread_visual_page/needs_visual 记录（needs_visual={needs_visual}，"
                      f"已声明页={sorted(declared)}）")
    return _check(name, True,
                  f"低文字图形页 {low_pages} 均已声明（needs_visual={needs_visual}）")


# ============================ V6 加密/损坏必须报 code ============================
def _check_v6(output: dict, native: NativeDoc) -> dict:
    name = "V6_encrypted_or_damaged_reported"
    codes = set(_issue_codes(output))
    completeness = output.get("completeness")

    if not native.opened:
        need = {"reader_failed", "reader_timeout"}
        if codes & need:
            return _check(name, True,
                          f"原件打不开（{native.error}），输出已报 {sorted(codes & need)}")
        return _check(name, False,
                      f"原件打不开（{native.error}），输出未报 reader_failed/reader_timeout"
                      f"（实际 code={sorted(codes) or '无'}）")

    if native.encrypted:
        if "encrypted_pdf" not in codes:
            return _check(name, False,
                          f"原件已加密且空密码解不开，输出未报 encrypted_pdf（实际 code="
                          f"{sorted(codes) or '无'}）")
        if completeness == "complete":
            return _check(name, False,
                          "已加密的 PDF 被标成 completeness=complete（§5 红线 3：不得静默成功）")
        return _check(name, True, f"加密已报 encrypted_pdf，completeness={completeness}")

    if native.repaired:
        if "pdf_damaged_repaired" not in codes:
            return _check(name, False,
                          "原件结构损坏（fitz is_repaired=True）但输出未报 pdf_damaged_repaired")
        return _check(name, True, "损坏已报 pdf_damaged_repaired")

    return _check(name, True, "原件可正常打开、未加密、未修复，无需报 code")


# ============================ V7 声明一致性 ============================
def _check_v7(output: dict, native: NativeDoc) -> dict:
    name = "V7_completeness_consistency"
    completeness = output.get("completeness")
    if completeness not in {"complete", "partial", "unverified"}:
        return _check(name, False, f"completeness={completeness!r} 不是契约取值")

    issues = [i for i in output.get("issues") or [] if isinstance(i, dict)]
    codes = [str(i.get("code") or "") for i in issues]
    hard = sorted({c for c in codes if _is_hard(c)})
    needs_visual = bool(output.get("needs_visual"))

    problems: list[str] = []
    if completeness == "complete":
        if hard:
            problems.append(f"标 complete 却有 HARD issue {hard}")
        if codes:
            problems.append(f"标 complete 却有 issue {sorted(set(codes))}"
                            f"（doc 11 §1：任何 issue 必须降为 partial）")
        if needs_visual:
            problems.append("标 complete 却 needs_visual=true")
    elif codes and completeness != "partial":
        problems.append(f"有 issue（{sorted(set(codes))}）但 completeness={completeness!r}"
                        f"（doc 11 §1：必须降为 partial）")
    if problems:
        return _check(name, False, "；".join(problems))
    return _check(name, True,
                  f"completeness={completeness}，issue={len(codes)} 条（HARD {len(hard)} 条），"
                  f"needs_visual={needs_visual}，一致")


# ============================ V8 幂等 ============================
_VOLATILE_KEYS = frozenset({
    "timestamp", "time", "created_at", "updated_at", "generated_at", "date",
    "elapsed", "elapsed_ms", "elapsed_s", "duration_ms", "run_id", "attempt",
    "attempts", "pid", "started_at", "finished_at", "mtime", "mtime_ns",
    "pdf", "path", "source_path", "abs_path", "output_path", "cwd",
})
_ABS_PATH_RE = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\|/)[^\n\r]*$")


def _normalize_for_idempotency(value: Any) -> Any:
    """去掉时间戳/绝对路径等"同一份输入两次必然不同/不重要"的字段。"""
    if isinstance(value, dict):
        return {str(k): _normalize_for_idempotency(v)
                for k, v in value.items() if str(k) not in _VOLATILE_KEYS}
    if isinstance(value, list):
        return [_normalize_for_idempotency(v) for v in value]
    if isinstance(value, str) and _ABS_PATH_RE.match(value):
        return "<path>"
    return value


def _check_v8(output: dict, second: dict | None) -> dict:
    name = "V8_idempotent"
    if second is None:
        return _skip(name, "未提供第二次运行的输出，无法判幂等（传 --second 或让 CLI 跑两遍）")
    left = json.dumps(_normalize_for_idempotency(output), ensure_ascii=False, sort_keys=True)
    right = json.dumps(_normalize_for_idempotency(second), ensure_ascii=False, sort_keys=True)
    if left == right:
        return _check(name, True, "两次输出（去掉时间戳/路径后）逐字节相同")
    # 给出第一处差异，方便定位
    at = next((i for i, (a, b) in enumerate(zip(left, right)) if a != b),
              min(len(left), len(right)))
    return _check(name, False,
                  f"两次输出不同：首处差异在第 {at} 字节附近 "
                  f"{left[max(0, at - 40):at + 40]!r} vs {right[max(0, at - 40):at + 40]!r}")


# ============================ 入口 ============================
def _as_output(obj: Any) -> dict:
    if isinstance(obj, dict):
        return obj
    if isinstance(obj, (str, Path)):
        path = Path(obj)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except OSError as exc:
            raise VerifyInputError(f"读不到输出 JSON：{path}：{exc}") from exc
        except json.JSONDecodeError as exc:
            raise VerifyInputError(f"输出 JSON 非法：{path}：{exc}") from exc
        return _as_output(data)
    raise VerifyInputError(f"输出必须是 dict 或 JSON 路径，收到 {type(obj).__name__}")


def verify(output: Any, pdf_path: str | Path, *,
           second_output: Any | None = None, native: NativeDoc | None = None) -> dict:
    """校验一份转换器输出。

    参数
    ----
    output
        被检对象：转换器输出的 dict，或指向输出 JSON 的路径。
    pdf_path
        原件路径（只读；用 fitz 独立重读）。
    second_output
        同一原件的第二次输出（可选）。给了才判 V8 幂等，否则 V8 记为 skipped。
    native
        已读好的基准（批量校验时复用，避免重复打开原件）。

    返回
    ----
    ``{"passed": bool, "checks": [...], "failed": [...], "skipped": [...],
       "summary": {...}, "verifier_version": "...", "pdf": "..."}``
    """
    out = _as_output(output)
    second = _as_output(second_output) if second_output is not None else None
    base = native if native is not None else read_native(pdf_path)

    checks = [
        _check_v1(out, base),
        _check_v2(out, base),
        _check_v3(out, base),
        _check_v4(out, base),
        _check_v5(out, base),
        _check_v6(out, base),
        _check_v7(out, base),
        _check_v8(out, second),
    ]
    failed = [c["name"] for c in checks if not c["ok"] and not c.get("skipped")]
    skipped = [c["name"] for c in checks if c.get("skipped")]
    passed = not failed
    return {
        "passed": passed,
        "pdf": str(pdf_path),
        "verifier_version": VERIFIER_VERSION,
        "checks": checks,
        "failed": failed,
        "skipped": skipped,
        "summary": {
            "total": len(checks),
            "passed": len(checks) - len(failed) - len(skipped),
            "failed": len(failed),
            "skipped": len(skipped),
        },
    }


def verify_files(output_json: str | Path, pdf_path: str | Path, *,
                 second_json: str | Path | None = None) -> dict:
    """`verify()` 的文件版：两个输出都是 JSON 文件路径。"""
    return verify(output_json, pdf_path, second_output=second_json)
