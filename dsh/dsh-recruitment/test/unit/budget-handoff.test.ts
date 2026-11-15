/**
 * task-78 / DESIGN §3.6：超限交接文本单测。
 *
 * 钉死的事：
 *   1. **固定前三行格式**（下游 grep 依赖，逐字比对）；
 *   2. 十个机检字面量全部出现：`BUDGET_EXCEEDED_HANDOFF` / `task_class=` / `tokens=` /
 *      `limit_tokens=` / `steps=` / `limit_steps=` / `usage_source=` / `HANDOFF_TO:` /
 *      `SUGGESTION:` / `STOP`；
 *   3. 交接对象按任务类：SCREENING → 人类 HR（Recruiting Workspace → 申请详情 → 初筛）；
 *      DECISION → 招聘负责人 / approver（正式决策与审批）；`config.handoff_owner` 非空时追加；
 *   4. 「做到哪一步」段含 last_tool / tools_used 摘要 / over 维度；dsh_step=null 也如实输出；
 *   5. 纯函数：同输入同输出，不读配置源、不读写任何东西。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUDGET_EXCEEDED_HANDOFF,
  buildHandoffText,
  evaluateBudget,
  resolveBudgetConfig,
  type BudgetSnapshot,
  type BudgetTokenBuckets,
  type BudgetUsageSource,
} from '../../src/budget/index.ts'

function tokensOf(total: number): BudgetTokenBuckets {
  return { uncached_input: total, output: 0, cache_read: 0, cache_write: 0, total }
}

function snapshotFor(input: {
  readonly taskClass?: 'SCREENING' | 'DECISION'
  readonly total?: number
  readonly steps?: number
  readonly maxTokens?: number
  readonly maxSteps?: number
  readonly dshStep?: number | null
  readonly lastTool?: string | null
  readonly toolsUsed?: Record<string, number>
  readonly usageSource?: BudgetUsageSource
}): BudgetSnapshot {
  return evaluateBudget({
    session_id: 'session-1',
    task_class: input.taskClass ?? 'SCREENING',
    task_class_source: 'auto',
    tokens: tokensOf(input.total ?? 150000),
    steps: input.steps ?? 16,
    dsh_step: input.dshStep === undefined ? 7 : input.dshStep,
    limits: { max_tokens: input.maxTokens ?? 100000, max_steps: input.maxSteps ?? 15 },
    usage_source: input.usageSource ?? 'session_projection.tokenUsage',
    last_tool: input.lastTool === undefined ? 'recruitment_resume_read' : input.lastTool,
    tools_used: input.toolsUsed ?? { recruitment_resume_read: 2, recruitment_application_get: 1 },
  })
}

const DEFAULT_CONFIG = resolveBudgetConfig({}, {})

const REQUIRED_LITERALS = [
  'BUDGET_EXCEEDED_HANDOFF',
  'task_class=',
  'tokens=',
  'limit_tokens=',
  'steps=',
  'limit_steps=',
  'usage_source=',
  'HANDOFF_TO:',
  'SUGGESTION:',
  'STOP',
] as const

test('固定前三行：HANDOFF 标识 / 关键字段行 / STOP（下游 grep 依赖）', () => {
  const text = buildHandoffText({ snapshot: snapshotFor({}), config: DEFAULT_CONFIG })
  const lines = text.split('\n')
  assert.equal(lines[0], 'BUDGET_EXCEEDED_HANDOFF')
  assert.match(
    lines[1]!,
    /^task_class=SCREENING tokens=150000 limit_tokens=100000 steps=16 limit_steps=15 usage_source=session_projection\.tokenUsage dsh_step=7$/,
  )
  assert.equal(lines[2], 'STOP')
})

test('十个机检字面量全部出现', () => {
  const text = buildHandoffText({ snapshot: snapshotFor({}), config: DEFAULT_CONFIG })
  for (const literal of REQUIRED_LITERALS) {
    assert.ok(text.includes(literal), `缺少字面量 ${literal}`)
  }
  assert.equal(BUDGET_EXCEEDED_HANDOFF, 'BUDGET_EXCEEDED_HANDOFF')
})

test('dsh_step=null 如实输出（不臆造步数）', () => {
  const text = buildHandoffText({ snapshot: snapshotFor({ dshStep: null }), config: DEFAULT_CONFIG })
  const lines = text.split('\n')
  assert.match(lines[1]!, / dsh_step=null$/)
})

test('交接对象：SCREENING → 人类 HR；DECISION → 招聘负责人 / approver', () => {
  const screening = buildHandoffText({ snapshot: snapshotFor({ taskClass: 'SCREENING' }), config: DEFAULT_CONFIG })
  assert.ok(screening.includes('HANDOFF_TO: 人类 HR（Recruiting Workspace → 申请详情 → 初筛）'))
  assert.match(screening, /^SUGGESTION: /m)

  const decision = buildHandoffText({
    snapshot: snapshotFor({ taskClass: 'DECISION', total: 300000, maxTokens: 200000, steps: 26, maxSteps: 25 }),
    config: DEFAULT_CONFIG,
  })
  assert.ok(decision.includes('HANDOFF_TO: 招聘负责人 / approver（正式决策与审批）'))
})

test('config.handoff_owner 非空时追加到 HANDOFF_TO', () => {
  const config = resolveBudgetConfig({ handoff: { owner: '张三（招聘负责人）' } }, {})
  const text = buildHandoffText({ snapshot: snapshotFor({}), config })
  assert.ok(
    text.includes(
      'HANDOFF_TO: 人类 HR（Recruiting Workspace → 申请详情 → 初筛）；指定交接人：张三（招聘负责人）',
    ),
  )
  // 空 owner 不追加
  const empty = buildHandoffText({ snapshot: snapshotFor({}), config: resolveBudgetConfig({ handoff: { owner: '  ' } }, {}) })
  assert.ok(empty.includes('HANDOFF_TO: 人类 HR（Recruiting Workspace → 申请详情 → 初筛）'))
  assert.ok(!empty.includes('指定交接人'))
})

test('「做到哪一步」段：last_tool / tools_used 摘要 / over 维度', () => {
  const text = buildHandoffText({ snapshot: snapshotFor({}), config: DEFAULT_CONFIG })
  assert.ok(text.includes('last_tool=recruitment_resume_read'))
  assert.ok(text.includes('recruitment_resume_read×2'))
  assert.ok(text.includes('recruitment_application_get×1'))
  assert.ok(text.includes('tokens used=150000 limit=100000'))
  assert.ok(text.includes('steps used=16 limit=15'))
  // over 顺序固定 tokens 在前
  assert.ok(text.indexOf('tokens used=') < text.indexOf('steps used='))
})

test('tools_used 为空 / last_tool=null 时如实写「无」与 null', () => {
  const text = buildHandoffText({
    snapshot: snapshotFor({ toolsUsed: {}, lastTool: null }),
    config: DEFAULT_CONFIG,
  })
  assert.ok(text.includes('last_tool=null'))
  assert.ok(text.includes('tools_used=无'))
})

test('usages / 副作用表述：注明 usage 来源、分桶，且不越权宣称"本轮零写库"', () => {
  const text = buildHandoffText({
    snapshot: snapshotFor({ usageSource: 'tokenMeter.measure' }),
    config: DEFAULT_CONFIG,
  })
  assert.ok(text.includes('usage_source=tokenMeter.measure'))
  assert.ok(text.includes('分桶 uncached_input=150000 output=0 cache_read=0 cache_write=0'))
  // 闸门只能保证「本次被拒调用」未执行；此前已放行的调用可能已写库，不得宣称本轮零写库。
  assert.ok(text.includes('本次零写入'))
  assert.ok(text.includes('不在本闸门回滚范围内'))
  assert.ok(!text.includes('本轮**零写库**'))
})

test('纯函数：同一输入两次输出完全相同', () => {
  const snapshot = snapshotFor({})
  const first = buildHandoffText({ snapshot, config: DEFAULT_CONFIG })
  const second = buildHandoffText({ snapshot, config: DEFAULT_CONFIG })
  assert.equal(first, second)
})
