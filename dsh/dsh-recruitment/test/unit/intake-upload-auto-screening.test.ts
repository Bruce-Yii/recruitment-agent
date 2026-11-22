// G-01 / Issue #24：简历入库后自动初筛评估的单测（不连库、不起服务、不写文件）。
//
// 被测面是 `src/http/intake-upload.ts` 新导出的 `runAutoScreeningAfterIntake()`：
//   * **有已批准 Rubric** → 只评估一次（只读工具/注入的 spy），返回 EVALUATED；
//   * **无已批准 Rubric** → 跳过、日志带原因、评估器一次都不调用；
//   * **评估抛错** → 只记日志、返回 FAILED，**绝不向上抛**（调用方因此不会把已成功的入库翻成失败）；
//   * **重复/并发触发** → 同申请去重、不同申请串行（同一时刻最多一个评估在跑）；
//   * **零 decision 写入** → 源码静态断言：本文件没有任何 decision 写语句，评估走既有只读工具。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  runAutoScreeningAfterIntake,
  type AutoScreeningHooks,
  type AutoScreeningOutcome,
  type AutoScreeningRubricProbe,
} from '../../src/http/intake-upload.ts'

// ---------------------------------------------------------------------------
//  夹具
// ---------------------------------------------------------------------------

const CFG: ResolvedDatabaseConfig = {
  host: '127.0.0.1',
  port: 5432,
  user: 'test',
  database: 'test',
  password: 'unused-in-unit-test',
  password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  actor_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  statement_timeout_ms: 15_000,
  connect_timeout_ms: 10_000,
  max: 2,
}
const APP_1 = '11111111-1111-4111-8111-111111111111'
const APP_2 = '22222222-2222-4222-8222-222222222222'
const RUBRIC_V1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

interface LogEntry { readonly level: 'warn'; readonly message: string }
function makeLogger(): { logs: LogEntry[]; warn(message: string): void } {
  const logs: LogEntry[] = []
  return { logs, warn(message: string) { logs.push({ level: 'warn', message }) } }
}

function hooksOf(probe: (app: string) => Promise<AutoScreeningRubricProbe>, evaluate: (input: {
  applicationId: string
  rubricVersionId: string
}) => Promise<unknown>): AutoScreeningHooks {
  return { probeApprovedRubric: ({ applicationId }) => probe(applicationId), evaluate }
}

// ---------------------------------------------------------------------------
//  1. 有已批准 Rubric → 评估一次
// ---------------------------------------------------------------------------

test('有已批准 Rubric：自动评估一次，rubric id 与 application id 原样传递', async () => {
  const logger = makeLogger()
  const probeCalls: string[] = []
  const evalCalls: Array<{ applicationId: string; rubricVersionId: string }> = []
  const hooks = hooksOf(
    async (app) => { probeCalls.push(app); return { kind: 'APPROVED', rubricVersionId: RUBRIC_V1 } },
    async (input) => { evalCalls.push(input); return { status: 'OK', verdict: 'PASS' } },
  )

  const outcome = await runAutoScreeningAfterIntake(CFG, APP_1, hooks, logger)

  assert.deepEqual(outcome, { kind: 'EVALUATED', applicationId: APP_1, rubricVersionId: RUBRIC_V1 })
  assert.deepEqual(probeCalls, [APP_1])
  assert.deepEqual(evalCalls, [{ applicationId: APP_1, rubricVersionId: RUBRIC_V1 }])
  assert.equal(logger.logs.length, 0, '正常路径不需要告警')
})

// ---------------------------------------------------------------------------
//  2. 无已批准 Rubric → 跳过 + 日志原因 + 评估器零调用
// ---------------------------------------------------------------------------

test('无已批准 Rubric：跳过，日志含原因，评估器一次都不调用', async () => {
  const logger = makeLogger()
  let evalCalls = 0
  const hooks = hooksOf(
    async () => ({ kind: 'NONE', reason: '岗位没有当前 Rubric 版本且申请未钉住 Rubric' }),
    async () => { evalCalls += 1; return undefined },
  )

  const outcome = await runAutoScreeningAfterIntake(CFG, APP_1, hooks, logger)

  assert.equal(outcome.kind, 'SKIPPED_NO_APPROVED_RUBRIC')
  assert.equal(outcome.kind === 'SKIPPED_NO_APPROVED_RUBRIC' && outcome.reason.includes('岗位没有当前 Rubric'), true)
  assert.equal(evalCalls, 0)
  assert.equal(logger.logs.length, 1)
  assert.match(logger.logs[0]!.message, /自动初筛未触发/)
  assert.match(logger.logs[0]!.message, /岗位没有当前 Rubric/)
  assert.match(logger.logs[0]!.message, new RegExp(APP_1))
})

test('探针失败（查库异常）也只记日志并返回 FAILED，不向上抛', async () => {
  const logger = makeLogger()
  const hooks = hooksOf(
    async () => { throw new Error('db down') },
    async () => { throw new Error('不应被调用') },
  )
  const outcome = await runAutoScreeningAfterIntake(CFG, APP_1, hooks, logger)
  assert.equal(outcome.kind, 'FAILED')
  assert.equal(outcome.kind === 'FAILED' && outcome.reason.includes('db down'), true)
  assert.equal(logger.logs.length, 1)
  assert.match(logger.logs[0]!.message, /自动初筛评估失败（不影响入库）/)
})

// ---------------------------------------------------------------------------
//  3. 评估失败 → 不回滚、不抛、零 decision 写入
// ---------------------------------------------------------------------------

test('评估抛错：只记日志并返回 FAILED；调用方因此不会把已成功的入库翻成失败', async () => {
  const logger = makeLogger()
  let evalCalls = 0
  const hooks = hooksOf(
    async () => ({ kind: 'APPROVED', rubricVersionId: RUBRIC_V1 }),
    async () => { evalCalls += 1; throw new Error('screening tool exploded') },
  )

  // 关键契约：这个 await 永不 reject——调用方（入库成功后的 background flow）
  // 不会因为评估失败进入失败分支，已 SUCCEEDED 的任务不会被改写。
  const outcome: AutoScreeningOutcome = await runAutoScreeningAfterIntake(CFG, APP_1, hooks, logger)

  assert.equal(evalCalls, 1)
  assert.equal(outcome.kind, 'FAILED')
  assert.equal(outcome.kind === 'FAILED' && outcome.reason.includes('screening tool exploded'), true)
  assert.equal(logger.logs.length, 1)
  assert.match(logger.logs[0]!.message, /不影响入库/)
})

test('零 decision 写入：入参只有 application_id，且源码无任何 decision 写语句', async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', '..', 'src', 'http', 'intake-upload.ts'), 'utf8')
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/\b(insert\s+into|update|delete\s+from)\s+recruitment\.decision\b/i.test(withoutComments), false)
  assert.equal(/\bdecision_record\b|\brecord_human_decision\b/i.test(withoutComments), false)
  // 走的是既有只读评估工具，而不是自研规则或写决策路径。
  assert.match(withoutComments, /createScreeningEvaluateTool/)
  assert.match(withoutComments, /\.execute\(\s*\{\s*application_id:\s*applicationId\s*\}/)

  // 注入的评估器只收到 application_id / rubricVersionId，没有任何 decision 写入参数。
  const logger = makeLogger()
  let seen: unknown
  const hooks = hooksOf(
    async () => ({ kind: 'APPROVED', rubricVersionId: RUBRIC_V1 }),
    async (input) => { seen = input; return undefined },
  )
  await runAutoScreeningAfterIntake(CFG, APP_1, hooks, logger)
  assert.deepEqual(Object.keys(seen as object).sort(), ['applicationId', 'rubricVersionId'])
})

// ---------------------------------------------------------------------------
//  4. 重复 / 并发触发防护
// ---------------------------------------------------------------------------

test('同一申请并发触发两次：只评估一次，第二次 SKIPPED_DUPLICATE', async () => {
  const logger = makeLogger()
  let evalCalls = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const hooks = hooksOf(
    async () => ({ kind: 'APPROVED', rubricVersionId: RUBRIC_V1 }),
    async () => { evalCalls += 1; await gate; return undefined },
  )

  const first = runAutoScreeningAfterIntake(CFG, APP_1, hooks, logger)
  const second = await runAutoScreeningAfterIntake(CFG, APP_1, hooks, logger)
  assert.equal(second.kind, 'SKIPPED_DUPLICATE')
  assert.equal(second.kind === 'SKIPPED_DUPLICATE' && second.reason.includes('已有自动初筛在跑'), true)

  release()
  const firstOutcome = await first
  assert.equal(firstOutcome.kind, 'EVALUATED')
  assert.equal(evalCalls, 1, '重复触发不得导致第二次评估')
  assert.match(logger.logs[0]!.message, /重复触发/)
})

test('不同申请并发触发：串行执行（同一时刻最多一个评估在跑）', async () => {
  const logger = makeLogger()
  let active = 0
  let maxActive = 0
  const order: string[] = []
  const hooks = hooksOf(
    async () => ({ kind: 'APPROVED', rubricVersionId: RUBRIC_V1 }),
    async ({ applicationId }) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      order.push(applicationId)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return undefined
    },
  )

  const [a, b] = await Promise.all([
    runAutoScreeningAfterIntake(CFG, APP_1, hooks, logger),
    runAutoScreeningAfterIntake(CFG, APP_2, hooks, logger),
  ])
  assert.equal(a.kind, 'EVALUATED')
  assert.equal(b.kind, 'EVALUATED')
  assert.equal(maxActive, 1, '评估必须串行，不得并发')
  assert.equal(order.length, 2)
  assert.notEqual(order[0], order[1])
})

test('前一次评估失败不会阻塞后续评估（串行链尾已归一）', async () => {
  const logger = makeLogger()
  const evaluated: string[] = []
  const hooks = hooksOf(
    async () => ({ kind: 'APPROVED', rubricVersionId: RUBRIC_V1 }),
    async ({ applicationId }) => {
      if (applicationId === APP_1) throw new Error('first fails')
      evaluated.push(applicationId)
      return undefined
    },
  )

  const [a, b] = await Promise.all([
    runAutoScreeningAfterIntake(CFG, APP_1, hooks, logger),
    runAutoScreeningAfterIntake(CFG, APP_2, hooks, logger),
  ])
  assert.equal(a.kind, 'FAILED')
  assert.equal(b.kind, 'EVALUATED')
  assert.deepEqual(evaluated, [APP_2])
})

// ---------------------------------------------------------------------------
//  5. 接线位置（源码断言）：评估在 SUCCEEDED 之后、且自带 catch 隔离
// ---------------------------------------------------------------------------

test('接线：自动初筛在 finalizeTask(SUCCEEDED) 之后调用，且被 catch 隔离', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', '..', 'src', 'http', 'intake-upload.ts'), 'utf8')
    .replace(/\r\n/g, '\n')
  const succeededAt = source.indexOf("'SUCCEEDED', null")
  // 用真实调用点（带 value.application_id 实参），不取文件顶部的导出声明。
  const autoAt = source.indexOf('runAutoScreeningAfterIntake(\n      cfg, value.application_id')
  assert.ok(succeededAt >= 0 && autoAt > succeededAt, '触发点必须在入库成功终态之后')
  const after = source.slice(autoAt, autoAt + 400)
  assert.match(after, /\.catch\(/, '自动初筛调用必须自带 catch 兜底，绝不翻盘已成功任务')
})
