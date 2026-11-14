// S9 转写导入的**纯单测**（不连库）：标签诚实性 + 参数校验 + 输出/入参 schema。
//
// 为什么这些必须在单测里：`transcript-rules.md` 的 TR-S4/TR-S5/TR-S6 是「标签不能撒谎」
// 的机检面；`source_kind` 与 `provenance` 的对应关系一旦漂移，集成测试只会验证
// “写进去了”，不会验证“标签是不是对的”。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_CONTENT_CHARS,
  artifactLabelsForSourceKind,
  createTranscriptImportTool,
  parseImportArgs,
  provenanceBasisFor,
  unconfiguredTranscriptImportTool,
} from '../../src/tools/transcript-import.ts'
import { resolveDatabaseConfig } from '../../src/db/pool.ts'

const INTERVIEW = '11111111-1111-4111-8111-000000000abc'
const DATABASE = resolveDatabaseConfig({
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'ra_s6s7',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
}, { RECRUITMENT_DB_PASSWORD: 'unused-in-this-test' }).resolved

/** 从 `<CODE>: <compact-json>` 里取 JSON 体。 */
function body(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  return JSON.parse(index >= 0 ? message.slice(index + 2) : message) as Record<string, unknown>
}

test('标签：DEMO_SAMPLE 一律 FIXTURE/MANUAL/NOT_CONNECTED，PLATFORM_EXPORT 才 LIVE 且仍 MANUAL/NOT_CONNECTED', () => {
  const demo = artifactLabelsForSourceKind('DEMO_SAMPLE')
  assert.deepEqual(demo, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' })
  const exportLabels = artifactLabelsForSourceKind('PLATFORM_EXPORT')
  assert.deepEqual(exportLabels, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' })
  for (const labels of [demo, exportLabels]) {
    assert.notEqual(labels.trigger, 'EVENT', '人工导入不得自称 EVENT 触发（TR-S6）')
    assert.notEqual(labels.connection, 'CONNECTED', '本工具不连会议平台，不得自称 CONNECTED')
  }
})

test('provenance_basis 是封闭码，不是自由文本', () => {
  assert.equal(provenanceBasisFor('LIVE'), 'PLATFORM_EXPORT_SELF_DECLARED_RECEIPT')
  assert.equal(provenanceBasisFor('FIXTURE'), 'DEMO_SAMPLE_NO_PLATFORM_RECEIPT')
})

test('参数：缺 content / 空 content / 非 UUID / 未知参数 / tenant_id 各自被拒（封闭 reason_code）', () => {
  const cases: readonly [Record<string, unknown>, string][] = [
    [{ interview_id: INTERVIEW, source_kind: 'DEMO_SAMPLE' }, 'MISSING_REQUIRED'],
    [{ interview_id: INTERVIEW, source_kind: 'DEMO_SAMPLE', content: '' }, 'TYPE_MISMATCH'],
    [{ interview_id: 'not-a-uuid', source_kind: 'DEMO_SAMPLE', content: 'x' }, 'ID_NOT_UUID'],
    [{ interview_id: INTERVIEW, source_kind: 'NOPE', content: 'x' }, 'OUT_OF_RANGE'],
    [{ interview_id: INTERVIEW, source_kind: 'DEMO_SAMPLE', content: 'x', tenant_id: 'x' }, 'TENANT_OR_ACTOR_NOT_ALLOWED'],
    [{ interview_id: INTERVIEW, source_kind: 'DEMO_SAMPLE', content: 'x', actor_id: 'x' }, 'TENANT_OR_ACTOR_NOT_ALLOWED'],
    [{ interview_id: INTERVIEW, source_kind: 'DEMO_SAMPLE', content: 'x', nope: 1 }, 'UNKNOWN_PARAM'],
  ]
  for (const [args, reason] of cases) {
    assert.throws(() => parseImportArgs(args), (error: unknown) => {
      const parsed = body(error)
      assert.equal(parsed.code, 'INVALID_ARGS')
      assert.equal(parsed.reason_code, reason, JSON.stringify(args))
      return true
    })
  }
})

test('参数：PLATFORM_EXPORT 必须有导出文件名；DEMO_SAMPLE 不得带文件名（否则等于造回执）', () => {
  const noFile = { interview_id: INTERVIEW, source_kind: 'PLATFORM_EXPORT', content: 'x' }
  assert.throws(() => parseImportArgs(noFile), (error: unknown) => {
    assert.equal(body(error).reason_code, 'EXPORT_FILE_NAME_REQUIRED')
    return true
  })
  const demoWithFile = { interview_id: INTERVIEW, source_kind: 'DEMO_SAMPLE', content: 'x', exported_file_name: 'a.txt' }
  assert.throws(() => parseImportArgs(demoWithFile), (error: unknown) => {
    assert.equal(body(error).reason_code, 'MUTUALLY_EXCLUSIVE')
    return true
  })
  const semicolon = {
    interview_id: INTERVIEW, source_kind: 'PLATFORM_EXPORT', content: 'x', exported_file_name: 'a;b.txt',
  }
  assert.throws(() => parseImportArgs(semicolon), (error: unknown) => {
    assert.equal(body(error).reason_code, 'OUT_OF_RANGE')
    return true
  })
  // 合法组合不抛
  assert.doesNotThrow(() => parseImportArgs({
    interview_id: INTERVIEW, source_kind: 'PLATFORM_EXPORT', content: 'x', exported_file_name: '导出.txt',
  }))
})

test('content 上限：MAX 通过，MAX+1 被拒 OUT_OF_RANGE', () => {
  assert.equal(MAX_CONTENT_CHARS, 400_000)
  assert.doesNotThrow(() => parseImportArgs({
    interview_id: INTERVIEW, source_kind: 'DEMO_SAMPLE', content: 'x'.repeat(MAX_CONTENT_CHARS),
  }))
  assert.throws(() => parseImportArgs({
    interview_id: INTERVIEW, source_kind: 'DEMO_SAMPLE', content: 'x'.repeat(MAX_CONTENT_CHARS + 1),
  }), (error: unknown) => {
    assert.equal(body(error).reason_code, 'OUT_OF_RANGE')
    return true
  })
})

test('入参 schema：封闭对象根；labels 的 trigger/connection 是闭集（不可能出现 EVENT/CONNECTED）', () => {
  assert.notEqual(DATABASE, null)
  const tool = createTranscriptImportTool(DATABASE!)
  const parameters = tool.parameters as {
    type: string
    additionalProperties: boolean
    required: string[]
    properties: Record<string, { enum?: string[] }>
  }
  assert.equal(parameters.type, 'object')
  assert.equal(parameters.additionalProperties, false)
  // content 变成可选（连接器回读路径不给正文），但 interview_id 仍然必填。
  assert.deepEqual([...parameters.required], ['interview_id'])
  assert.deepEqual([...((parameters.properties.source_kind?.enum) ?? [])], ['PLATFORM_EXPORT', 'DEMO_SAMPLE'])

  const schema = tool.output.schema as {
    properties: {
      labels: { properties: { trigger: { enum: string[] }; connection: { enum: string[] } } }
    }
  }
  assert.deepEqual([...schema.properties.labels.properties.trigger.enum], ['MANUAL'])
  // 连接器回读可以如实说 AUTH_REQUIRED；但绝不出现 CONNECTED（Live Gate=BLOCKED）。
  assert.deepEqual([...schema.properties.labels.properties.connection.enum], ['NOT_CONNECTED', 'AUTH_REQUIRED'])
  assert.equal(schema.properties.labels.properties.connection.enum.includes('CONNECTED'), false)
})

test('输出 schema 只用 DSH 子集：没有 type:null / type 数组', () => {
  const tool = createTranscriptImportTool(DATABASE!)
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return
    const record = node as Record<string, unknown>
    assert.notEqual(record.type, 'null')
    assert.equal(Array.isArray(record.type), false)
    for (const value of Object.values(record)) visit(value)
  }
  visit(tool.output.schema)
})

test('未配置替身：注册同名工具，调用报 NOT_CONFIGURED（不静默降级）', async () => {
  const tool = unconfiguredTranscriptImportTool(['config.database.host is required'])
  assert.equal(tool.name, 'recruitment_transcript_import')
  assert.equal((tool.parameters as { additionalProperties: boolean }).additionalProperties, false)
  await assert.rejects(async () => tool.execute({}, {}), (error: unknown) => {
    const parsed = body(error)
    assert.equal(parsed.code, 'NOT_CONFIGURED')
    assert.equal(parsed.reason_code, 'PLUGIN_NOT_CONFIGURED')
    return true
  })
})

// ---------------------------------------------------------------------------------------------
// 以下为补充的机检项（与上面的用例同一主题，加强到"输出值也不能撒谎"这一层）。
// ---------------------------------------------------------------------------------------------

/** DSH 已强制的 schema 子集：本工具只允许用这几个关键字。 */
const SUPPORTED_KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description'])
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean'])

/** 深扫 schema：子集外关键字 / type 数组 / type:'null' / required 未声明 / 缺 type。 */
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

/** 深扫值：输出里不允许 null（缺省一律靠省略键）。 */
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
    tool: 'recruitment_transcript_import',
    contract_version: '1.0.0',
    status: 'OK',
    write: true,
    replayed: false,
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' },
    provenance_basis: 'DEMO_SAMPLE_NO_PLATFORM_RECEIPT',
    interview: { id: INTERVIEW, application_id: INTERVIEW, job_id: INTERVIEW, round_no: 1, stage_code: 'S9', status: 'POST_INTERVIEW' },
    meeting: { id: INTERVIEW, provider: 'FEISHU', meeting_role: 'PRIMARY', binding_id: INTERVIEW, binding_method: 'MANUAL' },
    artifact: {
      id: INTERVIEW, meeting_id: INTERVIEW, provider: 'LOCAL_DEMO', provider_artifact_id: 'local:demo-sample:x',
      source_revision: 1, variant_type: 'ORIGINAL', language: 'zh', transcript_status: 'READY',
      provenance: 'FIXTURE', trigger_mode: 'MANUAL', connection_state: 'NOT_CONNECTED',
      is_canonical: true, is_complete: true, has_more: false, content_sha256: 'a'.repeat(64),
      char_count: 10, segment_count: 1, fetched_at: '2026-11-13T10:00:00.000Z',
    },
    record: {
      id: INTERVIEW, status: 'NEEDS_REVIEW', verification_status: 'UNVERIFIED',
      transcript_revision: 1, evidence_ok: true, is_current: true,
    },
    changes: { created: [{ table: 'transcript_artifact', id: INTERVIEW }], updated: [] },
    warnings: [{ code: 'FIXTURE_CONTENT_NOT_LIVE', message: '演示文本不是平台回读内容' }],
    next_actions: [],
  }
}

test('两套 schema 的每个节点都只用受支持关键字（不是"只查 type:null"那么宽）', () => {
  const tool = createTranscriptImportTool(DATABASE!)
  assert.deepEqual(schemaViolations(tool.parameters), [])
  assert.deepEqual(schemaViolations(tool.output.schema), [])
  // record 是**可省略键**：没有 rubric 时不出现（不是 null）
  assert.equal(((tool.output.schema as { required: string[] }).required).includes('record'), false)
})

test('输出值：无 null、required 齐全、无未声明键（有 record / 无 record 两种形状）', () => {
  const tool = createTranscriptImportTool(DATABASE!)
  const schema = tool.output.schema as { required: string[]; properties: Record<string, unknown> }
  const value = sampleOutput()
  assert.deepEqual(nullPaths(value), [])
  for (const key of schema.required) assert.ok(Object.hasOwn(value, key), `required 缺 ${key}`)
  for (const key of Object.keys(value)) assert.ok(Object.hasOwn(schema.properties, key), `未声明的键 ${key}`)
  // 没有 rubric 时 record 整体省略 —— 依然是合法形状
  const { record: _record, ...withoutRecord } = value
  assert.deepEqual(nullPaths(withoutRecord), [])
  for (const key of schema.required) assert.ok(Object.hasOwn(withoutRecord, key))
})

test('错误消息：`<CODE>: <compact-json>` 单行、可 JSON.parse、带 .code（TC §1.2）', async () => {
  await assert.rejects(
    async () => createTranscriptImportTool(DATABASE!).execute({ interview_id: 'nope' }, {}),
    (error: unknown) => {
      const message = (error as Error).message
      assert.match(message, /^INVALID_ARGS: \{/)
      assert.equal(message.includes('\n'), false, '错误消息必须单行')
      assert.equal((error as { code?: string }).code, 'INVALID_ARGS')
      const parsed = body(error)
      assert.equal(parsed.code, 'INVALID_ARGS')
      assert.equal(typeof parsed.message, 'string')
      return true
    },
  )
})

test('render：一行摘要（没有换行），只给身份/状态/计数，不回显正文', () => {
  const tool = createTranscriptImportTool(DATABASE!)
  const value = sampleOutput()
  const blocks = tool.output.render({}, value)
  assert.equal(blocks.length, 1)
  const text = blocks[0]?.text ?? ''
  assert.equal(text.includes('\n'), false, '导入摘要是单行')
  assert.ok(text.includes('replayed=false'))
  assert.ok(text.includes('provenance=FIXTURE'))
  assert.ok(text.includes('trigger=MANUAL'))
  assert.ok(text.includes('connection=NOT_CONNECTED'))
  assert.ok(text.includes('segments=1'))
  assert.equal(text.includes('a'.repeat(64)), false, '不得回显整段 sha')
})

test('写工具不可并行（TC §1.3：写操作 isConcurrencySafe=false）', () => {
  const tool = createTranscriptImportTool(DATABASE!)
  assert.equal(tool.isConcurrencySafe?.({}), false)
  assert.match(tool.description, /READY/)
  assert.match(tool.description, /interview_record/)
})
