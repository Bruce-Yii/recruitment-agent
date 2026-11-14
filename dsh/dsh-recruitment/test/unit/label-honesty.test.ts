// R4 三维标签的**机检**（N10 / `docs/23` P2-03 的回归）——不连库。
//
// 这个文件回答五个问题，全部可机检：
//   1. `provenance` 的判定式有没有被写死？—— 用假 client 跑判定表的**每一行**：
//      只有"租户被显式声明为非合成"才是 LIVE；缺租户行 / 有合成标记 / 缺声明一律 FIXTURE（fail-closed）。
//   2. 工具的 `output.schema.labels` 三轴齐不齐、枚举有没有被放宽？
//      写/读工具的 `connection` 只放各自契约允许的值，`provenance` 只允许 LIVE|FIXTURE（不许出现第四种取值）。
//   3. **全部 `src/tools/*.ts`** 的源码里还有没有硬编码的出口标签？—— `provenance: 'LIVE'` 必须 0 命中。
//   4. **LIVE 能力白名单**：任何在 `output.schema` 里声明"可能输出 LIVE"的工具文件，都必须连到
//      一个**证据来源**（租户合成声明 / 回读 Gate / 材料事件链 / 文件字节 digest）。
//      新增一个"能输出 LIVE"的工具而不接证据 ⇒ 本测试红（fail-closed，不靠人记得）。
//   5. `resume_read` 的 LIVE 是不是有证据：`provenance` 由 converter 对**实际文件字节**算的
//      SHA-256 决定；拿不到 digest ⇒ FIXTURE，不许默认 LIVE。
//
// 背景：`interview_schedule` / `job_create` 曾写死 `provenance: 'LIVE'`，而 `ra_s6s7` 是
// 0002_seed 的"演示租户 + 合成数据"（`organization.name` = '演示租户 · DEMO ONLY（非真实数据）'）。
// 把合成数据标成 LIVE 会把"演示通过"污染成"真实能力"，是 R4 的原始事故。
// 2026-11-14 第二轮：`job_get` / `interview_get` / `transcript_read` 三个**读**工具同样写死了
// `LIVE`（`docs/23` P2-03 漏网），`resume_read` 把 LIVE 当常量（没有把文件 digest 当依据）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import type { DatabaseClient, ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  buildThreeAxisLabels,
  createCandidateGetTool,
  resolveTenantProvenance,
} from '../../src/tools/candidate-get.ts'
import { createInterviewScheduleTool } from '../../src/tools/interview-schedule.ts'
import { createJobCreateTool, createJobUpdateTool } from '../../src/tools/job-create.ts'
import { createJobGetTool } from '../../src/tools/job-get.ts'
import { createInterviewGetTool } from '../../src/tools/interview-get.ts'
import { createTranscriptReadTool } from '../../src/tools/transcript-read.ts'
import { createResumeReadTool, toValue } from '../../src/tools/resume-read.ts'
import type { ConverterOutput } from '../../src/tools/converter.ts'

/** 本文件不连库：配置只在造工具定义（读 schema）时用到，执行路径不会被调用。 */
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

/** 三处工具源文件（相对本测试文件）。 */
const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'tools')

/**
 * 假连接：返回固定的一行（模拟 `resolveTenantProvenance` 的租户事实查询）。
 * @param row - 查询结果的第一行（`undefined` = 0 行）。
 * @returns 可以当作 `DatabaseClient` 用的对象，并记录本次 SQL 文本与参数。
 */
function fakeClient(row?: Record<string, unknown>): DatabaseClient & {
  readonly calls: { text: string; params: readonly unknown[] }[]
} {
  const calls: { text: string; params: readonly unknown[] }[] = []
  const client = {
    calls,
    async query(text: string, params: readonly unknown[] = []) {
      calls.push({ text, params })
      return { rows: row === undefined ? [] : [row] }
    },
  }
  return client as unknown as DatabaseClient & { readonly calls: { text: string; params: readonly unknown[] }[] }
}

/** 从工具定义里取 labels 的 schema。 */
function labelsSchema(tool: { output: { schema: unknown } }): Record<string, unknown> {
  const schema = tool.output.schema as Record<string, unknown>
  const properties = schema.properties as Record<string, unknown>
  const labels = properties.labels as Record<string, unknown> | undefined
  assert.ok(labels !== undefined, 'output.schema 必须声明 labels（三维标签不能缺席）')
  return labels
}

/** 取某个标签维度的 enum。 */
function labelEnum(labels: Record<string, unknown>, axis: string): string[] {
  const properties = labels.properties as Record<string, Record<string, unknown>>
  const property = properties[axis]
  assert.ok(property !== undefined, `labels.${axis} 必须存在`)
  assert.equal(property.type, 'string', `labels.${axis} 必须是单类型 string（DSH 子集不许类型数组）`)
  assert.ok(Array.isArray(property.enum), `labels.${axis} 必须是封闭枚举`)
  return property.enum as string[]
}

// ---------------------------------------------------------------------------
//  1. 判定式：只有正面证据才是 LIVE
// ---------------------------------------------------------------------------

test('provenance 判定式：演示租户（有 demo 标记）⇒ FIXTURE，即使别处写了 synthetic=false', async () => {
  const client = fakeClient({ tenant_exists: true, demo: 'true', synthetic: 'false' })
  assert.equal(await resolveTenantProvenance(client, CFG.tenant_id), 'FIXTURE')
})

test('provenance 判定式：缺租户行 / 缺声明 ⇒ FIXTURE（fail-closed，没有证据不许自称 LIVE）', async () => {
  assert.equal(await resolveTenantProvenance(fakeClient(undefined), CFG.tenant_id), 'FIXTURE')
  assert.equal(
    await resolveTenantProvenance(fakeClient({ tenant_exists: false, demo: null, synthetic: null }), CFG.tenant_id),
    'FIXTURE',
  )
  assert.equal(
    await resolveTenantProvenance(fakeClient({ tenant_exists: true, demo: null, synthetic: null }), CFG.tenant_id),
    'FIXTURE',
  )
  assert.equal(
    await resolveTenantProvenance(fakeClient({ tenant_exists: true, demo: null, synthetic: 'true' }), CFG.tenant_id),
    'FIXTURE',
  )
})

test('provenance 判定式：只有"显式声明非合成 + 无合成标记"才是 LIVE', async () => {
  const client = fakeClient({ tenant_exists: true, demo: null, synthetic: 'false' })
  assert.equal(await resolveTenantProvenance(client, CFG.tenant_id), 'LIVE')
  // 判定读的是库里的租户事实：一次查询、参数只有 tenant_id + 两个配置键，没有写死的租户白名单。
  assert.equal(client.calls.length, 1)
  const call = client.calls[0]
  assert.ok(call !== undefined)
  assert.match(call.text, /recruitment\.business_config/)
  assert.match(call.text, /recruitment\.organization/)
  assert.match(call.text, /distinct on \(config_key\)/, '同键多版本时必须取最新一版')
  assert.deepEqual(call.params, [CFG.tenant_id, 'stage_catalog', 'tenant_provenance'])
})

test('三维标签：trigger 恒 MANUAL、connection 恒 NOT_CONNECTED（与 provenance 正交，不压成一维）', async () => {
  const fixture = await buildThreeAxisLabels(
    fakeClient({ tenant_exists: true, demo: 'true', synthetic: null }),
    CFG.tenant_id,
  )
  assert.deepEqual(fixture, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' })

  const live = await buildThreeAxisLabels(
    fakeClient({ tenant_exists: true, demo: null, synthetic: 'false' }),
    CFG.tenant_id,
  )
  // 其余两轴不变：数据真 != 自动触发，也 != 能读外部系统。
  assert.deepEqual(live, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' })
})

// ---------------------------------------------------------------------------
//  2. 三个工具的出口 schema：三轴齐、枚举不放宽
// ---------------------------------------------------------------------------

test('output.schema.labels：job_create / job_update / interview_schedule / candidate_get 都三轴齐全', () => {
  const tools = {
    recruitment_job_create: createJobCreateTool(CFG),
    recruitment_job_update: createJobUpdateTool(CFG),
    recruitment_interview_schedule: createInterviewScheduleTool(CFG),
    recruitment_candidate_get: createCandidateGetTool(CFG),
  }
  for (const [name, tool] of Object.entries(tools)) {
    const schema = tool.output.schema as Record<string, unknown>
    const required = schema.required as string[]
    const labels = labelsSchema(tool)
    assert.deepEqual(
      labels.required,
      ['provenance', 'trigger', 'connection'],
      `${name}: labels 必须三轴全 required`,
    )
    assert.ok(required.includes('labels'), `${name}: labels 必须在顶层 required 里`)
    // 封闭枚举、单类型；不许出现第四种取值。
    assert.deepEqual(labelEnum(labels, 'provenance').sort(), ['FIXTURE', 'LIVE'])
    assert.deepEqual(labelEnum(labels, 'trigger'), ['MANUAL'])
    assert.deepEqual(labelEnum(labels, 'connection'), ['NOT_CONNECTED'], `${name}: 不接外部系统，不许放 CONNECTED`)
  }
})

// ---------------------------------------------------------------------------
//  3. 源码层：没有硬编码的出口标签，且三处共用同一份判定实现
// ---------------------------------------------------------------------------

test('源码扫描：三个工具文件里没有硬编码的 `provenance: \'LIVE\'` / `connection: \'CONNECTED\'`', () => {
  for (const file of ['interview-schedule.ts', 'job-create.ts', 'candidate-get.ts']) {
    const source = readFileSync(join(TOOL_DIR, file), 'utf8')
    // 只看对象字面量（后面跟逗号），类型声明里的 `provenance: 'LIVE' | 'FIXTURE'` 不算硬编码。
    assert.doesNotMatch(source, /provenance:\s*'LIVE'\s*,/, `${file}: provenance 不许写死 LIVE（必须按租户事实算）`)
    assert.doesNotMatch(source, /connection:\s*'CONNECTED'\s*,/, `${file}: connection 不许写死 CONNECTED`)
  }
})

test('单一判定实现：三处都 import 同一个 buildThreeAxisLabels（不各写一份，防漂移）', () => {
  for (const [file, importer] of [
    ['interview-schedule.ts', /import \{ buildThreeAxisLabels \} from '\.\/candidate-get\.ts'/],
    ['job-create.ts', /import \{ buildThreeAxisLabels \} from '\.\/candidate-get\.ts'/],
    ['candidate-get.ts', /export async function buildThreeAxisLabels/],
  ] as const) {
    const source = readFileSync(join(TOOL_DIR, file), 'utf8')
    assert.match(source, importer, `${file}: 必须共用 candidate-get.ts 的同一份判定实现`)
  }
})

// ---------------------------------------------------------------------------
//  4. 全部工具出口扫描：没有证据就不可能有 LIVE（2026-11-14 第二轮）
// ---------------------------------------------------------------------------
//
// 为什么从"三个文件"扩到"全部 src/tools/*.ts"：P2-03 只点了两个写工具，漏掉了
// `job_get` / `interview_get` / `transcript_read` 三个**读**工具同样写死 `LIVE`。
// 逐文件点名的检查会随工具增加而漏；这里改成"扫全部 + 白名单 fail-closed"：
// 以后任何工具想在出口给 LIVE，不接证据来源就红。

/** 全部工具源文件（"扫描所有工具的出口"的作用域 = `src/tools/*.ts`）。 */
const TOOL_FILES = readdirSync(TOOL_DIR).filter((name) => name.endsWith('.ts')).sort()

/** 声明"可能输出 LIVE"的 schema 节点（`enum` 里出现 LIVE）。 */
const LIVE_CAPABLE_ENUM = /enum:\s*\[[^\]]*'LIVE'[^\]]*\]/

/**
 * LIVE 白名单：**每个**能输出 LIVE 的工具文件都必须在这里，并且真的连到一个**证据来源**。
 *
 * 新增一个"能输出 LIVE"的工具而不接证据 ⇒ 它不在本表 ⇒ 测试红（fail-closed，
 * 不依赖后来的人记得改检查）。证据来源必须是**这次调用**可查到的正面证据，
 * 不接受"读到了业务库行"（演示租户的行同样读得到）。
 */
const LIVE_EVIDENCE: Record<string, { readonly marker: RegExp; readonly why: string }> = {
  'candidate-get.ts': {
    marker: /export async function resolveTenantProvenance/,
    why: '判定式的唯一实现：租户被显式声明为非合成',
  },
  'config-shared.ts': {
    marker: /export const LABELS_SCHEMA/,
    why: '只导出 schema；实际标签由消费方 config-*.ts 调 buildThreeAxisLabels（另有专测）',
  },
  'config-pipeline.ts': { marker: /import \{ buildThreeAxisLabels/, why: '同一份租户判定' },
  'config-role.ts': { marker: /import \{ buildThreeAxisLabels/, why: '同一份租户判定' },
  'config-team.ts': { marker: /import \{ buildThreeAxisLabels/, why: '同一份租户判定' },
  'interview-schedule.ts': { marker: /import \{ buildThreeAxisLabels/, why: '同一份租户判定' },
  'job-create.ts': { marker: /import \{ buildThreeAxisLabels/, why: '同一份租户判定' },
  'job-rubric-approve.ts': { marker: /import \{ buildThreeAxisLabels/, why: '同一份租户判定' },
  'stage-advance.ts': { marker: /import \{ buildThreeAxisLabels/, why: '同一份租户判定' },
  'job-get.ts': {
    marker: /import \{ resolveTenantProvenance \} from '\.\/candidate-get\.ts'/,
    why: '同一份租户判定（读侧：数据来自被读的那一行所属租户）',
  },
  'interview-get.ts': {
    marker: /import \{ resolveTenantProvenance \} from '\.\/candidate-get\.ts'/,
    why: '同一份租户判定',
  },
  'transcript-read.ts': {
    marker: /import \{ resolveTenantProvenance \} from '\.\/candidate-get\.ts'/,
    why: '同一份租户判定',
  },
  'transcript-import.ts': {
    marker: /evaluateLiveGate/,
    why: '连接器回读 Gate：证据齐全（平台通道 + 回执 + 哈希绑定）才是 LIVE',
  },
  'screening-evaluate.ts': {
    marker: /event_provider !== 'internal'/,
    why: '材料链 event_inbox.provider 非 internal（TC §1.3）',
  },
  'evaluation-summarize.ts': { marker: /async function computeProvenance/, why: 'TC §1.3 材料链 + 会议判定式' },
  'scorecard-submit.ts': { marker: /async function computeProvenance/, why: 'TC §1.3 材料链 + 会议判定式' },
  'decision-record.ts': { marker: /function provenanceOf/, why: '缺省按 FIXTURE（没有证据不许自称 LIVE）' },
  'resume-read.ts': {
    marker: /function readEvidenceOf/,
    why: 'converter 对实际文件字节算的 SHA-256（唯一真实的本地外部读取）',
  },
  'application-intake.ts': {
    marker: /provenance: 'FIXTURE',/,
    why: '写侧工具：当前实现恒 FIXTURE（fail-closed；schema 声明 LIVE 属另一处待收口，不在本 lane）',
  },
}

test('源码扫描：`provenance: \'LIVE\'` 字面量只允许出现在"证据闸门之后"', () => {
  // 唯一允许的例外：连接器回读 Gate 判 LIVE 之后返回常量（`transcript-import.ts`）。
  // 闸门必须**出现在字面量之前**——这个顺序就是"先有证据再贴标签"的机检形式。
  const GATED: Record<string, readonly RegExp[]> = {
    'transcript-import.ts': [/if \(evaluateLiveGate\(readback\)\.gate === 'LIVE'\)/],
  }
  for (const file of TOOL_FILES) {
    const source = readFileSync(join(TOOL_DIR, file), 'utf8')
    for (const pattern of [/provenance:\s*'LIVE'\s*[,}]/g, /provenance:\s*"LIVE"\s*[,}]/g]) {
      const occurrences = [...source.matchAll(pattern)]
      if (occurrences.length === 0) continue
      const gates = GATED[file]
      assert.ok(
        gates !== undefined,
        `${file}: 出口里出现硬编码的 provenance=LIVE（没有任何证据闸门）。`
          + '必须改成按本次调用的证据算（见 contracts/tenant-provenance.md）',
      )
      const gateAt = Math.min(...gates.map((gate) => source.search(gate)))
      assert.ok(gateAt >= 0, `${file}: 白名单要求的证据闸门不存在（${gates.join(' / ')}）`)
      for (const match of occurrences) {
        assert.ok(
          (match.index ?? -1) > gateAt,
          `${file}: 第 ${match.index} 字符的 provenance=LIVE 出现在证据闸门之前——标签先于证据，就是撒谎`,
        )
      }
    }
  }
})

test('源码扫描：没有"无论如何都 LIVE"的封闭枚举（enum 只含 LIVE）', () => {
  for (const file of TOOL_FILES) {
    const source = readFileSync(join(TOOL_DIR, file), 'utf8')
    assert.doesNotMatch(
      source,
      /enum:\s*\[\s*'LIVE'\s*\]/,
      `${file}: 封闭枚举里只剩 LIVE ⇒ 该工具永远不会诚实说 FIXTURE（resume_read 旧写法）`,
    )
  }
})

test('LIVE 白名单：每个能输出 LIVE 的工具都连到证据来源；新增工具不接证据就红', () => {
  const declared = TOOL_FILES.filter((file) => LIVE_CAPABLE_ENUM.test(readFileSync(join(TOOL_DIR, file), 'utf8')))
  // fail-closed：任何在**自己文件里**声明"可能输出 LIVE"的工具，必须已在白名单里写明证据来源。
  // （config-pipeline/role/team 的枚举来自共享的 `LABELS_SCHEMA`，由下一条测试覆盖。）
  const undocumented = declared.filter((file) => !Object.hasOwn(LIVE_EVIDENCE, file))
  assert.deepEqual(
    undocumented,
    [],
    '这些工具声明了能输出 LIVE 却没在白名单里写明证据来源（fail-closed：先有证据，才允许 LIVE）',
  )
  for (const [file, { marker, why }] of Object.entries(LIVE_EVIDENCE)) {
    const source = readFileSync(join(TOOL_DIR, file), 'utf8')
    assert.match(source, marker, `${file}: LIVE 必须连到证据来源（${why}）`)
  }
})

test('共享 LABELS_SCHEMA 的消费者必须真的调 buildThreeAxisLabels（不许只 import schema）', () => {
  for (const file of TOOL_FILES) {
    const source = readFileSync(join(TOOL_DIR, file), 'utf8')
    if (!/LABELS_SCHEMA/.test(source) || file === 'config-shared.ts') continue
    assert.match(source, /buildThreeAxisLabels\(/, `${file}: 声明了三维 schema 就必须用同一份判定实现算标签`)
  }
})

// ---------------------------------------------------------------------------
//  5. 三个"读库"工具的出口：三轴齐全、provenance 封闭、且真的调用同一份判定
// ---------------------------------------------------------------------------

test('读工具 output.schema.labels：三轴齐全、provenance 封闭、connection 只放契约允许值', () => {
  const tools = {
    recruitment_job_get: createJobGetTool(CFG),
    recruitment_interview_get: createInterviewGetTool(CFG),
    recruitment_transcript_read: createTranscriptReadTool(CFG),
  }
  // 这三个读工具的 connection 由**各自工具契约**解释为"直连业务库"（contracts/.../tool-contracts.md §1.4）；
  // 本 lane 不改这层语义（tenant-provenance.md §7 待值班），只要求枚举不许再放宽。
  const allowedConnection: Record<string, string[]> = {
    recruitment_job_get: ['CONNECTED', 'NOT_CONNECTED'],
    recruitment_interview_get: ['CONNECTED', 'NOT_CONNECTED'],
    recruitment_transcript_read: ['CONNECTED'],
  }
  for (const [name, tool] of Object.entries(tools)) {
    const schema = tool.output.schema as Record<string, unknown>
    const labels = labelsSchema(tool)
    assert.deepEqual(labels.required, ['provenance', 'trigger', 'connection'], `${name}: labels 必须三轴全 required`)
    assert.ok((schema.required as string[]).includes('labels'), `${name}: labels 必须在顶层 required 里`)
    assert.deepEqual(labelEnum(labels, 'provenance').sort(), ['FIXTURE', 'LIVE'], `${name}: provenance 封闭为两值`)
    assert.deepEqual(labelEnum(labels, 'trigger'), ['MANUAL'], `${name}: 会话内调用恒 MANUAL`)
    assert.deepEqual(
      [...labelEnum(labels, 'connection')].sort(),
      [...allowedConnection[name] as string[]].sort(),
      `${name}: connection 枚举不得放宽`,
    )
  }
})

test('三个读库工具真的调用 resolveTenantProvenance（不是 import 了不用、更不是写死）', () => {
  for (const file of ['job-get.ts', 'interview-get.ts', 'transcript-read.ts']) {
    const source = readFileSync(join(TOOL_DIR, file), 'utf8')
    assert.match(
      source,
      /provenance = await resolveTenantProvenance\(client, /,
      `${file}: labels.provenance 必须由 resolveTenantProvenance 在本次调用里算出`,
    )
  }
})

// ---------------------------------------------------------------------------
//  6. resume_read：LIVE 由"真实文件字节的 digest"决定（唯一合理保留 LIVE 的读工具）
// ---------------------------------------------------------------------------

/** 一份"converter 真的读到了文件"的输出（sha256 是 64 位 hex、有页数、有解析后端）。 */
const REAL_READ: ConverterOutput = {
  meta: {
    pages: 2,
    source_sha256: '9754a77f11b4b9733f9a5072340a078b066ad86896ea9568b975de4aa6ff2356',
    source_name: 'resume.pdf',
    backend: 'pymupdf/1.28.0',
    order_verified: true,
  },
  completeness: 'complete',
  blocks: [],
  fields: {},
}

test('resume_read：converter 给了文件字节 digest ⇒ LIVE，且依据码点名是哪个证据', () => {
  const value = toValue(REAL_READ, 10)
  assert.equal(value.provenance, 'LIVE')
  assert.equal(value.provenance_basis, 'FILE_BYTES_SHA256_VERIFIED')
  // 证据本身必须真的在出口里（可复核），不是只有一句"我 LIVE"。
  assert.match(value.source.sha256, /^[0-9a-f]{64}$/, 'LIVE 必须带可复核的 64 位 hex digest')
  assert.equal(value.source.pages, 2)
  assert.equal(value.source.backend, 'pymupdf/1.28.0')
})

test('resume_read：拿不到文件字节 digest ⇒ FIXTURE（fail-closed），并说明为什么不是 LIVE', () => {
  const cases: readonly [string, ConverterOutput][] = [
    ['完全没给 meta', { completeness: 'complete', blocks: [], fields: {} }],
    ['sha256 为空串', { ...REAL_READ, meta: { ...REAL_READ.meta, source_sha256: '' } }],
    ['sha256 不是 64 位 hex', { ...REAL_READ, meta: { ...REAL_READ.meta, source_sha256: 'deadbeef' } }],
    ['没有页数', { ...REAL_READ, meta: { ...REAL_READ.meta, pages: 0 } }],
    ['没有解析后端', { ...REAL_READ, meta: { ...REAL_READ.meta, backend: '' } }],
  ]
  for (const [label, output] of cases) {
    const value = toValue(output, 10)
    assert.equal(value.provenance, 'FIXTURE', `${label}: 没有证据不许自称 LIVE`)
    assert.equal(value.provenance_basis, 'NO_READ_EVIDENCE', `${label}: 依据码必须如实`)
    assert.ok(
      value.issues.some((issue) => issue.code === 'provenance_evidence_missing'),
      `${label}: 降级必须留下可读的 issue，而不是静默改标签`,
    )
  }
})

test('resume_read：输出 schema 声明 provenance 两值，且 provenance_basis 必填（LIVE 的证据位不可省）', () => {
  const tool = createResumeReadTool({
    python_bin: 'C:\\python.exe',
    converter_dir: 'C:\\converter',
    allowed_roots: ['C:\\corpus'],
    timeout_ms: 1000,
  })
  const properties = (tool.output.schema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>
  assert.deepEqual((properties.provenance?.enum as string[]).sort(), ['FIXTURE', 'LIVE'])
  assert.deepEqual(properties.provenance_basis?.enum, ['FILE_BYTES_SHA256_VERIFIED', 'NO_READ_EVIDENCE'])
  assert.ok(((tool.output.schema as Record<string, unknown>).required as string[]).includes('provenance_basis'))
  // 闭集证据：任何一个 LIVE 出口都必须带可机检的依据码（本测试的 toValue 用例已覆盖取值）。
  assert.doesNotMatch(
    readFileSync(join(TOOL_DIR, 'resume-read.ts'), 'utf8'),
    /provenance:\s*'LIVE'\s*,/,
    'resume-read.ts: LIVE 不许是常量（必须由 readEvidenceOf 算）',
  )
})
