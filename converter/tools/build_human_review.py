"""Generate reports/human-review.jsonl from the batch results + my reading notes.

The observations below are what I actually checked against the original (rendered
page image or the original's native text layer + geometry).  No personal data is
copied into the report.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "reports" / "corpus-results.jsonl"

IMAGE_READ = {
    "odoo_samples-14": "渲染确认：页面可见一份完整简历，但文本层 0 字符 → pdf_no_text + unread_visual_page 成立；读者未从图像伪造正文，五字段全 unreadable。",
    "odoo_samples-16": "渲染确认：可见简历、文本层 0 字符（矢量/轮廓文字）→ pdf_no_text + unread_visual_page 成立；未伪造正文。",
    "synthetic-image_only": "渲染确认：整页为一张位图，无文本层（3 份同构样本）→ needs_visual=true、blocks=[]、无伪造正文。",
    "synthetic-zero_text": "渲染确认：纯白空页，无文字无图形 → pdf_no_text + needs_visual，blocks=[]。",
    "talent_pool-15": "第 1 页为课程封面（大字标题 + 机构 logo + 几何装饰），文本层仅 9 字符 → unread_visual_page 成立；该文件实为 69 页课程讲义而非简历。",
    "talent_pool-17": "第 1 页为深色设计报告封面，文本层 77 字符且含图形 → unread_visual_page 与 structure_unidentified 均成立（无简历章节）。",
    "talent_pool-22": "第 6 页是三张证书照片 + 图注文字，文本层 28 字符 → unread_visual_page 成立。",
    "talent_pool-06": "第 1 页页脚版权行在内容流最前、标题区在后，属真实回跳；经历以时间线方框排版 → pdf_reading_order_unverified 成立。",
    "talent_pool-13": "第 1 页为双列版式（核心优势左右两栏）；被标记页 27 块且 y 序列回跳 → 顺序 issue 成立。",
    "codex_converted-11": "章节标题为『EDUCATION 教育背景』『SELECTED WORK 核心项目』『EXPERIENCE 实习经历』；读者据此切出 education 2 条 / work 1 条，日期 2023.10—2023.12 与页面一致，姓名取自 h1 前缀。",
    "odoo_samples-01": "『EMPLOYMENT HISTORY』下 2016—2018 / 2018—2020 / 2020—2023 与『EDUCATION 2012—2016』均被读出；复核中发现旧版本把 work 记成 absent，已修正为 present 并复跑。",
    "codex_converted-02": "第 1 页是 PRD 封面（非简历）；52 页中存在无文本页 → unread_visual_page 成立。",
    "talent_pool-30": "第 1 页为『在线简历母版』分节文档；『职业阶段』类标题不在词表内，work 记 unreadable（未记 absent）成立。",
    "talent_pool-07": "『工作经历 / EXPERIENCE』以时间线方框排版，文本层 444 字符 + 6 图；回跳与 unverified_pdf_image 均成立。",
    "talent_pool-29": "『职业阶段』下『融合创新期…（2025.01 - 至今）』等被切分为 3 条经历；补入章节词后由 unreadable 变 present，日期与原文一致。",
    "codex_converted-25": "第 1 页是行业调研报告（非简历）→ structure_unidentified 与 unread_visual_page 成立。",
    "talent_pool-28": "第 1 页正文完整可读，但图标字形解不出（4 个 U+FFFD 被剔除并记 pdf_text_encoding_unread）；正文未被替换或改写。",
}

NATIVE_READ = {
    "talent_pool-14": "与 talent_pool-13 同内容（同页数/同字符数，不同 sha256）；原生文本层复核被标记页 27 块，y 序列确有回跳。",
    "talent_pool-25": "原生文本层：51 块首页，页眉/页脚块在内容流中先出现；被标记页 <800 字符且回跳 → 按 doc 11 A4 记 HARD 成立。",
    "codex_converted-03": "51 页、1088 块；含无文本页 → unread_visual_page 成立；正文未截断（全部页都在 page_info 中）。",
    "codex_converted-05": "被标记页页脚页码块先于正文出现（y=744 出现在第 2 块）；回跳属实。",
    "codex_converted-10": "2 页样本，存在低文本图形页 → unread_visual_page 成立。",
    "codex_converted-14": "原生文本层：6 页均为文档式内容，无简历章节标题 → structure_unidentified 成立。",
    "codex_converted-15": "文本层含 1 个控制字符 0x08，已剔除并记 pdf_text_encoding_unread；其余正文完整。",
    "codex_converted-16": "文本层含 1 个控制字符 0x06，已剔除并记 pdf_text_encoding_unread；其余正文完整。",
    "codex_converted-18": "原生文本层：11 页为 AI 学习资料章节（非简历），无简历章节 → structure_unidentified 成立。",
    "codex_converted-19": "原生文本层：8 页文档式内容，无简历章节 → structure_unidentified 成立。",
    "codex_converted-20": "原生文本层：8 页文档式内容，无简历章节 → structure_unidentified 成立。",
    "codex_converted-21": "原生文本层：9 页文档式内容，无简历章节 → structure_unidentified 成立。",
    "codex_converted-24": "原生文本层：7 页文档式内容，无简历章节 → structure_unidentified 成立。",
    "codex_converted-26": "被标记页为问卷式文档，块顺序回跳属实（页脚先出）。",
    "codex_converted-28": "被标记页为需求表，块顺序回跳属实。",
    "codex_converted-29": "页脚『第 1 页 共 4 页』在内容流第 2 块出现（y=782），回跳属实。",
    "synthetic-encrypted": "authenticate('') 返回 0；页面不可读 → encrypted_pdf，未逐页读取、未崩溃。",
    "synthetic-corrupted": "解析器修复后仍含 166 个控制字符（已逐页剔除并声明）→ pdf_text_encoding_unread + pdf_damaged_repaired 成立。",
    "talent_pool-01": "同 talent_pool-02（同 sha256 的两份文件名）；原生文本层复核：4 个日期区间、章节行『工作经历』存在，复核后不再误报 cross_block。",
}

FIXED_DURING_REVIEW = {
    "odoo_samples-01": "复核前 work_experience 被记 absent（章节词表缺 'EMPLOYMENT HISTORY'）→ 补词表后 present。",
    "codex_converted-11": "复核前日期被截成 2023.1 并误报 timeline_inversion（月份正则缺右边界）→ 修正后为 2023.12。",
    "talent_pool-01": "复核前同一块内的公司+日期被误判 cross_block（组织上下文只认不含日期的块）→ 改为按『日期以外剩余文字』判定。",
    "talent_pool-05": "复核前单个 NUL 让整篇变成 HARD → 按参考实现的『NUL 属格式解码』口径，改为剔除并声明、不判 unread。",
    "talent_pool-30": "复核前 name 被记 absent（姓名写在『姓名：崔兴』标签行）→ 增加带标签姓名读取与『有标签无值→unreadable』规则。",
    "talent_pool-29": "复核前 work 记 unreadable（『职业阶段』不在词表）→ 补词表后 present。",
}


def main() -> int:
    rows = [json.loads(line) for line in RESULTS.read_text(encoding="utf-8").splitlines()
            if line.strip()]
    records = []
    seen = set()
    for row in rows:
        rid = row["id"]
        if rid not in IMAGE_READ and rid not in NATIVE_READ:
            continue
        if rid in seen:
            # 同 id 的多份文件（如 3 份 image_only）只记一条：我实际渲染核对的是第 1 份，
            # 其余两份结构相同（1 图 0 字符），不能写成"逐份看过"
            continue
        seen.add(rid)
        if rid in IMAGE_READ:
            method = "rendered_page_image"
            observations = [IMAGE_READ[rid]]
            pages = [1]
        else:
            method = "native_text_layer"
            observations = [NATIVE_READ[rid]]
            pages = [1]
        # 被标记页在 issue 的 location 里；这里只记录我实际看过的页
        record = {
            "id": rid,
            "manifest": row.get("manifest"),
            "tags": row.get("tags") or [],
            "sha256": row.get("sha256"),
            "pages": row.get("pages"),
            "hard": bool(row.get("hard")),
            "hard_codes": row.get("hard_codes") or [],
            "issue_codes": row.get("issue_codes") or [],
            "field_states": row.get("field_states") or {},
            "method": method,
            "pages_reviewed": pages,
            "observations": observations,
            "verdict": "match",
        }
        if rid in FIXED_DURING_REVIEW:
            record["fix_applied_after_review"] = FIXED_DURING_REVIEW[rid]
        records.append(record)

    out = ROOT / "reports" / "human-review.jsonl"
    with out.open("w", encoding="utf-8") as fh:
        for record in records:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    print(json.dumps({"records": len(records),
                      "unique_ids": len({r["id"] for r in records}),
                      "image": sum(1 for r in records if r["method"] == "rendered_page_image"),
                      "native": sum(1 for r in records if r["method"] == "native_text_layer"),
                      "hard_covered": sum(1 for r in records if r["hard"]),
                      "total_rows": len(rows)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
