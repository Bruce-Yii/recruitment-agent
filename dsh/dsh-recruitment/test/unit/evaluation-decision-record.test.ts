// S10 决策工具的参数层 / 人工确认 / approval 闸门（**不连库**）。
//
// 覆盖（对应任务书的 unit 清单）：
//   * 参数层负例：HIRED、stage_code、idempotency_key、scope/interview 互斥、as_of 缺失/未来/格式、
//     basis kind 非九种、digest 形状、missing_ack 两条、supersede 三条；
//   * human_confirmation 五个 reason_code 各一条（DECIDER_NOT_HUMAN / NO_HUMAN_CONFIRMATION /
//     CONFIRMATION_SUBJECT_MISMATCH / CONFIRMATION_TEXT_MISMATCH / CONFIRMATION_STALE）；
//   * `confirmation_text_sha256` 的 pre-image 四键规则（含 `override_rationale: null` 不省略键）；
//   * approval 三态：无依赖 → APPROVAL_UNAVAILABLE；`rejected` → APPROVAL_NOT_GRANTED；
//     只有 `allowed-once` 放行（"进主体"由 integration 证明）；
//   * `parameters` / `output.schema` 的 DSH 子集封闭性（无 type 数组、无 type:null、
//     required ⊆ properties、additionalProperties:false），以及"出参无 null"（stripNulls）。
//
// 已知偏差（与实现文件头一致）：`stage_code` 是**声明后拒收**（TENANT_OR_ACTOR_NOT_ALLOWED），
// `idempotency_key` **不在 schema**（UNKNOWN_PARAM，D-80）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertHumanDecider,
  confirmationTextSha256,
  createDecisionRecordTool,
  makeApprovalRequest,
  parseDecisionArgs,
  requireApprovalGranted,
  stripNulls,
  type ApprovalOutcome,
} from '../../src/tools/decision-record.ts'
import { digestOf } from '../../src/tools/contract.ts'
import { resolveDatabaseConfig } from '../../src/db/pool.ts'

const NOW = Date.parse('2026-11-13T02:00:00+08:00')
const AS_OF = '2026-11-13T01:00:00+08:00'
const APP = '11111111-1111-4111-8111-000000000701'
const INTERVIEW = '11111111-1111-4111-8111-000000000801'
const RUBRIC = '11111111-1111-4111-8111-000000000403'
const HUMAN = '11111111-1111-4111-8111-000000000103'
const OTHER_HUMAN = '11111111-1111-4111-8111-000000000104'
const SCORECARD = '11111111-1111-4111-8111-000000000c01'
const INTERVIEWER_X = '11111111-1111-4111-8111-000000000a01'
const PAYLOAD_HASH = 'b'.repeat(64)
const SUMMARY_DIGEST = 'a'.repeat(64)

/** 每条决策必带的三条依据（DC §6.1）。 */
function basisRefs(extra: Record<string, unknown>[] = []): Record<string, unknown>[] {
  return [
    {
      kind: 'SUMMARY',
      summary_digest: SUMMARY_DIGEST,
      contract_version: '2.0.0',
      coverage: { required_total: 3, submitted: 2, waived: 0, missing: 1 },
      tally: { advance: 2, hold: 0, reject: 0, waived: 0 },
      consensus: 'UNANIMOUS_ADVANCE',
      provenance: 'FIXTURE',
    },
    { kind: 'RUBRIC_VERSION', id: RUBRIC, version_no: 1, payload_hash: PAYLOAD_HASH },
    { kind: 'AUTHORITY', actor_id: HUMAN, is_hiring_manager: false },
    ...extra,
  ]
}

function scorecardRef(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'SCORECARD',
    id: SCORECARD,
    revision_no: 1,
    interviewer_id: INTERVIEWER_X,
    payload_hash: 'c'.repeat(64),
    overall: 'ADVANCE',
    transcript_basis: 'NO_TRANSCRIPT',
    transcript_state: 'NO_TRANSCRIPT',
    fields: [{ dimension_key: 'backend_depth', assessment: 'MET', evidence: [] }],
    ...overrides,
  }
}

/** 一条完整合法入参（STAGE / HOLD）。 */
function baseArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const args: Record<string, unknown> = {
    application_id: APP,
    decision_scope: 'STAGE',
    interview_id: INTERVIEW,
    as_of: AS_OF,
    result: 'HOLD',
    reason: '暂不决定：还差第三位面试官的面评，等补齐再谈',
    basis_refs: basisRefs([scorecardRef()]),
    summary_digest: SUMMARY_DIGEST,
    human_confirmation: {
      confirmed_by_actor_id: HUMAN,
      confirmed_at: '2026-11-13T01:59:00+08:00',
      confirmation_method: 'IN_APP_CONFIRM',
      confirmation_text_sha256: 'd'.repeat(64),
    },
  }
  return { ...args, ...overrides }
}

interface ErrorBody {
  readonly code: string
  readonly reason_code: string
  readonly family?: string
  readonly message: string
  readonly detail?: Record<string, unknown>
}

/** 从 `Error: <CODE>: <json>` 里取出错误体（TC §1.2）。 */
function errorBodyOf(fn: () => unknown): ErrorBody {
  try {
    fn()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const index = message.indexOf(': ')
    assert.ok(index > 0, `错误消息不是 <CODE>: <json> 形态：${message}`)
    const code = message.slice(0, index)
    const body = JSON.parse(message.slice(index + 2)) as Record<string, unknown>
    assert.equal(body.code, code, '消息前缀的 code 必须与 JSON 里的 code 相同（TC §1.2）')
    return body as unknown as ErrorBody
  }
  assert.fail('期望抛错但没抛')
}

/** `parseDecisionArgs` 的负例断言：只看"第一条违反项"。 */
function parseRejects(overrides: Record<string, unknown>, reasonCode: string, pathIncludes?: string): ErrorBody {
  const body = errorBodyOf(() => parseDecisionArgs(baseArgs(overrides), NOW))
  assert.equal(body.code, 'INVALID_ARGS')
  assert.equal(body.reason_code, reasonCode, `期望 ${reasonCode}，实际 ${body.reason_code}：${body.message}`)
  const violations = (body.detail as { violations?: { reason_code: string; path: string }[] }).violations ?? []
  assert.ok(violations.length > 0, 'detail.violations 不得为空（TC §1.1 第 7 条）')
  if (pathIncludes !== undefined) {
    assert.ok(violations[0]?.path.includes(pathIncludes), `期望 path 含 ${pathIncludes}，实际 ${violations[0]?.path}`)
  }
  return body
}

// =====================================================================
//  1. 参数层
// =====================================================================

test('合法入参被归一化（STAGE/HOLD：三个必带 kind + 一条面评）', () => {
  const args = parseDecisionArgs(baseArgs(), NOW)
  assert.equal(args.application_id, APP)
  assert.equal(args.decision_scope, 'STAGE')
  assert.equal(args.interview_id, INTERVIEW)
  assert.equal(args.result, 'HOLD')
  assert.equal(args.summary_digest, SUMMARY_DIGEST)
  assert.equal(args.basis_refs.length, 4)
  assert.deepEqual(args.acknowledged_missing, [])
  assert.equal(args.supersedes, undefined)
})

test('result=HIRED → RESULT_NOT_IN_V1_SCOPE（v1.0 禁用，STEP 0 就拦）', () => {
  parseRejects({ result: 'HIRED' }, 'RESULT_NOT_IN_V1_SCOPE', 'result')
})

test('result 非枚举 → ENUM_INVALID', () => {
  parseRejects({ result: 'MAYBE' }, 'ENUM_INVALID', 'result')
})

test('stage_code 是保留键：声明在 schema 里，但拒收（TENANT_OR_ACTOR_NOT_ALLOWED）', () => {
  parseRejects({ stage_code: 'S10' }, 'TENANT_OR_ACTOR_NOT_ALLOWED', 'stage_code')
  parseRejects({ stage_code: 'INTERVIEW' }, 'TENANT_OR_ACTOR_NOT_ALLOWED', 'stage_code')
})

test('decided_by_actor_id / decided_at / tenant_id / actor_id 一律拒收（TC §1.6）', () => {
  for (const key of ['decided_by_actor_id', 'decided_at', 'tenant_id', 'actor_id']) {
    parseRejects({ [key]: HUMAN }, 'TENANT_OR_ACTOR_NOT_ALLOWED', key)
  }
})

test('idempotency_key 不在 schema → UNKNOWN_PARAM（D-80：v1.0 不做客户端幂等）', () => {
  const body = parseRejects({ idempotency_key: 'dec-1' }, 'UNKNOWN_PARAM', 'idempotency_key')
  const allowed = (body.detail as { allowed?: string[] }).allowed ?? []
  assert.ok(allowed.includes('application_id'), 'detail.allowed 必须列出允许键')
  assert.equal(allowed.includes('idempotency_key'), false)
})

test('scope/interview 互斥：STAGE 必填 / FINAL 禁止 / SCREENING 不属于 S10', () => {
  parseRejects({ interview_id: undefined }, 'STAGE_REQUIRES_INTERVIEW', 'interview_id')
  parseRejects({ decision_scope: 'FINAL' }, 'FINAL_SCOPE_NO_INTERVIEW', 'interview_id')
  parseRejects({ decision_scope: 'SCREENING' }, 'DECISION_SCOPE_NOT_S10', 'decision_scope')
})

test('as_of：缺失 → MISSING_REQUIRED；未来 → AS_OF_IN_FUTURE；格式错 → TYPE_MISMATCH', () => {
  parseRejects({ as_of: undefined }, 'MISSING_REQUIRED', 'as_of')
  parseRejects({ as_of: '2027-01-01T00:00:00+08:00' }, 'AS_OF_IN_FUTURE', 'as_of')
  // DESIGN §2：TC §5.1 没有 AS_OF_FORMAT，格式错按 TYPE_MISMATCH。
  parseRejects({ as_of: '2026-11-13 01:00:00' }, 'TYPE_MISMATCH', 'as_of')
  parseRejects({ as_of: '2026-11-13T01:00:00' }, 'TYPE_MISMATCH', 'as_of')
})

test('basis_refs：空数组 → BASIS_REF_EMPTY；kind 非九种（含 AI_SUMMARY）→ BASIS_KIND_FORBIDDEN', () => {
  parseRejects({ basis_refs: [] }, 'BASIS_REF_EMPTY', 'basis_refs')
  parseRejects({ basis_refs: [{ kind: 'AI_SUMMARY', summary_digest: SUMMARY_DIGEST }] }, 'BASIS_KIND_FORBIDDEN', 'kind')
  parseRejects({ basis_refs: [{ kind: 'SCORE', id: SCORECARD }] }, 'BASIS_KIND_FORBIDDEN', 'kind')
})

test('basis_refs 超上限（200）→ OUT_OF_RANGE', () => {
  const many = Array.from({ length: 201 }, () => ({ kind: 'SUMMARY', summary_digest: SUMMARY_DIGEST }))
  parseRejects({ basis_refs: many }, 'OUT_OF_RANGE', 'basis_refs')
})

test('basis_refs[].kind 缺 → MISSING_REQUIRED；kind=SCORECARD 缺 overall/transcript_state → MISSING_REQUIRED', () => {
  parseRejects({ basis_refs: [{ id: SCORECARD }] }, 'MISSING_REQUIRED', 'kind')
  const body = parseRejects(
    { basis_refs: basisRefs([{ kind: 'SCORECARD', id: SCORECARD, transcript_basis: 'NO_TRANSCRIPT' }]) },
    'MISSING_REQUIRED',
    'basis_refs[3].overall',
  )
  const violations = (body.detail as { violations?: { path: string }[] }).violations ?? []
  assert.ok(violations.some((v) => v.path.includes('transcript_state')), 'transcript_state 也必须报缺失（TR-E7）')
})

test('basis_refs[SCORECARD] 的未知键（如 recommendation）→ UNKNOWN_PARAM', () => {
  parseRejects(
    { basis_refs: basisRefs([scorecardRef({ recommendation: 'ADVANCE' })]) },
    'UNKNOWN_PARAM',
    'recommendation',
  )
})

test('basis_refs[SCORECARD].fields[].assessment 非四态 → ENUM_INVALID', () => {
  parseRejects(
    { basis_refs: basisRefs([scorecardRef({ fields: [{ dimension_key: 'd1', assessment: 'MAYBE' }] })]) },
    'ENUM_INVALID',
    'assessment',
  )
})

test('summary_digest 形状：非 64 hex → TYPE_MISMATCH', () => {
  parseRejects({ summary_digest: 'zz' }, 'TYPE_MISMATCH', 'summary_digest')
  parseRejects({ summary_digest: 'a'.repeat(63) }, 'TYPE_MISMATCH', 'summary_digest')
  parseRejects({ summary_digest: 'A'.repeat(64) }, 'TYPE_MISMATCH', 'summary_digest')
})

test('missing_ack 两条：非 ADVANCE 带确认 → MUTUALLY_EXCLUSIVE；同一人出现两次 → OUT_OF_RANGE', () => {
  // (a) HOLD 不接受缺人确认（矩阵里它不需要任何确认，DC §4.2）
  parseRejects(
    { missing_disposition: 'PROCEED_WITH_MISSING', acknowledged_missing: [{ interviewer_id: INTERVIEWER_X, why_proceed: '补' }] },
    'MUTUALLY_EXCLUSIVE',
    'missing_disposition',
  )
  // (b) 同一个人确认两次是数据错误（TC §1.1 第 6 条）
  parseRejects(
    {
      result: 'ADVANCE',
      missing_disposition: 'PROCEED_WITH_MISSING',
      acknowledged_missing: [
        { interviewer_id: INTERVIEWER_X, why_proceed: '他的维度已交叉覆盖' },
        { interviewer_id: INTERVIEWER_X, why_proceed: '再说一次' },
      ],
    },
    'OUT_OF_RANGE',
    'interviewer_id',
  )
})

test('missing_ack：why_proceed 空白 → OUT_OF_RANGE；interviewer_id 非 UUID → ID_NOT_UUID', () => {
  parseRejects(
    {
      result: 'ADVANCE',
      missing_disposition: 'PROCEED_WITH_MISSING',
      acknowledged_missing: [{ interviewer_id: INTERVIEWER_X, why_proceed: '   ' }],
    },
    'OUT_OF_RANGE',
    'why_proceed',
  )
  parseRejects(
    {
      result: 'ADVANCE',
      missing_disposition: 'PROCEED_WITH_MISSING',
      acknowledged_missing: [{ interviewer_id: 'iv_0001', why_proceed: '补' }],
    },
    'ID_NOT_UUID',
    'interviewer_id',
  )
})

test('supersede 三条：缺 reason / expected_record_version 越界 / 未知键', () => {
  parseRejects(
    { supersedes: { decision_id: SCORECARD, expected_record_version: 1 } },
    'MISSING_REQUIRED',
    'supersedes.reason',
  )
  parseRejects(
    { supersedes: { decision_id: SCORECARD, reason: '改成待定', expected_record_version: 0 } },
    'OUT_OF_RANGE',
    'expected_record_version',
  )
  parseRejects(
    { supersedes: { decision_id: SCORECARD, reason: '改成待定', expected_record_version: 1, force: true } },
    'UNKNOWN_PARAM',
    'force',
  )
})

test('human_confirmation：未知键 → UNKNOWN_PARAM；method 非枚举 → ENUM_INVALID；hash 形状错 → TYPE_MISMATCH', () => {
  parseRejects(
    { human_confirmation: { ...baseArgs().human_confirmation as Record<string, unknown>, extra: 1 } },
    'UNKNOWN_PARAM',
    'extra',
  )
  parseRejects(
    { human_confirmation: { ...baseArgs().human_confirmation as Record<string, unknown>, confirmation_method: 'CLICK' } },
    'ENUM_INVALID',
    'confirmation_method',
  )
  parseRejects(
    { human_confirmation: { ...baseArgs().human_confirmation as Record<string, unknown>, confirmation_text_sha256: 'abc' } },
    'TYPE_MISMATCH',
    'confirmation_text_sha256',
  )
})

test('参数层一次收集全部违反项（不是遇到第一条就返回）', () => {
  const body = errorBodyOf(() => parseDecisionArgs({
    ...baseArgs(),
    result: 'HIRED',
    as_of: '2027-01-01T00:00:00+08:00',
    summary_digest: 'zz',
  }, NOW))
  const violations = (body.detail as { violations?: unknown[] }).violations ?? []
  assert.ok(violations.length >= 3, `期望 ≥3 条违反项，实际 ${violations.length}`)
})

// =====================================================================
//  2. human_confirmation（五个 reason_code 各一条）
// =====================================================================

const CONFIRMATION_REASON = '暂不决定：还差第三位面试官的面评'
const CONFIRMATION_BASIS = basisRefs([scorecardRef()])

/** 一份"内容 hash 正确"的人工确认（其余字段可覆盖）。 */
function confirmation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    confirmed_by_actor_id: HUMAN,
    confirmed_at: '2026-11-13T01:59:00+08:00',
    confirmation_method: 'IN_APP_CONFIRM',
    confirmation_text_sha256: confirmationTextSha256({
      result: 'HOLD',
      reason: CONFIRMATION_REASON,
      override_rationale: null,
      basis_refs: CONFIRMATION_BASIS,
    }),
    ...overrides,
  }
}

/** 跑一次 `assertHumanDecider`（默认全部正确）。 */
function assertHuman(overrides: Record<string, unknown> = {}): void {
  assertHumanDecider({
    actorId: HUMAN,
    actorKind: 'HUMAN',
    confirmation: confirmation(),
    nowMs: NOW,
    result: 'HOLD',
    reason: CONFIRMATION_REASON,
    overrideRationale: null,
    basisRefs: CONFIRMATION_BASIS,
    ...overrides,
  })
}

test('人工确认正例：四字段齐全、确认人 = actor、hash 对得上、时间在 24h 内', () => {
  assertHuman()
})

test('DECIDER_NOT_HUMAN：上下文 actor 的 kind 不是 HUMAN（SYSTEM / AGENT_WORKER）', () => {
  for (const kind of ['SYSTEM', 'AGENT_WORKER']) {
    const body = errorBodyOf(() => assertHuman({ actorKind: kind }))
    assert.equal(body.code, 'DECISION_REQUIRES_HUMAN')
    assert.equal(body.reason_code, 'DECIDER_NOT_HUMAN')
  }
})

test('NO_HUMAN_CONFIRMATION：缺整个对象或四要素不齐（DC-08）', () => {
  for (const bad of [undefined, {}, { confirmed_by_actor_id: HUMAN }, { ...confirmation(), confirmation_method: '' }]) {
    const body = errorBodyOf(() => assertHuman({ confirmation: bad }))
    assert.equal(body.code, 'DECISION_REQUIRES_HUMAN')
    assert.equal(body.reason_code, 'NO_HUMAN_CONFIRMATION')
  }
})

test('CONFIRMATION_SUBJECT_MISMATCH：不能替别人确认（DC-09）', () => {
  const body = errorBodyOf(() => assertHuman({
    confirmation: confirmation({ confirmed_by_actor_id: OTHER_HUMAN }),
  }))
  assert.equal(body.reason_code, 'CONFIRMATION_SUBJECT_MISMATCH')
})

test('CONFIRMATION_TEXT_MISMATCH：人确认的不是这一版内容（DC-11）', () => {
  const body = errorBodyOf(() => assertHuman({
    confirmation: confirmation({ confirmation_text_sha256: 'e'.repeat(64) }),
  }))
  assert.equal(body.reason_code, 'CONFIRMATION_TEXT_MISMATCH')
  // 改一个字也要变红：hash 覆盖的是内容，不是"点了确认"这个动作。
  const tampered = errorBodyOf(() => assertHuman({ reason: `${CONFIRMATION_REASON}（已改写）` }))
  assert.equal(tampered.reason_code, 'CONFIRMATION_TEXT_MISMATCH')
})

test('CONFIRMATION_STALE：晚于决策时刻，或与它相差超过 24h（TC §4.2）', () => {
  const future = errorBodyOf(() => assertHuman({
    confirmation: confirmation({ confirmed_at: '2026-11-13T03:00:00+08:00' }),
  }))
  assert.equal(future.reason_code, 'CONFIRMATION_STALE')
  const old = errorBodyOf(() => assertHuman({
    confirmation: confirmation({ confirmed_at: '2026-11-11T23:00:00+08:00' }),
  }))
  assert.equal(old.reason_code, 'CONFIRMATION_STALE')
})

// =====================================================================
//  3. confirmation_text_sha256 的 pre-image（四键，含 override_rationale:null）
// =====================================================================

test('pre-image 只有四个键 {result, reason, override_rationale, basis_refs}，且键序由 canonicalJson 固定', () => {
  const digest = confirmationTextSha256({
    result: 'REJECT',
    reason: 'backend_depth 两次澄清仍无容量估算',
    override_rationale: '两位面试官通过，但硬性维度有明确反证',
    basis_refs: CONFIRMATION_BASIS,
  })
  // 键序不同、但内容相同 ⇒ 同一个 hash（canonicalJson 排序）
  assert.equal(digest, digestOf({
    basis_refs: CONFIRMATION_BASIS,
    override_rationale: '两位面试官通过，但硬性维度有明确反证',
    reason: 'backend_depth 两次澄清仍无容量估算',
    result: 'REJECT',
  }))
  // 混进第五个键就不是同一个 pre-image
  assert.notEqual(digest, digestOf({
    result: 'REJECT',
    reason: 'backend_depth 两次澄清仍无容量估算',
    override_rationale: '两位面试官通过，但硬性维度有明确反证',
    basis_refs: CONFIRMATION_BASIS,
    decided_at: '2026-11-13T01:00:00+08:00',
  }))
})

test('override_rationale 未给时写 null 且**不省略键**（DC-11：否则理由可后补）', () => {
  const withNull = confirmationTextSha256({
    result: 'HOLD', reason: CONFIRMATION_REASON, override_rationale: null, basis_refs: CONFIRMATION_BASIS,
  })
  const omitted = digestOf({ result: 'HOLD', reason: CONFIRMATION_REASON, basis_refs: CONFIRMATION_BASIS })
  assert.equal(withNull, digestOf({
    result: 'HOLD', reason: CONFIRMATION_REASON, override_rationale: null, basis_refs: CONFIRMATION_BASIS,
  }))
  assert.notEqual(withNull, omitted, 'null 与"省略键"必须是不同的 pre-image')
  // 空串也不等于 null
  assert.notEqual(withNull, confirmationTextSha256({
    result: 'HOLD', reason: CONFIRMATION_REASON, override_rationale: '', basis_refs: CONFIRMATION_BASIS,
  }))
})

test('basis_refs 进 hash：换一条依据 → hash 变（依据不可事后替换）', () => {
  const a = confirmationTextSha256({
    result: 'HOLD', reason: CONFIRMATION_REASON, override_rationale: null, basis_refs: CONFIRMATION_BASIS,
  })
  const b = confirmationTextSha256({
    result: 'HOLD',
    reason: CONFIRMATION_REASON,
    override_rationale: null,
    basis_refs: basisRefs([scorecardRef({ overall: 'REJECT' })]),
  })
  assert.notEqual(a, b)
})

// =====================================================================
//  4. approval（D-79）：三态 + fail closed
// =====================================================================

test('没有 approval 依赖 → unavailable（headless 恒 fail closed）', async () => {
  const approve = makeApprovalRequest(undefined, undefined)
  assert.equal(await approve(), 'unavailable')
  const body = errorBodyOf(() => requireApprovalGranted('unavailable'))
  assert.equal(body.code, 'DECISION_REQUIRES_HUMAN')
  assert.equal(body.reason_code, 'APPROVAL_UNAVAILABLE')
})

test('宿主返回 rejected / cancelled → APPROVAL_NOT_GRANTED；只有 allowed-once 放行', async () => {
  for (const [returned, expected] of [
    ['rejected', 'rejected'],
    ['cancelled', 'cancelled'],
  ] as const) {
    const approve = makeApprovalRequest({ request: async () => returned }, undefined)
    const outcome = await approve()
    assert.equal(outcome, expected)
    const body = errorBodyOf(() => requireApprovalGranted(outcome))
    assert.equal(body.reason_code, 'APPROVAL_NOT_GRANTED')
  }
  assert.doesNotThrow(() => requireApprovalGranted('allowed-once'))
})

test('approval 请求把 agent/signal/toolName/reason 透传给宿主；非法返回归 unavailable', async () => {
  const seen: Record<string, unknown>[] = []
  const controller = new AbortController()
  const approve = makeApprovalRequest({
    request: async (req) => {
      seen.push({ ...req })
      return 'whatever-the-host-says'
    },
  }, { agent: { id: 'agent-1' }, signal: controller.signal })
  assert.equal(await approve(), 'unavailable')
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.toolName, 'recruitment_decision_record')
  assert.equal(seen[0]?.reason, 'S10 正式决策需要人工确认（D-79）')
  assert.deepEqual(seen[0]?.agent, { id: 'agent-1' })
  assert.equal(seen[0]?.signal, controller.signal)
})

test('ApprovalOutcome 的四个取值都被覆盖（防止悄悄加第五个）', () => {
  const outcomes: ApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']
  assert.equal(outcomes.length, 4)
})

// =====================================================================
//  5. schema 封闭性 + 出参无 null
// =====================================================================

const DATABASE = resolveDatabaseConfig({
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'ra_s6s7',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: HUMAN,
}, { RECRUITMENT_DB_PASSWORD: 'unused-in-this-test' })

const TOOL = createDecisionRecordTool({ database: DATABASE.resolved as NonNullable<typeof DATABASE.resolved> })

/** DSH 支持的约束关键字（与 test/unit/output-schema.test.ts 同一口径）。 */
const SUPPORTED = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean'])

function schemaViolations(schema: unknown, path = 'schema'): string[] {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return [`${path} 不是对象`]
  const out: string[] = []
  const node = schema as Record<string, unknown>
  for (const key of Object.keys(node)) {
    if (!SUPPORTED.has(key)) out.push(`${path}.${key} 不是受支持的关键字`)
  }
  if (Array.isArray(node.type)) out.push(`${path}.type 是数组（DSH 不支持）`)
  else if (typeof node.type === 'string') {
    if (!TYPES.has(node.type)) out.push(`${path}.type=${node.type} 不可用`)
  } else if (node.oneOf === undefined) {
    out.push(`${path}.type 缺失`)
  }
  const properties = node.properties as Record<string, unknown> | undefined
  for (const key of (node.required ?? []) as string[]) {
    if (properties === undefined || !Object.hasOwn(properties, key)) out.push(`${path}.required 里有未声明的键 ${key}`)
  }
  for (const [key, child] of Object.entries(properties ?? {})) out.push(...schemaViolations(child, `${path}.${key}`))
  if (node.items !== undefined) out.push(...schemaViolations(node.items, `${path}.items`))
  return out
}

function nullPaths(value: unknown, path = 'value'): string[] {
  if (value === null) return [path]
  if (Array.isArray(value)) return value.flatMap((item, index) => nullPaths(item, `${path}[${index}]`))
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => nullPaths(child, `${path}.${key}`))
  }
  return []
}

function valueViolations(schema: unknown, value: unknown, path = 'value'): string[] {
  const node = schema as Record<string, unknown>
  const type = node.type as string | undefined
  const typeOk = (): boolean => {
    switch (type) {
      case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
      case 'array': return Array.isArray(value)
      case 'string': return typeof value === 'string'
      case 'integer': return typeof value === 'number' && Number.isInteger(value)
      case 'number': return typeof value === 'number' && Number.isFinite(value)
      case 'boolean': return typeof value === 'boolean'
      default: return true
    }
  }
  if (!typeOk()) return [`${path} 类型不符（期望 ${type}）`]
  const out: string[] = []
  if (Array.isArray(node.enum) && !(node.enum as unknown[]).includes(value)) {
    out.push(`${path} 不在 enum 里：${JSON.stringify(value)}`)
  }
  if (type === 'array' && node.items !== undefined) {
    (value as unknown[]).forEach((item, index) => out.push(...valueViolations(node.items, item, `${path}[${index}]`)))
  }
  if (type === 'object') {
    const record = value as Record<string, unknown>
    const properties = (node.properties ?? {}) as Record<string, unknown>
    for (const key of (node.required ?? []) as string[]) {
      if (!Object.hasOwn(record, key)) out.push(`${path}.${key} 缺失（required）`)
    }
    if (node.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(properties, key)) out.push(`${path}.${key} 是未声明的键`)
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) out.push(...valueViolations(properties[key], child, `${path}.${key}`))
    }
  }
  return out
}

test('tool 形状：名字、不可并发、入参是封闭对象根', () => {
  assert.equal(TOOL.name, 'recruitment_decision_record')
  assert.equal(TOOL.isConcurrencySafe?.({}), false)
  const parameters = TOOL.parameters as Record<string, unknown>
  assert.equal(parameters.type, 'object')
  assert.equal(parameters.additionalProperties, false)
  assert.deepEqual(schemaViolations(parameters), [])
  assert.deepEqual(schemaViolations(TOOL.output.schema), [])
})

test('保留键确实声明在 parameters 里（否则会退化成 UNKNOWN_PARAM）', () => {
  const properties = (TOOL.parameters as { properties: Record<string, unknown> }).properties
  for (const key of ['tenant_id', 'actor_id', 'decided_by_actor_id', 'stage_code', 'decided_at']) {
    assert.ok(Object.hasOwn(properties, key), `${key} 必须声明（TC §1.6）`)
  }
  // D-80：幂等键不在 schema
  assert.equal(Object.hasOwn(properties, 'idempotency_key'), false)
  assert.equal(Object.hasOwn(properties, 'can_decide'), false)
})

/** 一份"契约逐字"的出参样本（含 TC §4.3 画成 null 的两个键）。 */
function sampleDecisionValue(): Record<string, unknown> {
  return {
    tool: 'recruitment_decision_record',
    contract_version: '2.0.0',
    status: 'OK',
    replayed: false,
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
    decision: {
      id: '11111111-1111-4111-8111-000000000d01',
      application_id: APP,
      interview_id: INTERVIEW,
      decision_scope: 'STAGE',
      stage_code: 'S10',
      result: 'HOLD',
      decided_by_actor_id: HUMAN,
      decided_at: '2026-11-13T01:59:10.000Z',
      record_version: 1,
      superseded_by_decision_id: null,
    },
    gate: {
      as_of: AS_OF,
      ready_for_decision: false,
      acknowledged_missing: [],
      permitted_results_echo: ['ADVANCE', 'HOLD', 'WITHDRAW'],
      summary_digest: SUMMARY_DIGEST,
    },
    superseded: null,
    event: { event_id: '11111111-1111-4111-8111-000000000e01', provider: 'internal', trust_level: 'INTERNAL' },
    warnings: [{ code: 'FIXTURE_BASIS', message: '演练数据' }],
  }
}

test('出参样本对 output.schema 零违反；stripNulls 后没有任何 null（DSH 校验器不支持 null）', () => {
  const value = sampleDecisionValue()
  // 契约形状确实带两个 null（TC §4.3）
  assert.deepEqual(nullPaths(value).sort(), ['value.decision.superseded_by_decision_id', 'value.superseded'])
  const stripped = stripNulls(value) as Record<string, unknown>
  assert.deepEqual(nullPaths(stripped), [])
  assert.equal(Object.hasOwn(stripped, 'superseded'), false)
  assert.equal(Object.hasOwn((stripped.decision as Record<string, unknown>), 'superseded_by_decision_id'), false)
  assert.deepEqual(valueViolations(TOOL.output.schema, stripped), [])
})

test('撤回出参：superseded 是 {decision_id, record_version}，也过 schema', () => {
  const value = stripNulls({
    ...sampleDecisionValue(),
    superseded: { decision_id: '11111111-1111-4111-8111-000000000d00', record_version: 2 },
    warnings: [{ code: 'SUPERSEDES_APPLIED', message: '撤回' }],
  }) as Record<string, unknown>
  assert.deepEqual(valueViolations(TOOL.output.schema, value), [])
})

test('FINAL scope 的出参不带 interview_id（null 键被省略后仍合法）', () => {
  const base = sampleDecisionValue()
  const decision = { ...(base.decision as Record<string, unknown>) }
  delete decision.interview_id
  const value = stripNulls({ ...base, decision: { ...decision, decision_scope: 'FINAL' } }) as Record<string, unknown>
  assert.deepEqual(valueViolations(TOOL.output.schema, value), [])
})

test('render()：中文摘要含决策 id/result/scope/gate/warnings 计数，且不打印候选人信息', () => {
  const value = stripNulls(sampleDecisionValue()) as Record<string, unknown>
  const blocks = TOOL.output.render({}, value)
  assert.equal(blocks.length, 1)
  const text = blocks[0]?.text ?? ''
  assert.match(text, /recruitment_decision_record 2\.0\.0/)
  assert.match(text, /decision 11111111-1111-4111-8111-000000000d01 scope=STAGE stage=S10 result=HOLD/)
  assert.match(text, /gate: as_of=/)
  assert.match(text, /warnings\(1\)/)
  assert.match(text, /FIXTURE_BASIS/)
  assert.equal(/name|phone|email|候选人姓名/.test(text), false)
})
