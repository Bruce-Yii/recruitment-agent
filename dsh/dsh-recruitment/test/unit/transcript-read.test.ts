// S9 转写读取的**纯单测**（不连库）：TR-D 七条派生规则 + 参数 reason_code + schema。
//
// 七条的顺序本身就是规则（`transcript-rules.md §4` / TR-D3）。集成测试只验“某个场景
// 端到端得出某值”，这里把每条规则单独钉住，避免以后有人“顺手调整顺序”。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createTranscriptReadTool,
  deriveTranscriptState,
  parseReadArgs,
  unconfiguredTranscriptReadTool,
  type TranscriptStateArtifact,
  type TranscriptStateSnapshot,
} from '../../src/tools/transcript-read.ts'
import { resolveDatabaseConfig } from '../../src/db/pool.ts'

const INTERVIEW = '11111111-1111-4111-8111-000000000abc'
const DATABASE = resolveDatabaseConfig({
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'ra_s6s7',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
}, { RECRUITMENT_DB_PASSWORD: 'unused-in-this-test' }).resolved

/** 造一份最小快照（默认：已绑一个会议、无产物、计划时间已过）。 */
function snapshot(overrides: Partial<TranscriptStateSnapshot> = {}): TranscriptStateSnapshot {
  return {
    as_of: '2026-11-13T11:00:00+08:00',
    scheduled_start_at: '2026-11-13T10:00:00+08:00',
    scheduled_end_at: '2026-11-13T10:30:00+08:00',
    meetings: [{ actual_end_at: '2026-11-13T10:30:00+08:00' }],
    artifacts: [],
    ...overrides,
  }
}

const READY: TranscriptStateArtifact = { transcript_status: 'READY', is_complete: true, is_canonical: false }
const PARTIAL: TranscriptStateArtifact = { transcript_status: 'PARTIAL', is_complete: false, is_canonical: false }
const AUTH: TranscriptStateArtifact = { transcript_status: 'AUTH_REQUIRED', is_complete: false, is_canonical: false }
const canon = (artifact: TranscriptStateArtifact): TranscriptStateArtifact => ({ ...artifact, is_canonical: true })

/** 从 `<CODE>: <compact-json>` 里取 JSON 体。 */
function body(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  return JSON.parse(index >= 0 ? message.slice(index + 2) : message) as Record<string, unknown>
}

test('TR-D 序 1：M(i)=∅ 且已过计划开始 → MISSING/NO_MEETING_BOUND', () => {
  const result = deriveTranscriptState(snapshot({ meetings: [], artifacts: [] }))
  assert.equal(result.state, 'MISSING')
  assert.equal(result.reason_code, 'NO_MEETING_BOUND')
})

test('TR-D 序 2：有 canonical 就 map 它的状态（READY/PARTIAL/AUTH_REQUIRED/未列出→PENDING）', () => {
  assert.deepEqual(deriveTranscriptState(snapshot({ artifacts: [canon(READY)] })), {
    state: 'READY', reason_code: 'CANONICAL_STATUS', no_canonical: false,
  })
  assert.equal(deriveTranscriptState(snapshot({ artifacts: [canon(PARTIAL)] })).state, 'PARTIAL')
  assert.equal(deriveTranscriptState(snapshot({ artifacts: [canon(AUTH)] })).state, 'AUTH_REQUIRED')
  const discovered = canon({ transcript_status: 'DISCOVERED', is_complete: false, is_canonical: true })
  const pending = deriveTranscriptState(snapshot({ artifacts: [discovered] }))
  assert.equal(pending.state, 'PENDING', '未列出的状态落 PENDING，不猜')
  assert.equal(pending.reason_code, 'CANONICAL_STATUS')
})

test('TR-D 序 3：无 canonical 但有 READY+complete → READY/READY_NO_CANONICAL（优先于 PARTIAL）', () => {
  const result = deriveTranscriptState(snapshot({ artifacts: [PARTIAL, READY] }))
  assert.equal(result.state, 'READY')
  assert.equal(result.reason_code, 'READY_NO_CANONICAL')
  assert.equal(result.no_canonical, true)
})

test('TR-D 序 4：无 canonical 只有 PARTIAL → PARTIAL/ONLY_PARTIAL（AUTH_REQUIRED 也在也不改）', () => {
  const result = deriveTranscriptState(snapshot({ artifacts: [AUTH, PARTIAL] }))
  assert.equal(result.state, 'PARTIAL')
  assert.equal(result.reason_code, 'ONLY_PARTIAL')
})

test('TR-D 序 5：无 canonical 只有 AUTH_REQUIRED → AUTH_REQUIRED/ONLY_AUTH_REQUIRED', () => {
  const result = deriveTranscriptState(snapshot({ artifacts: [AUTH] }))
  assert.equal(result.state, 'AUTH_REQUIRED')
  assert.equal(result.reason_code, 'ONLY_AUTH_REQUIRED')
})

test('TR-D 序 6：无产物且超过 max(actual_end, scheduled_end)+WAIT → MISSING/NO_ARTIFACT_AFTER_WAIT', () => {
  // 结束 10:30 + 120min = 12:30；12:31 才是 MISSING
  assert.equal(deriveTranscriptState(snapshot({ as_of: '2026-11-13T12:31:00+08:00' })).reason_code, 'NO_ARTIFACT_AFTER_WAIT')
  // 边界：恰好 12:30 还不算超过（严格大于）
  assert.equal(deriveTranscriptState(snapshot({ as_of: '2026-11-13T12:30:00+08:00' })).reason_code, 'WAITING')
})

test('TR-D 序 7：还没到等待窗 → PENDING/WAITING（不是 MISSING）', () => {
  const result = deriveTranscriptState(snapshot({ as_of: '2026-11-13T11:00:00+08:00' }))
  assert.equal(result.state, 'PENDING')
  assert.equal(result.reason_code, 'WAITING')
})

test('WAIT 可被 business_config 覆盖：10 分钟时同一时刻变成 MISSING，默认 120 仍是 PENDING', () => {
  const at = '2026-11-13T10:41:00+08:00' // 结束 10:30 + 10min = 10:40
  assert.equal(deriveTranscriptState(snapshot({ as_of: at, wait_minutes: 10 })).reason_code, 'NO_ARTIFACT_AFTER_WAIT')
  assert.equal(deriveTranscriptState(snapshot({ as_of: at })).reason_code, 'WAITING')
  // 坏值回退默认 120
  assert.equal(deriveTranscriptState(snapshot({ as_of: at, wait_minutes: 0 })).reason_code, 'WAITING')
})

test('WAIT 的起点取 max(actual_end, scheduled_end)：实际结束更晚时按实际结束算', () => {
  // scheduled_end 10:30，actual_end 11:00，WAIT=60 → 12:00 前是 PENDING
  const meeting = { actual_end_at: '2026-11-13T11:00:00+08:00' }
  assert.equal(deriveTranscriptState(snapshot({ meetings: [meeting], wait_minutes: 60, as_of: '2026-11-13T11:59:00+08:00' })).reason_code, 'WAITING')
  assert.equal(deriveTranscriptState(snapshot({ meetings: [meeting], wait_minutes: 60, as_of: '2026-11-13T12:01:00+08:00' })).reason_code, 'NO_ARTIFACT_AFTER_WAIT')
})

test('参数：as_of 未来 / 无偏移 / 非 UUID / 未知参数 / tenant_id / 越界各自 reason_code 正确', () => {
  const now = Date.parse('2026-11-13T00:00:00+08:00')
  const cases: readonly [Record<string, unknown>, string][] = [
    [{ interview_id: INTERVIEW, as_of: '2999-01-01T00:00:00+08:00' }, 'AS_OF_IN_FUTURE'],
    [{ interview_id: INTERVIEW, as_of: '2026-11-13T00:00:00' }, 'AS_OF_FORMAT'],
    [{ interview_id: 'not-a-uuid' }, 'ID_NOT_UUID'],
    [{}, 'MISSING_REQUIRED'],
    [{ interview_id: INTERVIEW, foo: 1 }, 'UNKNOWN_PARAM'],
    [{ interview_id: INTERVIEW, tenant_id: 'x' }, 'TENANT_OR_ACTOR_NOT_ALLOWED'],
    [{ interview_id: INTERVIEW, max_chars: 0 }, 'OUT_OF_RANGE'],
    [{ interview_id: INTERVIEW, include_text: 'true' }, 'TYPE_MISMATCH'],
  ]
  for (const [args, reason] of cases) {
    assert.throws(() => parseReadArgs(args, now), (error: unknown) => {
      const parsed = body(error)
      assert.equal(parsed.code, 'INVALID_ARGS')
      assert.equal(parsed.reason_code, reason, JSON.stringify(args))
      return true
    })
  }
  assert.doesNotThrow(() => parseReadArgs({ interview_id: INTERVIEW, as_of: '2026-11-13T00:00:00+08:00' }, now))
})

test('入参 schema 封闭；输出 schema 没有 type:null / type 数组；只读工具可并行', () => {
  const tool = createTranscriptReadTool(DATABASE!)
  assert.equal((tool.parameters as { additionalProperties: boolean }).additionalProperties, false)
  assert.equal(tool.isConcurrencySafe?.({}), true)
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return
    const record = node as Record<string, unknown>
    assert.notEqual(record.type, 'null')
    assert.equal(Array.isArray(record.type), false)
    for (const value of Object.values(record)) visit(value)
  }
  visit(tool.output.schema)
})

test('未配置替身：调用报 NOT_CONFIGURED（不静默返回空数据）', async () => {
  const tool = unconfiguredTranscriptReadTool(['config.database.host is required'])
  assert.equal(tool.name, 'recruitment_transcript_read')
  await assert.rejects(async () => tool.execute({ interview_id: INTERVIEW }, {}), (error: unknown) => {
    const parsed = body(error)
    assert.equal(parsed.code, 'NOT_CONFIGURED')
    return true
  })
})

// ---------------------------------------------------------------------------------------------
// 以下为补充的机检项（加强到"输出值也不能撒谎 / 可选键不许写 null"这一层）。
// ---------------------------------------------------------------------------------------------

/** DSH 已强制的 schema 子集：本工具只允许用这几个关键字。 */
const SUPPORTED_KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description'])
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean'])

function schemaViolations(node: unknown, path = 'schema'): string[] {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return [`${path} 不是对象`]
  const record = node as Record<string, unknown>
  const out: string[] = []
  for (const key of Object.keys(record)) {
    if (!SUPPORTED_KEYWORDS.has(key)) out.push(`${path}.${key} 不是受支持的关键字`)
  }
  const type = record.type
  if (Array.isArray(type)) out.push(`${path}.type 是数组（DSH 不支持）`)
  else if (typeof type === 'string') {
    if (!SCHEMA_TYPES.has(type)) out.push(`${path}.type=${type} 不受支持`)
  } else out.push(`${path}.type 缺失`)
  const properties = record.properties as Record<string, unknown> | undefined
  for (const key of (record.required ?? []) as string[]) {
    if (properties === undefined || !Object.hasOwn(properties, key)) out.push(`${path}.required 里有未声明的键 ${key}`)
  }
  if (properties !== undefined) {
    for (const [key, child] of Object.entries(properties)) out.push(...schemaViolations(child, `${path}.${key}`))
  }
  if (record.items !== undefined) out.push(...schemaViolations(record.items, `${path}.items`))
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

/** 一份真库跑出来的出参形状（手搓，避免单测连库）。 */
function sampleOutput(): Record<string, unknown> {
  return {
    tool: 'recruitment_transcript_read',
    contract_version: '1.0.0',
    status: 'OK',
    read_only: true,
    as_of: '2026-11-13T11:00:00+08:00',
    labels: { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' },
    interview: {
      id: INTERVIEW, application_id: INTERVIEW, round_no: 1, stage_code: 'S9',
      status: 'POST_INTERVIEW', timezone: 'Asia/Shanghai', record_version: 1,
    },
    transcript: {
      state: 'READY',
      reason_code: 'CANONICAL_STATUS',
      wait_minutes: 120,
      artifact_count: 1,
      canonical_artifact_id: INTERVIEW,
      canonical_revision: 1,
      selected_artifact_id: INTERVIEW,
      selected_source_revision: 1,
      meetings: [{
        id: INTERVIEW, provider: 'FEISHU', meeting_role: 'PRIMARY', binding_id: INTERVIEW,
        binding_method: 'MANUAL', in_transcript_set: true,
      }],
      artifacts: [{
        id: INTERVIEW, meeting_id: INTERVIEW, provider: 'LOCAL_DEMO', provider_artifact_id: 'local:demo-sample:x',
        source_revision: 1, variant_type: 'ORIGINAL', language: 'zh', transcript_status: 'READY',
        provenance: 'FIXTURE', trigger_mode: 'MANUAL', connection_state: 'NOT_CONNECTED',
        is_canonical: true, is_complete: true, has_more: false, content_sha256: 'a'.repeat(64),
        char_count: 10, segment_count: 1, fetched_at: '2026-11-13T10:00:00.000Z',
        created_at: '2026-11-13T10:00:00.000Z',
      }],
      text: {
        artifact_id: INTERVIEW, source_revision: 1, content: '00:00 正文不在这里',
        offset: 0, length: 10, total_chars: 10, has_more: false,
      },
      segments: [{ sequence: 0, content_text: '00:00 正文不在这里' }],
      segment_page: { offset: 0, limit: 200, total: 1, has_more: false },
      record: {
        id: INTERVIEW, status: 'NEEDS_REVIEW', verification_status: 'UNVERIFIED',
        transcript_revision: 1, evidence_ok: true, is_current: true,
        created_at: '2026-11-13T10:00:00.000Z',
      },
    },
    warnings: [{ code: 'RECORD_NOT_READY', message: '结构化记录还没就绪' }],
  }
}

test('两套 schema 的每个节点都只用受支持关键字；可选键（text/segments/record）不在 required', () => {
  const tool = createTranscriptReadTool(DATABASE!)
  assert.deepEqual(schemaViolations(tool.parameters), [])
  assert.deepEqual(schemaViolations(tool.output.schema), [])
  const transcript = ((tool.output.schema as { properties: Record<string, { required: string[] }> })
    .properties.transcript) as { required: string[] }
  for (const optional of ['text', 'segments', 'segment_page', 'record', 'canonical_artifact_id', 'selected_artifact_id']) {
    assert.equal(transcript.required.includes(optional), false, `${optional} 必须可省略（缺省靠省略键）`)
  }
  for (const required of ['state', 'reason_code', 'wait_minutes', 'artifact_count', 'meetings', 'artifacts']) {
    assert.ok(transcript.required.includes(required), `transcript.required 缺 ${required}`)
  }
})

test('输出值：无 null、required 齐全、无未声明键；极简形状（无 text/segments/record）也合法', () => {
  const tool = createTranscriptReadTool(DATABASE!)
  const schema = tool.output.schema as { required: string[]; properties: Record<string, unknown> }
  const value = sampleOutput()
  assert.deepEqual(nullPaths(value), [])
  for (const key of schema.required) assert.ok(Object.hasOwn(value, key), `required 缺 ${key}`)
  for (const key of Object.keys(value)) assert.ok(Object.hasOwn(schema.properties, key), `未声明的键 ${key}`)
  const bare = {
    ...value,
    transcript: { state: 'MISSING', reason_code: 'NO_MEETING_BOUND', wait_minutes: 120, artifact_count: 0, meetings: [], artifacts: [] },
    warnings: [{ code: 'TRANSCRIPT_NOT_READY', message: '还没拿到' }],
  }
  assert.deepEqual(nullPaths(bare), [])
  // has_more=false 时不得出现 next_offset（省略键，不写 null）
  const text = (value.transcript as { text: Record<string, unknown> }).text
  assert.equal(Object.hasOwn(text, 'next_offset'), false)
})

test('reason_code 只取 §5 封闭集，且序 1 优先于序 2 / 序 3 要求 is_complete', () => {
  const closed = new Set([
    'NO_MEETING_BOUND', 'CANONICAL_STATUS', 'READY_NO_CANONICAL', 'ONLY_PARTIAL',
    'ONLY_AUTH_REQUIRED', 'NO_ARTIFACT_AFTER_WAIT', 'WAITING',
  ])
  const sweep: TranscriptStateSnapshot[] = [
    snapshot({ meetings: [] }),
    snapshot(),
    snapshot({ artifacts: [READY] }),
    snapshot({ artifacts: [PARTIAL] }),
    snapshot({ artifacts: [AUTH] }),
    snapshot({ artifacts: [canon(READY)] }),
    snapshot({ artifacts: [canon(PARTIAL)] }),
  ]
  for (const item of sweep) {
    assert.ok(closed.has(deriveTranscriptState(item).reason_code), `越界 reason_code：${deriveTranscriptState(item).reason_code}`)
  }
  // M(i)=∅ 时即便有产物也不看 canonical（序 1 在序 2 之前）
  const noMeeting = deriveTranscriptState(snapshot({ meetings: [], artifacts: [canon(READY)] }))
  assert.equal(noMeeting.reason_code, 'NO_MEETING_BOUND')
  // 序 3 要求 is_complete=true；只有 status=READY 但未标完整（库层不允许的脏数据）不算 READY
  const incomplete = deriveTranscriptState(snapshot({
    artifacts: [{ transcript_status: 'READY', is_complete: false, is_canonical: false }],
  }))
  assert.equal(incomplete.state, 'PENDING')
  assert.equal(incomplete.reason_code, 'WAITING')
})

test('render：多行摘要，含 state/reason/canonical/产物/record/文本计数，不回显正文', () => {
  const tool = createTranscriptReadTool(DATABASE!)
  const value = sampleOutput()
  const blocks = tool.output.render({}, value)
  assert.equal(blocks.length, 1)
  const text = blocks[0]?.text ?? ''
  assert.ok(text.split('\n').length > 3, '读工具是多行摘要')
  assert.ok(text.includes('state=READY'))
  assert.ok(text.includes('reason=CANONICAL_STATUS'))
  assert.ok(text.includes('provenance=FIXTURE'))
  assert.ok(text.includes('connection=NOT_CONNECTED'))
  assert.ok(text.includes('status=NEEDS_REVIEW'))
  assert.ok(text.includes('has_more=false'))
  assert.equal(text.includes('00:00 正文不在这里'), false, '不得回显转写正文')
})

// =====================================================================
//  D-96：状态 READY 不等于有内容 —— "空"必须单独分类
// =====================================================================
// 飞书实测：视频会议录制没有生成"妙记"AI 转写，产物存在、状态看着正常，
// 正文却是空的。只按 status 派生会报 READY，把"没读到"说成"有转写"。

test('D-96：canonical 状态 READY 且有正文 → READY / CANONICAL_STATUS', () => {
  const derived = deriveTranscriptState(snapshot({
    artifacts: [{ transcript_status: 'READY', is_complete: true, is_canonical: true, content_chars: 2379 }],
  }))
  assert.equal(derived.state, 'READY')
  assert.equal(derived.reason_code, 'CANONICAL_STATUS')
})

test('D-96：canonical 状态 READY 但正文为空 → PARTIAL / ARTIFACT_EMPTY（不得报 READY）', () => {
  const derived = deriveTranscriptState(snapshot({
    artifacts: [{ transcript_status: 'READY', is_complete: true, is_canonical: true, content_chars: 0 }],
  }))
  assert.equal(derived.state, 'PARTIAL', '空正文不得报 READY')
  assert.equal(derived.reason_code, 'ARTIFACT_EMPTY')
})

test('D-96：两个 fixture 输出必须不同（有内容 vs 空）', () => {
  const withContent = deriveTranscriptState(snapshot({
    artifacts: [{ transcript_status: 'READY', is_complete: true, is_canonical: true, content_chars: 100 }],
  }))
  const empty = deriveTranscriptState(snapshot({
    artifacts: [{ transcript_status: 'READY', is_complete: true, is_canonical: true, content_chars: 0 }],
  }))
  assert.notDeepEqual(withContent, empty, '“有转写”和“转写为空”必须是两个不同结果')
})
