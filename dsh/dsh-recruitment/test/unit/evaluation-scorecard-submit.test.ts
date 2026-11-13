// 面评提交工具（`recruitment_scorecard_submit`）的**参数层 + 纯函数**单测。
//
// 不连库：只测 `src/tools/scorecard-submit.ts` 导出的纯函数与两份 JSON Schema 的封闭性。
// 覆盖（对应 `contracts/evaluation/tool-contracts.md` §1.1 / §2.1 / §2.6 / §7.1）：
//   1. 参数层负例全覆盖：未知键、类型、UUID、`items` 传数组、`TRANSCRIPT_SEGMENT` kind、
//      保留键（8 个）、整数/数组越界、**一次收集多条 violations**（§1.1 第 7 条）；
//   2. 语义层纯函数：覆盖率、四态/分值冲突、NOT_MET 必填 note、ADVANCE 两条、REJECT 四条、
//      `NO_TRANSCRIPT` 不得带 `SEGMENT`；
//   3. `rationale` 固定编码（G-1 / DESIGN §3.5 ②）的编码与解码；
//   4. `payload_hash`（SC-38）的确定性；
//   5. `output.schema` 只用 DSH 受支持子集（无 type 数组 / 无 type:'null' / required ⊆ properties），
//      且样例值逐值合法；`parameters` 是封闭对象根，保留键"声明但拒收"。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildRationale,
  computeScorecardPayloadHash,
  createScorecardSubmitTool,
  parseRejectReasonsFromRationale,
  parseScorecardSubmitArgs,
  validateScorecardSemantics,
  type ScorecardRejectReason,
} from '../../src/tools/scorecard-submit.ts'
import { canonicalJson, digestOf } from '../../src/tools/contract.ts'
import { resolveDatabaseConfig } from '../../src/db/pool.ts'

const DATABASE = resolveDatabaseConfig({
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'ra_s6s7',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
}, { RECRUITMENT_DB_PASSWORD: 'unused-in-this-test' }).resolved

if (DATABASE === null) throw new Error('测试配置解析失败（不连库，只是形状）')

const TOOL = createScorecardSubmitTool({ database: DATABASE })

const INTERVIEW_ID = '11111111-1111-4111-8111-000000000d01'
const RUBRIC_ID = '11111111-1111-4111-8111-000000000403'
const SCORECARD_ID = '11111111-1111-4111-8111-000000000e01'
const ARTIFACT_ID = '11111111-1111-4111-8111-000000000f01'
const SEGMENT_ID = '11111111-1111-4111-8111-000000001001'

/** 从契约错误里取回 JSON 体（消息形态 `<CODE>: <compact-json>`）。 */
function errorBody(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  const json = index >= 0 ? message.slice(index + 2) : message
  return JSON.parse(json) as Record<string, unknown>
}

/** 断言某次调用抛的契约错误是 `code` + `reason_code`。 */
function expectError(fn: () => unknown, code: string, reasonCode: string): Record<string, unknown> {
  try {
    fn()
  } catch (error) {
    const body = errorBody(error)
    assert.equal(body.code, code, `期望 code=${code}，实际 ${String(body.code)}`)
    assert.equal(body.reason_code, reasonCode, `期望 reason_code=${reasonCode}，实际 ${String(body.reason_code)}`)
    const message = error instanceof Error ? error.message : String(error)
    assert.ok(message.startsWith(`${code}: `), `错误消息必须以 "${code}: " 开头：${message.slice(0, 60)}`)
    return body
  }
  assert.fail(`期望抛错 ${code}/${reasonCode}，但没有抛`)
}

function violationsOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const detail = body.detail as Record<string, unknown>
  const violations = detail.violations
  assert.ok(Array.isArray(violations), 'detail.violations 必须存在')
  return violations as Record<string, unknown>[]
}

/** 一份合法的 `items`（两维 + 保留键）。 */
function validItems(): Record<string, unknown> {
  return {
    transcript_basis: 'TRANSCRIPT',
    backend_depth: { assessment: 'MET', score: 4, note: '讲清了分片键的选择' },
    async_pipeline: { assessment: 'NOT_MET', score: 1, note: '队列重放答不上来' },
  }
}

/** 一份合法的 REJECT 入参。 */
function validRejectArgs(): Record<string, unknown> {
  return {
    interview_id: INTERVIEW_ID,
    items: validItems(),
    overall: 'REJECT',
    reject_reasons: [{
      dimension_key: 'async_pipeline',
      observation: '追问队列重放两次都答成"重试就行"',
      why_decisive: '该维度是 MUST_HAVE，且已给两次澄清机会',
      evidence: [],
      evidence_state: 'MEMORY_ONLY',
    }],
    idempotency_key: 'sc:iv:d01:1',
  }
}

// =====================================================================
//  1. 参数层
// =====================================================================

test('合法 REJECT 入参通过：只保留已声明键，reject_reasons/evidence_state 保形', () => {
  const args = parseScorecardSubmitArgs(validRejectArgs())
  assert.equal(args.interview_id, INTERVIEW_ID)
  assert.equal(args.overall, 'REJECT')
  assert.equal(args.rubric_version_id, undefined)
  assert.deepEqual(Object.keys(args.items).sort(), ['async_pipeline', 'backend_depth', 'transcript_basis'])
  assert.equal(args.reject_reasons?.length, 1)
  assert.equal(args.reject_reasons?.[0]?.evidence_state, 'MEMORY_ONLY')
  assert.equal(args.revision, undefined)
})

test('未知键 → INVALID_ARGS(UNKNOWN_PARAM) 且 allowed[] 列出允许的键', () => {
  const body = expectError(
    () => parseScorecardSubmitArgs({ ...validRejectArgs(), whatever: 1 }),
    'INVALID_ARGS',
    'UNKNOWN_PARAM',
  )
  const detail = body.detail as Record<string, unknown>
  const allowed = detail.allowed as string[]
  assert.ok(Array.isArray(allowed) && allowed.length > 0, 'allowed[] 必须非空')
  assert.ok(allowed.includes('interview_id') && allowed.includes('items') && allowed.includes('revision'))
  assert.equal(violationsOf(body)[0]?.path, 'whatever')
})

test('保留键声明在 schema 里但一律拒收：10 个全给 → 10 条 TENANT_OR_ACTOR_NOT_ALLOWED', () => {
  const reserved = {
    tenant_id: '11111111-1111-4111-8111-000000000001',
    actor_id: '11111111-1111-4111-8111-000000000103',
    interviewer_id: '11111111-1111-4111-8111-000000000f02',
    decided_by_actor_id: '11111111-1111-4111-8111-000000000102',
    decided_at: '2026-11-13T01:00:00+08:00',
    round_no: 1,
    slot_code: 'DEFAULT',
    submitted_at: '2026-11-13T01:00:00+08:00',
    status: 'SUBMITTED',
    stage_code: 'S10',
  }
  const body = expectError(
    () => parseScorecardSubmitArgs({ ...validRejectArgs(), ...reserved }),
    'INVALID_ARGS',
    'TENANT_OR_ACTOR_NOT_ALLOWED',
  )
  const violations = violationsOf(body)
  assert.equal(violations.length, 10, `10 个保留键应各报一条，实际 ${violations.length}`)
  for (const violation of violations) {
    assert.equal(violation.reason_code, 'TENANT_OR_ACTOR_NOT_ALLOWED')
  }
  const paths = violations.map((violation) => violation.path).sort()
  assert.deepEqual(paths, Object.keys(reserved).sort())
})

test('items 传数组 → INVALID_ARGS(TYPE_MISMATCH)（D-74 / N-9）', () => {
  const body = expectError(
    () => parseScorecardSubmitArgs({ ...validRejectArgs(), items: [{ dimension_key: 'backend_depth' }] }),
    'INVALID_ARGS',
    'TYPE_MISMATCH',
  )
  assert.equal(violationsOf(body)[0]?.path, 'items')
})

test('items 缺 transcript_basis → INVALID_ARGS(TRANSCRIPT_BASIS_MISSING)', () => {
  const items = validItems()
  delete items.transcript_basis
  expectError(
    () => parseScorecardSubmitArgs({ ...validRejectArgs(), items }),
    'INVALID_ARGS',
    'TRANSCRIPT_BASIS_MISSING',
  )
})

test('items.transcript_basis 不在枚举 → INVALID_ARGS(ENUM_INVALID)', () => {
  const items = { ...validItems(), transcript_basis: 'MAYBE' }
  expectError(() => parseScorecardSubmitArgs({ ...validRejectArgs(), items }), 'INVALID_ARGS', 'ENUM_INVALID')
})

test('evidence.kind=TRANSCRIPT_SEGMENT（已作废）→ INVALID_ARGS(ENUM_INVALID)（D-74 / TR-E3）', () => {
  const items = validItems()
  ;(items.backend_depth as Record<string, unknown>).evidence = [{
    kind: 'TRANSCRIPT_SEGMENT',
    transcript_artifact_id: ARTIFACT_ID,
    transcript_revision: 1,
    segment_id: SEGMENT_ID,
    quote: '我们把订单表按用户 ID 分了 64 片',
  }]
  const body = expectError(
    () => parseScorecardSubmitArgs({ ...validRejectArgs(), items }),
    'INVALID_ARGS',
    'ENUM_INVALID',
  )
  assert.equal(violationsOf(body)[0]?.path, 'items.backend_depth.evidence[0].kind')
})

test('evidence 的 id 必须是 UUID：segment_id="seg_01" → INVALID_ARGS(ID_NOT_UUID)', () => {
  const items = validItems()
  ;(items.backend_depth as Record<string, unknown>).evidence = [{
    kind: 'SEGMENT',
    transcript_artifact_id: ARTIFACT_ID,
    transcript_revision: 1,
    segment_id: 'seg_01',
    quote: '原文片段',
  }]
  expectError(() => parseScorecardSubmitArgs({ ...validRejectArgs(), items }), 'INVALID_ARGS', 'ID_NOT_UUID')
})

test('interview_id 不是 UUID（stub id）→ INVALID_ARGS(ID_NOT_UUID)（§7.1 第 3 条）', () => {
  const body = expectError(
    () => parseScorecardSubmitArgs({ ...validRejectArgs(), interview_id: 'iv_0001' }),
    'INVALID_ARGS',
    'ID_NOT_UUID',
  )
  assert.equal(violationsOf(body)[0]?.path, 'interview_id')
})

test('rubric_version_id 不是 UUID → INVALID_ARGS(ID_NOT_UUID)', () => {
  expectError(
    () => parseScorecardSubmitArgs({ ...validRejectArgs(), rubric_version_id: 'rv_1' }),
    'INVALID_ARGS',
    'ID_NOT_UUID',
  )
})

test('整数/数组越界：score=0 / score=6 / score=4.5 / expected_record_version=0', () => {
  const low = validItems()
  ;(low.backend_depth as Record<string, unknown>).score = 0
  let body = expectError(
    () => parseScorecardSubmitArgs({ ...validRejectArgs(), items: low }),
    'INVALID_ARGS',
    'OUT_OF_RANGE',
  )
  assert.equal(violationsOf(body)[0]?.path, 'items.backend_depth.score')

  const high = validItems()
  ;(high.backend_depth as Record<string, unknown>).score = 6
  body = expectError(
    () => parseScorecardSubmitArgs({ ...validRejectArgs(), items: high }),
    'INVALID_ARGS',
    'OUT_OF_RANGE',
  )
  assert.equal(violationsOf(body)[0]?.path, 'items.backend_depth.score')

  const fractional = validItems()
  ;(fractional.backend_depth as Record<string, unknown>).score = 4.5
  body = expectError(
    () => parseScorecardSubmitArgs({ ...validRejectArgs(), items: fractional }),
    'INVALID_ARGS',
    'TYPE_MISMATCH',
  )
  assert.equal(violationsOf(body)[0]?.path, 'items.backend_depth.score')

  body = expectError(
    () => parseScorecardSubmitArgs({
      ...validRejectArgs(),
      revision: { supersedes_scorecard_id: SCORECARD_ID, expected_record_version: 0, revision_reason: '改判' },
    }),
    'INVALID_ARGS',
    'OUT_OF_RANGE',
  )
  assert.equal(violationsOf(body)[0]?.path, 'revision.expected_record_version')
})

test('reject_reasons 超过 10 条 → INVALID_ARGS(OUT_OF_RANGE)；evidence 超过 20 条同理', () => {
  const reasons = Array.from({ length: 11 }, (_unused, index) => ({
    dimension_key: `d${index}`,
    observation: '观察',
    why_decisive: '决定性',
    evidence: [],
    evidence_state: 'MEMORY_ONLY',
  }))
  let body = expectError(
    () => parseScorecardSubmitArgs({ ...validRejectArgs(), reject_reasons: reasons }),
    'INVALID_ARGS',
    'OUT_OF_RANGE',
  )
  assert.ok(violationsOf(body).some((violation) => violation.path === 'reject_reasons'))

  const items = validItems()
  ;(items.backend_depth as Record<string, unknown>).evidence = Array.from({ length: 21 }, () => ({
    kind: 'SEGMENT',
    transcript_artifact_id: ARTIFACT_ID,
    transcript_revision: 1,
    segment_id: SEGMENT_ID,
    quote: '原文',
  }))
  body = expectError(
    () => parseScorecardSubmitArgs({ ...validRejectArgs(), items }),
    'INVALID_ARGS',
    'OUT_OF_RANGE',
  )
  assert.ok(violationsOf(body).some((violation) => violation.path === 'items.backend_depth.evidence'))
})

test('revision 缺字段 → INVALID_ARGS(REVISION_FIELDS_INCOMPLETE)（不是 MISSING_REQUIRED）', () => {
  const body = expectError(
    () => parseScorecardSubmitArgs({
      ...validRejectArgs(),
      revision: { supersedes_scorecard_id: SCORECARD_ID },
    }),
    'INVALID_ARGS',
    'REVISION_FIELDS_INCOMPLETE',
  )
  const paths = violationsOf(body).map((violation) => violation.path).sort()
  assert.deepEqual(paths, ['revision.expected_record_version', 'revision.revision_reason'])
})

test('overall=REJECT 但没有 reject_reasons → INVALID_ARGS(REJECT_REASON_INCOMPLETE)', () => {
  const args = validRejectArgs()
  delete args.reject_reasons
  expectError(() => parseScorecardSubmitArgs(args), 'INVALID_ARGS', 'REJECT_REASON_INCOMPLETE')
})

test('reject_reasons 缺 observation → INVALID_ARGS(REJECT_REASON_INCOMPLETE)', () => {
  const args = validRejectArgs()
  args.reject_reasons = [{ dimension_key: 'async_pipeline', why_decisive: '决定性', evidence: [] }]
  const body = expectError(() => parseScorecardSubmitArgs(args), 'INVALID_ARGS', 'REJECT_REASON_INCOMPLETE')
  assert.equal(violationsOf(body)[0]?.path, 'reject_reasons[0].observation')
})

test('idempotency_key 非法（空格/超长）→ INVALID_ARGS(OUT_OF_RANGE)', () => {
  expectError(
    () => parseScorecardSubmitArgs({ ...validRejectArgs(), idempotency_key: 'sc iv 1' }),
    'INVALID_ARGS',
    'OUT_OF_RANGE',
  )
  expectError(
    () => parseScorecardSubmitArgs({ ...validRejectArgs(), idempotency_key: 'a'.repeat(129) }),
    'INVALID_ARGS',
    'OUT_OF_RANGE',
  )
})

test('必填缺失 → INVALID_ARGS(MISSING_REQUIRED)，四个必填一次报全', () => {
  const body = expectError(() => parseScorecardSubmitArgs({}), 'INVALID_ARGS', 'MISSING_REQUIRED')
  const paths = violationsOf(body).map((violation) => violation.path)
  assert.deepEqual([...paths].sort(), ['idempotency_key', 'interview_id', 'items', 'overall'])
})

test('arguments 不是对象（数组/标量）→ INVALID_ARGS(TYPE_MISMATCH)（§1.1 第 1 条）', () => {
  for (const raw of [[], 'x', 3, null]) {
    expectError(() => parseScorecardSubmitArgs(raw), 'INVALID_ARGS', 'TYPE_MISMATCH')
  }
})

test('一次收集多条违反项：未知键 + 保留键 + 类型 + 枚举 + UUID 同时报，不遇到第一条就返回', () => {
  const body = expectError(
    () => parseScorecardSubmitArgs({
      interview_id: 'iv_0001',
      items: [],
      overall: 'MAYBE',
      idempotency_key: 'ok-1',
      actor_id: '11111111-1111-4111-8111-000000000103',
      bogus_key: true,
    }),
    'INVALID_ARGS',
    'UNKNOWN_PARAM',
  )
  const violations = violationsOf(body)
  assert.ok(violations.length >= 5, `应一次收集 ≥5 条，实际 ${violations.length}`)
  const paths = violations.map((violation) => violation.path)
  for (const path of ['actor_id', 'bogus_key', 'interview_id', 'items', 'overall']) {
    assert.ok(paths.includes(path), `缺少 ${path} 的违反项：${paths.join(', ')}`)
  }
  const reasons = new Set(violations.map((violation) => violation.reason_code))
  assert.ok(reasons.has('TENANT_OR_ACTOR_NOT_ALLOWED'))
  assert.ok(reasons.has('ID_NOT_UUID'))
  assert.ok(reasons.has('TYPE_MISMATCH'))
  assert.ok(reasons.has('ENUM_INVALID'))
})

// =====================================================================
//  2. 语义层（纯函数）
// =====================================================================

const DIMENSIONS = ['backend_depth', 'async_pipeline'] as const

function semanticInput(overrides: Partial<Parameters<typeof validateScorecardSemantics>[0]> = {}) {
  return {
    items: validItems(),
    overall: 'HOLD',
    rejectReasons: [] as ScorecardRejectReason[],
    dimensionKeys: [...DIMENSIONS],
    transcriptBasis: 'TRANSCRIPT',
    transcriptReady: true,
    ...overrides,
  }
}

test('语义：缺一个维度 → DIMENSION_COVERAGE_INCOMPLETE；多一个维度 → DIMENSION_NOT_IN_RUBRIC', () => {
  const missing = semanticInput({
    items: { transcript_basis: 'TRANSCRIPT', backend_depth: { assessment: 'MET', note: 'n' } },
  })
  const body = expectError(() => validateScorecardSemantics(missing), 'INVALID_ARGS', 'DIMENSION_COVERAGE_INCOMPLETE')
  assert.deepEqual((body.detail as Record<string, unknown>).missing, ['async_pipeline'])

  const extra = semanticInput({
    items: { transcript_basis: 'TRANSCRIPT', backend_depth: { assessment: 'MET', note: 'n' }, async_pipeline: { assessment: 'MET', note: 'n' }, made_up: { assessment: 'MET', note: 'n' } },
  })
  const extraBody = expectError(() => validateScorecardSemantics(extra), 'INVALID_ARGS', 'DIMENSION_NOT_IN_RUBRIC')
  assert.deepEqual((extraBody.detail as Record<string, unknown>).unexpected, ['made_up'])
})

test('语义：NOT_OBSERVED/UNREADABLE 带 score → ASSESSMENT_SCORE_CONFLICT（不得把"判不了"打分）', () => {
  for (const assessment of ['NOT_OBSERVED', 'UNREADABLE'] as const) {
    const input = semanticInput({
      items: {
        transcript_basis: 'TRANSCRIPT',
        backend_depth: { assessment, score: 3 },
        async_pipeline: { assessment: 'NOT_MET', score: 1, note: 'n' },
      },
    })
    const body = expectError(() => validateScorecardSemantics(input), 'INVALID_ARGS', 'ASSESSMENT_SCORE_CONFLICT')
    assert.equal((body.detail as Record<string, unknown>).dimension_key, 'backend_depth')
  }
  // 缺省 / null 是合法的
  validateScorecardSemantics(semanticInput({
    items: {
      transcript_basis: 'TRANSCRIPT',
      backend_depth: { assessment: 'NOT_OBSERVED', score: null },
      async_pipeline: { assessment: 'NOT_MET', score: 1, note: 'n' },
    },
  }))
})

test('语义：NOT_MET 没有 note → NOT_MET_NOTE_MISSING', () => {
  const input = semanticInput({
    items: {
      transcript_basis: 'TRANSCRIPT',
      backend_depth: { assessment: 'MET', note: 'n' },
      async_pipeline: { assessment: 'NOT_MET', score: 2, note: '   ' },
    },
  })
  const body = expectError(() => validateScorecardSemantics(input), 'INVALID_ARGS', 'NOT_MET_NOTE_MISSING')
  assert.equal((body.detail as Record<string, unknown>).dimension_key, 'async_pipeline')
})

test('语义：transcript_basis 与 canonical transcript 状态不一致 → TRANSCRIPT_BASIS_CONFLICT', () => {
  expectError(
    () => validateScorecardSemantics(semanticInput({ transcriptBasis: 'NO_TRANSCRIPT', transcriptReady: true })),
    'INVALID_ARGS',
    'TRANSCRIPT_BASIS_CONFLICT',
  )
  expectError(
    () => validateScorecardSemantics(semanticInput({ transcriptBasis: 'TRANSCRIPT', transcriptReady: false })),
    'INVALID_ARGS',
    'TRANSCRIPT_BASIS_CONFLICT',
  )
})

test('语义：NO_TRANSCRIPT 却带 kind=SEGMENT 证据 → TRANSCRIPT_BASIS_CONFLICT（TR-E3）', () => {
  const input = semanticInput({
    transcriptBasis: 'NO_TRANSCRIPT',
    transcriptReady: false,
    items: {
      transcript_basis: 'NO_TRANSCRIPT',
      backend_depth: {
        assessment: 'MET',
        note: 'n',
        evidence: [{
          kind: 'SEGMENT',
          transcript_artifact_id: ARTIFACT_ID,
          transcript_revision: 1,
          segment_id: SEGMENT_ID,
          quote: '原文',
        }],
      },
      async_pipeline: { assessment: 'NOT_MET', score: 1, note: 'n' },
    },
  })
  const body = expectError(() => validateScorecardSemantics(input), 'INVALID_ARGS', 'TRANSCRIPT_BASIS_CONFLICT')
  assert.deepEqual((body.detail as Record<string, unknown>).paths, ['items.backend_depth'])
})

test('语义：ADVANCE 含未评维度 → ADVANCE_WITH_UNASSESSED_DIMENSION；MET 零依据 → ADVANCE_WITHOUT_BASIS', () => {
  const unassessed = semanticInput({
    overall: 'ADVANCE',
    items: {
      transcript_basis: 'TRANSCRIPT',
      backend_depth: { assessment: 'MET', note: 'n' },
      async_pipeline: { assessment: 'NOT_OBSERVED' },
    },
  })
  expectError(() => validateScorecardSemantics(unassessed), 'INVALID_ARGS', 'ADVANCE_WITH_UNASSESSED_DIMENSION')

  const withoutBasis = semanticInput({
    overall: 'ADVANCE',
    items: {
      transcript_basis: 'TRANSCRIPT',
      backend_depth: { assessment: 'MET', note: null, evidence: [] },
      async_pipeline: { assessment: 'MET', score: 3 },
    },
  })
  const body = expectError(() => validateScorecardSemantics(withoutBasis), 'INVALID_ARGS', 'ADVANCE_WITHOUT_BASIS')
  assert.deepEqual((body.detail as Record<string, unknown>).dimensions, ['backend_depth', 'async_pipeline'])

  // 每条 MET 带 note 或 evidence 就通过
  validateScorecardSemantics(semanticInput({
    overall: 'ADVANCE',
    items: {
      transcript_basis: 'TRANSCRIPT',
      backend_depth: { assessment: 'MET', note: '讲清了分片键' },
      async_pipeline: { assessment: 'MET', evidence: [{ kind: 'SEGMENT', transcript_artifact_id: ARTIFACT_ID, transcript_revision: 1, segment_id: SEGMENT_ID, quote: '原文' }] },
    },
  }))
})

test('语义：REJECT 的理由必须落到 NOT_MET（三条闸：NOT_BACKED / UNREADABLE / EVIDENCE_UNDECLARED）', () => {
  const notBacked = semanticInput({
    overall: 'REJECT',
    rejectReasons: [{
      dimension_key: 'backend_depth',
      observation: '观察',
      why_decisive: '决定性',
      evidence: [],
      evidence_state: 'MEMORY_ONLY',
    }],
  })
  expectError(() => validateScorecardSemantics(notBacked), 'INVALID_ARGS', 'REJECT_REASON_NOT_BACKED')

  const unreadable = semanticInput({
    overall: 'REJECT',
    items: {
      transcript_basis: 'TRANSCRIPT',
      backend_depth: { assessment: 'MET', note: 'n' },
      async_pipeline: { assessment: 'UNREADABLE' },
    },
    rejectReasons: [{
      dimension_key: 'async_pipeline',
      observation: '录音损坏',
      why_decisive: '决定性',
      evidence: [],
      evidence_state: 'MEMORY_ONLY',
    }],
  })
  expectError(() => validateScorecardSemantics(unreadable), 'EVIDENCE_INSUFFICIENT', 'REJECT_BASIS_UNREADABLE')

  const undeclared = semanticInput({
    overall: 'REJECT',
    rejectReasons: [{
      dimension_key: 'async_pipeline',
      observation: '观察',
      why_decisive: '决定性',
      evidence: [],
    }],
  })
  expectError(() => validateScorecardSemantics(undeclared), 'INVALID_ARGS', 'REJECT_EVIDENCE_UNDECLARED')

  // 合法 REJECT 通过
  validateScorecardSemantics(semanticInput({
    overall: 'REJECT',
    rejectReasons: [{
      dimension_key: 'async_pipeline',
      observation: '观察',
      why_decisive: '决定性',
      evidence: [],
      evidence_state: 'MEMORY_ONLY',
    }],
  }))
})

test('语义：reject_reason 指向保留键 transcript_basis → REJECT_REASON_NOT_BACKED', () => {
  const input = semanticInput({
    overall: 'REJECT',
    rejectReasons: [{
      dimension_key: 'transcript_basis',
      observation: '观察',
      why_decisive: '决定性',
      evidence: [],
      evidence_state: 'MEMORY_ONLY',
    }],
  })
  expectError(() => validateScorecardSemantics(input), 'INVALID_ARGS', 'REJECT_REASON_NOT_BACKED')
})

// =====================================================================
//  3. rationale 编码 / 解码（G-1，DESIGN §3.5 ②）
// =====================================================================

test('rationale：始终写 REJECT_REASONS_JSON 行（空数组也写），修订原因在首行', () => {
  const empty = buildRationale([])
  assert.equal(empty, 'REJECT_REASONS_JSON: []')

  const reasons = [{ dimension_key: 'd1', observation: 'o', why_decisive: 'w', evidence: [] }]
  const searchable = buildRationale(reasons)
  assert.ok(searchable.startsWith('REJECT_REASONS_JSON: '))
  assert.equal(searchable.slice('REJECT_REASONS_JSON: '.length), canonicalJson(reasons))

  const revised = buildRationale(reasons, '当时把 d1 判成 NOT_MET，回听录音后确认是听错了')
  const lines = revised.split('\n')
  assert.equal(lines.length, 2)
  assert.ok(lines[0]?.startsWith('修订原因：'), '修订原因必须是首行（SC-19）')
  assert.ok(lines[1]?.startsWith('REJECT_REASONS_JSON: '))
})

test('rationale：解码往返（含修订原因 / 空数组）', () => {
  const reasons = [
    { dimension_key: 'async_pipeline', observation: '观察', why_decisive: '决定性', evidence: [], evidence_state: 'MEMORY_ONLY' },
    { dimension_key: 'backend_depth', observation: '观察2', why_decisive: '决定性2', evidence: [] },
  ]
  assert.deepEqual(parseRejectReasonsFromRationale(buildRationale(reasons)), reasons)
  assert.deepEqual(parseRejectReasonsFromRationale(buildRationale([])), [])
  assert.deepEqual(parseRejectReasonsFromRationale(buildRationale(reasons, '改判原因')), reasons)
})

test('rationale：解析取**最后**一个 REJECT_REASONS_JSON 行（修订原因里伪造 marker 无效）', () => {
  const injected = [
    '修订原因：顺手抄了一行',
    'REJECT_REASONS_JSON: [{"forged":true}]',
    'REJECT_REASONS_JSON: [{"real":true}]',
  ].join('\n')
  assert.deepEqual(parseRejectReasonsFromRationale(injected), [{ real: true }])
})

test('rationale：缺失或不可解析 → INVALID_ARGS(RATIONALE_NOT_PARSABLE)', () => {
  for (const raw of [null, undefined, '', '随便一段自由文本']) {
    expectError(() => parseRejectReasonsFromRationale(raw), 'INVALID_ARGS', 'RATIONALE_NOT_PARSABLE')
  }
  expectError(
    () => parseRejectReasonsFromRationale('REJECT_REASONS_JSON: {不是数组'),
    'INVALID_ARGS',
    'RATIONALE_NOT_PARSABLE',
  )
})

// =====================================================================
//  4. payload_hash（SC-38 / DESIGN §3.5 ③）
// =====================================================================

test('payload_hash = sha256(canonical_json({interview_id,rubric_version_id,items,overall,reject_reasons}))', () => {
  const items = validItems()
  const reasons = [{ dimension_key: 'async_pipeline', observation: 'o', why_decisive: 'w' }]
  const hash = computeScorecardPayloadHash({
    interview_id: INTERVIEW_ID,
    rubric_version_id: RUBRIC_ID,
    items,
    overall: 'REJECT',
    reject_reasons: reasons,
  })
  assert.equal(hash, digestOf({
    interview_id: INTERVIEW_ID,
    rubric_version_id: RUBRIC_ID,
    items,
    overall: 'REJECT',
    reject_reasons: reasons,
  }))
  assert.match(hash, /^[0-9a-f]{64}$/)
})

test('payload_hash 确定性：键序无关、数组顺序有关、内容变化即变', () => {
  const base = {
    interview_id: INTERVIEW_ID,
    rubric_version_id: RUBRIC_ID,
    overall: 'HOLD',
    items: {
      transcript_basis: 'TRANSCRIPT',
      backend_depth: { assessment: 'MET', note: 'n', score: 4 },
      async_pipeline: { assessment: 'NOT_MET', note: 'm' },
    },
  }
  const reordered = {
    rubric_version_id: RUBRIC_ID,
    items: {
      async_pipeline: { note: 'm', assessment: 'NOT_MET' },
      backend_depth: { score: 4, note: 'n', assessment: 'MET' },
      transcript_basis: 'TRANSCRIPT',
    },
    overall: 'HOLD',
    interview_id: INTERVIEW_ID,
  }
  const a = computeScorecardPayloadHash(base)
  const b = computeScorecardPayloadHash(reordered)
  assert.equal(a, b, 'canonicalJson 保证键序无关')

  const changedOverall = computeScorecardPayloadHash({ ...base, overall: 'REJECT' })
  assert.notEqual(a, changedOverall)

  const changedScore = computeScorecardPayloadHash({
    ...base,
    items: {
      transcript_basis: 'TRANSCRIPT',
      backend_depth: { assessment: 'MET', note: 'n', score: 5 },
      async_pipeline: { assessment: 'NOT_MET', note: 'm' },
    },
  })
  assert.notEqual(a, changedScore)

  // reject_reasons 缺省与显式 [] 同值（SC-38 的 `reject_reasons ?? []`）
  assert.equal(
    computeScorecardPayloadHash({ ...base }),
    digestOf({
      interview_id: base.interview_id,
      rubric_version_id: base.rubric_version_id,
      items: base.items,
      overall: base.overall,
      reject_reasons: [],
    }),
  )
})

// =====================================================================
//  5. 两份 JSON Schema 的封闭性（TC §7.1）
// =====================================================================

/** DSH 支持的约束关键字（`json-schema.js` 的 CONSTRAINT_KEYWORDS + annotations）。 */
const SUPPORTED = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean'])

/** 深扫 schema：返回所有违规（子集外关键字 / type 数组 / type:'null' / required 不在 properties）。 */
function schemaViolations(schema: unknown, path = 'schema'): string[] {
  const out: string[] = []
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return [`${path} 不是对象`]
  const node = schema as Record<string, unknown>
  for (const key of Object.keys(node)) {
    if (!SUPPORTED.has(key)) out.push(`${path}.${key} 不是受支持的关键字`)
  }
  const type = node.type
  if (Array.isArray(type)) out.push(`${path}.type 是数组（DSH 不支持 type 数组）`)
  else if (typeof type === 'string') {
    if (!TYPES.has(type)) out.push(`${path}.type=${type} 不受支持`)
    if (type === 'null') out.push(`${path}.type=null（输出里不允许 null）`)
  } else if (node.oneOf === undefined) {
    out.push(`${path}.type 缺失`)
  }
  const properties = node.properties as Record<string, unknown> | undefined
  const required = node.required as string[] | undefined
  if (required !== undefined) {
    for (const key of required) {
      if (properties === undefined || !Object.hasOwn(properties, key)) {
        out.push(`${path}.required 里有未声明的键 ${key}`)
      }
    }
  }
  if (properties !== undefined) {
    for (const [key, child] of Object.entries(properties)) out.push(...schemaViolations(child, `${path}.${key}`))
  }
  if (node.items !== undefined) out.push(...schemaViolations(node.items, `${path}.items`))
  return out
}

/** 深扫值：返回所有为 null 的路径。 */
function nullPaths(value: unknown, path = 'value'): string[] {
  if (value === null) return [path]
  if (Array.isArray(value)) return value.flatMap((item, index) => nullPaths(item, `${path}[${index}]`))
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => nullPaths(child, `${path}.${key}`))
  }
  return []
}

/** 走一遍真实值对 schema 的校验（本文件用到的子集）。 */
function valueViolations(schema: unknown, value: unknown, path = 'value'): string[] {
  const node = schema as Record<string, unknown>
  const out: string[] = []
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
  if (!typeOk()) return [`${path} 类型不符（期望 ${String(type)}）`]
  if (Array.isArray(node.enum) && !(node.enum as unknown[]).includes(value)) {
    out.push(`${path} 不在 enum 里：${JSON.stringify(value)}`)
  }
  if (type === 'array' && node.items !== undefined) {
    ;(value as unknown[]).forEach((item, index) => out.push(...valueViolations(node.items, item, `${path}[${index}]`)))
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

test('output.schema 只用 DSH 受支持子集，没有 type:null / type 数组', () => {
  assert.deepEqual(schemaViolations(TOOL.output.schema), [])
})

test('parameters 是封闭对象根（additionalProperties:false），保留键声明但拒收', () => {
  const parameters = TOOL.parameters as Record<string, unknown>
  assert.equal(parameters.type, 'object')
  assert.equal(parameters.additionalProperties, false)
  assert.deepEqual(schemaViolations(parameters), [])
  const properties = parameters.properties as Record<string, unknown>
  for (const key of [
    'tenant_id', 'actor_id', 'interviewer_id', 'decided_by_actor_id', 'decided_at',
    'round_no', 'slot_code', 'submitted_at', 'status', 'stage_code',
  ]) {
    assert.ok(Object.hasOwn(properties, key), `保留键 ${key} 必须显式声明（TC §1.6 / §7.1 第 2 条）`)
  }
  const required = parameters.required as string[]
  assert.deepEqual([...required].sort(), ['idempotency_key', 'interview_id', 'items', 'overall'])
  // items 必须是对象（不是数组）
  const items = properties.items as Record<string, unknown>
  assert.equal(items.type, 'object')
})

test('输出样例值：无 null、required 齐全、无未声明键（TC §2.2 形状）', () => {
  const sample = {
    tool: 'recruitment_scorecard_submit',
    contract_version: '2.0.0',
    status: 'OK',
    replayed: false,
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
    scorecard: {
      id: SCORECARD_ID,
      revision_no: 1,
      status: 'SUBMITTED',
      interview_id: INTERVIEW_ID,
      interviewer_id: '11111111-1111-4111-8111-000000001101',
      actor_id: '11111111-1111-4111-8111-000000000102',
      rubric_version_id: RUBRIC_ID,
      rubric_payload_hash: 'a'.repeat(64),
      rubric_resolution: 'APPLICATION_PINNED',
      transcript_basis: 'TRANSCRIPT',
      payload_hash: 'b'.repeat(64),
      submitted_at: '2026-11-13T01:10:00.000Z',
      status_changed_by_actor_id: '11111111-1111-4111-8111-000000000102',
      status_source_event_id: '11111111-1111-4111-8111-000000001201',
      record_version: 1,
    },
    interview: { round_no: 1, slot_code: 'DEFAULT', scheduled_start_at: '2026-11-12T06:00:00.000Z', status: 'POST_INTERVIEW' },
    coverage: {
      dimensions_total: 3,
      dimensions_assessed: 3,
      by_assessment: { met: 1, not_met: 1, not_observed: 1, unreadable: 0 },
    },
    superseded: { scorecard_id: '11111111-1111-4111-8111-000000001301', revision_no: 1 },
    warnings: [{ code: 'NO_TIMESTAMPED_EVIDENCE', message: '1 条 reject_reason 未附转写证据，已按 MEMORY_ONLY 记录' }],
  }
  assert.deepEqual(nullPaths(sample), [])
  assert.deepEqual(valueViolations(TOOL.output.schema, sample), [])

  // superseded / scheduled_start_at 是可省略键（库里没有就省略，不写 null）
  const omitted = { ...sample } as Record<string, unknown>
  delete omitted.superseded
  const interview = { round_no: 1, slot_code: 'DEFAULT', status: 'SCHEDULED' }
  assert.deepEqual(valueViolations(TOOL.output.schema, { ...omitted, interview }), [])
})

test('render() 返回一条中文文本摘要，且不打印 PII', () => {
  const value = {
    tool: 'recruitment_scorecard_submit',
    contract_version: '2.0.0',
    status: 'OK',
    replayed: true,
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
    scorecard: {
      id: SCORECARD_ID,
      revision_no: 2,
      status: 'SUBMITTED',
      interview_id: INTERVIEW_ID,
      interviewer_id: '11111111-1111-4111-8111-000000001101',
      actor_id: '11111111-1111-4111-8111-000000000102',
      rubric_version_id: RUBRIC_ID,
      rubric_payload_hash: 'a'.repeat(64),
      rubric_resolution: 'APPLICATION_PINNED',
      transcript_basis: 'TRANSCRIPT',
      payload_hash: 'b'.repeat(64),
      submitted_at: '2026-11-13T01:10:00.000Z',
      status_changed_by_actor_id: '11111111-1111-4111-8111-000000000102',
      status_source_event_id: '11111111-1111-4111-8111-000000001201',
      record_version: 2,
    },
    interview: { round_no: 1, slot_code: 'DEFAULT', status: 'POST_INTERVIEW' },
    coverage: { dimensions_total: 2, dimensions_assessed: 2, by_assessment: { met: 1, not_met: 1, not_observed: 0, unreadable: 0 } },
    superseded: { scorecard_id: '11111111-1111-4111-8111-000000001301', revision_no: 1 },
    warnings: [{ code: 'FIXTURE_BASIS', message: 'provenance=FIXTURE' }],
  }
  const blocks = TOOL.output.render({}, value)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.type, 'text')
  const text = blocks[0]?.text ?? ''
  assert.ok(text.includes('面评已提交'), '摘要必须是中文')
  assert.ok(text.includes('幂等重放'), '重放要写明')
  assert.ok(text.includes('provenance=FIXTURE'))
  assert.ok(text.includes('FIXTURE_BASIS'))
  // 不打印 PII：样例里没有姓名/电话/邮箱，摘要里也不得出现
  assert.doesNotMatch(text, /@/)
  assert.doesNotMatch(text, /\b1[3-9]\d{9}\b/)
})

test('工具名与 contract_version 锁死（TC §2 / §2.2）', () => {
  assert.equal(TOOL.name, 'recruitment_scorecard_submit')
  const properties = (TOOL.output.schema as Record<string, unknown>).properties as Record<string, unknown>
  const version = properties.contract_version as Record<string, unknown>
  assert.equal(version.type, 'string')
  // 写工具不可并行（同 key 并发提交必须由库/幂等判定拦）
  assert.equal(TOOL.isConcurrencySafe?.({}), false)
})
