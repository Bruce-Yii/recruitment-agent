# 全量测试里的声明式跳过（skip ≠ pass）

本文件是 `dsh/dsh-recruitment` 全量测试（`node test/run-all.mjs`）中**所有**跳过用例的
逐条清单。R3/E2 要求：`skipped > 0` 不得宣称全绿，每条 skip 必须能逐条对上这里的原因。
CI（`.github/workflows/ci.yml` 的 plugin job）按原因里的固定标记匹配；清单外的 skip
会让 CI 红。

基线口径（commit `7695243`，本机无 DB 口令、有 Python/converter）：
`tests 2148 / pass 2144 / fail 0 / skipped 4`（`node --test` unit discovery，TAP reporter）。

## 1. 真实语料回归 — 环境 opt-in（已存在的门，未改动）

- 用例：`test/regression/real-corpus.test.ts`
  → `真实语料回归：全量=门槛判定 / 抽样=开发回路（SAMPLED 不构成门槛）+ 失败逐条可归因（docs/11 §11）`
- 跳过标记：`ACCEPTED skip, not a pass`
- 门：`RECRUITMENT_CORPUS_ROOT`（真实语料原件按设计不入库，R7）。
- 如何真跑：提供语料原件目录并设置该环境变量；门槛判定还需
  `RECRUITMENT_CORPUS_SAMPLE=all`（或 `RECRUITMENT_CORPUS_GATE=1`）。
- 分类：**(b) 独立环境门**；已是显式 opt-in + 明确原因，无需改动。

## 2-3. 上传真库成功 / 幂等 — 环境 opt-in（本次从死 skip 改为可真跑）

- 用例：`test/unit/intake-upload-db.test.ts`
  → `成功落盘 + 复算 sha256 + 建任务（真库 opt-in：RECRUITMENT_DB_PASSWORD）`
  → `重复上传同一 sha256 → 复用既有 event_id / task_id（真库 opt-in）`
- 跳过标记：`真库 opt-in 未开启`
- 门：`RECRUITMENT_DB_PASSWORD` + 可连通的 PostgreSQL（复用
  `test/integration/db.ts::createIsolatedTestDatabase`，一次性空库，用完 DROP）。
- 如何真跑：按 README §1.1 配好 `ra_s6s7` 与口令后跑全量；用例内断言
  material_path 字节、独立 SQL 读回 event/task 行数、同 sha 复用 id。
- 分类：**(b) 独立环境门**；原来是不可启用的死 skip（`assert.fail('unreachable')`
  永不运行），本次改成显式 env 门 + 真断言，不削弱断言强度。

## 4. 上传 SHA256_MISMATCH — standing skip（缺 seam，恒跳过）

- 用例：`test/unit/intake-upload-db.test.ts`
  → `磁盘 sha256 与内存不一致 → SHA256_MISMATCH 且清理文件（需可注入的文件系统故障 seam）`
- 跳过标记：`STANDING SKIP`
- 原因：生产 `src/db/intake-upload.ts` 直接用 `node:fs/promises` 的 `writeFile` /
  `readFile`，测试无法在两次操作之间篡改落盘字节；没有可注入的 FS 故障 seam。
  本 lane 禁止改生产实现，因此不能把它变成真执行。
- 分类：**(b) 需要独立环境/能力门**；保持 standing skip 并逐条声明，绝不伪造 PASS。
  若要真正覆盖，需在单独的 lane 里为生产代码加 FS seam 后再启用。

## 未发生的跳过（易被误认为 skip，实测均真跑）

本机有 Python 3.12 + PyMuPDF/python-docx/Pillow 且 `converter/src/issues.py` 存在，
以下历史条件跳过分支**均未触发**：

- `test/document/readers.test.ts`（合成 fixture 生成器可用 → 24 条 S2–S26 全跑）
- `test/document/document-read-wiring.test.ts`（fixture 生成可用）
- `test/document/quality.test.ts`（`issues.py` 存在 → severity 镜像守卫全跑）
- `test/tools/resume-read-formats.test.ts`、`test/integration/*`、`test/runtime/*`
  的 `CAN_RUN_PYTHON` 门也全部真跑。
