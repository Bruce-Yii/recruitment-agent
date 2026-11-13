// S8 排期工具（`recruitment_interview_schedule`）的 **D-79 人机闸门**单测（不连库）。
//
// 背景（P0，独立验收窗口回滚事务实测）：`scheduleInTransaction` 以前没有 approval 闸门，
// 无 approval 也能把 interview/interviewer/meeting/... 写进库里。D-79 要求写库前必须由人放行，
// 且 approval 依赖**缺省 = 一律拒绝**（headless fail closed）。
//
// 覆盖：
//   1. `makeApprovalRequest`：缺依赖 = `unavailable`；封闭集原样返回；未知字符串归 `unavailable`；
//   2. `requireApprovalGranted`：只有 `allowed-once` 放行；其余 `FORBIDDEN` +
//      `reason_code`（`APPROVAL_UNAVAILABLE` / `APPROVAL_NOT_GRANTED`）；
//   3. **参数非法时不去问人**：approval 调用数 = 0，且一个数据库语句都不发
//      （`scheduleInTransaction` 的形状校验在事务/保存点之前）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  APPROVAL_TIMEOUT_MS,
  makeApprovalRequest,
  requireApprovalGranted,
  scheduleInTransaction,
} from '../../src/tools/interview-schedule.ts'
import { RecruitmentToolError } from '../../src/tools/errors.ts'
import type { DatabaseClient, ResolvedDatabaseConfig } from '../../src/db/pool.ts'

/** 不连库：本文件的用例要么是纯函数，要么在参数层就抛，永远不会真的用到这些值。 */
const CFG = {
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  database: 'ra_s6s7',
  password: 'unused-in-this-test',
  password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
  statement_timeout_ms: 15_000,
  connect_timeout_ms: 10_000,
  max: 2,
} as ResolvedDatabaseConfig

/** 从契约错误里取回 JSON 体（消息形态 `<CODE>: <compact-json>`）。 */
function errorBody(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  const json = index >= 0 ? message.slice(index + 2) : message
  return JSON.parse(json) as Record<string, unknown>
}

/** 任何 SQL 都直接炸的假连接（用来证明"参数非法时连库都不碰"）。 */
class ExplodingClient {
  calls = 0

  query(): never {
    this.calls += 1
    throw new Error('参数非法时不得访问数据库')
  }
}

test('S8 D-79：approval 缺省 → makeApprovalRequest 返回 unavailable（= 拒绝写库）', async () => {
  assert.equal(await makeApprovalRequest(undefined, undefined)(), 'unavailable')
})

test('S8 D-79：makeApprovalRequest 透传 toolName/agent/signal，并把封闭集原样返回', async () => {
  const requests: Record<string, unknown>[] = []
  const agent = { id: 'agent-1' }
  const signal = new AbortController().signal
  const approval = {
    async request(req: Record<string, unknown>): Promise<string> {
      requests.push(req)
      return 'allowed-once'
    },
  }
  const approve = makeApprovalRequest(approval, { agent, signal })
  assert.equal(await approve(), 'allowed-once')
  assert.equal(requests.length, 1)
  const req = requests[0] ?? {}
  assert.equal(req.toolName, 'recruitment_interview_schedule')
  assert.equal(req.agent, agent)
  assert.equal(req.signal, signal)
  assert.equal(typeof req.reason, 'string')
  for (const outcome of ['rejected', 'cancelled', 'unavailable'] as const) {
    assert.equal(await makeApprovalRequest({ request: async () => outcome }, undefined)(), outcome)
  }
  // 封闭集之外的字符串：不猜，按不可用处理（fail closed）。
  assert.equal(await makeApprovalRequest({ request: async () => 'allow' }, undefined)(), 'unavailable')
})

test('S8 D-79：requireApprovalGranted 只在 allowed-once 放行，其余 FORBIDDEN + reason_code', () => {
  requireApprovalGranted('allowed-once')
  for (const [outcome, reasonCode] of [
    ['unavailable', 'APPROVAL_UNAVAILABLE'],
    ['rejected', 'APPROVAL_NOT_GRANTED'],
    ['cancelled', 'APPROVAL_NOT_GRANTED'],
    ['timeout', 'APPROVAL_NOT_GRANTED'],
  ] as const) {
    assert.throws(
      () => requireApprovalGranted(outcome),
      (error: unknown) => {
        assert.ok(error instanceof RecruitmentToolError, '必须是 RecruitmentToolError')
        assert.equal((error as RecruitmentToolError).code, 'FORBIDDEN')
        const body = errorBody(error)
        assert.equal(body.code, 'FORBIDDEN')
        assert.equal(body.reason_code, reasonCode)
        assert.deepEqual(body.detail, { approval: outcome, tool: 'recruitment_interview_schedule' })
        return true
      },
    )
  }
})

test('S8 D-79：approval 等待超时（默认 120s；测试注入 20ms）→ timeout；晚到的 allowed-once 不改变结论', async () => {
  // 裁定值写死：生产上限就是 120 秒（改它必须同时改测试与注释）。
  assert.equal(APPROVAL_TIMEOUT_MS, 120_000)

  // 宿主永远不回答 → 超过注入的 20ms 上限 → 'timeout'。
  const never = { request: () => new Promise<string>(() => undefined) }
  assert.equal(await makeApprovalRequest(never, undefined, 20)(), 'timeout')

  // 超时之后宿主才 resolve：本次结论已固定为 timeout，不会变成 allowed-once。
  let resolveLate: ((value: string) => void) | undefined
  const late = new Promise<string>((resolve) => {
    resolveLate = resolve
  })
  const approve = makeApprovalRequest({ request: () => late }, undefined, 20)
  const result = await approve()
  assert.equal(result, 'timeout')
  resolveLate?.('allowed-once')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(result, 'timeout', '超时后晚到的批准不得改写本次结论')
})

test('S8 D-79：参数非法 → INVALID_ARGS，且**不去问人**（approval 调用数 = 0、零 SQL）', async () => {
  const client = new ExplodingClient()
  let approvalCalls = 0
  const spy = async (): Promise<'allowed-once'> => {
    approvalCalls += 1
    return 'allowed-once'
  }
  await assert.rejects(
    scheduleInTransaction(client as unknown as DatabaseClient, CFG, {}, Date.now(), spy),
    (error: unknown) => {
      assert.ok(error instanceof RecruitmentToolError)
      assert.equal((error as RecruitmentToolError).code, 'INVALID_ARGS')
      return true
    },
  )
  assert.equal(approvalCalls, 0, '参数层就拒了，不得打扰人')
  assert.equal(client.calls, 0, '参数层就拒了，不得访问数据库')
})
