# U3 收口：`document_read` 接出来（2026-11-14）

**根因**：U0（契约）/ U1（Reader）/ U2（质量 + 恢复）都实现完了、**73 条测试绿**，
但**没有暴露成工具** —— agent 调不到。这就是 R2 说的假接线：能力在包里、入口没有它。
没有"收口"这一步（根因 B），所以它一直挂在缺口清单里。

---

## 1. 新增 `recruitment_document_read`

**唯一入口**：PDF / DOCX / PNG / JPEG，按**内容嗅探**选 reader（不按扩展名），扩展名与内容不符记 `MEDIA_MISMATCH`。

接线硬要求（`src/document/README.md` §6.2）逐字照做：

```ts
const { content, source_meta } = await readDocumentDetailed(path, cfg)
const facts = readerFactsFromSourceMeta(source_meta)   // 只消费 content 会丢 facts
const assessment = assess(content, facts)              // 症状：每份 PDF 都命中 doc_page_count_unverified（HARD）
const recovery = plan(content, { assessment, facts })
```

输出（一个对象把下一步需要的东西全给齐）：

| 部分 | 内容 |
|---|---|
| 内容 | `media_type` / `reader_id` / `reader_version` / `asset_sha256` / `completeness` / `needs_visual` / `page_count` / `text` / `blocks[]`（含稳定 `block_id`） |
| 判定 | `assessment.completeness` / `blocking` / `blocking_codes` / `soft_codes` / `actions[]` / `issues[]`（含 `suggested_action`） |
| 计划 | `recovery.plan_id` / `blocking` / `next`（structure\|repair\|human）/ `requires_model` / `vision_pages` / `steps[]` / `notes[]` |

三个诚实点：读不出就抛错（不返回"看起来 complete"）；`blocking=true` 时明确告诉模型
"不得进入可信结构化/S7"；恢复计划只是**计划**，本工具不调模型、不渲染、不写库。

**注册**：`src/index.ts` 现在注册 **19 个工具**（配置齐 / 未配置两条路径都是 19）。

## 2. 测试（4/4，含真跑 python）

```
node --test test/integration/document-read.test.ts
ℹ tests 4 / pass 4 / fail 0 / skipped 0
```

1. **合成 PDF → 内容 + 块 + 判定 + 恢复计划**（真调 `converter/`，python 真跑）；
   断言 `completeness=complete`、`page_count=1`、`blocks>0`、`asset_sha256` 64 位、
   `recovery.next ∈ {structure,repair,human}`。
2. **关键断言**：`blocking_codes` **不得**含 `doc_page_count_unverified`
   —— 出现它就说明 `readerFactsFromSourceMeta(source_meta)` 没被用上（README §6.2 点名的症状）。
3. 输出递归查 **无 null**（DSH 校验器没有 `type:null`，出现 null 会 `INVALID_TOOL_OUTPUT`）。
4. 路径越界 → `FORBIDDEN`；未知字节 → `READER_FAILED`（读不出就报错）；未配置 → `NOT_CONFIGURED`。

**全量**：`tests 719 / pass 719 / fail 0 / skipped 0`（改动前 715，新增 4）。

## 3. 浏览器验收（DSH 0.2.2-rc.3 + 隔离 home，真模型真调）

用**一份真实简历 PDF**（`个人简历-中国石油大学（华东）-孙光宇 .pdf`，在 `allowed_roots` 内）：

```
工具调用 | recruitment_document_read · …孙光宇 .pdf
按返回原样贴出：
media_type: application/pdf
completeness: partial
assessment.blocking: true
recovery.next: human
```

与直接调用工具的结果**逐字一致**。这里"partial + blocking=true + next=human"是**正确**的，
不是失败：这份 PDF 有跨块归属未核（`doc_cross_block_attribution`）和未核图片（`unverified_pdf_image`），
质量层据此拒绝直接进入可信结构化，并给出人工复核计划 —— 这正是 U2 存在的意义。

## 4. 现在 agent 手里有什么

19 个工具：简历读取（旧 PDF 纯文本 + 新的多格式统一入口）、结构化序列化/校验、岗位读/写、
候选人查、申请接入、初筛、面试约/查、转写导入/读、面评/汇总/决策、页面渲染、模型文本合并。
