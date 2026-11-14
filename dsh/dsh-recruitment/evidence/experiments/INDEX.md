# evidence/experiments 机器可核验索引（E3）

> **生成时间**：2026-11-15T05:26:01+08:00
> **生成命令**：`pwsh -File work/review/e1-e4-audit/probes/scan-referenced-files.ps1` → `pwsh -File work/review/e1-e4-audit/probes/build-evidence-index.ps1`
> **扫描规则**：扫描 docs/** + dsh/dsh-recruitment/{evidence,manual,contracts}/** + 两份 README/CONTRACT 的反引号路径；在仓库根/文档同级/包根/contracts/experiments/evidence/manual/converter 等基准下 Test-Path；transcript.txt/dialogue-only.txt 内的引用按"原始转录不可改写"豁免，其余缺失必须在同一行显式标注 按设计不入库/未入库/外部包/已删除/历史引用 才允许豁免
> **判定**：`FILES_PRESENT`=引用全部存在；`REFERENCED_MISSING_BY_DESIGN`=缺失条目每条均有硬理由（同行为标注/原始转录豁免）；`REFERENCED_MISSING`=仍有未标注缺失（E3 缺陷）；`FAIL_NO_README`=无 README。

**汇总**：实验 21 个；引用 160 条；FILES_PRESENT 18 / REFERENCED_MISSING_BY_DESIGN 3 / REFERENCED_MISSING 0 / FAIL_NO_README 0。

| 实验目录 | README | 生成时间（README mtime） | 标准产物 | 引用检查 | 缺（by_design） | 缺（真缺陷） | 判定 |
|---|---|---|---|---|---|---|---|
| 2026-11-13-natural-language-autonomous-run | 有 | 2026-11-14T21:39:53+08:00 | commands.txt,transcript.txt,dialogue-only.txt,db-readback.txt | 18 | 5 | 0 | REFERENCED_MISSING_BY_DESIGN |
| 2026-11-13-web-browser-acceptance | 有 | 2026-11-14T21:42:21+08:00 |  | 3 | 0 | 0 | FILES_PRESENT |
| 2026-11-14-acceptance-gates | 有 | 2026-11-14T21:42:09+08:00 |  | 4 | 0 | 0 | FILES_PRESENT |
| 2026-11-14-candidate-get-pg | 有 | 2026-11-14T21:40:31+08:00 |  | 4 | 2 | 0 | REFERENCED_MISSING_BY_DESIGN |
| 2026-11-14-ci-rehearsal | 有 | 2026-11-14T21:42:09+08:00 | FILES.sha256 | 21 | 0 | 0 | FILES_PRESENT |
| 2026-11-14-ci-rehearsal-2 | 有 | 2026-11-14T21:40:15+08:00 |  | 57 | 3 | 0 | REFERENCED_MISSING_BY_DESIGN |
| 2026-11-14-decision-inchat-first-write | 有 | 2026-11-14T02:38:25+08:00 |  | 0 | 0 | 0 | FILES_PRESENT |
| 2026-11-14-document-read-u3 | 有 | 2026-11-14T01:52:23+08:00 |  | 3 | 0 | 0 | FILES_PRESENT |
| 2026-11-14-dsh-022-base | 有 | 2026-11-14T21:40:15+08:00 |  | 1 | 0 | 0 | FILES_PRESENT |
| 2026-11-14-dsh-022-rc3-upgrade | 有 | 2026-11-14T21:39:53+08:00 |  | 2 | 0 | 0 | FILES_PRESENT |
| 2026-11-14-feishu-live-read | 有 | 2026-11-14T20:32:07+08:00 |  | 2 | 0 | 0 | FILES_PRESENT |
| 2026-11-14-feishu-live-readback | 有 | 2026-11-14T20:59:01+08:00 | commands.txt | 0 | 0 | 0 | FILES_PRESENT |
| 2026-11-14-format-coverage | 有 | 2026-11-14T21:42:09+08:00 |  | 5 | 0 | 0 | FILES_PRESENT |
| 2026-11-14-golden-path-e2e | 有 | 2026-11-14T21:40:15+08:00 | commands.txt | 15 | 0 | 0 | FILES_PRESENT |
| 2026-11-14-golden-path-rerun | 有 | 2026-11-14T21:13:30+08:00 | commands.txt | 8 | 0 | 0 | FILES_PRESENT |
| 2026-11-14-migrations-0007-0008 | 有 | 2026-11-14T01:17:10+08:00 |  | 1 | 0 | 0 | FILES_PRESENT |
| 2026-11-14-real-intake-20 | 有 | 2026-11-14T21:40:15+08:00 |  | 1 | 0 | 0 | FILES_PRESENT |
| 2026-11-14-real-resume-gate | 有 | 2026-11-14T03:08:28+08:00 |  | 0 | 0 | 0 | FILES_PRESENT |
| 2026-11-14-screening-decision-repro | 有 | 2026-11-14T21:41:42+08:00 | FILES.sha256 | 11 | 0 | 0 | FILES_PRESENT |
| 2026-11-14-workbench-panel | 有 | 2026-11-14T21:42:09+08:00 |  | 4 | 0 | 0 | FILES_PRESENT |
| 2026-11-15-golden-path-clean | 有 | 2026-11-15T05:00:30+08:00 | commands.txt | 0 | 0 | 0 | FILES_PRESENT |

## 缺失引用的逐条明细（机器可核验）

| 实验 | 文件 | 行 | 引用 | 存在 | by_design | 理由 |
|---|---|---|---|---|---|---|
| 2026-11-13-natural-language-autonomous-run | transcript.txt | 486 | `test/live-read.mjs` | False | True | 原始会话转录（EXPERIMENTS 规范禁止改写/节选；历史材料，不是当前证据引用） |
| 2026-11-13-natural-language-autonomous-run | transcript.txt | 486 | `test/negative.mjs` | False | True | 原始会话转录（EXPERIMENTS 规范禁止改写/节选；历史材料，不是当前证据引用） |
| 2026-11-13-natural-language-autonomous-run | transcript.txt | 486 | `test/structure-wiring.mjs` | False | True | 原始会话转录（EXPERIMENTS 规范禁止改写/节选；历史材料，不是当前证据引用） |
| 2026-11-13-natural-language-autonomous-run | transcript.txt | 487 | `test/structure/run-acceptance.mjs` | False | True | 原始会话转录（EXPERIMENTS 规范禁止改写/节选；历史材料，不是当前证据引用） |
| 2026-11-13-natural-language-autonomous-run | transcript.txt | 489 | `%TEMP%\structure-accept\` | False | True | 原始会话转录（EXPERIMENTS 规范禁止改写/节选；历史材料，不是当前证据引用） |
| 2026-11-14-candidate-get-pg | README.md | 3 | `src/tools/stubs.ts` | False | True | 文档已标注：目标文件已删除（历史引用） |
| 2026-11-14-candidate-get-pg | README.md | 23 | `src/tools/stubs.ts` | False | True | 文档已标注：目标文件已删除（历史引用） |
| 2026-11-14-ci-rehearsal-2 | ci-steps.md | 23 | `converter/corpus/batch2-picked.json` | False | True | 文档已标注：按设计不入库（机器本地/含 PII/仓库外产物） |
| 2026-11-14-ci-rehearsal-2 | ci-steps.md | 23 | `recruitment-os\temp\batch2-picked.json` | False | True | 文档已标注：按设计不入库（机器本地/含 PII/仓库外产物） |
| 2026-11-14-ci-rehearsal-2 | README.md | 49 | `converter/corpus/batch2-picked.json` | False | True | 文档已标注：按设计不入库（机器本地/含 PII/仓库外产物） |
