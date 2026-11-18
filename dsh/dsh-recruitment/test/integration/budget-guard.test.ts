// task-78 / DESIGN §5 证据 C：**真 PG 一次性干净库 + 真产品工具 + 真 guard 管线**的集成证据。
//
// 为什么这个文件不是"再写一个单测"：
//   1. 库：`createIsolatedTestDatabase('budget_it')` 建 `ra_budget_it_*`，按迁移目录全量重放（现至 0017），
//      **绝不**碰共享库 `ra_s6s7`；跑完**不 drop**（留给总控用 psql 独立复核）。库名写进
//      `work/d5/product-budget/evidence/integration/integration-evidence.json`。
//   2. 写工具：直接调产品真实工具定义 `createJobCreateTool(...).execute()`（`src/tools/job-create.ts`），
//      不写假的写工具；每次调用都真提交、真写 job/job_version/rubric_version/approval 行。
//   3. 派发：模拟 DSH `tools/pre-execute` 之后的 guard 管线 —— `installBudgetGuard(fakeCtx, ...)`
//      把 guard 注册到 fake `ctx.tools.guard`，派发函数**先跑 guard**，返回 reason 即拒绝，
//      **绝不**调用 `tool.execute()`（spy 计数钉死"工具 body 从未执行"）。
//   4. 三类证据：
//      a) 放行：预算内派发一次真实写工具 → 独立 pg 连接读回 `recruitment.job` count +1；
//      b) 拒绝：SCREENING_MAX_STEPS=1（先放行 1 次再把第 2 次拒掉）→
//         理由含 `BUDGET_EXCEEDED_HANDOFF`、body 未执行、**全库逐表 delta=0**（before/after 全表计数进 JSON）；
//      c) 反证：同一工具、同一参数，不装 guard 直接派发 → 写成功 +1（证明闸门是唯一拦截者）。
//   5. 配置来源/阈值断言（profile/env/default/模板/非法回退/status_tool 默认 false）与
//      status 工具注册开关（fake tools 上记录 register 调用）。
//
// 运行（在 dsh/dsh-recruitment 目录）：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   node --test --test-concurrency=1 test/integration/budget-guard.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEMO_DEPARTMENT,
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  migrationFiles,
  testDatabaseConfig,
  uniqueSuffix,
  type IsolatedTestDatabase,
} from './db.ts'
import { createJobCreateTool } from '../../src/tools/job-create.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  BUDGET_EXCEEDED_HANDOFF,
  DEFAULT_LIMITS,
  installBudgetGuard,
  readSessionUsage,
  resolveBudgetConfig,
  type BudgetSnapshot,
} from '../../src/budget/index.ts'

// ---------------------------------------------------------------------------
//  证据落盘（每次跑都覆盖同一份 JSON：库名 + 全表 before/after + 判定摘录）
// ---------------------------------------------------------------------------

const EVIDENCE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..',
  'work', 'd5', 'product-budget', 'evidence', 'integration',
)
const EVIDENCE_FILE = join(EVIDENCE_DIR, 'integration-evidence.json')
const EVIDENCE_MD = join(EVIDENCE_DIR, 'integration-evidence.md')
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const BUDGET_SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'budget')

/** 当前 git HEAD（**只读**：读 .git/HEAD 与其指向的 ref，不跑 git 命令、不做 git 写）。 */
function gitHead(): string {
  try {
    const head = readFileSync(join(REPO_ROOT, '.git', 'HEAD'), 'utf8').trim()
    if (head.startsWith('ref: ')) {
      return readFileSync(join(REPO_ROOT, '.git', head.slice('ref: '.length).trim()), 'utf8').trim()
    }
    return head
  } catch {
    return 'unknown'
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 证据钉住代码版本：A 的 `src/budget/**` 逐文件 hash + 合并 hash（防止"跑完后又改代码"）。 */
function budgetModuleFingerprint(): { files: Record<string, string>; combined: string } {
  const files: Record<string, string> = {}
  for (const name of readdirSync(BUDGET_SRC_DIR).filter((file) => file.endsWith('.ts')).sort()) {
    files[name] = sha256(readFileSync(join(BUDGET_SRC_DIR, name), 'utf8'))
  }
  const combined = sha256(
    Object.entries(files).map(([name, hash]) => `${name}:${hash}`).join('\n'),
  )
  return { files, combined }
}

interface TableCounts {
  readonly captured_at: string
  /** `schema.table` → 精确 count(*)（用独立 pg 连接、逐表查询，不是 n_live_tup 估算）。 */
  readonly counts: Readonly<Record<string, number>>
  readonly table_count: number
  readonly schemas: Readonly<Record<string, number>>
}

interface TableDelta {
  readonly before: number | null
  readonly after: number | null
  readonly delta: number
}

/** 本次运行的证据（JSON 可序列化；测试中途每次都落盘，防中断丢证据）。 */
const EVIDENCE: Record<string, unknown> = {
  lane: 'task-78 / 子代理 C（budget-integration）',
  contract: 'work/d5/product-budget/DESIGN.md §2/§3/§5/§6',
  command: 'node --test --test-concurrency=1 test/integration/budget-guard.test.ts',
  started_at: new Date().toISOString(),
  db: null,
  tables: null,
  config: null,
  allow: null,
  deny_steps: null,
  deny_tokens: null,
  counterproof: null,
  status_tool: null,
}

function isoNow(): string {
  return new Date().toISOString()
}

function writeEvidence(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(EVIDENCE_FILE, `${JSON.stringify(EVIDENCE, null, 2)}\n`, 'utf8')
  writeFileSync(EVIDENCE_MD, renderEvidenceMarkdown(), 'utf8')
}

function renderEvidenceMarkdown(): string {
  const lines: string[] = []
  lines.push('# task-78 预算闸门 · 集成证据（子代理 C）')
  lines.push('')
  lines.push(`- 生成时间：${isoNow()}`)
  lines.push(`- 命令：\`${String(EVIDENCE.command)}\``)
  const dbinfo = EVIDENCE.db as Record<string, unknown> | null
  if (dbinfo !== null) {
    lines.push(`- 一次性干净库：\`${String(dbinfo.name)}\`（**不 drop**，供独立 psql 复核）`)
    lines.push(`- 迁移：${((dbinfo.migrations as string[]) ?? []).join(' → ')}`)
  }
  const tables = EVIDENCE.tables as { count?: number; schemas?: Record<string, number> } | null
  if (tables !== null && tables !== undefined) {
    lines.push(`- 表清单：${String(tables.count)} 张（schemas=${JSON.stringify(tables.schemas)}）`)
  }
  const code = EVIDENCE.code as { git_head?: string; budget_module_combined_sha256?: string } | null
  if (code !== null && code !== undefined) {
    lines.push(`- git HEAD：\`${String(code.git_head)}\`（只读）`)
    lines.push(`- 证据钉住代码版本：\`src/budget/**\` combined sha256 = \`${String(code.budget_module_combined_sha256)}\``)
  }
  const allow = EVIDENCE.allow as Record<string, unknown> | null
  if (allow !== null && allow !== undefined) {
    lines.push('')
    lines.push('## a) 放行 → 真实写入 +1')
    lines.push('')
    lines.push(`- 工具：\`${String(allow.tool)}\`（真实产品工具 execute）`)
    lines.push(`- 返回：outcome=${String(allow.outcome)} job_id=${String(allow.job_id)}`)
    lines.push(`- 独立 SQL：${String(allow.readback_sql)} → ${String(allow.readback_count)}`)
    lines.push(`- count delta：${JSON.stringify(allow.delta)}`)
  }
  const denySteps = EVIDENCE.deny_steps as Record<string, unknown> | null
  if (denySteps !== null && denySteps !== undefined) {
    lines.push('')
    lines.push('## b) 拒绝（SCREENING_MAX_STEPS=1 的第 2 次调用）→ 零写入')
    lines.push('')
    lines.push(`- guard 返回：${String(denySteps.verdict_json)}`)
    lines.push(
      '- 工具 body 是否执行：**spy 包裹真实产品工具 execute**（withSpy）；'
      + `被拒那次 execute 增量 = 0（tool_body_executions=${String(denySteps.tool_body_executions)} 只来自被放行的第 1 次调用）`,
    )
    lines.push(`- 全表检查：${String(denySteps.table_check_method)}`)
    lines.push(
      `- 全表 delta=0：${String(denySteps.delta_all_zero)}（${String(denySteps.table_count)} 张表，`
      + `schemas=${JSON.stringify(denySteps.schemas)}）`,
    )
  }
  const denyTokens = EVIDENCE.deny_tokens as Record<string, unknown> | null
  if (denyTokens !== null && denyTokens !== undefined) {
    lines.push('')
    lines.push('## b2) 拒绝（token 超限）→ 零写入')
    lines.push('')
    lines.push(`- guard 返回：${String(denyTokens.verdict_json)}`)
    lines.push(
      `- 工具 body 是否执行：spy 包裹真实工具 execute，execute 增量 = ${String(denyTokens.tool_body_executions)}`
      + '（0 = body 从未执行）',
    )
    lines.push(`- 全表 delta=0：${String(denyTokens.delta_all_zero)}`)
  }
  const counter = EVIDENCE.counterproof as Record<string, unknown> | null
  if (counter !== null && counter !== undefined) {
    lines.push('')
    lines.push('## c) 反证 → 同一调用/同一参数不装 guard 直接写成功')
    lines.push('')
    lines.push(`- 同一参数：${String(counter.same_args_as_denied)}`)
    lines.push(`- guards 数量：${String(counter.guard_count)}；工具 body 执行：${String(counter.tool_body_executions)}`)
    lines.push(`- count delta：${JSON.stringify(counter.delta)}`)
  }
  const status = EVIDENCE.status_tool as {
    config_off?: Record<string, unknown>
    config_on?: Record<string, unknown>
  } | null
  if (status !== null && status !== undefined) {
    const off = status.config_off ?? {}
    const on = status.config_on ?? {}
    lines.push('')
    lines.push('## e) status 工具注册开关')
    lines.push('')
    lines.push(
      `- status_tool=false：guard=${String(off.guard_count)}，`
      + `注册工具=${JSON.stringify(off.registered)}（为空 = 不注册，D-128.2 工具数=30）`,
    )
    lines.push(
      `- status_tool=true：guard=${String(on.guard_count)}，`
      + `注册工具=${JSON.stringify(on.registered)}`,
    )
  }
  const enabled = EVIDENCE.enabled as {
    config_default?: unknown
    enabled_false?: Record<string, unknown>
    enabled_true_control?: Record<string, unknown>
  } | null
  if (enabled !== null && enabled !== undefined) {
    const off = enabled.enabled_false ?? {}
    lines.push('')
    lines.push('## f) `budget.enabled` 总开关（lead 2026-11-16 裁决）')
    lines.push('')
    lines.push(`- 默认：enabled=${String(enabled.config_default)}（sources.ENABLED=default）`)
    lines.push(
      `- enabled=false：config.enabled=${String(off.config_enabled)}，`
      + `guard=${String(off.guard_count)}，注册工具=${JSON.stringify(off.registered)}，`
      + `dispose 幂等=${String(off.dispose_idempotent)}`,
    )
    lines.push('- enabled 非布尔（"maybe"）：issue + 回退 true（见 integration-evidence.json 的 config.enabled.invalid）')
  }
  lines.push('')
  lines.push('## 最终四数（命令原文）')
  lines.push('')
  lines.push('```powershell')
  lines.push("$env:RECRUITMENT_DB_PASSWORD='123456'")
  lines.push('cd dsh/dsh-recruitment')
  lines.push('node --test --test-concurrency=1 test/integration/budget-guard.test.ts')
  lines.push('```')
  lines.push('')
  lines.push(
    '本文件由测试进程内生成；同目录 `test-run.txt` 是**同一次运行**的完整原始输出（含 `# tests / # pass / # fail / # skipped`）。'
    + '库里的提交行在测试进程结束后由 `psql-readback.txt` 的独立 psql 读回复核。',
  )
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
//  一次性干净库（不 drop；独立 readback 连接不 import 产品 DB 层）
// ---------------------------------------------------------------------------

let db: IsolatedTestDatabase
let readback: pg.Client
let cfg: ResolvedDatabaseConfig
const SESSION_PREFIX = `budget-it-${process.pid.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`

function isolatedConfig(): ResolvedDatabaseConfig {
  return { ...cfg, database: db.name }
}

function sessionIdFor(label: string): string {
  return `${SESSION_PREFIX}-${label}`
}

/** 枚举所有用户表（**不是**只查 public：本产品业务表在 `recruitment` schema）。 */
async function listTables(client: pg.Client): Promise<{ schema: string; table: string }[]> {
  const result = await client.query<{ schemaname: string; tablename: string }>(
    `select schemaname, tablename
       from pg_tables
      where schemaname not in ('pg_catalog', 'information_schema')
        and schemaname not like 'pg\\_%'
      order by schemaname, tablename`,
  )
  return result.rows.map((row) => ({ schema: row.schemaname, table: row.tablename }))
}

/** 全表精确 count(*) 快照（逐表 `count(*)`，同一独立连接，自动提交读已提交）。 */
async function snapshotTableCounts(client: pg.Client): Promise<TableCounts> {
  const tables = await listTables(client)
  const counts: Record<string, number> = {}
  const schemas: Record<string, number> = {}
  for (const table of tables) {
    const key = `${table.schema}.${table.table}`
    const result = await client.query<{ c: string }>(
      `select count(*)::text as c from "${table.schema}"."${table.table}"`,
    )
    counts[key] = Number(result.rows[0]?.c ?? '0')
    schemas[table.schema] = (schemas[table.schema] ?? 0) + 1
  }
  return { captured_at: isoNow(), counts, table_count: tables.length, schemas }
}

/** before/after 逐表 diff（只列变化的表；delta=0 时返回空对象）。 */
function tableDelta(before: TableCounts, after: TableCounts): Record<string, TableDelta> {
  const keys = new Set<string>([...Object.keys(before.counts), ...Object.keys(after.counts)])
  const changed: Record<string, TableDelta> = {}
  for (const key of [...keys].sort()) {
    const b = before.counts[key]
    const a = after.counts[key]
    if (a === undefined || b === undefined || a !== b) {
      changed[key] = {
        before: b ?? null,
        after: a ?? null,
        delta: (a ?? 0) - (b ?? 0),
      }
    }
  }
  return changed
}

// ---------------------------------------------------------------------------
//  fake DSH 上下文：只满足 budget 模块真正需要的面
//   - tools.guard(fn) / tools.register(tool)  → 记录 guard / 已注册工具
//   - sessionProjections.stateOf(session,'tokenUsage') → fixture 的真实四桶 + last.step
//   - 可选 tokenMeter.measure（本文件主路径用投影；兜底路径由 A 的单测覆盖）
// ---------------------------------------------------------------------------

interface UsageFixture {
  /** 四桶合计（全部记在 uncachedInputTokens，其余桶 0；total = 四桶之和）。 */
  readonly total: number
  readonly dshStep?: number | null
}

type GuardFn = (exec: unknown) => unknown

interface FakeDsh {
  readonly ctx: Record<string, unknown>
  readonly guards: GuardFn[]
  readonly registered: ToolLike[]
  readonly disposeCalls: number[]
  /** stateOf 被调用次数（证明 guard 真的读了真实 usage 面，而不是自己造数）。 */
  usageReads: number
}

interface ToolLike {
  readonly name: string
  execute(args: unknown, exec: unknown): Promise<unknown>
}

function createFakeDsh(usage: UsageFixture): FakeDsh {
  const guards: GuardFn[] = []
  const registered: ToolLike[] = []
  const disposeCalls: number[] = []
  const fake: FakeDsh = {
    ctx: {},
    guards,
    registered,
    disposeCalls,
    usageReads: 0,
  }
  const ctx: Record<string, unknown> = {
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    // 只读 DSH 服务面：tokenUsage 投影（DESIGN §1 / §3.3 的 primary 路径）
    sessionProjections: {
      stateOf(_session: unknown, name: string): unknown {
        if (name !== 'tokenUsage') return undefined
        fake.usageReads += 1
        return {
          totals: {
            uncachedInputTokens: usage.total,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          last: usage.dshStep === undefined || usage.dshStep === null
            ? null
            : { turn: 1, step: usage.dshStep, buckets: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        }
      },
    },
    tools: {
      guard(fn: GuardFn): () => void {
        guards.push(fn)
        return () => {
          disposeCalls.push(1)
          const index = guards.indexOf(fn)
          if (index >= 0) guards.splice(index, 1)
        }
      },
      register(tool: ToolLike): () => void {
        registered.push(tool)
        return () => {
          disposeCalls.push(1)
          const index = registered.indexOf(tool)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    effect(): () => void {
      return () => {
        disposeCalls.push(1)
      }
    },
  }
  ;(fake as { ctx: Record<string, unknown> }).ctx = ctx
  return fake
}

/** 包一层 spy：只有派发真的走到工具 body，calls.count 才 +1。 */
function withSpy(tool: ToolLike): { tool: ToolLike; calls: { count: number } } {
  const calls = { count: 0 }
  const spied: ToolLike = {
    name: tool.name,
    async execute(args: unknown, exec: unknown): Promise<unknown> {
      calls.count += 1
      return await tool.execute(args, exec)
    },
  }
  return { tool: spied, calls }
}

interface NormalizedDenied {
  readonly raw: unknown
  readonly reason: string
  readonly info: { readonly name?: string; readonly code?: string } | undefined
}

interface DispatchOutcome {
  readonly denied: NormalizedDenied | undefined
  readonly executed: boolean
  readonly result: unknown
  readonly error: unknown
}

function normalizeVerdict(verdict: unknown): NormalizedDenied {
  if (typeof verdict === 'string') return { raw: verdict, reason: verdict, info: undefined }
  if (verdict !== null && typeof verdict === 'object') {
    const record = verdict as Record<string, unknown>
    const info = record.info !== null && typeof record.info === 'object'
      ? (record.info as Record<string, unknown>)
      : undefined
    return {
      raw: verdict,
      reason: typeof record.reason === 'string' ? record.reason : JSON.stringify(verdict),
      info: info === undefined
        ? undefined
        : {
          ...(typeof info.name === 'string' ? { name: info.name } : {}),
          ...(typeof info.code === 'string' ? { code: info.code } : {}),
        },
    }
  }
  return { raw: verdict, reason: String(verdict), info: undefined }
}

/** 模拟 DSH 派发：**先跑全部 guard**；任何 guard 返回 reason → 拒绝且**不执行 body**。 */
async function dispatchTool(fake: FakeDsh, tool: ToolLike, args: unknown, sessionId: string): Promise<DispatchOutcome> {
  const exec = {
    name: tool.name,
    agent: { id: 'agent-budget-it', session: { id: sessionId } },
  }
  for (const guard of fake.guards) {
    const verdict = guard(exec)
    if (verdict) {
      return { denied: normalizeVerdict(verdict), executed: false, result: undefined, error: undefined }
    }
  }
  try {
    const result = await tool.execute(args, exec)
    return { denied: undefined, executed: true, result, error: undefined }
  } catch (error) {
    return { denied: undefined, executed: true, result: undefined, error }
  }
}

// ---------------------------------------------------------------------------
//  真实写工具参数（与 `test/integration/job-create.test.ts` 的合法夹具同形）
// ---------------------------------------------------------------------------

/** 1..50 条标准，权重和必须 = 1；两条机械型 MUST_HAVE。 */
const CRITERIA = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 0.5, field: 'work_experience', operator: 'EXISTS', value: true },
  { key: 'months_gte36', label: '至少 36 个月', kind: 'MUST_HAVE', weight: 0.5, field: 'timeline.covered_months_closed', operator: 'GTE', value: 36 },
]

let jobSeq = 0

/** 每次调用都用唯一 code（`uq_job_code`），保证"同一参数再调一次"也是合法新写入。 */
function jobArgs(tag: string): Record<string, unknown> {
  jobSeq += 1
  const code = `IT-${tag}-${jobSeq}-${uniqueSuffix().slice(-6)}`.toUpperCase()
  return {
    title: `预算闸门集成岗位 ${tag} ${jobSeq}`,
    code,
    department_id: DEMO_DEPARTMENT,
    description_md: `预算闸门集成测试 JD ${tag} ${jobSeq}`,
    criteria: CRITERIA,
  }
}

/** 从工具输出里取 job id（输出形状 = job-create 的规范输出值）。 */
function jobIdOf(value: unknown): string {
  const record = value as { job?: { id?: unknown } } | null
  const id = record?.job?.id
  if (typeof id !== 'string') throw new Error(`tool result has no job.id: ${JSON.stringify(value).slice(0, 200)}`)
  return id
}

/** 独立 SQL 读回：该 job id 在 `recruitment.job` 里的行数（不经过产品代码）。 */
async function countJobRow(jobId: string): Promise<number> {
  const result = await readback.query<{ c: string }>(
    'select count(*)::text as c from recruitment.job where id = $1',
    [jobId],
  )
  return Number(result.rows[0]?.c ?? '0')
}

function countOf(snapshot: TableCounts, table: string): number {
  const value = snapshot.counts[table]
  if (value === undefined) throw new Error(`table not in snapshot: ${table}`)
  return value
}

/**
 * 读 `enabled` 键（lead 2026-11-16 新增裁决：`budget.enabled` 默认 true）。
 * 用可选字段访问而不是直接 `.enabled`：在 A 落盘该键之前，本文件也不应因类型而失败。
 */
function enabledOf(config: unknown): boolean | undefined {
  if (config === null || typeof config !== 'object') return undefined
  return (config as { readonly enabled?: boolean }).enabled
}

/** 让 A 的实现缺位时错误信息好读：明确说"gate 未生效"，而不是等到 count 断言。 */
function assertionsForDeny(outcome: DispatchOutcome): NormalizedDenied {
  assert.notEqual(outcome.denied, undefined, 'expected guard to deny, but dispatch executed the tool')
  assert.equal(outcome.executed, false, 'denied call must NEVER execute the tool body')
  return outcome.denied as NormalizedDenied
}

// ---------------------------------------------------------------------------
//  0) bootstrap：一次性干净库 + 全量迁移 + 表清单
// ---------------------------------------------------------------------------

test('bootstrap: isolated clean DB (ra_budget_it_*) with all migrations from the directory, never shared', async () => {
  // 真值来源 = 迁移目录本身；不写死 "16" / "0016"，下次加迁移自动跟随。
  const onDisk = migrationFiles()
  const migrations = [...db.migrations]
  assert.deepEqual(migrations, [...onDisk], '重放清单必须与目录里的迁移文件逐项一致')
  assert.equal(migrations.length, onDisk.length, `expected ${onDisk.length} migrations, got ${migrations.length}`)
  assert.equal(migrations[0], '0001_init.sql')
  const lastFile = onDisk[onDisk.length - 1] ?? ''
  assert.equal(migrations[migrations.length - 1], lastFile)
  assert.ok(lastFile >= '0017_criterion_override.sql', `latest migration regressed: ${lastFile}`)
  // 台账必须与目录同步（防止"表建了、台账漏记"——0017 真库曾暴露过这一缺陷）。
  const ledger = await readback.query<{ n: string; latest: string }>(
    'select count(*)::text as n, max(version) as latest from recruitment.schema_migration',
  )
  assert.equal(ledger.rows[0]?.n, String(onDisk.length), 'schema_migration 条数必须 = 迁移文件数')
  assert.equal(ledger.rows[0]?.latest, lastFile.replace(/\.sql$/, ''), '台账末条必须 = 最后一个迁移文件')
  assertPrivateDatabase(db.name) // 不是共享 ra_s6s7
  assert.ok(db.name.startsWith('ra_budget_it_'), `unexpected db name: ${db.name}`)

  const tables = await listTables(readback)
  const schemas: Record<string, number> = {}
  for (const table of tables) schemas[table.schema] = (schemas[table.schema] ?? 0) + 1
  assert.ok(tables.length >= 60, `expected >= 60 user tables, got ${tables.length}`)
  assert.ok((schemas.recruitment ?? 0) >= 60, `expected >= 60 tables in recruitment schema, got ${schemas.recruitment}`)
  // 关键表必须在（否则"零写入"断言会是空洞的 0）
  const names = new Set(tables.map((table) => `${table.schema}.${table.table}`))
  for (const table of ['recruitment.job', 'recruitment.job_version', 'recruitment.rubric_version', 'recruitment.approval', 'recruitment.event_inbox']) {
    assert.ok(names.has(table), `missing table ${table}`)
  }

  EVIDENCE.db = {
    name: db.name,
    migrations,
    created_at: new Date().toISOString(),
    note: `一次性干净库，按迁移目录全量重放（${onDisk.length} 条，末条 ${lastFile}）；本文件**不 drop**，留给总控用 psql 独立读回`,
  }
  EVIDENCE.tables = {
    count: tables.length,
    schemas,
    names: [...names].sort(),
  }
  const fingerprint = budgetModuleFingerprint()
  EVIDENCE.code = {
    git_head: gitHead(),
    budget_module_files: fingerprint.files,
    budget_module_combined_sha256: fingerprint.combined,
    test_file_sha256: sha256(readFileSync(fileURLToPath(import.meta.url), 'utf8')),
  }
  writeEvidence()
})

// ---------------------------------------------------------------------------
//  a) 配置来源 / 阈值 / 非法回退 / status_tool 默认 false
// ---------------------------------------------------------------------------

test('config: defaults · profile · env · ${ENV} template · invalid fallback · status_tool default false', () => {
  // ① 默认值 + 来源
  const defaults = resolveBudgetConfig({}, {})
  assert.deepEqual(defaults.limits, DEFAULT_LIMITS)
  assert.equal(defaults.limits.DECISION.max_tokens, 200000)
  assert.equal(defaults.limits.DECISION.max_steps, 25)
  assert.equal(defaults.limits.SCREENING.max_tokens, 100000)
  assert.equal(defaults.limits.SCREENING.max_steps, 15)
  for (const key of ['DECISION_MAX_TOKENS', 'DECISION_MAX_STEPS', 'SCREENING_MAX_TOKENS', 'SCREENING_MAX_STEPS']) {
    assert.equal(defaults.sources[key], 'default', `${key} source`)
  }
  assert.equal(defaults.task_class, 'AUTO')
  assert.equal(defaults.default_class, 'SCREENING')
  assert.equal(defaults.status_tool, false, 'status_tool 默认必须 false（D-128.2 工具数=30）')
  assert.equal(defaults.handoff_owner, null)
  assert.deepEqual(defaults.issues, [])
  assert.equal(defaults.tool_class_map.record_human_decision, 'DECISION')
  assert.equal(defaults.tool_class_map.recruitment_screening_evaluate, 'SCREENING')

  // ② profile 显式值 → sources=profile；tool_class_map 是 merge 不是替换
  const profile = resolveBudgetConfig({
    DECISION_MAX_TOKENS: 250000,
    DECISION_MAX_STEPS: 30,
    SCREENING_MAX_TOKENS: 120000,
    SCREENING_MAX_STEPS: 16,
    task_class: 'DECISION',
    default_class: 'DECISION',
    status_tool: true,
    handoff: { owner: 'HR 负责人' },
    tool_class_map: { recruitment_job_create: 'DECISION' },
  }, {})
  assert.deepEqual(profile.limits, {
    DECISION: { max_tokens: 250000, max_steps: 30 },
    SCREENING: { max_tokens: 120000, max_steps: 16 },
  })
  for (const key of ['DECISION_MAX_TOKENS', 'DECISION_MAX_STEPS', 'SCREENING_MAX_TOKENS', 'SCREENING_MAX_STEPS']) {
    assert.equal(profile.sources[key], 'profile', `${key} source`)
  }
  assert.equal(profile.task_class, 'DECISION')
  assert.equal(profile.default_class, 'DECISION')
  assert.equal(profile.status_tool, true)
  assert.equal(profile.handoff_owner, 'HR 负责人')
  assert.equal(profile.tool_class_map.recruitment_job_create, 'DECISION')
  assert.equal(profile.tool_class_map.record_human_decision, 'DECISION', '覆盖是 merge，默认映射仍在')
  assert.deepEqual(profile.issues, [])

  // ③ env 注入（无 profile 值）→ sources=env
  const fromEnv = resolveBudgetConfig({}, {
    RECRUITMENT_BUDGET_SCREENING_MAX_STEPS: '1',
    RECRUITMENT_BUDGET_SCREENING_MAX_TOKENS: '777',
    RECRUITMENT_BUDGET_DECISION_MAX_STEPS: '9',
  })
  assert.equal(fromEnv.limits.SCREENING.max_steps, 1)
  assert.equal(fromEnv.limits.SCREENING.max_tokens, 777)
  assert.equal(fromEnv.limits.DECISION.max_steps, 9)
  assert.equal(fromEnv.sources.SCREENING_MAX_STEPS, 'env')
  assert.equal(fromEnv.sources.SCREENING_MAX_TOKENS, 'env')
  assert.equal(fromEnv.sources.DECISION_MAX_STEPS, 'env')
  assert.equal(fromEnv.sources.DECISION_MAX_TOKENS, 'default')
  assert.deepEqual(fromEnv.issues, [])

  // ④ `${ENV_NAME}` 模板 → 按 profile 显式值处理（sources=profile）
  const template = resolveBudgetConfig({ DECISION_MAX_STEPS: '${IT_DECISION_STEPS}' }, { IT_DECISION_STEPS: '7' })
  assert.equal(template.limits.DECISION.max_steps, 7)
  assert.equal(template.sources.DECISION_MAX_STEPS, 'profile')
  assert.deepEqual(template.issues, [])

  // ⑤ 非法值：负数 / 0 / 非数字 / NaN / 未定义模板 → issue + 回退默认 + sources=default
  const invalid = resolveBudgetConfig({
    SCREENING_MAX_STEPS: 0,
    DECISION_MAX_TOKENS: -5,
    SCREENING_MAX_TOKENS: 'abc',
    DECISION_MAX_STEPS: '${NOT_DEFINED_IT_VAR}',
  }, { RECRUITMENT_BUDGET_SCREENING_MAX_TOKENS: 'Infinity' })
  assert.equal(invalid.limits.SCREENING.max_steps, 15, '0 非法 → 回退默认')
  assert.equal(invalid.limits.DECISION.max_tokens, 200000, '负数非法 → 回退默认')
  assert.equal(invalid.limits.SCREENING.max_tokens, 100000, '非数字（且 env Infinity）→ 回退默认')
  assert.equal(invalid.limits.DECISION.max_steps, 25, '未定义模板变量 → 回退默认')
  for (const key of ['SCREENING_MAX_STEPS', 'DECISION_MAX_TOKENS', 'SCREENING_MAX_TOKENS', 'DECISION_MAX_STEPS']) {
    assert.equal(invalid.sources[key], 'default', `${key} source after invalid`)
  }
  assert.ok(invalid.issues.length >= 4, `expected >= 4 issues, got ${invalid.issues.length}`)
  for (const issue of invalid.issues) {
    assert.equal(typeof issue.key, 'string')
    assert.equal(typeof issue.message, 'string')
  }

  // ⑥ 未知 task_class → issue + AUTO
  const unknown = resolveBudgetConfig({ task_class: 'HIRING' }, {})
  assert.equal(unknown.task_class, 'AUTO')
  assert.ok(unknown.issues.some((issue) => issue.key === 'TASK_CLASS'))

  // ⑦ enabled（lead 2026-11-16 裁决）：默认 true；显式 false；非布尔 → issue + 回退 true
  const enabledDefault = resolveBudgetConfig({}, {})
  assert.equal(enabledOf(enabledDefault), true, 'enabled 默认必须 true')
  assert.equal(enabledDefault.sources.ENABLED, 'default')
  const enabledOff = resolveBudgetConfig({ enabled: false }, {})
  assert.equal(enabledOf(enabledOff), false)
  assert.equal(enabledOff.sources.ENABLED, 'profile')
  assert.deepEqual(enabledOff.issues, [], '显式 false 是合法值，不得产生 issue')
  const enabledBad = resolveBudgetConfig({ enabled: 'maybe' }, {})
  assert.equal(enabledOf(enabledBad), true, '非布尔 → 回退 true')
  assert.ok(enabledBad.issues.some((issue) => issue.key === 'ENABLED'), '非布尔必须留 issue')
  assert.equal(enabledBad.sources.ENABLED, 'default')

  EVIDENCE.config = {
    defaults: {
      limits: defaults.limits,
      task_class: defaults.task_class,
      default_class: defaults.default_class,
      status_tool: defaults.status_tool,
      sources: defaults.sources,
      issues: defaults.issues,
    },
    profile: {
      limits: profile.limits,
      sources: profile.sources,
      task_class: profile.task_class,
      default_class: profile.default_class,
      status_tool: profile.status_tool,
      handoff_owner: profile.handoff_owner,
      tool_class_map_job_create: profile.tool_class_map.recruitment_job_create,
    },
    env: { limits: fromEnv.limits, sources: fromEnv.sources },
    template: { limits: template.limits, sources: template.sources },
    invalid: { limits: invalid.limits, sources: invalid.sources, issues: invalid.issues },
    unknown_task_class: { task_class: unknown.task_class, issues: unknown.issues },
    enabled: {
      default: enabledOf(enabledDefault),
      default_source: enabledDefault.sources.ENABLED,
      profile_false: {
        enabled: enabledOf(enabledOff),
        sources: enabledOff.sources,
        issues: enabledOff.issues,
      },
      invalid: {
        enabled: enabledOf(enabledBad),
        sources: enabledBad.sources,
        issues: enabledBad.issues,
      },
    },
  }
  writeEvidence()
})

// ---------------------------------------------------------------------------
//  b) 放行：预算内派发真实写工具 → 独立 SQL 读回 recruitment.job +1
// ---------------------------------------------------------------------------

test('allow: within budget dispatch of real recruitment_job_create → recruitment.job count +1', async () => {
  const tool = createJobCreateTool(isolatedConfig())
  const { tool: spied, calls } = withSpy(tool)
  const fake = createFakeDsh({ total: 1500, dshStep: 3 })
  const installed = installBudgetGuard(fake.ctx, {}, {})
  assert.equal(fake.guards.length, 1, 'installBudgetGuard 必须注册 1 个 guard')
  assert.equal(installed.config.status_tool, false)

  const sessionId = sessionIdFor('allow')
  const args = jobArgs('ALLOW')
  const before = await snapshotTableCounts(readback)
  const outcome = await dispatchTool(fake, spied, args, sessionId)
  const after = await snapshotTableCounts(readback)

  assert.equal(outcome.denied, undefined, `unexpected deny: ${JSON.stringify(outcome.denied)}`)
  assert.equal(outcome.error, undefined, 'tool must not throw')
  assert.equal(calls.count, 1, 'tool body must execute exactly once')
  assert.equal(installed.config.sources.SCREENING_MAX_STEPS, 'default', '默认配置来源必须是 default')
  assert.equal(installed.config.limits.SCREENING.max_steps, 15)
  const jobId = jobIdOf(outcome.result)
  const delta = tableDelta(before, after)
  assert.equal(delta['recruitment.job']?.delta, 1, `recruitment.job must be +1: ${JSON.stringify(delta)}`)

  const readbackCount = await countJobRow(jobId)
  assert.equal(readbackCount, 1, 'independent SQL readback must see the committed job row')

  // 闸门真实读了 tokenUsage 投影（不是自己造数）：usage_source 必须如实标注
  const usage = readSessionUsage(fake.ctx, { id: sessionId })
  const snapshot: BudgetSnapshot = installed.tracker.snapshot(sessionId, usage)
  assert.equal(snapshot.tokens.total, 1500)
  assert.equal(snapshot.steps, 1)
  assert.equal(snapshot.within, true)
  assert.equal(snapshot.usage_source, 'session_projection.tokenUsage')
  assert.equal(snapshot.task_class, 'SCREENING')
  assert.equal(snapshot.dsh_step, 3)
  assert.ok(fake.usageReads >= 1, 'guard must read the real tokenUsage projection')

  EVIDENCE.allow = {
    tool: tool.name,
    session_id: sessionId,
    outcome: (outcome.result as Record<string, unknown> | null)?.outcome ?? null,
    job_id: jobId,
    job_code: args.code,
    readback_sql: 'select count(*) from recruitment.job where id = $1',
    readback_count: readbackCount,
    before: { 'recruitment.job': countOf(before, 'recruitment.job') },
    after: { 'recruitment.job': countOf(after, 'recruitment.job') },
    delta,
    snapshot: { ...snapshot, limits: snapshot.limits, tokens: snapshot.tokens },
    config: {
      limits: installed.config.limits,
      sources: installed.config.sources,
      status_tool: installed.config.status_tool,
    },
    guard_count: fake.guards.length,
    usage_reads: fake.usageReads,
    table_count: before.table_count,
  }
  writeEvidence()
})

// ---------------------------------------------------------------------------
//  c) 拒绝（步数）：SCREENING_MAX_STEPS=1，先放行 1 次，第 2 次被 deny
//     → 理由含 BUDGET_EXCEEDED_HANDOFF；body 从未执行；**全库逐表 delta=0**
// ---------------------------------------------------------------------------

let deniedCall: { args: Record<string, unknown>; sessionId: string; toolName: string } | null = null

test('deny(steps): SCREENING max_steps=1 → 2nd real write call denied, tool body never executed, ALL tables delta=0', async () => {
  const tool = createJobCreateTool(isolatedConfig())
  const { tool: spied, calls } = withSpy(tool)
  const fake = createFakeDsh({ total: 1500, dshStep: 3 })
  const installed = installBudgetGuard(fake.ctx, {}, { RECRUITMENT_BUDGET_SCREENING_MAX_STEPS: '1' })
  assert.equal(installed.config.limits.SCREENING.max_steps, 1)
  assert.equal(installed.config.limits.SCREENING.max_tokens, 100000, '其余维度仍取默认')
  assert.equal(installed.config.sources.SCREENING_MAX_STEPS, 'env', '极小阈值来自 env 注入')
  assert.equal(installed.config.sources.SCREENING_MAX_TOKENS, 'default')
  assert.equal(fake.guards.length, 1, 'guard must be registered')

  const sessionId = sessionIdFor('deny-steps')
  // 第 1 次：计入后 steps=1 ≤ max_steps=1 → 放行（真实写入 1 次）
  const firstArgs = jobArgs('STEP1')
  const first = await dispatchTool(fake, spied, firstArgs, sessionId)
  assert.equal(first.denied, undefined, `1st call must be allowed: ${JSON.stringify(first.denied)}`)
  assert.equal(calls.count, 1)
  const firstJobId = jobIdOf(first.result)
  assert.equal(await countJobRow(firstJobId), 1)

  // 第 2 次：同一工具、同会话；计入后 steps=2 > 1 → 拒绝，body 不执行
  const secondArgs = jobArgs('STEP2')
  const beforeDeny = await snapshotTableCounts(readback)
  const denied = await dispatchTool(fake, spied, secondArgs, sessionId)
  const afterDeny = await snapshotTableCounts(readback)
  const verdict = assertionsForDeny(denied)

  assert.equal(calls.count, 1, 'denied call must NEVER execute the tool body (spy still 1)')
  assert.ok(verdict.reason.includes(BUDGET_EXCEEDED_HANDOFF),
    `reason must contain ${BUDGET_EXCEEDED_HANDOFF}: ${verdict.reason.slice(0, 400)}`)
  if (verdict.info !== undefined) {
    assert.equal(verdict.info.name, BUDGET_EXCEEDED_HANDOFF, 'info.name is the structured error identity')
  }

  // 逐表 delta=0：枚举 pg_tables 全部用户表（本产品 = recruitment schema，不是 public）
  const delta = tableDelta(beforeDeny, afterDeny)
  assert.deepEqual(delta, {}, `denied call must write NOTHING, got changes: ${JSON.stringify(delta)}`)

  // 被拒的写参数确实可以在无 guard 时写成功（反证用例复用），这里先钉住参数没被消耗
  deniedCall = { args: { ...secondArgs }, sessionId, toolName: tool.name }
  const usageAfterDeny = readSessionUsage(fake.ctx, { id: sessionId })
  const snapshotAfterDeny = installed.tracker.snapshot(sessionId, usageAfterDeny)
  assert.equal(snapshotAfterDeny.steps, 2, '计步语义：第 2 次调用被拒但 steps 已计（第 N+1 步不放行）')
  assert.equal(snapshotAfterDeny.within, false)
  EVIDENCE.deny_steps = {
    tool: tool.name,
    session_id: sessionId,
    limit: installed.config.limits.SCREENING.max_steps,
    limit_tokens: installed.config.limits.SCREENING.max_tokens,
    config: { limits: installed.config.limits, sources: installed.config.sources },
    first_call: { allowed: true, job_id: firstJobId, job_code: firstArgs.code },
    denied_call: { job_code: secondArgs.code, executed_tool_body: false },
    tool_body_executions: calls.count,
    guard_count: fake.guards.length,
    verdict_json: JSON.stringify(verdict.raw),
    reason: verdict.reason,
    info: verdict.info ?? null,
    snapshot_after_deny: {
      steps: snapshotAfterDeny.steps,
      within: snapshotAfterDeny.within,
      over: snapshotAfterDeny.over,
      task_class: snapshotAfterDeny.task_class,
      usage_source: snapshotAfterDeny.usage_source,
    },
    table_check_method: 'pg_tables (all non-system schemas, i.e. recruitment) → per-table count(*) via independent pg client; before vs after denied dispatch',
    table_count: beforeDeny.table_count,
    schemas: beforeDeny.schemas,
    delta_all_zero: Object.keys(delta).length === 0,
    diff: delta,
    before: beforeDeny.counts,
    after: afterDeny.counts,
    usage_reads: fake.usageReads,
  }
  writeEvidence()
})

// ---------------------------------------------------------------------------
//  b2) 拒绝（token）：默认 SCREENING max_tokens=100000，usage 100001 → 第 1 次即拒
// ---------------------------------------------------------------------------

test('deny(tokens): usage 100001 > SCREENING max_tokens 100000 → call denied, body never executed, ALL tables delta=0', async () => {
  const tool = createJobCreateTool(isolatedConfig())
  const { tool: spied, calls } = withSpy(tool)
  const fake = createFakeDsh({ total: 100001, dshStep: 10 })
  const installed = installBudgetGuard(fake.ctx, {}, {})
  assert.equal(fake.guards.length, 1)

  const sessionId = sessionIdFor('deny-tokens')
  const args = jobArgs('TOKEN')
  const before = await snapshotTableCounts(readback)
  const denied = await dispatchTool(fake, spied, args, sessionId)
  const after = await snapshotTableCounts(readback)
  const verdict = assertionsForDeny(denied)

  assert.equal(calls.count, 0, 'denied call must NEVER execute the tool body')
  assert.ok(verdict.reason.includes(BUDGET_EXCEEDED_HANDOFF), 'reason must carry the handoff literal')
  const delta = tableDelta(before, after)
  assert.deepEqual(delta, {}, `token-over call must write NOTHING: ${JSON.stringify(delta)}`)

  const usage = readSessionUsage(fake.ctx, { id: sessionId })
  const snapshot = installed.tracker.snapshot(sessionId, usage)
  assert.equal(snapshot.within, false)
  assert.equal(snapshot.steps, 0, 'denied call must not consume a step')
  assert.ok(snapshot.over.some((item) => item.dimension === 'tokens'), 'over must name tokens')

  EVIDENCE.deny_tokens = {
    tool: tool.name,
    session_id: sessionId,
    usage_total: 100001,
    limit_tokens: installed.config.limits.SCREENING.max_tokens,
    config: { limits: installed.config.limits, sources: installed.config.sources },
    guard_count: fake.guards.length,
    verdict_json: JSON.stringify(verdict.raw),
    reason: verdict.reason,
    info: verdict.info ?? null,
    tool_body_executions: calls.count,
    delta_all_zero: Object.keys(delta).length === 0,
    diff: delta,
    before: before.counts,
    after: after.counts,
    snapshot: { within: snapshot.within, over: snapshot.over, steps: snapshot.steps, tokens: snapshot.tokens },
  }
  writeEvidence()
})

// ---------------------------------------------------------------------------
//  d) 反证：同一工具、同一参数，**不装 guard** 直接派发 → 写成功 +1
// ---------------------------------------------------------------------------

test('counterproof: same denied call/args WITHOUT guard executes and writes +1 (guard is the only blocker)', async () => {
  assert.notEqual(deniedCall, null, 'deny(steps) case must have run first')
  const same = deniedCall as { args: Record<string, unknown>; sessionId: string; toolName: string }

  const tool = createJobCreateTool(isolatedConfig())
  assert.equal(tool.name, same.toolName, 'counterproof must use the SAME product tool')
  const { tool: spied, calls } = withSpy(tool)
  // 不装 guard：新建 fake ctx 后**不调用** installBudgetGuard
  const fake = createFakeDsh({ total: 1500, dshStep: 3 })
  assert.equal(fake.guards.length, 0, 'counterproof runs with ZERO guards installed')

  const before = await snapshotTableCounts(readback)
  const outcome = await dispatchTool(fake, spied, same.args, same.sessionId)
  const after = await snapshotTableCounts(readback)

  assert.equal(outcome.denied, undefined)
  assert.equal(outcome.error, undefined, 'tool must not throw without the guard')
  assert.equal(calls.count, 1, 'without guard the tool body executes')
  const jobId = jobIdOf(outcome.result)
  const delta = tableDelta(before, after)
  assert.equal(delta['recruitment.job']?.delta, 1, `counterproof must write +1 job: ${JSON.stringify(delta)}`)
  assert.equal(await countJobRow(jobId), 1)

  EVIDENCE.counterproof = {
    tool: tool.name,
    session_id: same.sessionId,
    same_args_as_denied: JSON.stringify(same.args) === JSON.stringify(deniedCall?.args),
    job_code: same.args.code,
    guard_count: fake.guards.length,
    tool_body_executions: calls.count,
    readback_sql: 'select count(*) from recruitment.job where id = $1',
    readback_count: await countJobRow(jobId),
    delta,
    before: { 'recruitment.job': countOf(before, 'recruitment.job') },
    after: { 'recruitment.job': countOf(after, 'recruitment.job') },
    outcome: (outcome.result as Record<string, unknown> | null)?.outcome ?? null,
    job_id: jobId,
    table_count: before.table_count,
  }
  writeEvidence()
})

// ---------------------------------------------------------------------------
//  e) status 工具注册开关：status_tool=false 不注册；true 注册 recruitment_budget_status
// ---------------------------------------------------------------------------

test('status tool: status_tool=false registers NOTHING; true registers recruitment_budget_status (read-only)', async () => {
  const fakeOff = createFakeDsh({ total: 1500, dshStep: 3 })
  const off = installBudgetGuard(fakeOff.ctx, { status_tool: false }, {})
  assert.equal(off.config.status_tool, false)
  assert.equal(fakeOff.guards.length, 1, 'guard 始终注册')
  assert.equal(fakeOff.registered.length, 0, 'status_tool=false 时不得注册 status 工具（D-128.2 工具数=30）')

  const fakeOn = createFakeDsh({ total: 1500, dshStep: 3 })
  const on = installBudgetGuard(fakeOn.ctx, { status_tool: true }, {})
  assert.equal(on.config.status_tool, true)
  assert.equal(fakeOn.guards.length, 1)
  assert.equal(fakeOn.registered.length, 1, 'status_tool=true 时必须注册 1 个工具')
  const statusTool = fakeOn.registered[0] as ToolLike
  assert.equal(statusTool.name, 'recruitment_budget_status')
  assert.equal(typeof statusTool.execute, 'function')

  // 只读工具实际可执行（无 DB / 无文件；sessions 为空时 ok=true）
  const value = await statusTool.execute({}, {}) as Record<string, unknown>
  assert.equal(value.ok, true)
  assert.ok(Array.isArray(value.sessions))
  assert.deepEqual(value.limits, on.config.limits)
  assert.deepEqual(value.issues, [])

  // 先抓注册证据再 dispose（dispose 会撤回注册，之后数组为空）
  const registeredWhenOn = fakeOn.registered.map((item) => item.name)
  const registeredWhenOff = fakeOff.registered.map((item) => item.name)
  assert.deepEqual(registeredWhenOn, ['recruitment_budget_status'])
  assert.deepEqual(registeredWhenOff, [])

  // dispose 幂等：guard 与 registered 都被撤回（不抛异常）
  off.dispose()
  on.dispose()
  off.dispose()
  on.dispose()
  assert.equal(fakeOn.guards.length, 0, 'dispose 必须撤回 guard')
  assert.equal(fakeOn.registered.length, 0, 'dispose 必须撤回 status 工具')

  EVIDENCE.status_tool = {
    config_off: {
      status_tool: off.config.status_tool,
      guard_count: 1,
      registered: registeredWhenOff,
      guard_after_dispose: fakeOff.guards.length,
    },
    config_on: {
      status_tool: on.config.status_tool,
      guard_count: 1,
      registered: registeredWhenOn,
      guard_after_dispose: fakeOn.guards.length,
      tool_output: { ok: value.ok, sessions: value.sessions, limits: value.limits, issues: value.issues },
    },
    note: 'status 工具默认关闭：D-128.2 权威工具数 = 30（29 recruitment_* + record_human_decision）',
  }
  writeEvidence()
})

// ---------------------------------------------------------------------------
//  f) enabled=false（lead 2026-11-16 裁决）：整个闸门不注册，dispose 幂等 no-op
// ---------------------------------------------------------------------------

test('enabled:false registers NEITHER guard NOR status tool; dispose is idempotent no-op', async () => {
  const fakeOff = createFakeDsh({ total: 1500, dshStep: 3 })
  // 即使 status_tool=true，enabled=false 也一律不注册
  const off = installBudgetGuard(fakeOff.ctx, { enabled: false, status_tool: true }, {})
  assert.equal(enabledOf(off.config), false)
  assert.equal(off.config.status_tool, true, '配置解析仍如实保留 status_tool=true（只是不注册）')
  assert.equal(fakeOff.guards.length, 0, 'enabled=false 时不得注册 guard')
  assert.equal(fakeOff.registered.length, 0, 'enabled=false 时不得注册 status 工具')
  assert.equal(typeof off.dispose, 'function')
  off.dispose()
  off.dispose()
  assert.equal(fakeOff.guards.length, 0, 'dispose 幂等 no-op：不得凭空产生注册')
  assert.equal(fakeOff.registered.length, 0)

  // 对照：同一 fake ctx 形状下 enabled=true 确实注册（证明上面的 0 不是因为 ctx 形状不对）
  const fakeOn = createFakeDsh({ total: 1500, dshStep: 3 })
  const on = installBudgetGuard(fakeOn.ctx, { enabled: true, status_tool: true }, {})
  assert.equal(enabledOf(on.config), true)
  assert.equal(fakeOn.guards.length, 1, 'enabled=true 时 guard 注册')
  assert.equal(fakeOn.registered.length, 1, 'enabled=true 时 status 工具注册')
  on.dispose()

  EVIDENCE.enabled = {
    config_default: enabledOf(resolveBudgetConfig({}, {})),
    enabled_false: {
      config_enabled: enabledOf(off.config),
      status_tool: off.config.status_tool,
      guard_count: fakeOff.guards.length,
      registered: fakeOff.registered.map((item) => item.name),
      dispose_idempotent: true,
    },
    enabled_true_control: {
      config_enabled: enabledOf(on.config),
      guard_count: 1,
      registered_count: 1,
    },
  }
  writeEvidence()
})

// ---------------------------------------------------------------------------
//  bootstrap / teardown（**不 drop 库**：留给总控 psql 复核）
// ---------------------------------------------------------------------------

test.before(async () => {
  db = await createIsolatedTestDatabase('budget_it')
  cfg = testDatabaseConfig()
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  // 独立 readback 连接：不 import 产品 DB 层（`src/db/pool.ts`），只连这个一次性库
  const base = testDatabaseConfig()
  readback = new pg.Client({
    host: base.host,
    port: base.port,
    user: base.user,
    password: base.password,
    database: db.name,
    application_name: 'budget-it-readback',
  })
  await readback.connect()
  EVIDENCE.db = { name: db.name, migrations: [...db.migrations], started_at: new Date().toISOString() }
  writeEvidence()
})

test.after(async () => {
  EVIDENCE.finished_at = isoNow()
  writeEvidence()
  if (readback !== undefined) await readback.end().catch(() => {})
  if (db !== undefined) {
    // 默认**跑完即 drop**：历史上"故意不 drop"导致每跑一次全量就多一个 ra_budget_it_*（D-150 复发）。
    // 需要人工 psql 复核时设 RECRUITMENT_KEEP_BUDGET_DB=1 再跑，库会保留。
    if (process.env.RECRUITMENT_KEEP_BUDGET_DB === '1') {
      await db.pool.end().catch(() => {})
    } else {
      await db.drop().catch(() => {})
    }
  }
})
