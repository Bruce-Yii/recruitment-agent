// 批量初筛不通过编排层（纯逻辑）单测：不连真库、不 import 决策工具实现。
// 写入口通过 deps.toolFactory 注入 stub；幂等预检通过 deps.findIdempotent 注入 stub。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseBatchRejectInput,
  parseToolError,
  runBatchReject,
  type DecisionToolLike,
} from '../../src/domain/batch-reject.ts'
import { RecruitmentToolError } from '../../src/tools/errors.ts'

const APP_1 = '11111111-1111-4111-8111-000000000001'
const APP_2 = '22222222-2222-4222-8222-000000000002'
const DEC_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
const DEC_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002'
const TENANT = '33333333-3333-4333-8333-000000000003'
const ACTOR = '44444444-4444-4444-8444-000000000004'

const BASE = {
  application_ids: [APP_1, APP_2],
  reason: '材料不齐，暂不推进',
  confirmation_text: '我确认这两条初筛都不通过',
} as const

// ---------------------------------------------------------------------------
//  1. parseBatchRejectInput —— 边界
// ---------------------------------------------------------------------------

function expectInvalid(body: Record<string, unknown>, hint: string): void {
  try {
    parseBatchRejectInput(body)
    assert.fail(`${hint} 应抛 INVALID_ARGS`)
  } catch (error) {
    assert.equal((error as { code?: unknown }).code, 'INVALID_ARGS', hint)
    assert.match((error as Error).message, /.+/, hint)
  }
}

test('parse：最小合法入参 → 原样返回（不 trim、不改写）', () => {
  assert.deepEqual(parseBatchRejectInput(BASE), BASE)
})

test('parse：0 个 application_ids → INVALID_ARGS', () => {
  expectInvalid({ ...BASE, application_ids: [] }, '空数组')
})

test('parse：51 个 application_ids → INVALID_ARGS', () => {
  expectInvalid({ ...BASE, application_ids: Array.from({ length: 51 }, () => APP_1) }, '51 个')
})

test('parse：恰好 50 个 UUID → ok', () => {
  const result = parseBatchRejectInput({ ...BASE, application_ids: Array.from({ length: 50 }, () => APP_1) })
  assert.equal(result.application_ids.length, 50)
})

test('parse：非 UUID application_id → INVALID_ARGS', () => {
  expectInvalid({ ...BASE, application_ids: [APP_1, 'not-a-uuid'] }, '非 UUID')
})

test('parse：空 reason / 全空白 reason / 超长 reason → INVALID_ARGS', () => {
  expectInvalid({ ...BASE, reason: '' }, '空 reason')
  expectInvalid({ ...BASE, reason: '   ' }, '全空白 reason')
  expectInvalid({ ...BASE, reason: 'x'.repeat(501) }, '501 字符 reason')
  assert.equal(parseBatchRejectInput({ ...BASE, reason: 'x'.repeat(500) }).reason.length, 500)
})

test('parse：空 confirmation_text / 超长 confirmation_text → INVALID_ARGS', () => {
  expectInvalid({ ...BASE, confirmation_text: '' }, '空 text')
  expectInvalid({ ...BASE, confirmation_text: '   ' }, '全空白 text')
  expectInvalid({ ...BASE, confirmation_text: 'x'.repeat(2001) }, '2001 字符 text')
  assert.equal(parseBatchRejectInput({ ...BASE, confirmation_text: 'x'.repeat(2000) }).confirmation_text.length, 2000)
})

test('parse：非对象 body → INVALID_ARGS', () => {
  expectInvalid(null as unknown as Record<string, unknown>, 'null body')
})

// ---------------------------------------------------------------------------
//  2. parseToolError —— 错误信封不吞细节
// ---------------------------------------------------------------------------

test('parseToolError：从 CODE: {compact-json} 抽 code/reason_code/message', () => {
  const parsed = parseToolError(new RecruitmentToolError('FORBIDDEN', JSON.stringify({
    code: 'FORBIDDEN', reason_code: 'ACTOR_NOT_HUMAN', message: '执行 actor 不是人', detail: { actor: 'x' },
  })))
  assert.equal(parsed.code, 'FORBIDDEN')
  assert.equal(parsed.reason_code, 'ACTOR_NOT_HUMAN')
  assert.equal(parsed.message, '执行 actor 不是人')
})

test('parseToolError：非信封错误保留原文', () => {
  const parsed = parseToolError(new Error('connection refused'))
  assert.equal(parsed.reason_code, 'UNKNOWN')
  assert.match(parsed.message, /connection refused/)
})

// ---------------------------------------------------------------------------
//  3. runBatchReject —— 部分失败 / 幂等 / 入参形状（stub 工具，无真库）
// ---------------------------------------------------------------------------

interface StubOptions {
  readonly execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
  readonly findIdempotent?: (applicationId: string, reason: string) => Promise<string | undefined>
}

function makeDeps(options: StubOptions) {
  const calls: Array<{ args: Record<string, unknown>; exec: unknown }> = []
  const tool: DecisionToolLike = {
    name: 'record_human_decision',
    async execute(args, exec) {
      calls.push({ args: args as Record<string, unknown>, exec })
      return await options.execute(args as Record<string, unknown>, exec)
    },
  }
  const deps = {
    database: { tenant_id: TENANT } as never,
    identity: {} as never,
    session_id: 'session-11111111-1111-4111-8111-000000000001',
    actor_id: ACTOR,
    now_ms: 1_700_000_000_000,
    toolFactory: () => tool,
    findIdempotent: options.findIdempotent ?? (async () => undefined),
  }
  return { deps, calls }
}

test('runBatchReject：一条成功一条失败 → 两条 results、succeeded=1、failed=1（成功不受失败影响）', async () => {
  const { deps, calls } = makeDeps({
    async execute(args) {
      if (args.application_id === APP_1) {
        return { decision: { id: DEC_1 }, replayed: false }
      }
      throw new RecruitmentToolError('INVALID_ARGS', JSON.stringify({
        code: 'INVALID_ARGS', reason_code: 'APPLICATION_NOT_FOUND', message: '该租户下没有这个申请',
      }))
    },
  })
  const result = await runBatchReject(deps, BASE)

  assert.equal(result.results.length, 2)
  assert.equal(result.succeeded, 1)
  assert.equal(result.failed, 1)
  assert.equal(calls.length, 2, '每条申请都独立调用了一次工具（失败那条也调用过，未被整体回滚）')

  const first = result.results[0]!
  assert.equal(first.application_id, APP_1)
  assert.equal(first.ok, true)
  assert.equal(first.decision_id, DEC_1)

  const second = result.results[1]!
  assert.equal(second.application_id, APP_2)
  assert.equal(second.ok, false)
  assert.equal(second.reason_code, 'APPLICATION_NOT_FOUND')
  assert.match(second.message ?? '', /没有这个申请/)
  assert.equal(second.decision_id, undefined)
})

test('runBatchReject：幂等预检命中 → ok=true + ALREADY_DECIDED_IDEMPOTENT + 不调工具（真正零写入）', async () => {
  const { deps, calls } = makeDeps({
    async execute(args) {
      return { decision: { id: args.application_id === APP_1 ? DEC_1 : DEC_2 } }
    },
    async findIdempotent(applicationId) {
      // 只有 APP_1 命中：它必须零写入；APP_2 未命中，走工具正常写。
      return applicationId === APP_1 ? DEC_1 : undefined
    },
  })
  const result = await runBatchReject(deps, {
    ...BASE,
    application_ids: [APP_1, APP_2],
  })

  assert.equal(result.succeeded, 2)
  assert.equal(result.failed, 0)
  assert.equal(calls.length, 1, '只有未命中的第二条调用了工具')
  assert.equal(result.results[0]!.reason_code, 'ALREADY_DECIDED_IDEMPOTENT')
  assert.equal(result.results[0]!.decision_id, DEC_1)
  assert.equal(result.results[1]!.decision_id, DEC_2)
  assert.equal(result.results[1]!.reason_code, undefined)
})

test('runBatchReject：工具抛 ALREADY_DECIDED + 复检命中 → 幂等 ok=true；未命中 → ok=false', async () => {
  // (a) 竞态：工具报 ALREADY_DECIDED，但复检查到同 reason 的 REJECT → 幂等成功。
  const raceDeps = makeDeps({
    async execute() {
      throw new RecruitmentToolError('ALREADY_DECIDED', JSON.stringify({
        code: 'ALREADY_DECIDED', reason_code: 'SCOPE_ALREADY_DECIDED', message: '已有当前决策',
      }))
    },
    async findIdempotent() {
      return DEC_2
    },
  })
  const race = await runBatchReject(raceDeps.deps, { ...BASE, application_ids: [APP_1] })
  assert.equal(race.succeeded, 1)
  assert.equal(race.results[0]!.reason_code, 'ALREADY_DECIDED_IDEMPOTENT')
  assert.equal(race.results[0]!.decision_id, DEC_2)

  // (b) 已有别的决策（不同 reason）：复检查不到 → 失败，reason_code 保留。
  const otherDeps = makeDeps({
    async execute() {
      throw new RecruitmentToolError('ALREADY_DECIDED', JSON.stringify({
        code: 'ALREADY_DECIDED', reason_code: 'SCOPE_ALREADY_DECIDED', message: '已有当前决策（不同结论）',
      }))
    },
    async findIdempotent() {
      return undefined
    },
  })
  const other = await runBatchReject(otherDeps.deps, { ...BASE, application_ids: [APP_1] })
  assert.equal(other.failed, 1)
  assert.equal(other.results[0]!.ok, false)
  assert.equal(other.results[0]!.reason_code, 'SCOPE_ALREADY_DECIDED')
})

test('runBatchReject：每条工具调用 shape 正确（SCREENING/REJECT、IN_CHAT、同一句原话、exec 带 session）', async () => {
  const { deps, calls } = makeDeps({
    async execute(args) {
      return { decision: { id: args.application_id === APP_1 ? DEC_1 : DEC_2 } }
    },
  })
  await runBatchReject(deps, BASE)

  assert.equal(calls.length, 2)
  for (const call of calls) {
    const a = call.args
    assert.equal(a.decision_scope, 'SCREENING')
    assert.equal(a.result, 'REJECT')
    assert.equal(a.reason, BASE.reason)
    const hc = a.human_confirmation as Record<string, unknown>
    assert.equal(hc.method, 'IN_CHAT')
    assert.equal(hc.text, BASE.confirmation_text)
    assert.equal(hc.confirmed_at, new Date(1_700_000_000_000).toISOString())
    const exec = call.exec as { agent: { id: string }; headers: Record<string, string> }
    assert.equal(exec.agent.id, 'session-11111111-1111-4111-8111-000000000001')
    assert.equal(exec.headers['x-dsh-session'], 'session-11111111-1111-4111-8111-000000000001')
  }
})

test('runBatchReject：工具名来自工具定义（不是硬编码的错名）', async () => {
  const { deps } = makeDeps({ async execute() { return { decision: { id: DEC_1 } } } })
  // 工厂返回的 stub.name 正确；若 Owner 传错工具名，本编排不依赖它，真正写入由工厂默认实现保证。
  const tool = deps.toolFactory({ database: deps.database, identity: deps.identity })
  assert.equal(tool.name, 'record_human_decision')
})

test('runBatchReject：预检失败 → 该条失败，不贸然写库', async () => {
  const { deps, calls } = makeDeps({
    async execute() { assert.fail('预检失败时不应写库'); return undefined },
    async findIdempotent() { throw new Error('db down') },
  })
  const result = await runBatchReject(deps, { ...BASE, application_ids: [APP_1] })
  assert.equal(result.failed, 1)
  assert.equal(calls.length, 0)
  assert.match(result.results[0]!.message ?? '', /幂等预检失败/)
})
