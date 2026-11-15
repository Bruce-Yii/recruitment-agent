"""task-77 姓名抽取回归：带标签优先 / 无标签只认结构层 h1 / 删除 font_size_max 猜测。

事故（真实合成简历 p03-synthetic-resume-V4.pdf）：旧 ``_find_name`` 先收集首页
"姓名形态"块做候选，无 h1 时走"取候选里字号最大且唯一"的 ``font_size_max``
fallback，于是把首页正文小标题「声明」（12pt）当成了姓名；而带标签路径
``_LABELED_NAME`` 只接受 2-4 个汉字（读不出「测试候选人丁」），且只在"无候选"
时才执行，永远轮不到。

本文件用合成 blocks 直接调用 ``src.resume_fields.analyze``（不依赖真实语料），
锁死修复后的业务口径：
① 带标签字段（行首锚定，大小写不敏感）最高优先；
② 结构层 h1（level==1，已含"首页+最大字号+姓名形态"）及 h1 前缀；
③ 没有可信来源时如实 absent / unreadable，绝不猜、绝不把「声明」当姓名。
"""
from __future__ import annotations

from src import resume_fields as rf

SHA = "0" * 64


def _block(text, *, page=1, bbox=(40, 40, 200, 52), level=None, font_size=None,
           kind="paragraph", provenance="native_text"):
    block = {"kind": kind, "text": text,
             "location": {"page": page, "bbox": list(bbox)},
             "links": [], "provenance": provenance}
    if level:
        block["level"] = level
    if font_size is not None:
        block["evidence"] = {"font_size": font_size}
    return block


def _analyze(blocks, **kwargs):
    return rf.analyze(blocks, page_info=kwargs.pop("page_info", [{"page": 1, "images": 0}]),
                      page_count=kwargs.pop("page_count", 1), source_sha256=SHA,
                      issues_before=kwargs.pop("issues_before", []), **kwargs)


def _name(blocks, **kwargs):
    return _analyze(blocks, **kwargs)["fields"]["name"]


def _incident_blocks(*, with_labels=True):
    """复刻 V4 的真实版式（字号/层次同现状取证）。

    15pt 英文标题（无 level）+ 12pt 章节标题（level=2）+ 10pt 正文 +
    10pt「姓名：测试候选人丁」/「Name: P03 Synthetic Candidate D」+ 12pt「声明」（无 level）。
    """
    blocks = [
        _block("P0-3 SYNTHETIC RESUME V4 — NOT A REA", bbox=(56, 49, 596, 67),
               font_size=15.0),
        _block("基本信息", bbox=(56, 98, 104, 112.4), level=2, font_size=12.0,
               kind="heading"),
    ]
    if with_labels:
        blocks.append(_block("姓名：测试候选人丁", bbox=(56, 122, 146, 134),
                             font_size=10.0))
        blocks.append(_block("Name: P03 Synthetic Candidate D",
                             bbox=(56, 138, 366, 150), font_size=10.0))
    blocks.extend([
        _block("电话：+8613800000004", bbox=(56, 154, 226, 166), font_size=10.0),
        _block("邮箱：p03.synthetic.d@demo-recruitment.test",
               bbox=(56, 170, 456, 182), font_size=10.0),
        _block("工作经历", bbox=(56, 208, 104, 222.4), level=2, font_size=12.0,
               kind="heading"),
        _block("2018-2025  合成演示公司丙（Synthetic Demo Corp D）  平台工程师",
               bbox=(56, 232, 536, 244), font_size=10.0),
        _block("教育经历", bbox=(56, 286, 104, 300.4), level=2, font_size=12.0,
               kind="heading"),
        _block("2014-2018  演示大学丁（Demo University C）  软件工程  本科",
               bbox=(56, 310, 506, 322), font_size=10.0),
        _block("声明", bbox=(56, 378, 80, 392.4), font_size=12.0),
        _block("本文件全部字段与经历均为虚构，用于验证 RESUME_PARSE 长任务。",
               bbox=(56, 402, 526, 414), font_size=10.0),
    ])
    return blocks


# ---------------------------------------------------------------- 事故回归
def test_incident_v4_labeled_name_beats_declaration_heading():
    """事故件回归：必须读出「测试候选人丁」，绝不输出「声明」。"""
    field = _name(_incident_blocks())
    assert field["state"] == "present"
    assert field["value"] == "测试候选人丁"
    assert field["value"] != "声明"          # 事故的直接断言
    assert field["match_rule"] == "labeled_name"
    assert field["provenance"] == "native_text"
    assert field["reason"] == ""
    # evidence 指向姓名块（不是 12pt 的「声明」块）
    evidence = field["evidence"][0]
    assert evidence["block"] == 2
    assert evidence["text"] == "测试候选人丁"
    assert evidence["bbox"] == [56, 122, 146, 134]
    assert evidence["page"] == 1
    assert evidence["source_sha256"] == SHA


def test_no_label_with_declaration_heading_never_guesses_a_name():
    """去掉全部姓名标签（含 Name: 行）后：如实 absent/unreadable，绝不拿「声明」顶替。"""
    field = _name(_incident_blocks(with_labels=False))
    assert field["state"] in {"absent", "unreadable"}
    assert field["value"] is None
    assert field["value"] != "声明"
    assert field["reason"], "非 present 必须写清 reason"


def test_declaration_heading_alone_is_absent_not_a_name():
    """只有「声明」小标题（无 level、无标签）：没有可信来源 → absent，不再靠字号猜。"""
    field = _name([_block("声明", font_size=12.0)])
    assert field["state"] == "absent"
    assert field["value"] is None
    assert field["reason"] == "no_name_candidate"


def test_name_shaped_block_without_level_is_not_guessed():
    """reproof：首页最大字号的姓名形态块，若没有结构层 h1 也没有标签 → 不猜（absent）。"""
    field = _name([_block("张三", font_size=20.0),
                   _block("工作经历", level=2, font_size=12.0, kind="heading")])
    assert field["state"] == "absent"
    assert field["value"] is None


# ---------------------------------------------------------------- 结构层 h1
def test_structural_h1_pure_cjk_name_is_present():
    field = _name([_block("张三", bbox=(40, 40, 80, 64), level=1, font_size=20.0,
                          kind="heading")])
    assert field["state"] == "present"
    assert field["value"] == "张三"
    assert field["match_rule"] == "heading_level_1"
    assert field["evidence"][0]["text"] == "张三"


def test_structural_h1_prefix_rule_does_not_fall_back_to_whole_line():
    """「张馨方  AI Product Manager」→ 只取姓名段，不把整行当姓名。"""
    field = _name([_block("张馨方  AI Product Manager", level=1, font_size=20.0,
                          kind="heading", bbox=(40, 40, 400, 64))])
    assert field["state"] == "present"
    assert field["value"] == "张馨方"
    assert field["match_rule"] == "heading_level_1_prefix"
    assert field["value"] != "张馨方  AI Product Manager"


def test_h1_on_page_two_is_not_a_name():
    """姓名只可能来自首页：第二页的 h1 不得被当成 name。"""
    field = _name([_block("张三", page=2, level=1, font_size=20.0, kind="heading")],
                  page_info=[{"page": 1, "images": 0}, {"page": 2, "images": 0}],
                  page_count=2)
    assert field["state"] == "absent"
    assert field["value"] is None


# ---------------------------------------------------------------- 带标签字段
def test_labeled_six_char_cjk_name_is_present():
    """标签值 2-20 汉字：6 字长姓名（旧规则只认 2-4 字，读不出）。"""
    field = _name([_block("姓名：测试候选人丁", font_size=10.0)])
    assert field["state"] == "present"
    assert field["value"] == "测试候选人丁"
    assert field["match_rule"] == "labeled_name"


def test_labeled_two_char_cjk_name_still_present():
    """2-4 字标签名是既有正例，不得退化。"""
    field = _name([_block("姓名：张某", font_size=10.0)])
    assert field["state"] == "present"
    assert field["value"] == "张某"
    assert field["match_rule"] == "labeled_name"


def test_labeled_english_name_is_case_insensitive():
    """`Name: P03 Synthetic Candidate D`（含 4 个英文词）大小写不敏感可读。"""
    for label in ("Name:", "name:", "NAME:"):
        field = _name([_block(f"{label} P03 Synthetic Candidate D", font_size=10.0)])
        assert field["state"] == "present", label
        assert field["value"] == "P03 Synthetic Candidate D", label
        assert field["match_rule"] == "labeled_name"


def test_labeled_name_beats_h1():
    """标签优先级高于结构层 h1（业务口径 a > b）。"""
    blocks = [
        _block("王五", level=1, font_size=20.0, kind="heading", bbox=(40, 40, 80, 64)),
        _block("姓名：李四", font_size=10.0, bbox=(40, 80, 200, 92)),
    ]
    field = _name(blocks)
    assert field["state"] == "present"
    assert field["value"] == "李四"
    assert field["match_rule"] == "labeled_name"


def test_labeled_name_beats_personal_resume_heading():
    """brief 用例：h1=「个人简历」、另有「姓名：李四」→ 取李四（不是「个人简历」）。"""
    blocks = [
        _block("个人简历", level=1, font_size=20.0, kind="heading", bbox=(40, 40, 200, 64)),
        _block("姓名：李四", font_size=10.0, bbox=(40, 80, 200, 92)),
    ]
    field = _name(blocks)
    assert field["state"] == "present"
    assert field["value"] == "李四"
    assert field["value"] != "个人简历"


def test_labeled_value_adjacent_field_is_trimmed():
    """同 block「姓名：张三性别：男」：按字段词截断，值只取姓名。"""
    field = _name([_block("姓名：张三性别：男", font_size=10.0)])
    assert field["state"] == "present"
    assert field["value"] == "张三"
    assert field["match_rule"] == "labeled_name"


def test_mid_sentence_name_word_is_not_a_label():
    """行中间的「姓名」不是字段标签（行首锚定），不得误当成姓名来源。"""
    field = _name([_block("请按系统提示填写姓名：张三", font_size=10.0)])
    assert field["state"] == "absent"
    assert field["value"] is None


def test_label_without_readable_value_is_unreadable():
    """带标签但读不出值 → unreadable（红线：不能当 absent，更不能编造 value）。"""
    for text in ("姓名：", "姓名：12345", "Name:"):
        field = _name([_block(text, font_size=10.0)])
        assert field["state"] == "unreadable", text
        assert field["value"] is None, text
        assert field["reason"] == "name_label_without_readable_value", text


def test_labeled_value_that_is_a_document_word_is_unreadable():
    """「姓名：个人简介 / 个人简历 …」这种标签值是文档词：不当姓名，退回 unreadable。

    尤其「个人简历」不得被相邻字段截断规则截成「个人」这种更糟的假姓名。
    """
    for text in ("姓名：个人简介", "姓名：个人简历", "姓名：个人简历张三",
                 "姓名：工作经历"):
        field = _name([_block(text, font_size=10.0)])
        assert field["state"] == "unreadable", text
        assert field["value"] is None, text


def test_labeled_name_provenance_follows_block():
    """标签路径的 provenance 必须逐块传播（OCR 块不得冒充 native_text）。"""
    field = _name([_block("姓名：张某", provenance="ocr")])
    assert field["state"] == "present"
    assert field["value"] == "张某"
    assert field["provenance"] == "ocr"
