// O4 / O16 / O12(纯函数) 的单测（不连库；HTTP 用假 req/res，database=null）。
//
// 每条对应产品复核报告的一条 OURS：
//   * O4  未绑定身份的错误里必须有人话引导（"请先在招聘工作台顶部选择身份…"），
//         同时保留 reason_code / session_id（机检与排障用）；
//   * O16 未绑定 session 调 `GET /recruitment/api/decision/facts` → 4xx 且 reason 是"未绑定"，
//         message 是人话，不能落成"读取失败/READER_FAILED"；
//   * O12 remediation 由服务端按 approval 真值生成：已批准的 v2 不得出现在"去审批"建议里；
//         钉住 v1 未批准 + 岗位 v2 已批准时，建议必须是"按钉住版本继续"（并说明没有重绑入口）。
//
// 真库事实（application_get 的实际输出、零写入行数）在同前缀的 integration 测试里。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createDemoActorIdentity, resolveExecutionActor, resolveSessionActor } from '../../src/demo-actor/resolve.ts'
import { createDemoActorIdentity as createIdentity } from '../../src/demo-actor/index.ts'
import {
  DECISION_PATHS,
  registerDecisionHttp,
  type DecisionHostContext,
} from '../../src/http/decision-read.ts'
import {
  deriveApplicationNextStep,
  type ApplicationGateFacts,
} from '../../src/http/recruiting.ts'
import { deriveRubricRemediation } from '../../src/tools/business-read.ts'
import { PLACEHOLDER_CONFIRMATION_MESSAGE, parseDecisionArgs } from '../../src/tools/decision-record.ts'
import { createRecordHumanDecisionTool } from '../../src/tools/record-human-decision.ts'
import { resolveDatabaseConfig } from '../../src/db/pool.ts'
import { ACTOR_UNBOUND_HUMAN_HINT } from '../../src/tools/errors.ts'
import { errorBody } from '../integration/db.ts'

const SESSION_A = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const UBOUND_SESSION = 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ACTOR_103 = '11111111-1111-4111-8111-000000000103'
const APPLICATION = '11111111-1111-4111-8111-000000000701'
const HEX_A = 'a'.repeat(64)

// ---------------------------------------------------------------------------
//  O4：未绑定身份 → 人话引导（机检字段不动）
// ---------------------------------------------------------------------------

test('O4：resolveExecutionActor 未绑定 → message 带人话引导，reason_code/session_id 原样保留', () => {
  const { identity } = createDemoActorIdentity()
  assert.throws(
    () => resolveExecutionActor({ agent: { id: SESSION_A } }, identity),
    (error: unknown) => {
      const body = JSON.parse(String((error as Error).message).slice(String((error as Error).message).indexOf(': ') + 2)) as Record<string, unknown>
      assert.equal(body.reason_code, 'SESSION_NOT_BOUND')
      assert.equal(body.session_id, SESSION_A)
      assert.equal(String(body.message), ACTOR_UNBOUND_HUMAN_HINT)
      // 面向 HR/模型的那句话必须可读（不是第二份 JSON）
      assert.match(String(body.message), /请先在招聘工作台顶部选择身份/)
      return true
    },
  )
})

test('O4：resolveSessionActor 显式 session 未绑定 → 同一句引导（HTTP 路径共用）', () => {
  const { identity } = createDemoActorIdentity()
  assert.throws(
    () => resolveSessionActor(identity, UBOUND_SESSION),
    (error: unknown) => {
      assert.match(String((error as Error).message), /SESSION_NOT_BOUND/)
      assert.match(String((error as Error).message), /请先在招聘工作台顶部选择身份（Recruiter \/ Interviewer A \/ B），再操作。/)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
//  O16：facts 路由未绑定 → 409 + SESSION_NOT_BOUND + 人话（不是 READER_FAILED）
// ---------------------------------------------------------------------------

interface Captured {
  readonly status: number
  readonly json: Record<string, unknown>
}

class FakeResponse {
  status = 0
  headers: Record<string, unknown> = {}
  headersSent = false
  private chunks: string[] = []
  private settle!: (value: Captured) => void
  readonly done = new Promise<Captured>((resolve) => { this.settle = resolve })

  writeHead(status: number, headers?: Record<string, unknown>): this {
    this.status = status
    this.headers = headers ?? {}
    this.headersSent = true
    return this
  }

  end(chunk?: unknown): void {
    if (chunk !== undefined && chunk !== null) this.chunks.push(String(chunk))
    const text = this.chunks.join('')
    let json: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(text)
      json = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      json = {}
    }
    this.settle({ status: this.status, json })
  }
}

class FakeRequest {
  readonly headers: Record<string, string | undefined>
  readonly method: string
  readonly url: string

  constructor(options: { url: string; method?: string; headers?: Record<string, string | undefined> }) {
    this.url = options.url
    this.method = options.method ?? 'GET'
    this.headers = { host: '127.0.0.1:49347', 'x-recruitment-request': '1', ...(options.headers ?? {}) }
  }
}

/** 起一个假 webServer（只记录注册），把 decision 三条路由抓出来。 */
function decisionRegister(identity: ReturnType<typeof createIdentity>['identity']): {
  readonly handler: (req: unknown, res: unknown) => void | Promise<void>
} {
  const registered: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }> = []
  const ctx: DecisionHostContext = {
    webServer: {
      host: '127.0.0.1',
      port: 49347,
      register: (route) => {
        registered.push(route as unknown as (typeof registered)[number])
        return () => {}
      },
    },
  }
  registerDecisionHttp(ctx, { database: null, databaseIssues: ['database.password_env'], identity })
  const facts = registered.find((route) => route.path === DECISION_PATHS.facts)
  assert.ok(facts !== undefined, `facts 路由未注册：${registered.map((route) => route.path).join(', ')}`)
  return { handler: facts.handler }
}

async function send(
  handler: (req: unknown, res: unknown) => void | Promise<void>,
  request: FakeRequest,
): Promise<Captured> {
  const response = new FakeResponse()
  await handler(request, response)
  return await response.done
}

test('O16：未绑定 session 调 GET decision/facts → 409 SESSION_NOT_BOUND + 人话（不是读取失败）', async () => {
  const { identity } = createIdentity()
  const { handler } = decisionRegister(identity)
  const result = await send(handler, new FakeRequest({
    url: `${DECISION_PATHS.facts}?application_id=${APPLICATION}`,
    headers: { 'x-dsh-session': UBOUND_SESSION },
  }))
  assert.equal(result.status, 409)
  const error = result.json.error as Record<string, unknown>
  assert.equal(error.code, 'DEMO_ACTOR_UNMAPPED')
  assert.equal(error.reason_code, 'SESSION_NOT_BOUND', '未绑定必须有专门 reason，不能落成读库失败')
  assert.equal(String(error.message), ACTOR_UNBOUND_HUMAN_HINT)
  assert.match(String(error.message), /请先在招聘工作台顶部选择身份/)
  // 归因反例：这句话里不能出现"读取失败 / READER_FAILED"（O16 的病根）
  assert.doesNotMatch(String(error.message), /读取失败|READER_FAILED/)
})

test('O16：未绑定 session 不会因为"读库"才失败 —— 绑定前先被身份闸门拒（database=null 也一致）', async () => {
  const { identity } = createIdentity()
  const { handler } = decisionRegister(identity)
  // 没带 x-dsh-session：既有口径仍是 400 SESSION_REQUIRED（缺参数，不是未绑定）。
  const noHeader = await send(handler, new FakeRequest({
    url: `${DECISION_PATHS.facts}?application_id=${APPLICATION}`,
    headers: { 'x-dsh-session': undefined },
  }))
  assert.equal(noHeader.status, 400)
  assert.equal((noHeader.json.error as Record<string, unknown>).reason_code, 'SESSION_REQUIRED')

  // 已绑定（但库未配置）：身份闸门通过 → 503 NOT_CONFIGURED；证明 409 的归因确实是"身份未绑定"。
  identity.registry.bind(SESSION_A, 'recruiter')
  const bound = await send(handler, new FakeRequest({
    url: `${DECISION_PATHS.facts}?application_id=${APPLICATION}`,
    headers: { 'x-dsh-session': SESSION_A },
  }))
  assert.equal(bound.status, 503)
  assert.equal((bound.json.error as Record<string, unknown>).code, 'NOT_CONFIGURED')
})

// ---------------------------------------------------------------------------
//  O3：占位凭据（入参层拒绝；人话；trace to PLACEHOLDER_CONFIRMATION）
// ---------------------------------------------------------------------------

/** 一条 STEP 0 全合法、只把 human_confirmation 换成占位值的 SCREENING 入参。 */
function screeningArgs(confirmation: Record<string, unknown>): Record<string, unknown> {
  // as_of / confirmed_at 用相对 now 的最近时刻：否则会先撞 AS_OF_IN_FUTURE（与本用例无关）。
  const recent = new Date(Date.now() - 60_000).toISOString()
  return {
    application_id: APPLICATION,
    decision_scope: 'SCREENING',
    as_of: recent,
    result: 'HOLD',
    reason: '占位凭据负例',
    basis_refs: [{ kind: 'AUTHORITY', actor_id: ACTOR_103, is_hiring_manager: false }],
    human_confirmation: {
      confirmed_at: recent,
      confirmation_method: 'IN_APP_CONFIRM',
      confirmation_text_sha256: HEX_A,
      ...confirmation,
    },
  }
}

test('O3：全零 confirmed_by_actor_id → INVALID_ARGS/PLACEHOLDER_CONFIRMATION + 人话 message', () => {
  assert.throws(
    () => parseDecisionArgs(screeningArgs({ confirmed_by_actor_id: '00000000-0000-0000-0000-000000000000' }), Date.now()),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'INVALID_ARGS')
      assert.equal(body.reason_code, 'PLACEHOLDER_CONFIRMATION')
      assert.equal(body.message, `${PLACEHOLDER_CONFIRMATION_MESSAGE}（confirmed_by_actor_id 是全零 UUID）`)
      assert.match(String(body.message), /确认人必须是真实身份，不能用占位值/)
      const violations = (body.detail as Record<string, unknown>).violations as Array<Record<string, unknown>>
      assert.equal(violations[0]?.path, 'human_confirmation.confirmed_by_actor_id')
      return true
    },
  )
})

test('O3：全零 confirmation_text_sha256 → INVALID_ARGS/PLACEHOLDER_CONFIRMATION + 人话 message', () => {
  assert.throws(
    () => parseDecisionArgs(screeningArgs({
      confirmed_by_actor_id: ACTOR_103,
      confirmation_text_sha256: '0'.repeat(64),
    }), Date.now()),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'INVALID_ARGS')
      assert.equal(body.reason_code, 'PLACEHOLDER_CONFIRMATION')
      assert.match(String(body.message), /占位值/)
      assert.doesNotMatch(String(body.message), /^参数不合法/, '占位凭据必须给一句人话，而不是通用参数错误')
      const violations = (body.detail as Record<string, unknown>).violations as Array<Record<string, unknown>>
      assert.equal(violations[0]?.path, 'human_confirmation.confirmation_text_sha256')
      return true
    },
  )
})

test('O3：非法 UUID（非全零）仍报原有 ID_NOT_UUID（不吞掉既有口径）', () => {
  assert.throws(
    () => parseDecisionArgs(screeningArgs({ confirmed_by_actor_id: 'not-a-uuid' }), Date.now()),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'INVALID_ARGS')
      assert.equal(body.reason_code, 'ID_NOT_UUID')
      return true
    },
  )
})

test('O3：高层 record_human_decision 的 confirmed_by_actor_id 全零 → 入参层 PLACEHOLDER_CONFIRMATION（不碰库）', async () => {
  const database = resolveDatabaseConfig({
    host: '127.0.0.1', port: 1, user: 'postgres', database: 'ra_fix_srv',
    tenant_id: '11111111-1111-4111-8111-000000000001',
    actor_id: ACTOR_103,
  }, { RECRUITMENT_DB_PASSWORD: 'unused-in-this-test' })
  assert.ok(database.resolved !== null, '配置应能解析（本用例不建连接）')
  const tool = createRecordHumanDecisionTool({ database: database.resolved })
  const recent = new Date(Date.now() - 60_000).toISOString()
  await assert.rejects(
    () => tool.execute({
      application_id: APPLICATION,
      decision_scope: 'SCREENING',
      result: 'HOLD',
      reason: '占位凭据负例',
      human_confirmation: {
        confirmed_by_actor_id: '00000000-0000-0000-0000-000000000000',
        confirmed_at: recent,
        method: 'IN_CHAT',
        text: '我确认',
      },
    }, {}),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'INVALID_ARGS')
      assert.equal(body.reason_code, 'PLACEHOLDER_CONFIRMATION')
      assert.match(String(body.message), /确认人必须是真实身份，不能用占位值/)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
//  O12：remediation 纯函数按 approval 真值；next_step 同真值
// ---------------------------------------------------------------------------

const RUBRIC_V1 = { id: '11111111-1111-4111-8111-000000000403', version_no: 1, approved: false }
const RUBRIC_V2 = { id: 'eca33003-fb03-42c8-ae97-99c09207ff0b', version_no: 2, approved: true }

test('O12：v1 被钉住未批准 + v2 已批准 → 建议里不出现"审批 v2"，且指明钉住版本未批准', () => {
  const advice = deriveRubricRemediation({ pinned: RUBRIC_V1, current: RUBRIC_V2 })
  assert.equal(advice.code, 'PINNED_VERSION_NOT_APPROVED')
  assert.equal(advice.pinned_approved, false)
  assert.equal(advice.job_current_approved, true)
  assert.equal(advice.rebind_action_available, false)
  const text = JSON.stringify(advice)
  assert.doesNotMatch(text, /审批\s*v2/)
  assert.doesNotMatch(text, /approve\s*v2/i)
  assert.match(advice.message, /钉住版本 v1 未批准/)
  assert.match(advice.message, /按钉住版本继续/)
  assert.match(advice.message, /没有"把申请重绑到已批准版本"的产品入口/)
})

test('O12：钉住版本已批准 → CONTINUE_WITH_PINNED（不再提审批）', () => {
  const advice = deriveRubricRemediation({ pinned: { ...RUBRIC_V1, approved: true }, current: RUBRIC_V2 })
  assert.equal(advice.code, 'CONTINUE_WITH_PINNED')
  assert.match(advice.message, /按钉住版本继续/)
  assert.doesNotMatch(JSON.stringify(advice), /审批\s*v[12]/)
})

test('O12：钉住未批准且岗位也无已批准版本 → 先批准钉住版本（不是岗位当前版本）', () => {
  const advice = deriveRubricRemediation({ pinned: RUBRIC_V1, current: { ...RUBRIC_V2, approved: false } })
  assert.equal(advice.code, 'APPROVE_PINNED_VERSION')
  assert.match(advice.message, /先由人批准 v1/)
})

test('O12：未钉住 + 岗位当前已批准 → NO_RUBRIC_PINNED（补钉即可，不是审批）', () => {
  const advice = deriveRubricRemediation({ pinned: undefined, current: RUBRIC_V2 })
  assert.equal(advice.code, 'NO_RUBRIC_PINNED')
  assert.match(advice.message, /补钉/)
  assert.doesNotMatch(JSON.stringify(advice), /审批\s*v2/)
})

test('O12 next_step：钉住版本未批准 → RESOLVE_RUBRIC_STANDARD（不是"等待初筛决定"）', () => {
  const base: ApplicationGateFacts = {
    lifecycle_status: 'ACTIVE',
    current_stage_code: 'S7',
    has_material: true,
    parse_status: 'PARSED',
    has_current_screening_decision: false,
    has_scheduled_interview: false,
    has_post_interview_scorecard_gap: false,
    has_current_stage_decision: false,
    pinned_rubric_approved: false,
    pinned_rubric_version_no: 1,
  }
  const blocked = deriveApplicationNextStep(base)
  assert.equal(blocked.code, 'RESOLVE_RUBRIC_STANDARD')
  assert.equal(blocked.kind, 'HUMAN_ACTION')
  assert.match(blocked.label, /评分标准/)
  // 已批准（或未知）时保持既有口径：等待初筛决定。
  assert.equal(deriveApplicationNextStep({ ...base, pinned_rubric_approved: true }).code, 'PROVIDE_SCREENING_DECISION')
  assert.equal(deriveApplicationNextStep({ ...base, pinned_rubric_approved: null }).code, 'PROVIDE_SCREENING_DECISION')
})
