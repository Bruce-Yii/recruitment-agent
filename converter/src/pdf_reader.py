"""PDF reader: blocks with coordinates, honest tri-state fields, explicit issues.

判定顺序照抄 ``resume-conversion-build/tools/conversion/documents.py::read_pdf``
(L194-444, read-only reference, 2026-11)：

    1. 加密且空密码打不开 → encrypted_pdf，直接返回（绝不逐页读）
    2. 可选版面后端；页覆盖不符 → pdf_layout_unread
    3. 逐页 get_text("blocks", sort=False) —— 保持内容流顺序，不做 x/y 全局排序
    4. 坏字形/控制字符 → pdf_text_encoding_unread（记录 region）
    5. 有版面后端则按几何重排，且 Counter(非空白字符) 必须完全相等才采用
    6. 无后端时 stream_order_issue()：页字 <800 → HARD，≥800 → warning
    7. 链接按「词中心点落在 link rect 内」归属到块；未定位的真实 URI 单独成块
    8. 页字 <80 且有图形 → unread_visual_page；否则图片只记 unverified_pdf_image
    9. 全文无 block → pdf_no_text
   10. 正文不做任何 NFKC / 改写（documents.py:379-381）

在本项目新增（均有据可查，见 README）：
    * 坏字形/控制字符**从正文剔除**并逐页记录剔除内容（doc 11 A6 要求"不得出现
      在正文"），同时保留 Counter 恒等式：native == blocks + 剔除 + 噪声；
    * 平台噪声整块移出正文并逐条记录（doc 11 §9.5）；
    * 招聘字段三态 / 时间线 / 受保护属性（doc 11 §9.2/9.4/9.6）；
    * needs_visual 在"有整页图像未读"时也为 True（比参考实现更保守，见 README）。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import unicodedata
from pathlib import Path

import fitz

from . import __version__, content, pdf_layout, resume_fields, structure as st

BACKEND = f"pymupdf/{fitz.__version__}"
_OCR_TOOL = Path(__file__).with_name("ocr_titles.py")
_CID_RE = re.compile(r"\(cid:\d+\)")
# Cc 控制字符（保留 \t \n \r：它们是合法排版空白）
_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
# "解不出的字形"判据：U+FFFD / (cid:N) / 除 NUL 以外的控制字符。
# NUL 不在此列——参考实现把 NUL 当"格式解码"（content.normalize 用空格替换），
# 它不是文本层解码失败；把它算成 HARD 会让一份完全可读的简历变成"读不出"。
_BAD_GLYPH_RE = re.compile(r"\ufffd|\(cid:\d+\)|[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]")
# `[label](<href>)`（同 content.link_md）；只用于把 block 文本还原成**可见文字**：
# label 是印在页面上的词，href 只是注解目标，不算"这个 URL 已经出现在正文里"。
_LINK_MD_RE = re.compile(r"\[((?:\\.|[^\]])*)\]\(<[^>]*>\)")


# ============================ 保真工具 ============================
def strip_unreadable(text: str) -> tuple[str, str]:
    """剔除无法解码的字形标记，返回 (干净文本, 被剔除的字符)。

    ``\\ufffd`` / ``(cid:N)`` / 控制字符不是原文内容，而是"这层文本没解出来"的
    标记。doc 11 A6 要求它们不得出现在正文，所以这里剔除；剔除的字符原样返回，
    供验收报告做 ``Counter`` 恒等式（native == blocks + removed）审计。
    """
    removed: list[str] = []

    def _drop(match):
        removed.append(match.group(0))
        return ""

    clean = _CID_RE.sub(_drop, text or "")
    clean = _CTRL_RE.sub(_drop, clean)
    if "\ufffd" in clean:
        removed.append("\ufffd" * clean.count("\ufffd"))
        clean = clean.replace("\ufffd", "")
    return clean, "".join(removed)


def non_space_counter(text: str):
    """非空白字符计数器（验收 A2 的唯一口径）。"""
    from collections import Counter
    return Counter(re.sub(r"\s", "", text or ""))


def _native_block(kind: str, text: str, location: dict, links=None) -> dict:
    """原生文本块：provenance 逐块标注（doc 11 D2）。"""
    block = content.block(kind, text, location, links)
    block["provenance"] = "native_text"
    return block


def _pdf_image_coverage(page, images) -> float | None:
    """Share of the page area covered by embedded images, or None if unknown.

    Pure geometry from the page's own placement rects; no content guessing.
    """
    try:
        page_area = page.rect.get_area()
    except Exception:  # noqa: BLE001
        return None
    if not page_area:
        return None
    total = 0.0
    try:
        for item in images:
            for rect in page.get_image_rects(item[0]):
                total += (rect & page.rect).get_area()
    except Exception:  # noqa: BLE001
        return None
    return total / page_area


def _pdf_image_note(number: int, chars: int, images, coverage) -> tuple | None:
    """Geometry locates images; it cannot decide their semantic role.

    Native text stays available in the work MD. Agent may confirm a photo or
    decoration from the original, or read image facts, without retyping the
    correct native text. Unknown placement is never evidence of decoration.
    """
    if not images:
        return None
    detail = f"page {number} has {len(images)} embedded image(s)"
    geometry = "unknown" if coverage is None else f"{coverage:.3f}"
    # 不能按"图片面积小"就判定为装饰——几何位置不能决定语义角色。
    return ("unverified_pdf_image",
            f"{detail}, coverage {geometry}; confirm image role/content from the original; preserve native text",
            True)


def _pdf_bullet_boundaries(text: str) -> str:
    """Keep visible PDF bullet lines separate when Markdown renders them.

    The native reader may put several visual list items in one text block.
    Keep the author's marker and wording; only add a paragraph boundary where
    an explicit typographic bullet begins a physical line.
    """
    lines = text.split('\n')
    result = []
    for line in lines:
        if re.match(r'^[ \t]*\[?[●•▪◦‣⁃]', line) and result and result[-1].strip():
            result.append('')
        result.append(line)
    return '\n'.join(result)


def _pdf_block_sizes(page) -> dict:
    """block bbox -> (最大字号, 是否含加粗 span)。失败返回 {}。"""
    try:
        d = page.get_text("dict")
    except Exception:  # noqa: BLE001
        return {}
    if not isinstance(d, dict):
        return {}
    out = {}
    for blk in d.get("blocks", []):
        if blk.get("type") != 0:
            continue
        bbox = blk.get("bbox") or []
        if len(bbox) != 4:
            continue
        mx = 0.0
        bold = False
        for line in blk.get("lines", []):
            for span in line.get("spans", []):
                if (span.get("text") or "").strip():
                    mx = max(mx, float(span.get("size") or 0))
                    # flags bit 4 (16) = 粗体；这是排版强调信号，与字号独立
                    if int(span.get("flags") or 0) & 16:
                        bold = True
        key = tuple(round(x, 1) for x in bbox)
        if mx:
            prev = out.get(key)
            out[key] = (max(prev[0], mx) if prev else mx,
                        bold or (prev[1] if prev else False))
    return out


def _lookup_size(size_map: dict, bbox):
    """返回 (字号, 是否加粗)；拿不到返回 (0.0, False)。"""
    if not size_map or not bbox or len(bbox) != 4:
        return 0.0, False
    key = tuple(round(x, 1) for x in bbox)
    if key in size_map:
        return size_map[key]
    for k, v in size_map.items():
        if all(abs(a - b) <= 1.0 for a, b in zip(k, key)):
            return v
    return 0.0, False


# ============================ OCR 只补标题 ============================
def _ocr_heading_inserts(path: Path, max_pages: int = 3) -> tuple[list, str]:
    """用外部 OCR 找出「原生文本层里没有的标题」，返回 (标题列表, 说明)。

    每个元素：(page, bbox, level, text)。只返回标题，不返回正文——
    正文一律用原生文本（历史决定：不整页覆盖，避免丢正确正文）。
    """
    py = os.environ.get("RESUME_CONVERSION_OCR_PYTHON", "").strip()
    if not py or not Path(py).is_file() or not _OCR_TOOL.is_file():
        return [], "ocr_disabled"
    try:
        proc = subprocess.run([py, str(_OCR_TOOL), str(path), "--max-pages", str(max_pages)],
                              capture_output=True, timeout=240)
    except Exception as exc:  # noqa: BLE001
        return [], f"ocr_run_failed: {exc}"
    if proc.returncode != 0:
        return [], f"ocr_exit_{proc.returncode}: " + proc.stderr.decode("utf-8", "replace")[:200]
    try:
        data = json.loads(proc.stdout.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        return [], f"ocr_bad_json: {exc}"
    if not data.get("ok"):
        return [], "ocr_not_ok: " + str(data.get("error"))

    inserts = []
    for page in data.get("pages") or []:
        pno = page.get("page") or 1
        raw = []
        for ln in page.get("lines") or []:
            text = (ln.get("text") or "").strip()
            rect = ln.get("bbox_pdf") or []
            if not text or len(rect) != 4:
                continue
            raw.append({"kind": "paragraph", "text": text,
                        "location": {"page": pno, "bbox": [float(x) for x in rect]},
                        "links": [], "provenance": "ocr_title",
                        "evidence": {"bbox_height": float(ln.get("height") or 0)}})
        if not raw:
            continue
        st.infer_structure(raw)
        for b in raw:
            lv = b.get("level") or 0
            if lv <= 0:
                continue
            inserts.append((pno, list(b["location"]["bbox"]), int(lv), b["text"]))
    if not inserts:
        return [], "ocr_no_headings"
    return inserts, ""


# ============================ 失败返回 ============================
def _failed(path: Path, sha: str | None, code: str, message: str, *,
            needs_visual: bool = False) -> dict:
    return content.result(
        blocks=[], completeness="partial", needs_visual=needs_visual,
        issues=[{"code": code, "message": message}],
        meta={"pages": 0, "source_sha256": sha, "source_name": path.name,
              "backend": BACKEND, "reader_version": __version__,
              "page_info": [], "layout_backend": None, "order_verified": False,
              "repaired": False, "failed": True},
        extra={"fields": resume_fields.empty_fields(code),
               "noise": [],
               "protected_attributes": resume_fields.empty_protected(code),
               "screening": resume_fields.empty_screening(code),
               "timeline": {}})


# ============================ 主实现 ============================
def read_pdf(path) -> dict:
    """读一份 PDF，返回 content.result() 形状 + 招聘字段层。"""
    path = Path(path)
    try:
        sha = hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as exc:
        return _failed(path, None, "reader_failed", f"cannot read file: {type(exc).__name__}: {exc}")
    try:
        doc = fitz.open(str(path))
    except Exception as exc:  # noqa: BLE001
        return _failed(path, sha, "reader_failed",
                       f"PDF could not be opened: {type(exc).__name__}: {exc}")
    try:
        return _read_doc(doc, path, sha)
    finally:
        try:
            doc.close()
        except Exception:  # noqa: BLE001
            pass


def _read_doc(doc, path: Path, sha: str) -> dict:
    if doc.is_encrypted and not doc.authenticate(""):
        return content.result(
            blocks=[], completeness="partial", needs_visual=True,
            issues=[{"code": "encrypted_pdf",
                     "message": "PDF cannot be opened without a password"}],
            meta={"pages": doc.page_count, "source_sha256": sha, "source_name": path.name,
                  "backend": BACKEND, "reader_version": __version__,
                  "page_info": [{"page": n, "chars": None, "images": None, "drawings": None,
                                 "readable": False, "layout_order_applied": False,
                                 "image_coverage": None, "block_count": 0,
                                 "encoding_removed": "", "noise_removed": ""}
                                for n in range(1, doc.page_count + 1)],
                  "layout_backend": None, "order_verified": False,
                  "repaired": bool(getattr(doc, "is_repaired", False))},
            extra={"fields": resume_fields.empty_fields("encrypted_pdf"),
                   "noise": [],
                   "protected_attributes": resume_fields.empty_protected("encrypted_pdf"),
                   "screening": resume_fields.empty_screening("encrypted_pdf"),
                   "timeline": {}})

    blocks, pages, issues, warnings = [], [], [], []
    order_unverified_pages: list[int] = []
    repaired = bool(getattr(doc, "is_repaired", False))
    if repaired:
        issues.append({"code": "pdf_damaged_repaired",
                       "message": ("PDF structure was damaged and the parser repaired it; "
                                   "missing content cannot be excluded")})

    layout = None
    try:
        layout = pdf_layout.infer(path)
        if layout is not None and (len(layout['pages']) != len(doc) or
                                   [p['page'] for p in layout['pages']] != list(range(1, len(doc) + 1))):
            raise ValueError('layout page coverage differs from original')
    except Exception as exc:  # noqa: BLE001
        layout = None
        issues.append({'code': 'pdf_layout_unread', 'message': str(exc)})

    for number, page in enumerate(doc, 1):
        page_blocks = []
        encoding_regions = []
        encoding_removed = []
        layout_applied = False
        try:
            type3_fonts = sum(1 for font in (page.get_fonts(full=True) or [])
                              if len(font) > 2 and font[2] == 'Type3')
        except Exception:  # noqa: BLE001
            type3_fonts = 0
        size_map = _pdf_block_sizes(page)
        page_sizes = []
        for raw in page.get_text("blocks", sort=False):
            if raw[6] != 0 or not raw[4].strip():
                continue
            clean, removed = strip_unreadable(raw[4])
            if removed:
                encoding_removed.append(removed)          # 已声明移除：保真恒等式要用
            if removed and _BAD_GLYPH_RE.search(removed):
                encoding_regions.append(list(raw[:4]))    # 只有真的解不出才算 unread
            if not clean.strip():
                continue  # 整块只有坏字形：内容已记入 encoding_removed，不造空块
            page_blocks.append(_native_block("paragraph", clean,
                                             {"page": number, "bbox": list(raw[:4])}))
            page_sizes.append(_lookup_size(size_map, list(raw[:4])))
        if encoding_regions:
            # One page-level task: the Agent reads the whole selected page and
            # returns the whole page text. Region bboxes are evidence for where
            # the native layer failed, not a request to patch those spots only.
            cause = ('; text is drawn with Type3 vector fonts, so the native '
                     'text layer is unreliable' if type3_fonts else '')
            issues.append({'code': 'pdf_text_encoding_unread',
                           'message': ('native PDF text contains undecoded glyphs or invalid '
                                       'control characters' + cause + '. Read the whole page '
                                       'image of this original and return the complete page text '
                                       '(preserve readable native text and real URI links); do not '
                                       'treat this as local wording patches'),
                           'location': {'page': number, 'regions': encoding_regions}})
        if layout is not None:
            try:
                ordered = pdf_layout.order_page(page, layout['pages'][number - 1], number)
                # The block reader and line reader must agree on all native
                # non-whitespace characters before geometry can be adopted.
                before = ''.join(re.sub(r'\s', '', b['text']) for b in page_blocks)
                after = ''.join(re.sub(r'\s', '', b['text']) for b in ordered)
                if non_space_counter(before) != non_space_counter(after):
                    raise ValueError('layout does not preserve native text exactly once')
                page_blocks = ordered
                for block in page_blocks:
                    block.setdefault("provenance", "native_text")
                layout_applied = True
            except Exception as exc:  # noqa: BLE001
                issues.append({'code': 'pdf_layout_unread', 'message': str(exc),
                               'location': {'page': number}})
        elif pdf_layout.stream_order_issue(page_blocks):
            order_msg = ('native content stream jumps backwards across page regions; '
                         'layout order is unverified')
            page_chars = len(page.get_text("text").strip())
            order_unverified_pages.append(number)
            # 敏感度分级：本页文字已充足时，顺序瑕疵不影响内容完整性，
            # 降级为 warning（不阻断、不产生 Agent 请求），仅记录证据。
            # 注意：warning 不等于"顺序可信"——字段层仍据此拒绝断言"没有该章节"。
            if page_chars >= 800:
                warnings.append(f"pdf_reading_order_soft: page {number} {order_msg}")
            else:
                issues.append({'code': 'pdf_reading_order_unverified',
                               'message': order_msg, 'location': {'page': number}})

        # 链接归属：把 URI 注解挂到它覆盖的可见词上，再按块改写原文一次（从右到左）
        words = page.get_text("words", sort=False)
        rects = []
        for link in page.get_links():
            uri = link.get("uri")
            if uri:
                rects.append((fitz.Rect(link["from"]), uri))
        word_link: dict[tuple, str] = {}
        for w in words:
            centre = fitz.Point((w[0] + w[2]) / 2, (w[1] + w[3]) / 2)
            containing = [(rect.get_area(), uri) for rect, uri in rects
                          if rect.contains(centre)]
            if containing:
                word_link[(w[0], w[1], w[2], w[3])] = min(containing)[1]
        used_uris: set[str] = set()

        def link_block(block) -> None:
            bx0, by0, bx1, by1 = block["location"]["bbox"]
            block_words = [w for w in words
                           if bx0 <= (w[0] + w[2]) / 2 <= bx1
                           and by0 <= (w[1] + w[3]) / 2 <= by1]
            runs: list[dict] = []
            current = None
            for w in block_words:
                uri = word_link.get((w[0], w[1], w[2], w[3]))
                if uri is None:
                    current = None
                    continue
                if current is not None and current["uri"] == uri:
                    current["words"].append(w)
                else:
                    current = {"uri": uri, "words": [w]}
                    runs.append(current)
            if not runs:
                return
            text = block["text"]
            found = []
            cursor = 0
            for run in runs:
                label = " ".join(w[4] for w in run["words"])
                position = text.find(label, cursor)
                if position < 0:
                    label = run["words"][0][4]
                    position = text.find(label, cursor)
                    if position < 0:
                        continue
                found.append((position, position + len(label), label,
                              run["uri"], run["words"]))
                cursor = position + len(label)
            for position, end, label, uri, run_words in reversed(found):
                box = fitz.Rect(run_words[0][:4])
                for w in run_words[1:]:
                    box |= fitz.Rect(w[:4])
                item = {"text": label, "href": uri,
                        "location": {"page": number, "bbox": list(box)}}
                text = text[:position] + content.link_md(label, uri) + text[end:]
                block["links"].append(item)
                used_uris.add(uri)
            block["text"] = text

        for block in page_blocks:
            link_block(block)
            block['text'] = _pdf_bullet_boundaries(block['text'])
        # 只记录字号证据，标题判定统一交给 structure.infer_structure（唯一入口）
        if layout is None:  # 有 layout 重排时 block/字号对应关系不可靠，不提供证据
            for _b, _sz in zip(page_blocks, page_sizes):
                _size, _bold = _sz if isinstance(_sz, tuple) else (_sz, False)
                if _size > 0:
                    _ev = _b.setdefault("evidence", {})
                    _ev["font_size"] = _size
                    if _bold:
                        _ev["is_bold"] = True
        # A real URI whose visible words cannot be located in a block keeps its
        # own entry rather than being attached to unrelated text.
        #
        # D-55：先看这个 URI 的字面文本是不是已经印在本页某个 block 里。
        # URL 夹在一整行中文里时，整行是一个"词"，词中心点落在注解矩形外 →
        # 词绑不上 → 走 fallback 再生成一个 [URL](<URL>) → 同一个 URL 在正文
        # 里出现两次。已出现就不再生成 fallback 块；URL 确实没印出来的链接
        # 仍然按原设计用 URL 当 label 保留。
        # 基线只取本页的原生 block（不含本循环刚生成的 fallback 记录），
        # 否则一个 URL 是另一个 URL 的前缀时结果会依赖遍历顺序；同时把
        # `[label](<href>)` 还原成 label——href 不是印在页面上的文字，
        # 若拿它当证据，URI 只是别的链接 href 的前缀时会被误判成"已出现"。
        visible = re.sub(r"\s", "", _LINK_MD_RE.sub(
            r"\1", "\n".join(b["text"] for b in page_blocks)))
        seen_fallback = set()
        for rect, uri in rects:
            if uri in used_uris or uri in seen_fallback:
                continue
            seen_fallback.add(uri)
            if re.sub(r"\s", "", uri) in visible:
                continue
            label = " ".join(w[4] for w in words if rect.contains(
                fitz.Point((w[0] + w[2]) / 2, (w[1] + w[3]) / 2))) or uri
            # 词里可能带坏字形标记：链接记录块同样不允许把 U+FFFD 带进正文
            label = strip_unreadable(label)[0] or uri
            item = {"text": label, "href": uri,
                    "location": {"page": number, "bbox": list(rect)}}
            page_blocks.append(_native_block("link", content.link_md(label, uri),
                                             item["location"], [item]))
        chars = len(page.get_text("text").strip())
        images = page.get_images(full=True)
        try:
            drawings = len(page.get_drawings())
        except Exception:  # noqa: BLE001
            drawings = 0
        coverage = _pdf_image_coverage(page, images)
        pages.append({"page": number, "chars": chars, "images": len(images),
                      "drawings": drawings, "layout_order_applied": layout_applied,
                      "image_coverage": coverage,
                      "block_count": len(page_blocks),
                      "encoding_removed": "".join(encoding_removed)})
        if chars < 80 and (images or drawings):
            issues.append({"code": "unread_visual_page",
                           "message": "low-text page contains graphics",
                           "location": {"page": number}})
        elif chars == 0 and not images and not drawings:
            # doc 11 A1：每页要么有 block，要么有 issue。空白页既没有内容也没有图形，
            # 必须留一条记录，否则这一页在输出里"消失"了。
            issues.append({"code": "pdf_page_empty",
                           "message": "page has no text, no image and no drawing",
                           "location": {"page": number}})
        else:
            note = _pdf_image_note(number, chars, images, coverage)
            if note is not None:
                code, text, is_issue = note
                if is_issue:
                    issues.append({"code": code, "message": text,
                                   "location": {"page": number}})
                else:
                    warnings.append(f"{code}: {text}")
        blocks.extend(page_blocks)

    # ---- 平台噪声：整块移出正文，逐条记录（doc 11 §9.5）----
    blocks, noise = resume_fields.split_noise(blocks)
    if noise:
        issues.append({"code": "platform_noise_excluded",
                       "message": f"{len(noise)} block(s) of platform branding removed from body",
                       "location": {"page": noise[0]["page"], "bbox": noise[0]["bbox"]}})
    for page in pages:
        removed_text = "".join(n["text"] for n in noise if n["page"] == page["page"])
        page["noise_removed"] = removed_text
    # 平台标识与正文同块 → 不能删（会删真内容），必须报出来
    for block in blocks:
        hit, marker = resume_fields.is_noise_block(block)
        if not hit:
            text = block.get("text") or ""
            low = text.lower()
            if any(m in low for m in resume_fields._PLATFORM_MARKERS):
                issues.append({"code": "platform_noise_inline_unresolved",
                               "message": ("platform branding shares a text block with body "
                                           "content and was kept; confirm it is not a company name"),
                               "location": {"page": (block.get("location") or {}).get("page"),
                                            "bbox": (block.get("location") or {}).get("bbox")}})

    if not blocks:
        issues.append({"code": "pdf_no_text", "message": "PDF has no machine-readable text"})

    # ---- 结构层：只提供证据，不判断正文 ----
    if blocks:
        page_of = {}
        for block in blocks:
            page_of[id(block)] = (block.get("location") or {}).get("page") or 1
        st.infer_structure(blocks, page_of=page_of)
        st.mark_headings(blocks)

    # ---- OCR 兜底：只补标题，正文保持原生 ----
    ocr_note = "not_attempted"
    plain = "\n".join(b.get("text") or "" for b in blocks)
    if len(plain.strip()) >= 800:
        ocr_note = "not_needed"
        if st.heading_count(blocks) <= 1:
            inserts, note = _ocr_heading_inserts(path, max_pages=3)
            if inserts:
                native = [{"page": (b.get("location") or {}).get("page") or 1,
                           "y": ((b.get("location") or {}).get("bbox") or [0, 0, 0, 1e9])[1]}
                          for b in blocks]
                added = 0
                for pno, bbox, lv, txt in inserts:
                    at = len(blocks)
                    for idx, nat in enumerate(native):
                        if nat["page"] > pno or (nat["page"] == pno and nat["y"] > bbox[3]):
                            at = idx
                            break
                    block = content.block("heading", "#" * min(int(lv), 6) + " " + txt,
                                          {"page": pno, "bbox": bbox})
                    block["level"] = int(lv)
                    block["provenance"] = "ocr_title"
                    blocks.insert(at, block)
                    native.insert(at, {"page": pno, "y": bbox[1]})
                    added += 1
                warnings.append(f"headings_from_ocr_region: inserted {added} heading(s) "
                                f"into native text (body kept native, not replaced)")
                ocr_note = f"inserted {added}"
            elif note in ("ocr_disabled",):
                warnings.append("ocr_title_backend_unconfigured: heading_count<=1 and no OCR "
                                "interpreter configured; titles may be missing (body unaffected)")
                ocr_note = "backend_unconfigured"
            elif note not in ("ocr_no_headings",):
                warnings.append(f"ocr_fallback_skipped: {note}")
                ocr_note = note

    # ---- 招聘字段层 ----
    analysis = resume_fields.analyze(blocks, page_info=pages, page_count=doc.page_count,
                                     source_sha256=sha, issues_before=list(issues),
                                     order_unverified_pages=order_unverified_pages)
    issues.extend(analysis["issues"])
    warnings.extend(analysis["warnings"])

    needs_visual = (not blocks
                    or any(i["code"] == "pdf_text_encoding_unread" for i in issues)
                    or any(i["code"] == "unread_visual_page" for i in issues))
    return content.result(
        blocks=blocks,
        title=(doc.metadata or {}).get("title") or "",
        completeness="complete",
        issues=issues,
        warnings=warnings,
        needs_visual=needs_visual,
        meta={"pages": doc.page_count, "source_sha256": sha, "source_name": path.name,
              "backend": BACKEND, "reader_version": __version__,
              "page_info": pages, "layout_backend": (layout or {}).get("backend") if layout else None,
              "order_verified": bool(layout) and all(p["layout_order_applied"] for p in pages),
              "repaired": repaired, "ocr": ocr_note,
              "noise_blocks": len(noise),
              "encoding_removed_chars": "".join(p["encoding_removed"] for p in pages)},
        extra={"fields": analysis["fields"],
               "noise": noise,
               "protected_attributes": analysis["protected_attributes"],
               "screening": analysis["screening"],
               "timeline": analysis["timeline"]},
    )


def native_page_text(path) -> list[str]:
    """测试/验收辅助：逐页原生文本（不含任何清洗），用于 Counter 比对。"""
    with fitz.open(str(path)) as doc:
        return [page.get_text("text") for page in doc]
