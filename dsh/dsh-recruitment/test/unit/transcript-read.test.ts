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
  readTranscriptInTransaction,
  unconfiguredTranscriptReadTool,
  type TranscriptStateArtifact,
  type TranscriptStateSnapshot,
} from '../../src/tools/transcript-read.ts'
import { resolveDatabaseConfig } from '../../src/db/pool.ts'
import type { DatabaseClient, ResolvedDatabaseConfig } from '../../src/db/pool.ts'

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
    'ONLY_AUTH_REQUIRED', 'NO_ARTIFACT_AFTER_WAIT', 'WAITING', 'ARTIFACT_EMPTY',
  ])
  const sweep: TranscriptStateSnapshot[] = [
    snapshot({ meetings: [] }),
    snapshot(),
    snapshot({ artifacts: [READY] }),
    snapshot({ artifacts: [PARTIAL] }),
    snapshot({ artifacts: [AUTH] }),
    snapshot({ artifacts: [canon(READY)] }),
    snapshot({ artifacts: [canon(PARTIAL)] }),
    snapshot({ artifacts: [{ transcript_status: 'READY', is_complete: true, is_canonical: true, content_chars: 0 }] }),
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

// =====================================================================
//  真值 vs output.schema（2026-11-15 P0 回归）
// =====================================================================
// 事故：`transcript.artifacts[]` 的输出对象多写了一个 `content_chars`，而
// `ARTIFACT_SCHEMA`（`additionalProperties:false`）只声明 `char_count`，
// 真 DSH 会话对工具输出逐值校验 → 任何返回至少 1 个 artifact 的调用都
// `INVALID_TOOL_OUTPUT`（证据：`work/handoff/FALSIFICATION-2026-11-15.md §1`）。
//
// 为什么以前没抓到：上面的 `sampleOutput()` 是**人以为的形状**，它从来不含
// `content_chars`；真实路径没人跑过。这里用假 `DatabaseClient`（只实现 `query`）
// 调 **`execute()` 的同一核心函数** `readTranscriptInTransaction()`，把返回的
// **完整值**按 DSH 子集（`additionalProperties:false` / `required` / `type` / `enum`）
// 严格校验。判据与 `test/unit/output-schema.test.ts` 的 `valueViolations` 一致。

/** 真会话用的那三个 id（`work/verify-2026-11-15-l1/session/goal.txt`）。 */
const REAL_INTERVIEW = '11111111-1111-4111-8111-000000000801'
const REAL_ARTIFACT = '11111111-1111-4111-8111-000000000a01'
const REAL_MEETING = '11111111-1111-4111-8111-000000000901'
const REAL_APPLICATION = '11111111-1111-4111-8111-000000000701'
/** 服务端"现在"（固定值；`as_of` 缺省就用它）。 */
const REAL_NOW_MS = Date.parse('2026-11-13T11:00:00+08:00')

const READ_CFG = DATABASE as ResolvedDatabaseConfig
const READ_TOOL = createTranscriptReadTool(READ_CFG)

/** 一份"库里的行"（默认值 = 演示库 `ra_s6s7` 里 801 面试的等价形状）。 */
function interviewRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REAL_INTERVIEW,
    application_id: REAL_APPLICATION,
    round_no: 1,
    stage_code: 'S8',
    status: 'POST_INTERVIEW',
    scheduled_start_at: new Date('2026-11-12T06:00:00.000Z'),
    scheduled_end_at: new Date('2026-11-12T07:00:00.000Z'),
    timezone: 'Asia/Shanghai',
    record_version: 1,
    ...overrides,
  }
}

function meetingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    binding_id: '11111111-1111-4111-8111-000000000b01',
    binding_method: 'MANUAL',
    meeting_id: REAL_MEETING,
    provider: 'FEISHU',
    external_meeting_id: 'manual-demo-2026-11-12',
    meeting_role: 'PRIMARY',
    actual_start_at: new Date('2026-11-12T06:00:00.000Z'),
    actual_end_at: new Date('2026-11-12T07:00:00.000Z'),
    ...overrides,
  }
}

function artifactRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REAL_ARTIFACT,
    meeting_id: REAL_MEETING,
    provider: 'FEISHU',
    provider_artifact_id: 'feishu:transcript:demo',
    source_revision: 1,
    variant_type: 'ORIGINAL',
    language: 'zh',
    transcript_status: 'READY',
    provenance: 'FIXTURE',
    trigger_mode: 'MANUAL',
    connection_state: 'CONNECTED',
    is_canonical: true,
    is_complete: true,
    has_more: false,
    content_sha256: 'a'.repeat(64),
    fetched_at: new Date('2026-11-12T07:00:00.000Z'),
    created_at: new Date('2026-11-12T07:00:00.000Z'),
    char_count: '376',
    segment_count: '8',
    ...overrides,
  }
}

function recordRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-000000000c01',
    status: 'NEEDS_REVIEW',
    verification_status: 'UNVERIFIED',
    transcript_revision: 1,
    transcript_artifact_id: REAL_ARTIFACT,
    evidence_ok: false,
    is_current: true,
    created_at: new Date('2026-11-12T07:30:00.000Z'),
    ...overrides,
  }
}

/** 假库的场景（只描述"查出来是什么行"，不模拟 SQL 语义）。 */
interface FakeTranscriptDb {
  readonly interview: Record<string, unknown>
  readonly meetings: readonly Record<string, unknown>[]
  readonly artifacts: readonly Record<string, unknown>[]
  readonly textRows: readonly Record<string, unknown>[]
  readonly segments: readonly Record<string, unknown>[]
  readonly segmentTotal: number
  readonly record: Record<string, unknown> | undefined
  readonly waitMinutes: string | null
  readonly tenant: Record<string, unknown>
}

/**
 * 只实现 `query` 的假 `DatabaseClient`：按 SQL 文本返回造好的行。
 *
 * 为什么要假库而不是连库：本文件是**纯单测**（CI 无库也能跑），但必须走到
 * 真实核心函数（`readTranscriptInTransaction`）里的每一处取值/拼装，
 * 否则"输出值 vs schema"的漂移仍然抓不到。
 * @param scenario - 覆盖默认场景的字段（默认 = 有正文、canonical、record 未就绪）。
 */
function fakeTranscriptClient(scenario: Partial<FakeTranscriptDb> = {}): DatabaseClient {
  const db: FakeTranscriptDb = {
    interview: interviewRow(),
    meetings: [meetingRow()],
    artifacts: [artifactRow()],
    textRows: [],
    segments: [],
    segmentTotal: 0,
    record: recordRow(),
    waitMinutes: '120',
    tenant: { tenant_exists: true, demo: 'true', synthetic: null },
    ...scenario,
  }
  const fake = {
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      const text = String(sql)
      if (text.includes('from recruitment.interview_record')) {
        return { rows: (db.record === undefined ? [] : [db.record]) as T[] }
      }
      if (text.includes('from recruitment.interview i')) return { rows: [db.interview] as T[] }
      if (text.includes('from recruitment.meeting_binding b')) return { rows: [...db.meetings] as T[] }
      if (text.includes('coalesce(length(a.raw_text)')) return { rows: [...db.artifacts] as T[] }
      if (text.includes('substring(raw_text from')) return { rows: [...db.textRows] as T[] }
      if (text.includes('count(*) as total from recruitment.transcript_segment')) {
        return { rows: [{ total: db.segmentTotal }] as T[] }
      }
      if (text.includes('from recruitment.transcript_segment')) return { rows: [...db.segments] as T[] }
      if (text.includes('tenant_exists')) return { rows: [db.tenant] as T[] }
      if (text.includes('wait_minutes')) {
        return { rows: (db.waitMinutes === null ? [] : [{ wait_minutes: db.waitMinutes }]) as T[] }
      }
      throw new Error(`fake client 未匹配的 SQL：${text}`)
    },
  }
  return fake as unknown as DatabaseClient
}

/**
 * 把**返回值**按 DSH 子集校验（与 `test/unit/output-schema.test.ts` 同一判据）：
 * 类型、enum、required、additionalProperties:false、数组 items。空数组 = 合法。
 * @param schema - 工具的 `output.schema`。
 * @param value - 工具真实返回的值。
 * @param path - 报错路径前缀。
 * @returns 违规描述数组。
 */
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
  if (!typeOk()) return [`${path} 类型不符（期望 ${type}）`]
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

/** 一次真值读取（走 `readTranscriptInTransaction`，不是手写样例）。 */
async function readRealValue(
  scenario: Partial<FakeTranscriptDb> = {},
  args: Record<string, unknown> = { interview_id: REAL_INTERVIEW, artifact_id: REAL_ARTIFACT },
): Promise<Record<string, unknown>> {
  return await readTranscriptInTransaction(
    fakeTranscriptClient(scenario), READ_CFG, args, REAL_NOW_MS,
  ) as Record<string, unknown>
}

test('真值 vs output.schema：readTranscriptInTransaction 完整返回值严格通过（artifact 不得有 content_chars）', async () => {
  const value = await readRealValue({
    textRows: [{ content: '00:00 这', total_chars: '376', slice_len: '8' }],
    segments: [{ sequence: 0, content_text: '00:00 这', speaker_ref: null }],
    segmentTotal: 1,
  }, { interview_id: REAL_INTERVIEW, artifact_id: REAL_ARTIFACT, include_segments: true })

  assert.deepEqual(nullPaths(value), [], '输出值里不得有 null（缺省靠省略键）')
  assert.deepEqual(valueViolations(READ_TOOL.output.schema, value), [], '返回值与 output.schema 不一致')

  const transcript = value.transcript as Record<string, unknown>
  assert.equal(transcript.state, 'READY')
  assert.equal(transcript.reason_code, 'CANONICAL_STATUS')
  assert.equal(transcript.wait_minutes, 120)
  assert.equal(transcript.artifact_count, 1)
  const artifact = (transcript.artifacts as Record<string, unknown>[])[0] as Record<string, unknown>
  // 2026-11-15 P0 的最小回归断言：这个键不属于 schema，出现即真会话 INVALID_TOOL_OUTPUT。
  assert.equal(Object.hasOwn(artifact, 'content_chars'), false, 'artifact 对象不得有 schema 未声明的 content_chars')
  assert.equal(artifact.char_count, 376)
  assert.equal(artifact.segment_count, 8)
  const text = transcript.text as Record<string, unknown>
  assert.equal(text.total_chars, 376)
  assert.equal(text.has_more, true)
  assert.equal(text.next_offset, 8)
  assert.equal((transcript.segment_page as Record<string, unknown>).total, 1)
})

test('负控：把 content_chars 加回真实返回值 → 校验器必须报"未声明的键"（证明本回归抓得到该 P0）', async () => {
  const value = await readRealValue()
  const withDrift = structuredClone(value) as Record<string, unknown>
  const transcript = withDrift.transcript as Record<string, unknown>
  const artifact = (transcript.artifacts as Record<string, unknown>[])[0] as Record<string, unknown>
  // 这就是 2026-11-15 真会话失败的那个形状（`0a24395` 引入、:943 写死）。
  artifact.content_chars = 376
  const violations = valueViolations(READ_TOOL.output.schema, withDrift)
  assert.ok(
    violations.includes('value.transcript.artifacts[0].content_chars 是未声明的键'),
    `负控未被抓到，violations=${JSON.stringify(violations)}`,
  )
})

test('ARTIFACT_EMPTY 的真值也严格通过 schema（reason_code enum 回归）', async () => {
  const tool = createTranscriptReadTool(READ_CFG)
  const schema = tool.output.schema as {
    properties: { transcript: { properties: { reason_code: { enum: string[] } } } }
  }
  const enumValues = schema.properties.transcript.properties.reason_code.enum
  assert.ok(enumValues.includes('ARTIFACT_EMPTY'), `reason_code enum 缺 ARTIFACT_EMPTY：${JSON.stringify(enumValues)}`)

  const value = await readRealValue({
    artifacts: [artifactRow({ transcript_status: 'READY', is_complete: true, is_canonical: true, char_count: '0', segment_count: '0' })],
    textRows: [{ content: '', total_chars: '0', slice_len: '0' }],
  })
  const transcript = value.transcript as Record<string, unknown>
  assert.equal(transcript.state, 'PARTIAL', '空正文不得报 READY（D-96）')
  assert.equal(transcript.reason_code, 'ARTIFACT_EMPTY')
  assert.equal((transcript.artifacts as Record<string, unknown>[])[0]?.char_count, 0)
  assert.deepEqual(valueViolations(tool.output.schema, value), [])
})

test('output.schema 的 reason_code enum 与 TR-D §5 封闭集逐一相等（8 个，含 ARTIFACT_EMPTY）', () => {
  const tool = createTranscriptReadTool(READ_CFG)
  const schema = tool.output.schema as {
    properties: { transcript: { properties: { reason_code: { enum: string[] } } } }
  }
  const actual = [...schema.properties.transcript.properties.reason_code.enum].sort()
  const contract = [
    'NO_MEETING_BOUND', 'CANONICAL_STATUS', 'READY_NO_CANONICAL', 'ONLY_PARTIAL',
    'ONLY_AUTH_REQUIRED', 'NO_ARTIFACT_AFTER_WAIT', 'WAITING', 'ARTIFACT_EMPTY',
  ].sort()
  assert.deepEqual(actual, contract, 'schema enum 必须与 contracts/interview/transcript-rules.md §5 一致')
})

test('最小真值（无产物/无正文/无片段/无 record）也严格通过 schema', async () => {
  const value = await readRealValue({
    meetings: [],
    artifacts: [],
    record: undefined,
  }, { interview_id: REAL_INTERVIEW })

  assert.deepEqual(nullPaths(value), [])
  assert.deepEqual(valueViolations(READ_TOOL.output.schema, value), [])
  const transcript = value.transcript as Record<string, unknown>
  assert.equal(transcript.state, 'MISSING')
  assert.equal(transcript.reason_code, 'NO_MEETING_BOUND')
  for (const optional of ['text', 'segments', 'segment_page', 'record', 'canonical_artifact_id', 'selected_artifact_id']) {
    assert.equal(Object.hasOwn(transcript, optional), false, `${optional} 缺省必须省略键（不写 null）`)
  }
  assert.ok((value.warnings as readonly { code: string }[]).some((warning) => warning.code === 'RECORD_MISSING'))
})
